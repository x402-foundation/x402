import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientKeetaSigner } from "../../signer";
import type { ExactKeetaPayload } from "../../types";
import * as KeetaNet from "@keetanetwork/keetanet-client";

/**
 * Keeta client implementation for the Exact payment scheme.
 */
export class ExactKeetaScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactKeetaScheme instance.
   *
   * @param signer - The Keeta account for signing transactions
   */
  constructor(private readonly signer: ClientKeetaSigner) {}

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
    const amount = BigInt(paymentRequirements.amount);
    const recipient = KeetaNet.lib.Account.fromPublicKeyString(paymentRequirements.payTo);

    const token = KeetaNet.lib.Account.fromPublicKeyString(paymentRequirements.asset).assertKeyType(
      KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN,
    );

    let external: string | undefined;
    if (typeof paymentRequirements.extra?.external === "string") {
      external = paymentRequirements.extra.external;
    }

    const paymentBlock = await this.signer.computePaymentBlock(
      paymentRequirements.network,
      recipient,
      amount,
      token,
      external,
    );

    const payload: ExactKeetaPayload = {
      block: Buffer.from(paymentBlock.toBytes(true)).toString("base64"),
    };

    return {
      x402Version,
      payload,
    };
  }
}
