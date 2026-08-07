import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import type { Network } from "@x402/core/types";
import {
  SUI_DEVNET_CAIP2,
  SUI_FULLNODE_URLS,
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
} from "./constants";

/**
 * Map a CAIP-2 Sui network id to the SDK's network name.
 *
 * @param network - CAIP-2 network identifier (e.g. "sui:testnet")
 * @returns The SDK network name ("mainnet" | "testnet" | "devnet")
 */
export function getSuiNetworkName(network: Network): SuiClientTypes.Network {
  switch (network) {
    case SUI_MAINNET_CAIP2:
      return "mainnet";
    case SUI_TESTNET_CAIP2:
      return "testnet";
    case SUI_DEVNET_CAIP2:
      return "devnet";
    default:
      throw new Error(`Unsupported Sui network: ${network}`);
  }
}

/**
 * Normalize an ExactSuiPayload `signature` into a non-empty array of signature
 * strings. Returns null when malformed (undefined, an empty array, or a
 * non-string element).
 *
 * @param signature - The payload signature field (string | string[])
 * @returns A non-empty string array, or null when malformed
 */
export function normalizeSignatures(signature: unknown): string[] | null {
  const arr = typeof signature === "string" ? [signature] : signature;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (!arr.every((s): s is string => typeof s === "string")) return null;
  return arr;
}

/**
 * Resolves a Sui client for a CAIP-2 network id.
 */
export type SuiClientResolver = (network: Network) => ClientWithCoreApi;

/**
 * Create a client resolver from optional per-network overrides. Networks
 * without an override get a lazily constructed, cached gRPC client for the
 * default public fullnode.
 *
 * @param clients - Optional Sui clients keyed by CAIP-2 network id
 * @returns A resolver from CAIP-2 network id to a Sui client
 */
export function createSuiClientResolver(
  clients?: Record<string, ClientWithCoreApi>,
): SuiClientResolver {
  const defaults = new Map<string, ClientWithCoreApi>();

  return (network: Network): ClientWithCoreApi => {
    const override = clients?.[network];
    if (override) return override;

    const cached = defaults.get(network);
    if (cached) return cached;

    const client = new SuiGrpcClient({
      network: getSuiNetworkName(network),
      baseUrl: SUI_FULLNODE_URLS[network],
    });
    defaults.set(network, client);
    return client;
  };
}

/**
 * Decode a Base64 string into bytes; no size cap. Returns null for a non-string,
 * an empty value, or one that is not valid Base64.
 *
 * @param value - The Base64 value
 * @returns The decoded bytes, or null when malformed
 */
export function parseBase64Bytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const bytes = fromBase64(value);
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * The Base64 bytes of every `Pure` input, whether or not a command references it.
 * An optional server nonce may ride as an unused `Pure` input.
 *
 * @param data - The decoded transaction data (`Transaction.getData()`)
 * @returns The Base64 string of each Pure input
 */
export function pureInputsBase64(data: ReturnType<Transaction["getData"]>): string[] {
  const out: string[] = [];
  for (const input of data.inputs) {
    if (input.Pure?.bytes) out.push(input.Pure.bytes);
  }
  return out;
}

/**
 * Whether the transaction carries `nonceBase64` as a `Pure` input. Compares
 * Base64 strings directly — both sides are SDK-canonical — canonicalizing the
 * declared nonce once so a byte-equal value matches.
 *
 * @param data - The decoded transaction data (`Transaction.getData()`)
 * @param nonceBase64 - The declared server nonce (Base64)
 * @returns True when a Pure input equals the nonce
 */
export function transactionCarriesNonce(
  data: ReturnType<Transaction["getData"]>,
  nonceBase64: string,
): boolean {
  let canonical: string;
  try {
    canonical = toBase64(fromBase64(nonceBase64));
  } catch {
    return false;
  }
  return pureInputsBase64(data).includes(canonical);
}

/**
 * The exact-payment effects check: assert `payTo`'s net balance change in the
 * requested asset equals exactly `amount`. Recipient-credit-only — it does not
 * constrain the payer's debit or forbid other credits.
 *
 * @param balanceChanges - Balance changes from a simulation or executed transaction
 * @param asset - The required coin type
 * @param payTo - The declared recipient
 * @param amount - The exact atomic-unit amount the recipient must net
 * @returns A problem description, or null when the recipient nets exactly
 */
export function matchExactPayment(
  balanceChanges: readonly SuiClientTypes.BalanceChange[],
  asset: string,
  payTo: string,
  amount: string,
): string | null {
  const coinType = normalizeStructTag(asset);
  const recipient = normalizeSuiAddress(payTo);
  const want = BigInt(amount);

  // Sui emits at most one balance change per (coinType, address), so the
  // recipient's credit is a single entry, not a sum.
  const change = balanceChanges.find(
    c =>
      normalizeStructTag(c.coinType) === coinType && normalizeSuiAddress(c.address) === recipient,
  );
  const got = change ? BigInt(change.amount) : 0n;

  if (got !== want) {
    return `recipient ${payTo} credited ${got}, expected exactly ${want}`;
  }

  return null;
}
