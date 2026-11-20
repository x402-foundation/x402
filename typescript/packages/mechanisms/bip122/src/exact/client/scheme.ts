import type { PaymentRequirements } from "@x402/core/types";
import type { ExactBip122Payload, LightningPayer } from "../types";
import { ERR_MISSING_INVOICE, ERR_INVALID_PAYMENT_METHOD, PAYMENT_METHOD_LIGHTNING } from "../constants";

/**
 * x402 client-side scheme for Bitcoin Lightning (bip122/exact).
 *
 * Responsibilities:
 * - Extract the BOLT11 invoice from PaymentRequirements.extra
 * - Pay it via the provided LightningPayer
 * - Return the payload (invoice string) for the Authorization header
 *
 * @example
 * ```ts
 * import { ExactBip122ClientScheme } from "@x402/bip122/exact/client";
 *
 * const client = new ExactBip122ClientScheme({
 *   payInvoice: async (invoice, network) => {
 *     await myWallet.pay(invoice);
 *   }
 * });
 *
 * const payload = await client.createPaymentPayload(2, requirements);
 * ```
 */
export class ExactBip122ClientScheme {
  readonly scheme = "exact";

  constructor(private readonly payer: LightningPayer) {}

  async createPaymentPayload(
    _x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<{ payload: ExactBip122Payload }> {
    const paymentMethod = requirements.extra?.paymentMethod;
    if (paymentMethod && paymentMethod !== PAYMENT_METHOD_LIGHTNING) {
      throw new Error(`${ERR_INVALID_PAYMENT_METHOD}: expected lightning, got ${paymentMethod}`);
    }

    const invoice = requirements.extra?.invoice;
    if (!invoice || typeof invoice !== "string") {
      throw new Error(`${ERR_MISSING_INVOICE}: PaymentRequirements.extra.invoice is required`);
    }

    await this.payer.payInvoice(invoice, requirements.network);

    return { payload: { invoice } };
  }
}
