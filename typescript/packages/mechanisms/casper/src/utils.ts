import type { Network } from "@x402/core/types";
import { buildDomain, CASPER_DOMAIN_TYPES, hashTypedData } from "@casper-ecosystem/casper-eip-712";
import { NetworkConfigs } from "./constants";
import type { ExactCasperAuthorization } from "./types";
import casperSdk from "casper-js-sdk";

const { Conversions } = casperSdk;

/**
 * Casper address regex. "00" is account-hash and "01" is package hash.
 */
export const CASPER_ADDRESS_REGEX = /^(00|01)[0-9a-fA-F]{64}$/;

/**
 * Casper contract package hashes are 32-byte hex strings with no prefix.
 */
export const CONTRACT_PACKAGE_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/**
 * Encode bytes as lowercase hex without a prefix.
 *
 * @param bytes - Bytes to encode.
 * @returns Hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Conversions.encodeBase16(bytes).toLowerCase();
}

/**
 * Decode a hex string into bytes.
 *
 * @param hex - Hex string, with or without "0x" prefix.
 * @returns Decoded bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error("hex string must have an even number of characters");
  }
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) {
    throw new Error("hex string contains non-hex characters");
  }
  return Conversions.decodeBase16(cleaned);
}

/**
 * Check whether a string is a valid Casper address.
 *
 * @param value - Value to validate.
 * @returns True when the value is a valid Casper address.
 */
export function isValidCasperAddress(value: string): boolean {
  return CASPER_ADDRESS_REGEX.test(value);
}

/**
 * Check whether a string is a valid contract package hash.
 *
 * @param value - Value to validate.
 * @returns True when the value is a valid package hash.
 */
export function isValidContractPackageHash(value: string): boolean {
  return CONTRACT_PACKAGE_HASH_REGEX.test(value);
}

/**
 * Extract the chain name portion from a Casper CAIP-2 identifier.
 *
 * @param network - CAIP-2 network identifier.
 * @returns Chain name.
 */
export function chainNameFromNetwork(network: string): string {
  const parts = network.split(":");
  return parts.length === 2 ? parts[1] : network;
}

/**
 * Look up default network config.
 *
 * @param network - CAIP-2 network identifier.
 * @returns Network config.
 */
export function getNetworkConfig(network: string) {
  const config = NetworkConfigs[network];
  if (!config) {
    throw new Error(`unsupported Casper network: ${network}`);
  }
  return config;
}

/**
 * Check canonical low-s form for Casper secp256k1 signatures.
 *
 * @param signature - Signature bytes with Casper algorithm tag.
 * @returns True when canonical or when not a secp256k1 signature.
 */
export function isCanonicalSecp256k1Signature(signature: Uint8Array): boolean {
  if (signature[0] !== 0x02) {
    return true;
  }
  if (signature.length !== 65) {
    return false;
  }
  const s = BigInt(`0x${bytesToHex(signature.slice(33, 65))}`);
  return s <= SECP256K1_HALF_ORDER;
}

/**
 * Build the CEP-3009 EIP-712 digest for transfer_with_authorization.
 *
 * @param params - Digest input fields.
 * @param params.name - Token name.
 * @param params.version - Token domain version.
 * @param params.network - Casper CAIP-2 network.
 * @param params.asset - Contract package hash.
 * @param params.authorization - Authorization fields.
 * @returns 32-byte digest.
 */
export function buildTransferWithAuthorizationDigest(params: {
  name: string;
  version: string;
  network: Network;
  asset: string;
  authorization: ExactCasperAuthorization;
}): Uint8Array {
  const domain = buildDomain(params.name, params.version, params.network, `0x${params.asset}`);
  const message = {
    from: `0x${params.authorization.from}`,
    to: `0x${params.authorization.to}`,
    value: BigInt(params.authorization.value),
    validAfter: BigInt(params.authorization.validAfter),
    validBefore: BigInt(params.authorization.validBefore),
    nonce: `0x${params.authorization.nonce}`,
  };

  return hashTypedData(
    domain,
    transferWithAuthorizationTypes,
    "TransferWithAuthorization",
    message,
    {
      domainTypes: CASPER_DOMAIN_TYPES,
    },
  );
}
