import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeStructTag, toBase64 } from "@mysten/sui/utils";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { ExactSuiPayload, SuiClientOptions } from "../../types";
import { createSuiClientResolver, parseBase64Bytes, type SuiClientResolver } from "../../utils";

/**
 * Sui client implementation for the Exact payment scheme. Builds and signs (but
 * does not execute) a transaction whose effects transfer `amount` to `payTo`,
 * sourced via the SDK's `tx.balance()` input. When the requirements announce a
 * `feePayer` it sets the sponsor as gas owner; when they declare a server
 * `nonce` its bytes ride as a `Pure` input.
 */
export class ExactSuiScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  private readonly getClient: SuiClientResolver;

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

    // Decode the declared server nonce (Base64) so it can ride as an unused Pure
    // input below. A nonce beyond 32 bytes stays valid but may forfeit gasless
    // eligibility (see NONCE_GASLESS_PURE_BYTES).
    const declaredNonce = paymentRequirements.extra?.nonce;
    let nonceBytes: Uint8Array | undefined;
    if (declaredNonce !== undefined) {
      const parsed = parseBase64Bytes(declaredNonce);
      if (!parsed) {
        throw new Error(`Invalid payment nonce in requirements: ${String(declaredNonce)}`);
      }
      nonceBytes = parsed;
    }

    const tx = new Transaction();
    tx.setSender(this.signer.toSuiAddress());
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [coinType],
      arguments: [tx.balance({ type: coinType, balance: BigInt(amount) }), tx.pure.address(payTo)],
    });
    // Passed as raw bytes (no BCS length prefix) so the decoded `Pure.bytes` is
    // exactly the nonce.
    if (nonceBytes) {
      tx.pure(nonceBytes);
    }

    // When the requirements announce a sponsor, set it as gas owner with empty
    // gas payment (Address Balance gas); the sponsor co-signs at settlement.
    const feePayer = paymentRequirements.extra?.feePayer;
    if (typeof feePayer === "string") {
      tx.setGasOwner(feePayer);
      tx.setGasPayment([]);
    }

    const client = this.getClient(network);
    const bytes = await tx.build({ client });
    const { signature } = await this.signer.signTransaction(bytes);

    const payload: ExactSuiPayload = {
      transaction: toBase64(bytes),
      signature,
    };

    return {
      x402Version,
      payload,
    };
  }
}
