/**
 * AVM Client Scheme for Exact Payment Protocol
 *
 * Creates atomic transaction groups for Algorand ASA transfers.
 * Uses AlgorandClient and TransactionComposer from algokit-utils v10
 * for transaction construction, fee pooling, and group management.
 */

import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";
import {
  Transaction,
  encodeTransactionRaw,
  groupTransactions,
  makeEmptyTransactionSigner,
} from "@algorandfoundation/algokit-utils/transact";
import { microAlgo } from "@algorandfoundation/algokit-utils/amount";
import type {
  PaymentRequirements,
  SchemeNetworkClient,
  PaymentPayloadResult,
} from "@x402/core/types";
import type { ClientAvmSigner, ClientAvmConfig } from "../../signer";
import type { ExactAvmPayloadV2 } from "../../types";
import { encodeTransaction } from "../../utils";
import { USDC_CONFIG } from "../../constants";
import { isTestnetNetwork } from "../../utils";

/**
 * AVM client implementation for the Exact payment scheme.
 *
 * Creates atomic transaction groups with ASA transfers for x402 payments.
 * Supports optional fee payer transactions for gasless payments.
 */
export class ExactAvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactAvmScheme instance.
   *
   * @param signer - The AVM signer for client operations
   * @param config - Optional configuration for Algod client
   */
  constructor(
    private readonly signer: ClientAvmSigner,
    private readonly config?: ClientAvmConfig,
  ) {}

  /**
   * Creates a payment payload for the Exact scheme.
   *
   * Constructs an atomic transaction group with:
   * - Optional fee payer transaction (if feePayer specified in requirements.extra)
   * - ASA transfer transaction to payTo address
   *
   * Uses TransactionComposer for automatic suggested params, group ID assignment,
   * and fee pooling. For sponsored (gasless) transactions, exact fees are calculated
   * from actual encoded transaction sizes using the protocol fee formula:
   *   fee = max(fee_per_byte × txn_size_in_bytes, min_fee)
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to a payment payload result
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const { amount, asset, payTo, network, extra } = paymentRequirements;

    const algorandClient = this.getAlgorandClient(network);

    // Get asset ID (from requirements or default USDC)
    const assetId = this.getAssetId(asset, network);

    // Get fee payer address from extra if provided
    const feePayer = extra?.feePayer as string | undefined;
    let paymentIndex = 0;

    // Use an empty signer for building — we sign manually after
    // (fee payer txns stay unsigned for the facilitator to sign)
    const emptySigner = makeEmptyTransactionSigner();

    // Build the transaction group using TransactionComposer
    const composer = algorandClient.newGroup();

    if (feePayer) {
      // First pass: add fee payer with a placeholder fee.
      // The actual fee will be recalculated after build() using exact transaction sizes.
      composer.addPayment({
        sender: feePayer,
        receiver: feePayer,
        amount: microAlgo(0),
        note: `x402-fee-payer-${Date.now()}`,
        signer: emptySigner,
      });
      paymentIndex = 1;
    }

    composer.addAssetTransfer({
      sender: this.signer.address,
      receiver: payTo,
      assetId: BigInt(assetId),
      amount: BigInt(amount),
      staticFee: feePayer ? microAlgo(0) : undefined, // 0 fee when fee payer covers
      note: `x402-payment-v${x402Version}-${Date.now()}`,
      signer: emptySigner,
    });

    // Build transactions (assigns group ID, suggested params, fees)
    const built = await composer.build();
    let transactions = built.transactions.map(tws => tws.txn);

    // For sponsored transactions: recalculate the fee payer's fee using
    // exact encoded sizes of all transactions in the group.
    // Algorand fee formula: fee = max(fee_per_byte × txn_size, min_fee)
    //
    // After changing fees, the group ID must be recomputed because it is
    // derived from each transaction's encoded bytes (which include the fee).
    if (feePayer) {
      const sp = await algorandClient.getSuggestedParams();
      const feePerByte = Number(sp.fee);
      const minFee = Number(sp.minFee);

      // Calculate exact fee for each transaction based on its actual encoded size
      let totalGroupFee = BigInt(0);
      for (const txn of transactions) {
        const txnSize = encodeTransactionRaw(txn).length;
        const txnFee = feePerByte > 0 ? Math.max(feePerByte * txnSize, minFee) : minFee;
        totalGroupFee += BigInt(txnFee);
      }

      // Strip group ID, set correct fees, then re-group.
      // groupTransactions() requires group to be absent, computes the new group hash,
      // and returns new Transaction objects with the correct group ID.
      const ungrouped = transactions.map((txn, i) => {
        const fee = i === 0 ? totalGroupFee : BigInt(0);
        return new Transaction({ ...txn, fee, group: undefined });
      });
      transactions = groupTransactions(ungrouped);
    }

    // Encode all transactions to raw bytes
    const encodedTxns = transactions.map(txn => encodeTransactionRaw(txn));

    // Determine which transactions the client should sign
    const clientIndexes = transactions
      .map((txn, i) => (txn.sender.toString() === this.signer.address ? i : -1))
      .filter(i => i !== -1);

    // Sign client's transactions
    const signedTxns = await this.signer.signTransactions(encodedTxns, clientIndexes);

    // Build payment group with signed/unsigned transactions
    const paymentGroup: string[] = encodedTxns.map((txnBytes, i) => {
      const signedTxn = signedTxns[i];
      if (signedTxn) {
        return encodeTransaction(signedTxn);
      }
      // Return unsigned transaction for facilitator to sign
      return encodeTransaction(txnBytes);
    });

    const payload: ExactAvmPayloadV2 = {
      paymentGroup,
      paymentIndex,
    };

    return {
      x402Version,
      payload: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * Creates or retrieves an AlgorandClient for the given network.
   *
   * @param network - Network identifier (CAIP-2 format)
   * @returns AlgorandClient instance
   */
  private getAlgorandClient(network: string): AlgorandClient {
    if (this.config?.algorandClient) {
      return this.config.algorandClient;
    }
    if (this.config?.algodUrl) {
      return AlgorandClient.fromConfig({
        algodConfig: {
          server: this.config.algodUrl,
          token: this.config.algodToken ?? "",
        },
      });
    }
    // Auto-detect network
    return isTestnetNetwork(network) ? AlgorandClient.testNet() : AlgorandClient.mainNet();
  }

  /**
   * Gets the asset ID from the requirements or defaults to USDC
   *
   * @param asset - Asset identifier from requirements
   * @param network - Network identifier
   * @returns Asset ID as string
   */
  private getAssetId(asset: string, network: string): string {
    // If asset is already a numeric string, use it directly
    if (/^\d+$/.test(asset)) {
      return asset;
    }

    // Try to get from USDC config
    const usdcConfig = USDC_CONFIG[network];
    if (usdcConfig) {
      return usdcConfig.asaId;
    }

    // Default to the asset as-is (might be an ASA ID)
    return asset;
  }
}
