import type { PaymentRequirements } from "@x402/core/types";

// Chain configuration constants

// EVM Chain IDs (CAIP-2 format: eip155:chainId)
// Only chains we explicitly reference in code
export const EVM_CHAIN_IDS = {
  BASE_MAINNET: "8453",
  BASE_SEPOLIA: "84532",
} as const;

/**
 * Local registry of EVM chains x402 supports.
 *
 * Decoupled from `viem/chains` so paywall display name and testnet detection
 * remain correct regardless of the viem version pinned in the lockfile.
 * Keep in sync with `EVM_NETWORK_CHAIN_ID_MAP` in `@x402/evm`.
 */
const EVM_CHAIN_METADATA: Record<number, { name: string; testnet: boolean }> = {
  // Mainnets
  1: { name: "Ethereum", testnet: false },
  137: { name: "Polygon", testnet: false },
  988: { name: "Stable", testnet: false },
  1329: { name: "Sei", testnet: false },
  1514: { name: "Story", testnet: false },
  2741: { name: "Abstract", testnet: false },
  3338: { name: "peaq", testnet: false },
  4326: { name: "MegaETH", testnet: false },
  4689: { name: "IoTeX", testnet: false },
  8453: { name: "Base", testnet: false },
  41923: { name: "EDU Chain", testnet: false },
  42161: { name: "Arbitrum One", testnet: false },
  43114: { name: "Avalanche", testnet: false },
  // Testnets
  143: { name: "Monad", testnet: true },
  1328: { name: "Sei Testnet", testnet: true },
  2201: { name: "Stable Testnet", testnet: true },
  11124: { name: "Abstract Testnet", testnet: true },
  11155111: { name: "Sepolia", testnet: true },
  31611: { name: "Mezo Testnet", testnet: true },
  43113: { name: "Avalanche Fuji", testnet: true },
  80002: { name: "Polygon Amoy", testnet: true },
  84532: { name: "Base Sepolia", testnet: true },
  421614: { name: "Arbitrum Sepolia", testnet: true },
  324705682: { name: "SKALE Base Sepolia", testnet: true },
};

// Solana Network References (CAIP-2 format: solana:genesisHash)
export const SOLANA_NETWORK_REFS = {
  MAINNET: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  DEVNET: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

// Algorand Network References (CAIP-2 format: algorand:genesisHash)
export const ALGORAND_NETWORK_REFS = {
  MAINNET: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  TESTNET: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
} as const;

/**
 * Normalizes the payment requirements into an array.
 *
 * @param paymentRequirements - A single requirement or a list of requirements.
 * @returns An array of payment requirements.
 */
export function normalizePaymentRequirements(
  paymentRequirements: PaymentRequirements | PaymentRequirements[],
): PaymentRequirements[] {
  if (Array.isArray(paymentRequirements)) {
    return paymentRequirements;
  }
  return [paymentRequirements];
}

/**
 * Returns the preferred networks to attempt first when selecting a payment requirement.
 *
 * @param testnet - Whether the paywall is operating in testnet mode.
 * @returns Ordered list of preferred networks (CAIP-2 format).
 */
export function getPreferredNetworks(testnet: boolean): string[] {
  if (testnet) {
    return [`eip155:${EVM_CHAIN_IDS.BASE_SEPOLIA}`, `solana:${SOLANA_NETWORK_REFS.DEVNET}`];
  }
  return [`eip155:${EVM_CHAIN_IDS.BASE_MAINNET}`, `solana:${SOLANA_NETWORK_REFS.MAINNET}`];
}

/**
 * Selects the most appropriate payment requirement for the user.
 *
 * @param paymentRequirements - All available payment requirements.
 * @param testnet - Whether the paywall is operating in testnet mode.
 * @returns The selected payment requirement.
 */
export function choosePaymentRequirement(
  paymentRequirements: PaymentRequirements | PaymentRequirements[],
  testnet: boolean,
): PaymentRequirements {
  const normalized = normalizePaymentRequirements(paymentRequirements);
  const preferredNetworks = getPreferredNetworks(testnet);

  // Try to find a requirement matching preferred networks
  for (const preferredNetwork of preferredNetworks) {
    const match = normalized.find(req => req.network === preferredNetwork);
    if (match) {
      return match;
    }
  }

  // Fall back to first requirement
  return normalized[0];
}

/**
 * Determines if the provided network is an EVM network.
 *
 * @param network - The network to check (CAIP-2 format: eip155:chainId).
 * @returns True if the network is EVM based.
 */
export function isEvmNetwork(network: string): boolean {
  return network.startsWith("eip155:");
}

/**
 * Determines if the provided network is an SVM network.
 *
 * @param network - The network to check (CAIP-2 format: solana:reference).
 * @returns True if the network is SVM based.
 */
export function isSvmNetwork(network: string): boolean {
  return network.startsWith("solana:");
}

/**
 * Determines if the provided network is an AVM (Algorand) network.
 *
 * @param network - The network to check (CAIP-2 format: algorand:genesisHash).
 * @returns True if the network is AVM based.
 */
export function isAvmNetwork(network: string): boolean {
  return network.startsWith("algorand:");
}

/**
 * Provides a human-readable display name for a network.
 * Uses x402's local EVM chain registry instead of viem/chains so the display
 * name is independent of the viem version pinned in the lockfile.
 *
 * @param network - The network identifier (CAIP-2 format).
 * @returns A display name suitable for UI use.
 */
export function getNetworkDisplayName(network: string): string {
  if (network.startsWith("eip155:")) {
    const chainId = parseInt(network.split(":")[1]);
    const chain = EVM_CHAIN_METADATA[chainId];

    if (chain) {
      return chain.name;
    }

    return `Chain ${chainId}`;
  }

  if (network.startsWith("solana:")) {
    const ref = network.split(":")[1];
    return ref === SOLANA_NETWORK_REFS.DEVNET ? "Solana Devnet" : "Solana Mainnet";
  }

  if (network.startsWith("algorand:")) {
    const ref = network.split(":")[1];
    return ref === ALGORAND_NETWORK_REFS.TESTNET ? "Algorand Testnet" : "Algorand Mainnet";
  }

  return network;
}

/**
 * Indicates whether the provided network is a testnet.
 * Uses x402's local EVM chain registry instead of viem's testnet flag.
 *
 * @param network - The network to evaluate (CAIP-2 format).
 * @returns True if the network is a recognized testnet.
 */
export function isTestnetNetwork(network: string): boolean {
  if (network.startsWith("eip155:")) {
    const chainId = parseInt(network.split(":")[1]);
    return EVM_CHAIN_METADATA[chainId]?.testnet ?? false;
  }

  if (network.startsWith("solana:")) {
    const ref = network.split(":")[1];
    return ref === SOLANA_NETWORK_REFS.DEVNET;
  }

  if (network.startsWith("algorand:")) {
    const ref = network.split(":")[1];
    return ref === ALGORAND_NETWORK_REFS.TESTNET;
  }

  return false;
}
