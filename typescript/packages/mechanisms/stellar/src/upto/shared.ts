import { StrKey } from "@stellar/stellar-sdk";
import { UPTO_DEPLOYMENTS } from "./constants";

/** Largest value of a Soroban `i128`. */
export const I128_MAX = (1n << 127n) - 1n;

export const isAccountAddress = (value: unknown): value is string =>
  typeof value === "string" && StrKey.isValidEd25519PublicKey(value);

export const isContractAddress = (value: unknown): value is string =>
  typeof value === "string" && StrKey.isValidContract(value);

export const isMuxedAddress = (value: unknown): value is string =>
  typeof value === "string" && StrKey.isValidMed25519PublicKey(value);

export const isAccountOrContract = (value: unknown): value is string =>
  isAccountAddress(value) || isContractAddress(value);

/**
 * Parses a canonical non-negative integer string that fits an `i128`.
 *
 * @param value - The amount
 * @returns The amount, or `undefined` for anything else
 */
export function parseAtomicAmount(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,38})$/.test(value)) return undefined;
  const amount = BigInt(value);
  return amount <= I128_MAX ? amount : undefined;
}

/**
 * The settlement contract of a network: the configured one, or the canonical deployment.
 *
 * @param network - CAIP-2 network
 * @param contracts - Contract addresses by network
 * @returns The contract address, or `undefined` when the network has none
 */
export function resolveUptoContract(
  network: string,
  contracts?: Readonly<Record<string, string>>,
): string | undefined {
  return contracts?.[network] ?? UPTO_DEPLOYMENTS[network]?.address;
}
