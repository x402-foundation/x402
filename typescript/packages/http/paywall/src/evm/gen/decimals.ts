// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
// Source: @x402/evm DEFAULT_STABLECOINS (decimals !== 6 only).
// Regenerate via: pnpm --filter @x402/paywall run build:paywall

/**
 * Per-network default token decimals that differ from the paywall fallback (6),
 * keyed by CAIP-2 network identifier. Chains whose default stablecoin uses 6
 * decimals are omitted; `getDefaultTokenDecimals` treats a missing key as 6.
 * Emitted at build time so the paywall's runtime module graph does not depend on `@x402/evm`.
 */
export const NETWORK_DECIMALS: Record<string, number> = {
  "eip155:31611": 18,
  "eip155:31612": 18,
  "eip155:4326": 18,
};
