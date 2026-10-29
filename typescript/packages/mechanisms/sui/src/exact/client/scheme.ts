import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { fromBase64, isValidSuiAddress, normalizeStructTag } from "@mysten/sui/utils";
import type {
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { ExactSuiPayload, SuiClientOptions } from "../../types";
import { findDefaultAsset } from "../../defaultAssets";
import { createSuiClientResolver, parseBase64Bytes, type SuiClientResolver } from "../../utils";

/**
 * Sui client implementation for the Exact payment scheme. Builds and signs (but
 * does not execute) a `balance::send_funds` of `amount` to `payTo`, valid for
 * the current and next epoch. An advertised `feePayer` becomes the gas owner,
 * and a declared server `nonce` is carried as a `Pure` input.
 */
export class ExactSuiScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly findDefaultAsset = findDefaultAsset;

  private readonly getClient: SuiClientResolver;
  private readonly chainIds = new Map<Network, Promise<string>>();

  /**
   * Creates a new ExactSuiScheme client instance.
   *
   * @param signer - Any Sui signer (Ed25519Keypair, Secp256k1Keypair, wallet-backed, ...)
   * @param options - Optional per-network Sui client overrides
   */
  constructor(
    private readonly signer: Signer,
    options?: SuiClientOptions,
  ) {
    this.getClient = createSuiClientResolver(options?.clients);
  }

  /**
   * Creates a payment payload by building and signing the payment transaction.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements (amount, asset, payTo, network, extra)
   * @returns Promise resolving to a signed payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const { amount, asset, payTo, network } = paymentRequirements;
    if (!asset) {
      throw new Error("Asset is required");
    }
    if (!payTo || !isValidSuiAddress(payTo)) {
      throw new Error(`Invalid pay-to address: ${payTo}`);
    }
    if (!amount || !/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new Error(`Amount must be a positive atomic-unit integer: ${amount}`);
    }
    const coinType = normalizeStructTag(asset);

    // A nonce over 32 bytes is valid but forfeits gasless (NONCE_GASLESS_PURE_BYTES).
    const declaredNonce = paymentRequirements.extra?.nonce;
    let nonceBytes: Uint8Array | undefined;
    if (declaredNonce !== undefined) {
      const parsed = parseBase64Bytes(declaredNonce);
      if (!parsed) {
        throw new Error(`Invalid payment nonce in requirements: ${String(declaredNonce)}`);
      }
      nonceBytes = parsed;
    }

    const feePayer = paymentRequirements.extra?.feePayer;
    const sponsored = typeof feePayer === "string";

    const tx = new Transaction();
    tx.setSender(this.signer.toSuiAddress());
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [coinType],
      arguments: [
        // The sponsor rejects use of its gas coin, so a SUI payment must not draw on it.
        tx.balance({ type: coinType, balance: BigInt(amount), useGasCoin: !sponsored }),
        tx.pure.address(payTo),
      ],
    });
    // Raw bytes, not a BCS vector, so the decoded `Pure.bytes` is exactly the nonce.
    if (nonceBytes) {
      tx.pure(nonceBytes);
    }

    // The sponsor pays gas from its address balance and co-signs at settlement.
    if (sponsored) {
      tx.setGasOwner(feePayer);
      tx.setGasPayment([]);
    }

    const client = this.getClient(network);
    const [{ systemState }, chain] = await Promise.all([
      client.core.getCurrentSystemState(),
      this.getChainIdentifier(network, client),
    ]);
    const epoch = BigInt(systemState.epoch);
    tx.setExpiration({
      ValidDuring: {
        minEpoch: String(epoch),
        maxEpoch: String(epoch + 1n),
        minTimestamp: null,
        maxTimestamp: null,
        chain,
        nonce: (Math.random() * 0x100000000) >>> 0,
      },
    });

    const bytes = await tx.build({ client });
    // A wallet-backed signer may return different bytes than it was given; the
    // signature covers the returned ones.
    const signed = await this.signer.signTransaction(bytes);
    if (sponsored) {
      assertWithinGasCap(fromBase64(signed.bytes), paymentRequirements.extra?.maxGasBudget);
    }

    const payload: ExactSuiPayload = {
      transaction: signed.bytes,
      signature: signed.signature,
    };

    return {
      x402Version,
      payload,
    };
  }

  /**
   * The network's chain identifier, fetched once per network.
   *
   * @param network - The CAIP-2 network id
   * @param client - The Sui client for the network
   * @returns The chain identifier
   */
  private getChainIdentifier(network: Network, client: ClientWithCoreApi): Promise<string> {
    let chainId = this.chainIds.get(network);
    if (!chainId) {
      chainId = client.core.getChainIdentifier().then(r => r.chainIdentifier);
      chainId.catch(() => this.chainIds.delete(network));
      this.chainIds.set(network, chainId);
    }
    return chainId;
  }
}

/**
 * Throw when a sponsored transaction's budget exceeds the advertised cap.
 *
 * @param bytes - The built transaction bytes
 * @param maxGasBudget - The facilitator's `extra.maxGasBudget`, if any
 */
function assertWithinGasCap(bytes: Uint8Array, maxGasBudget: unknown): void {
  if (maxGasBudget === undefined) return;
  if (typeof maxGasBudget !== "string" || !/^[0-9]+$/.test(maxGasBudget)) {
    throw new Error(`Invalid maxGasBudget in requirements: ${String(maxGasBudget)}`);
  }
  const budget = BigInt(Transaction.from(bytes).getData().gasData.budget ?? 0);
  if (budget > BigInt(maxGasBudget)) {
    throw new Error(`Gas budget ${budget} exceeds the sponsor's maxGasBudget ${maxGasBudget}`);
  }
}
