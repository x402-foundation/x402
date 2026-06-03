/**
 * Curated testnet faucet URLs keyed by CAIP-2 network identifier.
 *
 * Hand-maintained per `DEFAULT_ASSETS.md` "Paywall faucet link (recommended
 * for testnets)" section. Mainnet entries omitted (paywall faucet UI is
 * testnet-gated).
 */
export const FAUCET_URLS: Record<string, string> = {
  // EVM testnets
  "eip155:84532": "https://faucet.circle.com/", // Base Sepolia
  "eip155:421614": "https://faucet.circle.com/", // Arbitrum Sepolia
  "eip155:31611": "https://faucet.test.mezo.org/", // Mezo Testnet
  "eip155:2201": "https://faucet.stable.xyz/faucet", // Stable Testnet
  "eip155:72344": "https://testnet.radiustech.xyz/wallet", // Radius Testnet
  // SVM testnets
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://faucet.circle.com/",
  // AVM testnets
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=":
    "https://dispenser.testnet.aws.algodev.network/",
};

/**
 * Resolve the testnet faucet URL for a network. Returns undefined when no URL
 * is configured (caller renders fallback text). Server override
 * (`PaywallConfig.faucetUrls`) wins over the curated map.
 *
 * @param network - CAIP-2 network identifier
 * @param x402 - Object exposing the optional consumer `faucetUrls` override
 * @param x402.faucetUrls - Optional per-chain override map keyed by CAIP-2 identifier
 * @returns Resolved faucet URL or undefined when no entry exists
 */
export function resolveFaucetUrl(
  network: string,
  x402: { faucetUrls?: Record<string, string> },
): string | undefined {
  return x402.faucetUrls?.[network] ?? FAUCET_URLS[network];
}
