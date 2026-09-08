import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  CARDANO_ADDRESS_REGEX,
  CANONICAL_CARDANO_ASSET_REGEX,
  CARDANO_UTXO_REF_REGEX,
  isCardanoNetwork,
  SCHEME_EXACT,
  POSITIVE_CANONICAL_AMOUNT_REGEX,
} from "../../constants";
import { findDefaultAsset } from "../../defaultAssets";
import { resolveCardanoPolicies } from "../../policy";
import type { ClientCardanoSigner } from "../../signer";
import type { ExactCardanoPayload } from "../../types";

/**
 * Cardano client implementation for the Exact payment scheme.
 *
 * The signer is responsible for choosing a UTXO that backs the payment and
 * including it as both an input and as the `nonce` field returned alongside
 * the signed transaction. The transaction is never broadcast by the client:
 * the facilitator verifies and submits it during `settle()`.
 */
export class ExactCardanoScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;
  readonly findDefaultAsset = findDefaultAsset;

  /**
   * Creates a new Cardano client scheme.
   *
   * @param signer - The Cardano client signer.
   */
  constructor(private readonly signer: ClientCardanoSigner) {}

  /**
   * Builds a Cardano payment payload by delegating signing to the configured
   * signer. The signer is responsible for honoring the assetTransferMethod in
   * `paymentRequirements.extra`.
   *
   * @param x402Version - The x402 protocol version.
   * @param paymentRequirements - The payment requirements to fulfill.
   * @param context - Payment-required context (unused; Masumi registry claims
   *   are validated by the facilitator against `PaymentPayload.resource`).
   * @returns A promise resolving to the Cardano payment payload.
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    void context;
    if (!isCardanoNetwork(paymentRequirements.network)) {
      throw new Error(`Unsupported Cardano network: ${paymentRequirements.network}`);
    }
    if (!paymentRequirements.payTo) {
      throw new Error("Pay-to address is required");
    }
    if (!CARDANO_ADDRESS_REGEX.test(paymentRequirements.payTo)) {
      throw new Error(`Invalid Cardano pay-to address: ${paymentRequirements.payTo}`);
    }
    if (!paymentRequirements.asset) {
      throw new Error("Asset is required");
    }
    if (!CANONICAL_CARDANO_ASSET_REGEX.test(paymentRequirements.asset)) {
      throw new Error(
        `Cardano asset must use canonical lowercase form: ${paymentRequirements.asset}`,
      );
    }
    if (!paymentRequirements.amount) {
      throw new Error("Amount is required");
    }
    if (!POSITIVE_CANONICAL_AMOUNT_REGEX.test(paymentRequirements.amount)) {
      throw new Error(
        `Amount must be a positive canonical integer, got: ${paymentRequirements.amount}`,
      );
    }
    // Refuse a 402 the facilitator would reject anyway, before touching the wallet.
    if (!resolveCardanoPolicies(paymentRequirements.extra)) {
      throw new Error("Cardano payment requirements carry an invalid confirmation policy");
    }

    const result = await this.signer.buildAndSignPaymentTransaction({
      network: paymentRequirements.network,
      payTo: paymentRequirements.payTo,
      asset: paymentRequirements.asset,
      amount: paymentRequirements.amount,
      maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds,
      extra: paymentRequirements.extra,
    });

    if (!result || typeof result.transaction !== "string" || result.transaction.length === 0) {
      throw new Error("Cardano signer returned an empty transaction");
    }
    if (!result.nonce || !CARDANO_UTXO_REF_REGEX.test(result.nonce)) {
      throw new Error(`Cardano signer returned an invalid nonce: ${result.nonce}`);
    }

    const payload: ExactCardanoPayload = {
      transaction: result.transaction,
      nonce: result.nonce,
    };

    return {
      x402Version,
      payload,
    };
  }
}
