import type { PaymentRequirements, AssetAmount, Price } from "@x402/core/types";
import {
  ASSET,
  DEFAULT_INVOICE_DESCRIPTION,
  DEFAULT_INVOICE_EXPIRY_SECONDS,
  PAY_TO_ANONYMOUS,
  PAYMENT_METHOD_LIGHTNING,
  SCHEME,
  SUPPORTED_NETWORKS,
  ERR_UNSUPPORTED_NETWORK,
} from "../constants";
import type { LightningReceiver } from "../types";

/**
 * x402 server-side scheme for Bitcoin Lightning (bip122/exact).
 *
 * Responsibilities:
 * - Convert a price to millisatoshis
 * - Create a BOLT11 invoice and inject it into PaymentRequirements.extra
 *
 * The server does NOT verify payments — that is the facilitator's role.
 * For sovereign (no-facilitator) deployments, use ExactBip122FacilitatorScheme
 * directly on the server.
 *
 * @example
 * ```ts
 * import { ExactBip122ServerScheme } from "@x402/bip122/exact/server";
 * import { myLightningReceiver } from "./my-receiver";
 *
 * const server = new ExactBip122ServerScheme(myLightningReceiver);
 * ```
 */
export class ExactBip122ServerScheme {
  readonly scheme = SCHEME;

  constructor(
    private readonly receiver: LightningReceiver,
    private readonly defaultDescription = DEFAULT_INVOICE_DESCRIPTION,
    private readonly defaultExpirySeconds = DEFAULT_INVOICE_EXPIRY_SECONDS,
  ) {}

  /**
   * Parse a price into an AssetAmount (millisatoshis).
   * Accepts a number (treated as satoshis) or a string like "1000" (sats) or "1000msat".
   */
  async parsePrice(price: Price, network: string): Promise<AssetAmount> {
    if (!SUPPORTED_NETWORKS.includes(network as (typeof SUPPORTED_NETWORKS)[number])) {
      throw new Error(`${ERR_UNSUPPORTED_NETWORK}: ${network}`);
    }

    if (typeof price === "object" && "amount" in price) {
      return { amount: price.amount, asset: ASSET };
    }

    const raw = typeof price === "number" ? price : parseFloat(String(price).replace(/[^0-9.]/g, ""));
    if (isNaN(raw) || raw <= 0) throw new Error(`Invalid price: ${price}`);

    // Treat bare numbers as satoshis → convert to msats
    const amountMsat = Math.round(raw * 1000);
    return { amount: String(amountMsat), asset: ASSET };
  }

  /**
   * Create a BOLT11 invoice and inject it into PaymentRequirements.extra.
   * Called by the x402 middleware before sending the 402 response.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: { network: string; extra?: Record<string, unknown> },
  ): Promise<PaymentRequirements> {
    const network = supportedKind.network ?? requirements.network;

    const amountMsat = Number(requirements.amount);
    if (isNaN(amountMsat) || amountMsat <= 0) {
      throw new Error(`Invalid amount in requirements: ${requirements.amount}`);
    }

    const invoice = await this.receiver.createInvoice(
      amountMsat,
      this.defaultDescription,
      this.defaultExpirySeconds,
      network,
    );

    return {
      ...requirements,
      asset: ASSET,
      payTo: PAY_TO_ANONYMOUS,
      extra: {
        ...requirements.extra,
        paymentMethod: PAYMENT_METHOD_LIGHTNING,
        invoice,
      },
    };
  }
}
