import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { ClientHederaSigner } from "../../signer";
import type { ExactHederaPayloadV2 } from "../../types";
import { assertSupportedHederaNetwork } from "../../utils";

/**
 * Hedera client implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactHederaScheme instance.
   *
   * @param signer - Client-side Hedera signer
   */
  constructor(private readonly signer: ClientHederaSigner) {}

  /**
   * Creates a payment payload for exact Hedera payments.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Selected payment requirements
   * @param _ - Optional payment payload context
   * @returns Payload result
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (paymentRequirements.scheme !== "exact") {
      throw new Error("Unsupported scheme for Hedera exact client");
    }
    assertSupportedHederaNetwork(paymentRequirements.network);

    if (typeof paymentRequirements.extra?.feePayer !== "string") {
      throw new Error("feePayer is required in paymentRequirements.extra for Hedera exact");
    }

    const transaction =
      await this.signer.createPartiallySignedTransferTransaction(paymentRequirements);

    const payload: ExactHederaPayloadV2 = { transaction };
    return { x402Version, payload };
  }
}
