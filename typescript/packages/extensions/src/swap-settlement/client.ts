/**
 * Client functions for the Swap Settlement Extension.
 *
 * These helpers build quote requests, verify quoted requirements hashes, and
 * construct the EIP-712 typed data the payer signs for each authorization
 * method, plus the extension fragment merged into `PaymentPayload.extensions`.
 */

import type { PaymentRequirements } from "@x402/core/types";
import type { Address, Hex } from "viem";
import { computeQuoteIdHash, computeRequirementsHash, deriveEip3009Nonce } from "./canonical";
import {
  SWAP_SETTLEMENT_KEY,
  type SwapQuoteRequest,
  type SwapQuoteResponse,
  type SwapSettlementExtension,
  type SwapSettlementPayloadInfo,
  type SwapSettlementServerInfo,
  type SwapWitness,
} from "./types";

/**
 * The canonical Permit2 contract address (same on all supported chains).
 */
export const CANONICAL_PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * The normative Permit2 witness typestring for `PermitWitnessTransferFrom`,
 * byte-for-byte as defined by the specification. It is never transmitted on
 * the wire and always used when signing and verifying.
 */
export const SWAP_WITNESS_TYPE_STRING =
  "SwapWitness witness)SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,address outputAsset,uint256 outputAmount)TokenPermissions(address token,uint256 amount)";

/**
 * EIP-712 types for the Permit2 `PermitWitnessTransferFrom` signature with
 * the `SwapWitness` witness. Field order matches the normative typestring.
 */
export const PERMIT2_SWAP_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "SwapWitness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  SwapWitness: [
    { name: "quoteIdHash", type: "bytes32" },
    { name: "requirementsHash", type: "bytes32" },
    { name: "payTo", type: "address" },
    { name: "outputAsset", type: "address" },
    { name: "outputAmount", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for the EIP-3009 `ReceiveWithAuthorization` signature.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * EIP-712 types for the `SwapSettlementIntent` signature used by the
 * `allowance` method.
 */
export const SWAP_SETTLEMENT_INTENT_TYPES = {
  SwapSettlementIntent: [
    { name: "quoteIdHash", type: "bytes32" },
    { name: "requirementsHash", type: "bytes32" },
    { name: "inputAsset", type: "address" },
    { name: "maxAmountIn", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Builds the body for `POST {quoteUrl}`.
 *
 * `paymentRequirements` MUST be the exact `accepts[]` entry the client
 * intends to satisfy, passed through unmodified. `inputAsset` MUST differ
 * from `paymentRequirements.asset`.
 *
 * @param paymentRequirements - The exact `accepts[]` entry to satisfy
 * @param payer - The payer address that will sign the authorization
 * @param inputAsset - The input asset the payer holds and authorizes
 * @param x402Version - The x402 protocol version (defaults to 2)
 * @returns The quote request body
 */
export function buildQuoteRequest(
  paymentRequirements: PaymentRequirements,
  payer: string,
  inputAsset: string,
  x402Version: number = 2,
): SwapQuoteRequest {
  return {
    x402Version,
    paymentRequirements,
    payer,
    inputAsset,
  };
}

/**
 * Recomputes `requirementsHash` from the `402` response the client received
 * and compares it to the value returned in the quote. Clients MUST perform
 * this check and MUST NOT sign if the hashes differ.
 *
 * @param paymentRequirements - The exact `accepts[]` entry from the 402 response
 * @param quote - The quote response to check against
 * @throws {Error} If the locally computed hash differs from `quote.requirementsHash`
 */
export function assertRequirementsHashMatches(
  paymentRequirements: PaymentRequirements,
  quote: SwapQuoteResponse,
): void {
  const localHash = computeRequirementsHash(paymentRequirements);
  if (localHash.toLowerCase() !== quote.requirementsHash.toLowerCase()) {
    throw new Error(
      `swap-settlement: requirementsHash mismatch — locally computed ${localHash}, ` +
        `quote ${quote.requirementsHash}. Do not sign; the quoted requirements differ ` +
        `from the 402 response.`,
    );
  }
}

/**
 * Builds the `SwapWitness` binding a signature to one quote and one set of
 * payment requirements. `requirementsHash` is recomputed locally from the
 * requirements (never trusted from the quote).
 *
 * @param quote - The quote response being consumed
 * @param paymentRequirements - The exact `accepts[]` entry from the 402 response
 * @returns The witness struct
 */
export function buildSwapWitness(
  quote: SwapQuoteResponse,
  paymentRequirements: PaymentRequirements,
): SwapWitness {
  return {
    quoteIdHash: computeQuoteIdHash(quote.quoteId),
    requirementsHash: computeRequirementsHash(paymentRequirements),
    payTo: paymentRequirements.payTo,
    outputAsset: paymentRequirements.asset,
    outputAmount: paymentRequirements.amount,
  };
}

/**
 * Parameters for {@link buildPermit2WitnessTypedData}.
 */
export interface BuildPermit2WitnessTypedDataParams {
  /** The EIP-155 chain id of the network. */
  chainId: number;
  /** The settler contract address (the spender). */
  settler: string;
  /** The input asset address. */
  inputAsset: string;
  /** Maximum input-asset amount the settler may pull (decimal string or bigint). */
  maxAmountIn: string | bigint;
  /** Permit2 unordered nonce (decimal string or bigint). */
  nonce: string | bigint;
  /** Signature deadline (unix seconds, decimal string or bigint). */
  deadline: string | bigint;
  /** The witness binding the signature to the quote. */
  witness: SwapWitness;
  /** Override for the Permit2 contract address (defaults to canonical). */
  permit2Address?: string;
}

/**
 * Builds the EIP-712 typed data for a Permit2 `PermitWitnessTransferFrom`
 * signature carrying the `SwapWitness`.
 *
 * @param params - The quote-derived parameters and witness
 * @returns Typed data ready for `signTypedData`
 */
export function buildPermit2WitnessTypedData(params: BuildPermit2WitnessTypedDataParams) {
  return {
    domain: {
      name: "Permit2",
      chainId: params.chainId,
      verifyingContract: (params.permit2Address ?? CANONICAL_PERMIT2_ADDRESS) as Address,
    },
    types: PERMIT2_SWAP_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: params.inputAsset as Address,
        amount: BigInt(params.maxAmountIn),
      },
      spender: params.settler as Address,
      nonce: BigInt(params.nonce),
      deadline: BigInt(params.deadline),
      witness: {
        quoteIdHash: params.witness.quoteIdHash as Hex,
        requirementsHash: params.witness.requirementsHash as Hex,
        payTo: params.witness.payTo as Address,
        outputAsset: params.witness.outputAsset as Address,
        outputAmount: BigInt(params.witness.outputAmount),
      },
    },
  } as const;
}

/**
 * Parameters for {@link buildEip3009TypedData}.
 */
export interface BuildEip3009TypedDataParams {
  /** The EIP-155 chain id of the network. */
  chainId: number;
  /** The input asset (token) contract address. */
  token: string;
  /** The token's EIP-712 domain name (read from the contract). */
  tokenName: string;
  /** The token's EIP-712 domain version (read from the contract). */
  tokenVersion: string;
  /** The payer (token owner). */
  from: string;
  /** The settler contract address (the payee). */
  settler: string;
  /** Maximum input-asset amount the settler may pull (decimal string or bigint). */
  maxAmountIn: string | bigint;
  /** Authorization not valid before this time (unix seconds, decimal string or bigint). */
  validAfter: string | bigint;
  /** Authorization not valid after this time; MUST be <= quote expiry. */
  validBefore: string | bigint;
  /** The 32-byte quote-id hash (0x-hex). */
  quoteIdHash: string;
  /** The 32-byte requirements hash (0x-hex). */
  requirementsHash: string;
}

/**
 * Builds the EIP-712 typed data for an EIP-3009 `ReceiveWithAuthorization`
 * signature. The nonce is derived as
 * `keccak256(abi.encode(quoteIdHash, requirementsHash))` to bind the
 * signature to the quote.
 *
 * @param params - The quote-derived parameters
 * @returns Typed data ready for `signTypedData`
 */
export function buildEip3009TypedData(params: BuildEip3009TypedDataParams) {
  return {
    domain: {
      name: params.tokenName,
      version: params.tokenVersion,
      chainId: params.chainId,
      verifyingContract: params.token as Address,
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: params.from as Address,
      to: params.settler as Address,
      value: BigInt(params.maxAmountIn),
      validAfter: BigInt(params.validAfter),
      validBefore: BigInt(params.validBefore),
      nonce: deriveEip3009Nonce(params.quoteIdHash, params.requirementsHash),
    },
  } as const;
}

/**
 * Parameters for {@link buildIntentTypedData}.
 */
export interface BuildIntentTypedDataParams {
  /** The EIP-155 chain id of the network. */
  chainId: number;
  /** The settler contract address (EIP-712 verifying contract). */
  settler: string;
  /** The 32-byte quote-id hash (0x-hex). */
  quoteIdHash: string;
  /** The 32-byte requirements hash (0x-hex). */
  requirementsHash: string;
  /** The input asset address. */
  inputAsset: string;
  /** Maximum input-asset amount the settler may pull (decimal string or bigint). */
  maxAmountIn: string | bigint;
  /** Signature deadline (unix seconds, decimal string or bigint). */
  deadline: string | bigint;
}

/**
 * Builds the EIP-712 typed data for the `SwapSettlementIntent` signature used
 * by the `allowance` method. Binding the domain to the settler address scopes
 * intents to a single settler deployment.
 *
 * @param params - The quote-derived parameters
 * @returns Typed data ready for `signTypedData`
 */
export function buildIntentTypedData(params: BuildIntentTypedDataParams) {
  return {
    domain: {
      name: "x402 swap-settlement",
      version: "1",
      chainId: params.chainId,
      verifyingContract: params.settler as Address,
    },
    types: SWAP_SETTLEMENT_INTENT_TYPES,
    primaryType: "SwapSettlementIntent",
    message: {
      quoteIdHash: params.quoteIdHash as Hex,
      requirementsHash: params.requirementsHash as Hex,
      inputAsset: params.inputAsset as Address,
      maxAmountIn: BigInt(params.maxAmountIn),
      deadline: BigInt(params.deadline),
    },
  } as const;
}

/**
 * Wraps client-populated payload info into the extensions fragment to merge
 * into `PaymentPayload.extensions`.
 *
 * @param info - The client-populated swap settlement info
 * @returns An object keyed by the extension identifier containing the info
 *
 * @example
 * ```typescript
 * const paymentPayload = {
 *   ...basePayload,
 *   extensions: {
 *     ...basePayload.extensions,
 *     ...buildSwapSettlementExtension(info),
 *   },
 * };
 * ```
 */
export function buildSwapSettlementExtension(
  info: SwapSettlementPayloadInfo,
): Record<string, SwapSettlementExtension> {
  return {
    [SWAP_SETTLEMENT_KEY]: { info },
  };
}

/**
 * Extracts the swap-settlement discovery info a server advertised in its 402 response.
 *
 * Expects the spec wire format `{ info: { ... } }` under
 * `extensions["swap-settlement"]`. Returns null when the response does not
 * declare the extension (or the declaration is malformed), so callers can fall
 * back to paying in the required asset directly.
 *
 * @param paymentRequired - The decoded PaymentRequired response
 * @param paymentRequired.extensions - The server-declared extensions object
 * @returns The advertised server info, or null when swap settlement is not offered
 *
 * @example
 * ```typescript
 * const paymentRequired = httpClient.getPaymentRequiredResponse(name => res.headers.get(name));
 * const swapInfo = extractSwapSettlementServerInfo(paymentRequired);
 * if (swapInfo) {
 *   const quote = await fetch(swapInfo.quoteUrl, { ... });
 * }
 * ```
 */
export function extractSwapSettlementServerInfo(paymentRequired: {
  extensions?: Record<string, unknown>;
}): SwapSettlementServerInfo | null {
  const ext = paymentRequired?.extensions?.[SWAP_SETTLEMENT_KEY] as
    | Record<string, unknown>
    | undefined;
  if (!ext || typeof ext !== "object") return null;
  const info = ext.info as SwapSettlementServerInfo | undefined;
  if (
    typeof info !== "object" ||
    info === null ||
    typeof info.quoteUrl !== "string" ||
    !Array.isArray(info.networks)
  ) {
    return null;
  }
  return info;
}
