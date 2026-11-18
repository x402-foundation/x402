import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner, SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";
import { STELLAR_TESTNET_CAIP2 } from "./constants";
import { getNetworkPassphrase } from "./utils";
import type { Network } from "@x402/core/types";

/**
 * Ed25519 signer for Stellar transactions and auth entries.
 *
 * Implements SEP-43 interface (except signMessage).
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
 */
export type Ed25519Signer = {
  address: string;
  signAuthEntry: SignAuthEntry;
  signTransaction: SignTransaction;
};

/**
 * Facilitator signer for Stellar transactions.
 *
 * Alias for Ed25519Signer. Used by x402 facilitators to verify and settle payments.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
 */
export type FacilitatorStellarSigner = Ed25519Signer;

/**
 * Client signer for Stellar transactions.
 *
 * Used by x402 clients to sign auth entries. Supports both classic (G) and contract (C) accounts.
 * signTransaction is optional for client signers.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
 */
export type ClientStellarSigner = {
  address: string;
  signAuthEntry: SignAuthEntry;
  signTransaction?: SignTransaction;
};

/**
 * Creates an Ed25519 signer for the given Stellar network.
 *
 * @param privateKey - Stellar classic (G) account private key
 * @param defaultNetwork - Is the network the signTransactiopn method will default to if no network is provided. Must use the CAIP-2 format identifier.
 * @returns Ed25519 signer implementing SEP-43 interface (except signMessage)
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
 */
export function createEd25519Signer(
  privateKey: string,
  defaultNetwork: Network = STELLAR_TESTNET_CAIP2,
): Ed25519Signer {
  const kp = Keypair.fromSecret(privateKey);
  const networkPassphrase = getNetworkPassphrase(defaultNetwork);

  const address = kp.publicKey();
  const { signAuthEntry, signTransaction } = basicNodeSigner(kp, networkPassphrase);

  return {
    address,
    signAuthEntry,
    signTransaction,
  };
}

/**
 * Type guard for FacilitatorStellarSigner.
 *
 * Checks for required methods: address, signAuthEntry, signTransaction.
 *
 * @param signer - Value to check
 * @returns `true` if signer is a FacilitatorStellarSigner
 */
export function isFacilitatorStellarSigner(signer: unknown): signer is FacilitatorStellarSigner {
  if (typeof signer !== "object" || signer === null) return false;
  const s = signer as Record<string, unknown>;
  return (
    typeof s.address === "string" &&
    typeof s.signAuthEntry === "function" &&
    typeof s.signTransaction === "function"
  );
}

/**
 * Type guard for ClientStellarSigner.
 *
 * Checks for required methods: address, signAuthEntry. signTransaction is optional.
 *
 * @param signer - Value to check
 * @returns `true` if signer is a ClientStellarSigner
 */
export function isClientStellarSigner(signer: unknown): signer is ClientStellarSigner {
  if (typeof signer !== "object" || signer === null) return false;
  const s = signer as Record<string, unknown>;
  return (
    typeof s.address === "string" &&
    typeof s.signAuthEntry === "function" &&
    (s.signTransaction === undefined || typeof s.signTransaction === "function")
  );
}
