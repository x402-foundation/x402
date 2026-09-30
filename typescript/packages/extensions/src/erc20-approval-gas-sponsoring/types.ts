/**
 * Type definitions for the ERC-20 Approval Gas Sponsoring Extension
 *
 * This extension enables gasless Permit2 approval for generic ERC-20 tokens
 * that do NOT implement EIP-2612. The client signs (but does not broadcast) a
 * raw `approve(Permit2, MaxUint256)` transaction, and the facilitator broadcasts
 * it atomically before settling the Permit2 payment.
 */

import type { FacilitatorExtension } from "@x402/core/types";

/**
 * A single transaction to be executed by the signer.
 * - `0x${string}`: a pre-signed serialized transaction (broadcast as-is via sendRawTransaction)
 * - `{ to, data, gas? }`: an unsigned call intent (signer signs and broadcasts)
 */
export type TransactionRequest =
  | `0x${string}`
  | { to: `0x${string}`; data: `0x${string}`; gas?: bigint };

/**
 * Signer capability carried by the ERC-20 approval extension when registered in a facilitator.
 *
 * Mirrors FacilitatorEvmSigner (from @x402/evm) plus `sendTransactions`.
 * The signer owns execution of multiple transactions, enabling production implementations
 * to bundle them atomically (e.g., Flashbots, multicall, smart account batching)
 * while simpler implementations can execute them sequentially.
 *
 * The method signatures are duplicated here (rather than extending FacilitatorEvmSigner)
 * to avoid a circular dependency between @x402/extensions and @x402/evm.
 */
export interface Erc20ApprovalGasSponsoringSigner {
  getAddresses(): readonly `0x${string}`[];
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  verifyTypedData(args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }): Promise<boolean>;
  writeContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    gas?: bigint;
  }): Promise<`0x${string}`>;
  sendTransaction(args: { to: `0x${string}`; data: `0x${string}` }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string }>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  sendTransactions(transactions: TransactionRequest[]): Promise<`0x${string}`[]>;
}

/**
 * Extension identifier for the ERC-20 approval gas sponsoring extension.
 */
export const ERC20_APPROVAL_GAS_SPONSORING = {
  key: "erc20ApprovalGasSponsoring",
} as const satisfies FacilitatorExtension;

/** Current schema version for the ERC-20 approval gas sponsoring extension info. */
export const ERC20_APPROVAL_GAS_SPONSORING_VERSION = "1";

/**
 * Extended extension object registered in a facilitator via registerExtension().
 * Carries the signer that owns the full approve+settle flow for ERC-20 tokens
 * that lack EIP-2612.
 *
 * @example
 * ```typescript
 * import { createErc20ApprovalGasSponsoringExtension } from '@x402/extensions';
 *
 * facilitator.registerExtension(
 *   createErc20ApprovalGasSponsoringExtension(signer),
 * );
 * ```
 */
export interface Erc20ApprovalGasSponsoringFacilitatorExtension extends FacilitatorExtension {
  key: "erc20ApprovalGasSponsoring";
  /** Default signer with approve+settle capability. Optional — settlement fails gracefully if absent. */
  signer?: Erc20ApprovalGasSponsoringSigner;
  /** Network-specific signer resolver. Takes precedence over `signer` when provided. */
  signerForNetwork?: (network: string) => Erc20ApprovalGasSponsoringSigner | undefined;
}

/**
 * Base signer shape without `sendTransactions`.
 * Matches the FacilitatorEvmSigner shape from @x402/evm (duplicated to avoid circular dep).
 */
export type Erc20ApprovalGasSponsoringBaseSigner = Omit<
  Erc20ApprovalGasSponsoringSigner,
  "sendTransactions"
>;

/**
 * Create an ERC-20 approval gas sponsoring extension ready to register in a facilitator.
 *
 * @param signer - A complete signer with `sendTransactions` already implemented.
 *   The signer decides how to execute the transactions (sequentially, batched, or atomically).
 * @param signerForNetwork - Optional network-specific signer resolver. When provided,
 *   takes precedence over `signer` and allows different settlement signers per network.
 * @returns A fully configured extension to pass to `facilitator.registerExtension()`
 */
export function createErc20ApprovalGasSponsoringExtension(
  signer: Erc20ApprovalGasSponsoringSigner,
  signerForNetwork?: (network: string) => Erc20ApprovalGasSponsoringSigner | undefined,
): Erc20ApprovalGasSponsoringFacilitatorExtension {
  return { ...ERC20_APPROVAL_GAS_SPONSORING, signer, signerForNetwork };
}

/**
 * ERC-20 approval gas sponsoring info populated by the client.
 *
 * Contains the RLP-encoded signed `approve(Permit2, MaxUint256)` transaction
 * that the facilitator broadcasts before settling the Permit2 payment.
 *
 * Note: Unlike EIP-2612, there is no nonce/deadline/signature — instead the
 * entire signed transaction is included as `signedTransaction`.
 */
export interface Erc20ApprovalGasSponsoringInfo {
  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
  /** The address of the sender (token owner who signed the tx). */
  from: `0x${string}`;
  /** The address of the ERC-20 token contract. */
  asset: `0x${string}`;
  /** The address of the spender (Canonical Permit2). */
  spender: `0x${string}`;
  /** The amount approved (uint256 as decimal string). Always MaxUint256. */
  amount: string;
  /** The RLP-encoded signed EIP-1559 transaction as a hex string. */
  signedTransaction: `0x${string}`;
  /** Schema version identifier. */
  version: string;
}

/**
 * Server-side ERC-20 approval gas sponsoring info included in PaymentRequired.
 * Contains a description and version; the client populates the rest.
 */
export interface Erc20ApprovalGasSponsoringServerInfo {
  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
  /** Human-readable description of the extension. */
  description: string;
  /** Schema version identifier. */
  version: string;
}

/**
 * The full extension object as it appears in PaymentRequired.extensions
 * and PaymentPayload.extensions.
 */
export interface Erc20ApprovalGasSponsoringExtension {
  /** Extension info - server-provided or client-enriched. */
  info: Erc20ApprovalGasSponsoringServerInfo | Erc20ApprovalGasSponsoringInfo;
  /** JSON Schema describing the expected structure of info. */
  schema: Record<string, unknown>;
}
