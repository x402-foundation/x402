import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { isNearNetwork } from "../../constants";
import type { ClientNearSigner } from "../../signer";
import type { ExactNearPayload } from "../../types";

/**
 * Client-side NEAR exact-scheme implementation.
 */
export class ExactNearScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates an ExactNearScheme.
   *
   * @param signer - Client signer abstraction for delegate-action creation
   */
  constructor(private readonly signer: ClientNearSigner) {}

  /**
   * Creates a payment payload for NEAR exact payment requirements.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Selected payment requirements
   * @returns Minimal payload result for x402 client assembly
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    if (paymentRequirements.scheme !== this.scheme) {
      throw new Error(`Unsupported scheme: ${paymentRequirements.scheme}`);
    }

    if (!isNearNetwork(paymentRequirements.network)) {
      throw new Error(`Unsupported NEAR network: ${paymentRequirements.network}`);
    }

    const signedDelegateAction = await this.signer.createSignedDelegateAction({
      x402Version,
      paymentRequirements,
    });

    if (typeof signedDelegateAction !== "string" || signedDelegateAction.length === 0) {
      throw new Error("Client signer returned an empty signed delegate action");
    }

    const payload: ExactNearPayload = {
      signedDelegateAction,
    };

    return {
      x402Version,
      payload,
    };
  }
}
