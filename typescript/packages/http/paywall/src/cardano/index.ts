import { type CardanoPaywallHandler, createCardanoPaywallHandler } from "./handler";
import type { KoiosProtocolParamsOptions } from "./protocolParams";

export type { CardanoPaywallHandler } from "./handler";

/** Options for {@link createCardanoPaywall}. */
export type CardanoPaywallOptions = Omit<KoiosProtocolParamsOptions, "now">;

/**
 * Creates a Cardano paywall handler. It accepts only `exact` requirements with
 * the default (plain transfer) method on `cardano:*` or CIP-34 networks, and
 * injects Koios protocol parameters fetched by the server.
 *
 * @param options - Koios URLs, optional server-only token and cache timings.
 * @returns The handler.
 */
export function createCardanoPaywall(options: CardanoPaywallOptions = {}): CardanoPaywallHandler {
  return createCardanoPaywallHandler(options);
}

/** Cardano paywall handler with default options (Koios public APIs). */
export const cardanoPaywall: CardanoPaywallHandler = createCardanoPaywall();
