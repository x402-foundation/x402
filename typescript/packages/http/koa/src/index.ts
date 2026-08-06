import type { Context } from "koa";
import { SETTLEMENT_OVERRIDES_HEADER, SettlementOverrides } from "@x402/core/server";

/**
 * Set settlement overrides on the response for partial settlement.
 * The middleware will extract these before settlement and strip the header from the client response.
 *
 * @param ctx - Koa context object
 * @param overrides - Settlement overrides (e.g., { amount: "500" } for partial settlement)
 */
export function setSettlementOverrides(ctx: Context, overrides: SettlementOverrides): void {
  ctx.set(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(overrides));
}

// Adapter
export { KoaAdapter } from "./adapter";

// Re-exports from @x402/core (matching express's pattern)
export { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";

export type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  Network,
  SchemeNetworkServer,
} from "@x402/core/types";

export type { PaywallProvider, PaywallConfig, SettlementOverrides } from "@x402/core/server";

export { RouteConfigurationError, SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";

export type { RouteValidationError } from "@x402/core/server";
