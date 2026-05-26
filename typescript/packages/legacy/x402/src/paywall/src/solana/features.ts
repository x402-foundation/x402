import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
  type WalletWithSolanaFeatures,
} from "@solana/wallet-standard-features";
import type { Wallet } from "@wallet-standard/base";

/**
 * Type guard ensuring the wallet implements the Solana signing features.
 *
 * @param wallet - Wallet instance to inspect.
 * @returns True when the wallet supports Solana signing.
 */
export const hasSolanaSigning = (wallet: Wallet): wallet is WalletWithSolanaFeatures =>
  SolanaSignTransaction in wallet.features;

/**
 * Extracts the Solana transaction signing feature when present.
 *
 * @param wallet - Wallet that may expose the signing capability.
 * @returns The signing feature if available, otherwise undefined.
 */
export const getSolanaSignTransactionFeature = (wallet: WalletWithSolanaFeatures) =>
  (wallet.features as unknown as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction];

/**
 * Retrieves the standard connect feature from a wallet, if supported.
 *
 * @param wallet - Wallet under inspection.
 * @returns The connect feature when present.
 */
export const getStandardConnectFeature = (wallet: WalletWithSolanaFeatures) =>
  (wallet.features as unknown as Partial<StandardConnectFeature>)[StandardConnect];

/**
 * Retrieves the standard events feature from a wallet, if supported.
 *
 * @param wallet - Wallet under inspection.
 * @returns The events feature when present.
 */
export const getStandardEventsFeature = (wallet: WalletWithSolanaFeatures) =>
  (wallet.features as unknown as Partial<StandardEventsFeature>)[StandardEvents];

/**
 * Retrieves the standard disconnect feature from a wallet, if supported.
 *
 * @param wallet - Wallet under inspection.
 * @returns The disconnect feature when present.
 */
export const getStandardDisconnectFeature = (wallet: WalletWithSolanaFeatures) =>
  (wallet.features as unknown as Partial<StandardDisconnectFeature>)[StandardDisconnect];

export type { StandardEventsChangeProperties } from "@wallet-standard/features";
