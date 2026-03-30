import type { PaymentPayload } from "@x402/core/types";
import type { FacilitatorEvmSigner } from "../signer";

export const EIP2612_GAS_SPONSORING_KEY = "eip2612GasSponsoring" as const;
export const ERC20_APPROVAL_GAS_SPONSORING_KEY = "erc20ApprovalGasSponsoring" as const;
export const ERC20_APPROVAL_GAS_SPONSORING_VERSION = "1" as const;

export interface Eip2612GasSponsoringInfo {
  [key: string]: unknown;
  from: string;
  asset: string;
  spender: string;
  amount: string;
  nonce: string;
  deadline: string;
  signature: string;
  version: string;
}

export interface Erc20ApprovalGasSponsoringInfo {
  [key: string]: unknown;
  from: `0x${string}`;
  asset: `0x${string}`;
  spender: `0x${string}`;
  amount: string;
  signedTransaction: `0x${string}`;
  version: string;
}

/**
 * A single transaction to be executed by the signer.
 * - `0x${string}`: a pre-signed serialized transaction (broadcast as-is via sendRawTransaction)
 * - `{ to, data, gas? }`: an unsigned call intent (signer signs and broadcasts)
 */
export type TransactionRequest =
  | `0x${string}`
  | { to: `0x${string}`; data: `0x${string}`; gas?: bigint };

export type Erc20ApprovalGasSponsoringSigner = FacilitatorEvmSigner & {
  sendTransactions(transactions: TransactionRequest[]): Promise<`0x${string}`[]>;
  simulateTransactions?(transactions: TransactionRequest[]): Promise<boolean>;
};

export interface Erc20ApprovalGasSponsoringFacilitatorExtension {
  key: typeof ERC20_APPROVAL_GAS_SPONSORING_KEY;
  signer?: Erc20ApprovalGasSponsoringSigner;
  signerForNetwork?: (network: string) => Erc20ApprovalGasSponsoringSigner | undefined;
}

/**
 * Extracts a typed `info` payload from an extension entry.
 *
 * @param payload - Payment payload containing optional extensions.
 * @param extensionKey - Extension key to extract.
 * @returns The extension `info` object when present; otherwise null.
 */
function _extractInfo(
  payload: PaymentPayload,
  extensionKey: string,
): Record<string, unknown> | null {
  const extensions = payload.extensions;
  if (!extensions) return null;
  const extension = extensions[extensionKey] as { info?: Record<string, unknown> } | undefined;
  if (!extension?.info) return null;
  return extension.info;
}

/**
 * Extracts and validates required EIP-2612 gas sponsoring fields.
 *
 * @param payload - Payment payload returned by the client scheme.
 * @returns Parsed EIP-2612 gas sponsoring info when available and complete.
 */
export function extractEip2612GasSponsoringInfo(
  payload: PaymentPayload,
): Eip2612GasSponsoringInfo | null {
  const info = _extractInfo(payload, EIP2612_GAS_SPONSORING_KEY);
  if (!info) return null;
  if (
    !info.from ||
    !info.asset ||
    !info.spender ||
    !info.amount ||
    !info.nonce ||
    !info.deadline ||
    !info.signature ||
    !info.version
  ) {
    return null;
  }
  return info as unknown as Eip2612GasSponsoringInfo;
}

/**
 * Validates the structure and formatting of EIP-2612 sponsoring info.
 *
 * @param info - EIP-2612 extension info to validate.
 * @returns True when all required fields match expected patterns.
 */
export function validateEip2612GasSponsoringInfo(info: Eip2612GasSponsoringInfo): boolean {
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const numericPattern = /^[0-9]+$/;
  const hexPattern = /^0x[a-fA-F0-9]+$/;
  const versionPattern = /^[0-9]+(\.[0-9]+)*$/;
  return (
    addressPattern.test(info.from) &&
    addressPattern.test(info.asset) &&
    addressPattern.test(info.spender) &&
    numericPattern.test(info.amount) &&
    numericPattern.test(info.nonce) &&
    numericPattern.test(info.deadline) &&
    hexPattern.test(info.signature) &&
    versionPattern.test(info.version)
  );
}

/**
 * Extracts and validates required ERC-20 approval sponsoring fields.
 *
 * @param payload - Payment payload returned by the client scheme.
 * @returns Parsed ERC-20 approval sponsoring info when available and complete.
 */
export function extractErc20ApprovalGasSponsoringInfo(
  payload: PaymentPayload,
): Erc20ApprovalGasSponsoringInfo | null {
  const info = _extractInfo(payload, ERC20_APPROVAL_GAS_SPONSORING_KEY);
  if (!info) return null;
  if (
    !info.from ||
    !info.asset ||
    !info.spender ||
    !info.amount ||
    !info.signedTransaction ||
    !info.version
  ) {
    return null;
  }
  return info as unknown as Erc20ApprovalGasSponsoringInfo;
}

/**
 * Validates the structure and formatting of ERC-20 approval sponsoring info.
 *
 * @param info - ERC-20 approval extension info to validate.
 * @returns True when all required fields match expected patterns.
 */
export function validateErc20ApprovalGasSponsoringInfo(
  info: Erc20ApprovalGasSponsoringInfo,
): boolean {
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  const numericPattern = /^[0-9]+$/;
  const hexPattern = /^0x[a-fA-F0-9]+$/;
  const versionPattern = /^[0-9]+(\.[0-9]+)*$/;
  return (
    addressPattern.test(info.from) &&
    addressPattern.test(info.asset) &&
    addressPattern.test(info.spender) &&
    numericPattern.test(info.amount) &&
    hexPattern.test(info.signedTransaction) &&
    versionPattern.test(info.version)
  );
}

/**
 * Resolves the ERC-20 approval extension signer for a specific network.
 *
 * @param extension - Optional facilitator extension config.
 * @param network - CAIP-2 network identifier.
 * @returns A network-specific signer when available, else the default signer.
 */
export function resolveErc20ApprovalExtensionSigner(
  extension: Erc20ApprovalGasSponsoringFacilitatorExtension | undefined,
  network: string,
): Erc20ApprovalGasSponsoringSigner | undefined {
  if (!extension) return undefined;
  return extension.signerForNetwork?.(network) ?? extension.signer;
}
