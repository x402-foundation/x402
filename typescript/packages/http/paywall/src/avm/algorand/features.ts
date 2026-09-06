import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import type { Wallet } from "@wallet-standard/base";
import type { WalletWithAvmFeatures } from "./types";

/**
 * Feature identifier for Algorand transaction signing
 */
export const AlgorandSignTransaction = "algorand:signTransaction";

/**
 * Type guard ensuring the wallet implements Algorand signing features.
 *
 * @param wallet - Wallet instance to inspect.
 * @returns True when the wallet supports Algorand signing.
 */
export const hasAlgorandSigning = (wallet: Wallet): wallet is WalletWithAvmFeatures =>
  AlgorandSignTransaction in wallet.features;

/**
 * Extracts the Algorand transaction signing feature when present.
 *
 * @param wallet - Wallet that may expose the signing capability.
 * @returns The signing feature if available, otherwise undefined.
 */
export const getAlgorandSignTransactionFeature = (wallet: WalletWithAvmFeatures) =>
  wallet.features[AlgorandSignTransaction];

/**
 * Retrieves the standard connect feature from a wallet, if supported.
 *
 * @param wallet - Wallet under inspection.
 * @returns The connect feature when present.
 */
export const getStandardConnectFeature = (wallet: WalletWithAvmFeatures) =>
  (wallet.features as unknown as Partial<StandardConnectFeature>)[StandardConnect];

/**
 * Retrieves the standard events feature from a wallet, if supported.
 *
 * @param wallet - Wallet under inspection.
 * @returns The events feature when present.
 */
export const getStandardEventsFeature = (wallet: WalletWithAvmFeatures) =>
  (wallet.features as unknown as Partial<StandardEventsFeature>)[StandardEvents];

/**
 * Retrieves the standard disconnect feature from a wallet, if supported.
 *
 * @param wallet - Wallet under inspection.
 * @returns The disconnect feature when present.
 */
export const getStandardDisconnectFeature = (wallet: WalletWithAvmFeatures) =>
  (wallet.features as unknown as Partial<StandardDisconnectFeature>)[StandardDisconnect];

export type { StandardEventsChangeProperties } from "@wallet-standard/features";
