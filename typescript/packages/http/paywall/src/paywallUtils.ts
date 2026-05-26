import type { PaymentRequirements } from "@x402/core/types";
import * as allChains from "viem/chains";

// Chain configuration constants

// EVM Chain IDs (CAIP-2 format: eip155:chainId)
// Only chains we explicitly reference in code
export const EVM_CHAIN_IDS = {
  BASE_MAINNET: "8453",
  BASE_SEPOLIA: "84532",
} as const;

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
 * Uses viem/chains for EVM chain metadata (based on ethereum-lists/chains).
 * See: https://github.com/ethereum-lists/chains
 *
 * @param network - The network identifier (CAIP-2 format).
 * @returns A display name suitable for UI use.
 */
export function getNetworkDisplayName(network: string): string {
  if (network.startsWith("eip155:")) {
    const chainId = parseInt(network.split(":")[1]);

    // Find matching chain in viem's chain definitions
    const chain = Object.values(allChains).find(c => c.id === chainId);

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
 * Uses viem's testnet property for EVM chains.
 *
 * @param network - The network to evaluate (CAIP-2 format).
 * @returns True if the network is a recognized testnet.
 */
export function isTestnetNetwork(network: string): boolean {
  if (network.startsWith("eip155:")) {
    const chainId = parseInt(network.split(":")[1]);
    const chain = Object.values(allChains).find(c => c.id === chainId);
    return chain?.testnet ?? false;
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
