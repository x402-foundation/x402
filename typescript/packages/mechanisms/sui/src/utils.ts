// Portions copyright 2026 Danny Devs (https://github.com/Danny-Devs/x402-sui), Apache-2.0

import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { BalanceChange } from "@mysten/sui/jsonRpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { Network, PaymentRequirements } from "@x402/core/types";
import type { SuiOutput } from "./types";
import {
  SUI_ADDRESS_REGEX,
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
  SUI_DEVNET_CAIP2,
  MAINNET_RPC_URL,
  TESTNET_RPC_URL,
  DEVNET_RPC_URL,
} from "./constants";

/**
 * Create a gRPC Sui client for the specified network. The facilitator uses this
 * for `simulateTransaction` (verification), `executeTransaction` (settlement),
 * `getTransaction` (the replay guard), and `waitForTransaction`. gRPC is the
 * transport where the gasless Address-Balance path resolves, and the only one
 * Mysten's public fullnodes still serve (the JSON-RPC endpoints are retired).
 *
 * @param network - CAIP-2 network identifier (e.g., "sui:testnet")
 * @param customRpcUrl - Optional custom gRPC base URL override
 * @returns SuiGrpcClient configured for the specified network
 */
export function createSuiClient(network: Network, customRpcUrl?: string): SuiGrpcClient {
  const ref = suiNetworkRef(network);
  const baseUrl =
    customRpcUrl ??
    { mainnet: MAINNET_RPC_URL, testnet: TESTNET_RPC_URL, devnet: DEVNET_RPC_URL }[ref];
  return new SuiGrpcClient({ network: ref, baseUrl });
}

/**
 * Map a CAIP-2 Sui network id to the SDK's network reference.
 *
 * @param network - CAIP-2 network identifier (e.g., "sui:testnet")
 * @returns The SDK network ref ("mainnet" | "testnet" | "devnet")
 */
export function suiNetworkRef(network: Network): "mainnet" | "testnet" | "devnet" {
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
 * Validate a fully zero-padded Sui address (0x + 64 hex chars). Short-form
 * addresses like "0x2" must be normalized to full length first.
 *
 * @param address - Hex-encoded Sui address
 * @returns true if the address matches the full-length format
 */
export function validateSuiAddress(address: string): boolean {
  return SUI_ADDRESS_REGEX.test(address);
}

/**
 * Compare two Sui coin types for equality after normalization (leading zeros,
 * casing, formatting).
 *
 * @param a - First coin type
 * @param b - Second coin type
 * @returns true if the coin types are equivalent
 */
export function coinTypesEqual(a: string, b: string): boolean {
  return normalizeStructTag(a) === normalizeStructTag(b);
}

/**
 * Convert a decimal amount string to a token's smallest units. Uses toFixed to
 * avoid scientific notation (e.g. 1e-7) leaking into the result.
 *
 * @param decimalAmount - The decimal amount (e.g., "0.10")
 * @param decimals - The number of decimals for the token (e.g., 6 for USDC)
 * @returns The amount in smallest units as a string
 */
export function convertToTokenAmount(decimalAmount: string, decimals: number): string {
  const trimmed = decimalAmount.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(`Negative amounts not allowed: ${decimalAmount}`);
  }
  const amount = parseFloat(trimmed);
  if (isNaN(amount)) {
    throw new Error(`Invalid amount: ${decimalAmount}`);
  }
  const [intPart, decPart = ""] = amount.toFixed(decimals).split(".");
  const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
  const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";
  return tokenAmount;
}

/**
 * Resolve the declared outputs of a requirements object: the explicit
 * `extra.outputs` when present, otherwise the implicit single output
 * `[{ to: payTo, amount }]`.
 *
 * @param requirements - The payment requirements
 * @returns The ordered list of declared `{ to, amount }` outputs
 */
export function outputsOf(requirements: PaymentRequirements): SuiOutput[] {
  const declared = requirements.extra?.outputs as SuiOutput[] | undefined;
  if (Array.isArray(declared) && declared.length > 0) {
    return declared;
  }
  return [{ to: requirements.payTo, amount: requirements.amount }];
}

/**
 * Extract the AddressOwner of a `BalanceChange.owner`. Only AddressOwner credits
 * count as payment recipients; ObjectOwner / Shared / Immutable are ignored.
 *
 * @param owner - The owner field from a BalanceChange
 * @returns The address string, or "" when not an AddressOwner
 */
export function addressOwnerOf(owner: BalanceChange["owner"]): string {
  if (owner && typeof owner === "object" && "AddressOwner" in owner) {
    return owner.AddressOwner;
  }
  return "";
}

/**
 * The exact-fee matcher. Given simulation `balanceChanges`, the asset, the
 * declared outputs, and the payer, return the list of problems (empty = clean):
 *   - every declared output is credited EXACTLY its amount (AddressOwner only),
 *   - no UNDECLARED address receives any of the asset (the skim cheat-vector),
 *   - the payer is debited EXACTLY the sum of the declared outputs.
 *
 * This is the V2 Sui scheme's heart: the exact-fee, no-skim balance-change check.
 *
 * @param balanceChanges - The asset balance changes from a dry-run/simulation
 * @param asset - The required coin type
 * @param outputs - The declared `{ to, amount }` outputs
 * @param payer - The payer (signer) address
 * @returns A list of mismatch descriptions; empty when the split matches exactly
 */
export function matchBalanceChanges(
  balanceChanges: readonly BalanceChange[],
  asset: string,
  outputs: SuiOutput[],
  payer: string,
): string[] {
  const net = new Map<string, bigint>();
  for (const bc of balanceChanges) {
    if (!coinTypesEqual(bc.coinType, asset)) continue;
    const address = addressOwnerOf(bc.owner);
    if (!address) continue; // skip non-AddressOwner changes
    const key = address.toLowerCase();
    net.set(key, (net.get(key) ?? 0n) + BigInt(bc.amount));
  }

  const problems: string[] = [];
  let total = 0n;
  const declared = new Set<string>();
  for (const o of outputs) {
    const key = o.to.toLowerCase();
    declared.add(key);
    const got = net.get(key) ?? 0n;
    const want = BigInt(o.amount);
    if (got !== want) problems.push(`output ${o.to.slice(0, 12)}… expected +${want} got ${got}`);
    total += want;
  }

  // No UNDECLARED positive recipient of the asset.
  for (const [addr, delta] of net) {
    if (addr === payer.toLowerCase()) continue;
    if (delta > 0n && !declared.has(addr)) {
      problems.push(`undeclared recipient ${addr.slice(0, 12)}… received +${delta}`);
    }
  }

  // The payer is debited EXACTLY the total of the declared outputs.
  const payerDelta = net.get(payer.toLowerCase()) ?? 0n;
  if (payerDelta !== -total) problems.push(`payer expected -${total} got ${payerDelta}`);

  return problems;
}
