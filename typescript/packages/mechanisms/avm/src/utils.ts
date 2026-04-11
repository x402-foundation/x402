/**
 * AVM (Algorand) Utilities for x402 Payment Protocol
 *
 * Provides utility functions for Algod client creation, transaction encoding/decoding,
 * address validation, and network identification.
 */

import {
  decodeTransaction as decodeUnsignedTxn,
  decodeSignedTransaction as decodeSignedTxn,
} from "@algorandfoundation/algokit-utils/transact";
import { isValidAddress } from "@algorandfoundation/algokit-utils/common";
import {
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  ALGORAND_TESTNET_CAIP2,
} from "./constants";

/**
 * Encodes transaction bytes to base64 string
 *
 * @param txn - Transaction bytes (Uint8Array)
 * @returns Base64 encoded string
 */
export function encodeTransaction(txn: Uint8Array): string {
  return Buffer.from(txn).toString("base64");
}

/**
 * Decodes a base64 encoded transaction to bytes
 *
 * @param encoded - Base64 encoded transaction string
 * @returns Transaction bytes (Uint8Array)
 */
export function decodeTransaction(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

/**
 * Decodes a signed transaction from base64 msgpack
 *
 * @param encoded - Base64 encoded signed transaction
 * @returns Decoded signed transaction object
 */
export function decodeSignedTransaction(encoded: string) {
  const bytes = decodeTransaction(encoded);
  return decodeSignedTxn(bytes);
}

/**
 * Decodes an unsigned transaction from base64 msgpack
 *
 * @param encoded - Base64 encoded unsigned transaction
 * @returns Decoded transaction object
 */
export function decodeUnsignedTransaction(encoded: string) {
  const bytes = decodeTransaction(encoded);
  return decodeUnsignedTxn(bytes);
}

/**
 * Validates an Algorand address
 *
 * Uses isValidAddress from algokit-utils which performs full checksum validation.
 *
 * @param address - The address to validate
 * @returns True if the address is valid
 */
export function isValidAlgorandAddress(address: string): boolean {
  return isValidAddress(address);
}

/**
 * Gets the sender address from a transaction (signed or unsigned)
 *
 * @param txnBytes - Transaction bytes
 * @param isSigned - Whether the transaction is signed (default: true)
 * @returns Sender address string
 */
export function getSenderFromTransaction(txnBytes: Uint8Array, isSigned: boolean = true): string {
  if (isSigned) {
    const signedTxn = decodeSignedTxn(txnBytes);
    return signedTxn.txn.sender.toString();
  }
  const txn = decodeUnsignedTxn(txnBytes);
  return txn.sender.toString();
}

/**
 * Converts a decimal amount to atomic units (token's smallest unit)
 *
 * @param decimalAmount - The decimal amount as a string (e.g., "1.50")
 * @param decimals - Number of decimal places (e.g., 6 for USDC)
 * @returns Amount in atomic units as a string
 *
 * @example
 * ```typescript
 * convertToTokenAmount("1.50", 6) // Returns "1500000"
 * convertToTokenAmount("0.10", 6) // Returns "100000"
 * ```
 */
export function convertToTokenAmount(decimalAmount: string, decimals: number): string {
  const amount = parseFloat(decimalAmount);
  if (isNaN(amount)) {
    throw new Error(`Invalid amount: ${decimalAmount}`);
  }

  // Handle decimal conversion properly
  const [intPart, decPart = ""] = String(amount).split(".");
  const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
  const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";

  return tokenAmount;
}

/**
 * Converts atomic units to decimal amount
 *
 * @param atomicAmount - Amount in atomic units (string or bigint)
 * @param decimals - Number of decimal places
 * @returns Decimal amount as a string
 */
export function convertFromTokenAmount(atomicAmount: string | bigint, decimals: number): string {
  const amount = BigInt(atomicAmount);
  const divisor = BigInt(10 ** decimals);
  const intPart = amount / divisor;
  const decPart = amount % divisor;

  if (decPart === BigInt(0)) {
    return intPart.toString();
  }

  const decStr = decPart.toString().padStart(decimals, "0");
  // Remove trailing zeros
  const trimmedDec = decStr.replace(/0+$/, "");
  return `${intPart}.${trimmedDec}`;
}

/**
 * Gets the network type from a CAIP-2 identifier
 *
 * @param caip2 - CAIP-2 network identifier
 * @returns Network type ("mainnet" | "testnet") or null if unknown
 */
export function getNetworkFromCaip2(caip2: string): "mainnet" | "testnet" | null {
  if (!caip2.startsWith("algorand:")) {
    return null;
  }

  const genesisHash = caip2.slice("algorand:".length);

  if (genesisHash === ALGORAND_MAINNET_GENESIS_HASH) {
    return "mainnet";
  }
  if (genesisHash === ALGORAND_TESTNET_GENESIS_HASH) {
    return "testnet";
  }

  return null;
}

/**
 * Checks if a network identifier is an Algorand network
 *
 * @param network - Network identifier (CAIP-2 format)
 * @returns True if the network is an Algorand network
 */
export function isAlgorandNetwork(network: string): boolean {
  return network.startsWith("algorand:");
}

/**
 * Checks if a network identifier is a testnet
 *
 * @param network - Network identifier (CAIP-2 format)
 * @returns True if the network is a testnet
 */
export function isTestnetNetwork(network: string): boolean {
  return network === ALGORAND_TESTNET_CAIP2;
}

/**
 * Gets the genesis hash from a transaction
 *
 * @param txn - The transaction object
 * @param txn.genesisHash - The genesis hash bytes
 * @returns Base64 encoded genesis hash
 */
export function getGenesisHashFromTransaction(txn: { genesisHash?: Uint8Array }): string {
  if (!txn.genesisHash) {
    throw new Error("Transaction does not have a genesis hash");
  }
  return Buffer.from(txn.genesisHash).toString("base64");
}

/**
 * Validates that all transactions in a group have the same group ID
 *
 * @param txns - Array of transaction bytes
 * @returns True if all transactions have matching group IDs
 */
export function validateGroupId(txns: Uint8Array[]): boolean {
  if (txns.length <= 1) {
    return true;
  }

  let expectedGroupId: string | null = null;

  for (const txnBytes of txns) {
    const txn = decodeUnsignedTxn(txnBytes);
    const groupId = txn.group ? Buffer.from(txn.group).toString("base64") : null;

    if (expectedGroupId === null) {
      expectedGroupId = groupId;
    } else if (groupId !== expectedGroupId) {
      return false;
    }
  }

  return true;
}

/**
 * Extracts the transaction ID from signed transaction bytes
 *
 * @param signedTxnBytes - Signed transaction bytes
 * @returns Transaction ID string
 */
export function getTransactionId(signedTxnBytes: Uint8Array): string {
  const signedTxn = decodeSignedTxn(signedTxnBytes);
  return signedTxn.txn.txId();
}

/**
 * Checks if a signed transaction has a valid signature
 *
 * @param signedTxnBytes - Signed transaction bytes
 * @returns True if the transaction has a signature
 */
export function hasSignature(signedTxnBytes: Uint8Array): boolean {
  const signedTxn = decodeSignedTxn(signedTxnBytes);
  return (
    signedTxn.sig !== undefined || signedTxn.lsig !== undefined || signedTxn.msig !== undefined
  );
}

// Re-export algokit-utils types that consumers may need
export { Address, encodeAddress, decodeAddress } from "@algorandfoundation/algokit-utils/common";
