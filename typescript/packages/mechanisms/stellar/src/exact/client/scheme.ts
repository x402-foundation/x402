import { nativeToScVal, contract } from "@stellar/stellar-sdk";
import { handleSimulationResult } from "../../shared";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  isStellarNetwork,
  RpcConfig,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "../../utils";
import type { ClientStellarSigner } from "../../signer";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

/**
 * Stellar client implementation for the Exact payment scheme.
 */
export class ExactStellarScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactStellarScheme instance.
   *
   * @param signer - The Stellar signer for client operations
   * @param rpcConfig - Optional configuration with custom RPC URL
   * @returns ExactStellarScheme instance
   */
  constructor(
    private readonly signer: ClientStellarSigner,
    private readonly rpcConfig?: RpcConfig,
  ) {}

  /**
   * Creates a payment payload for the Exact scheme.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to a payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    try {
      this.validateCreateAndSignPaymentInput(paymentRequirements);
    } catch (error) {
      throw new Error(`Invalid input parameters for creating Stellar payment, cause: ${error}`);
    }

    const sourcePublicKey = this.signer.address;
    const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = paymentRequirements;
    const networkPassphrase = getNetworkPassphrase(network);
    const rpcUrl = getRpcUrl(network, this.rpcConfig);

    if (!extra.areFeesSponsored) {
      throw new Error(`Exact scheme requires areFeesSponsored to be true`);
    }

    // Fetch current ledger and calculate maxLedger
    const rpcServer = getRpcClient(network, this.rpcConfig);
    const latestLedger = await rpcServer.getLatestLedger();
    const currentLedger = latestLedger.sequence;
    const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
    const maxLedger = currentLedger + Math.ceil(maxTimeoutSeconds / estimatedLedgerSeconds);

    const tx = await contract.AssembledTransaction.build({
      contractId: asset,
      method: "transfer",
      args: [
        // SEP-41 spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md#interface
        nativeToScVal(sourcePublicKey, { type: "address" }), // from
        nativeToScVal(payTo, { type: "address" }), // to
        nativeToScVal(amount, { type: "i128" }), // amount
      ],
      networkPassphrase,
      rpcUrl,
      parseResultXdr: result => result,
    });
    handleSimulationResult(tx.simulation);

    let missingSigners = tx.needsNonInvokerSigningBy();
    if (!missingSigners.includes(sourcePublicKey) || missingSigners.length > 1) {
      throw new Error(
        `Expected to sign with [${sourcePublicKey}], but got [${missingSigners.join(", ")}]`,
      );
    }
    await tx.signAuthEntries({
      address: sourcePublicKey,
      signAuthEntry: this.signer.signAuthEntry,
      expiration: maxLedger,
    });

    await tx.simulate();
    handleSimulationResult(tx.simulation);

    missingSigners = tx.needsNonInvokerSigningBy();
    if (missingSigners.length > 0) {
      throw new Error(`unexpected signer(s) required: [${missingSigners.join(", ")}]`);
    }

    return {
      x402Version,
      payload: {
        transaction: tx.built!.toXDR(),
      },
    };
  }

  /**
   * Validates the input parameters for the createAndSignPayment function.
   *
   * @param paymentRequirements - Payment requirements
   * @throws Error if validation fails
   */
  private validateCreateAndSignPaymentInput(paymentRequirements: PaymentRequirements): void {
    const { scheme, network, payTo, asset, amount } = paymentRequirements;
    if (typeof amount !== "string" || !Number.isInteger(Number(amount)) || Number(amount) <= 0) {
      throw new Error(`Invalid amount: ${amount}. Amount must be a positive integer.`);
    }

    if (scheme !== "exact") {
      throw new Error(`Unsupported scheme: ${scheme}`);
    }

    if (!isStellarNetwork(network)) {
      throw new Error(`Unsupported Stellar network: ${network}`);
    }

    if (!validateStellarDestinationAddress(payTo)) {
      throw new Error(`Invalid Stellar destination address: ${payTo}`);
    }

    if (!validateStellarAssetAddress(asset)) {
      throw new Error(`Invalid Stellar asset address: ${asset}`);
    }
  }
}
