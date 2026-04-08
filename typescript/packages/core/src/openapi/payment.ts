/**
 * Payment info extraction: converts x402 PaymentOption(s) to OpenAPI x-payment-info.
 */
import type { PaymentOption } from "../http/x402HTTPResourceServer";
import type { PaymentInfo } from "./schemas";

/**
 * Resolve a Price value to a display amount string.
 *
 * Handles:
 * - Dollar strings: "$0.001" → "0.001"
 * - Plain strings: "1000" → "1000"
 * - Numbers: 0.5 → "0.5"
 * - AssetAmount objects: { amount: "1000", asset: "..." } → "1000"
 * - Dynamic functions: () => Price → undefined (cannot resolve statically)
 *
 * @param price - The price value to resolve
 * @returns The display amount string, or undefined for dynamic prices
 */
function resolvePrice(price: unknown): string | undefined {
  if (typeof price === "function") return undefined;

  if (typeof price === "string") {
    const dollarMatch = price.match(/^\$(\d+(?:\.\d+)?)$/);
    if (dollarMatch) return dollarMatch[1];
    return price;
  }

  if (typeof price === "number") return String(price);

  if (price !== null && typeof price === "object" && "amount" in price) {
    const assetAmount = price as { amount: string };
    return assetAmount.amount;
  }

  return undefined;
}

/**
 * Build a structured x-payment-info object from x402 PaymentOption(s).
 *
 * Uses the first option's price for the spec. All options share the x402 protocol.
 *
 * @param accepts - One or more payment options from the route config
 * @returns A structured x-payment-info object
 */
export function buildPaymentInfo(accepts: PaymentOption | PaymentOption[]): PaymentInfo {
  const options = Array.isArray(accepts) ? accepts : [accepts];
  const firstOption = options[0];
  const amount = resolvePrice(firstOption.price);

  return {
    price: amount
      ? { mode: "fixed" as const, amount, currency: "USD" }
      : { mode: "dynamic" as const },
    protocols: [{ x402: {} }],
  };
}
