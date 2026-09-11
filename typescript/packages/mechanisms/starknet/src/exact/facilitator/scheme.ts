/**
 * Starknet `exact` facilitator (x402 v2 / SNIP-9).
 *
 * Implements the Facilitator Verification Rules and Settlement steps from
 * specs/schemes/exact/scheme_exact_starknet.md. Verification fails closed: any
 * check that cannot be safely determined rejects the payment. Settlement
 * re-verifies (never trusts a prior /verify), guards against duplicate
 * submissions, broadcasts via the facilitator signer, and reports success only
 * after the transaction is accepted onchain with a SUCCEEDED execution status
 * AND a receipt showing the exact payer → payTo transfer (merchant-truth).
 *
 * A broadcast whose confirmation cannot be established within the deadline is
 * reported as the non-terminal `settlement_pending` outcome, and its hash is
 * remembered in a `PendingSettlementStore` so the resource server's single
 * automatic retry of the identical payload reconciles against that
 * transaction instead of verifying and broadcasting a second one. That is the
 * only path back to `success: true` for a settlement this facilitator left
 * unresolved; a consumed SNIP-9 nonce on any other settle request, including
 * one whose earlier success response was lost in transit, is terminal.
 */

import {
  CallData,
  RpcError,
  TimeoutError,
  type GetTransactionReceiptResponse,
  type RpcProvider,
  typedData as snTypedData,
} from "starknet";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import {
  ANY_CALLER,
  CHAIN_IDS,
  STARKNET_ADDRESS_REGEX,
  MAX_SIGNATURE_FELTS,
  MIN_REMAINING_WINDOW_SECONDS,
  READ_BLOCK,
  SKEW_MARGIN_SECONDS,
  STARK_PRIME,
  STARKNET_ERROR_REASONS,
  TRANSFER_SELECTOR,
  U128_MAX,
  VALID_SIGNATURE_MAGIC,
} from "../../constants";
import type { ExactStarknetPayload } from "../../types";
import {
  buildCanonicalOutsideExecutionTypedData,
  parseOutsideExecution,
  type CanonicalOutsideExecutionMessage,
  type OutsideExecutionMessage,
  type OutsideExecutionTypedData,
} from "../../typed-data";
import {
  amountStringEquals,
  chainIdSafeToFelt,
  feltEquals,
  isFeltString,
  isFieldElement,
  isValidStarknetAddress,
  parseAmount,
  parseU256,
} from "../../utils";
import {
  createStarknetProvider,
  resolveTimeoutMs,
  type FacilitatorStarknetSigner,
} from "../../signer";
import { SettlementCache, nonceKey } from "../../settlement-cache";
import {
  assertExactTransfer,
  simulateSettlement,
  type EventLike,
  type SimulationResult,
} from "./simulate";

/**
 * Core standard x402 v2 reason tokens used by this scheme. Starknet-specific
 * tokens come from STARKNET_ERROR_REASONS. Both are bare enum tokens - human
 * context always goes in the separate invalidMessage / errorMessage field.
 */
const CORE_REASONS = {
  INVALID_PAYLOAD: "invalid_payload",
  INVALID_SCHEME: "invalid_scheme",
  INVALID_NETWORK: "invalid_network",
  INVALID_PAYMENT_REQUIREMENTS: "invalid_payment_requirements",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_X402_VERSION: "invalid_x402_version",
  UNEXPECTED_VERIFY_ERROR: "unexpected_verify_error",
  UNEXPECTED_SETTLE_ERROR: "unexpected_settle_error",
  INVALID_TRANSACTION_STATE: "invalid_transaction_state",
} as const;

/** The SDK's union of structured JSON-RPC error names. */
type RpcErrorType = Parameters<RpcError["isType"]>[0];

/**
 * The asset transfer method and payment flow this scheme implements, mirroring
 * what the server scheme registers with core. The ATM is core's SDK sentinel:
 * a payment here is always a signed SNIP-9 OutsideExecution, so there is no
 * on-wire choice to make and core strips the key before the 402 is sent.
 */
const DECLARED_ATM = "default";
const DECLARED_PAYMENT_FLOW = "authorization";

/**
 * Whether a protocol-reserved flow key is absent or carries the one value this
 * scheme implements. Absence is valid; any other value - null included - is a
 * key that appears with a value the scheme does not implement.
 *
 * @param value - The value found under the reserved key, if any
 * @param declared - The only value this scheme accepts
 * @returns True when the key may be accepted
 */
function isDeclaredFlowValue(value: unknown, declared: string): boolean {
  return value === undefined || value === declared;
}

/** Poll interval for post-broadcast confirmation. */
const CONFIRM_RETRY_INTERVAL_MS = 1500;

/**
 * Default wall-clock budget for post-broadcast confirmation. Past this the
 * settlement resolves to the non-terminal `settlement_pending` outcome
 * carrying the transaction hash, which the resource server's retry
 * reconciles. Kept below core's 90 s facilitator HTTP timeout so that answer
 * reaches the caller.
 */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 75_000;

/**
 * Build a rejection. `invalidReason` is always a bare enum token; human context
 * goes in `invalidMessage`. `payer` is included ONLY after the signature has
 * been independently verified (spec rule 9, Facilitator Safety).
 *
 * @param reason - The bare enum reason token
 * @param invalidMessage - Optional human-readable diagnostic context
 * @param payer - Optional payer address, only once its signature is verified
 * @returns The failed VerifyResponse
 */
function invalid(reason: string, invalidMessage?: string, payer?: string): VerifyResponse {
  const res: VerifyResponse = { isValid: false, invalidReason: reason };
  if (invalidMessage) res.invalidMessage = invalidMessage;
  if (payer) res.payer = payer;
  return res;
}

/**
 * Build a SettleResponse, defaulting `transaction` to the empty string so a
 * failure never carries a stale hash unless one is explicitly supplied.
 *
 * @param fields - The response fields to populate
 * @param fields.success - Whether settlement succeeded
 * @param fields.network - The CAIP-2 network identifier
 * @param fields.transaction - The settlement transaction hash, if any
 * @param fields.errorReason - The bare enum error token, on failure
 * @param fields.errorMessage - Optional human-readable diagnostic context
 * @param fields.payer - The payer address, once known
 * @param fields.amount - The settled amount in atomic units
 * @returns The assembled SettleResponse
 */
function settleResponse(fields: {
  success: boolean;
  network: Network;
  transaction?: string;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  amount?: string;
}): SettleResponse {
  const res: SettleResponse = {
    success: fields.success,
    transaction: fields.transaction ?? "",
    network: fields.network,
  };
  if (fields.errorReason) res.errorReason = fields.errorReason;
  if (fields.errorMessage) res.errorMessage = fields.errorMessage;
  if (fields.payer) res.payer = fields.payer;
  if (fields.amount) res.amount = fields.amount;
  return res;
}

/**
 * Structurally validate the `exact` Starknet payload before trusting any field.
 *
 * @param p - The candidate `PaymentPayload.payload` value
 * @param maxSignatureFelts - Upper bound on the signature's felt count
 * @returns True when `p` has the required `from` / `outsideExecution` shape
 */
function isExactStarknetPayload(p: unknown, maxSignatureFelts: number): p is ExactStarknetPayload {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  if (typeof obj.from !== "string") return false;
  const oe = obj.outsideExecution as Record<string, unknown> | undefined;
  if (!oe || typeof oe !== "object") return false;
  if (typeof oe.typedData !== "object" || oe.typedData === null) return false;
  if (!Array.isArray(oe.signature) || oe.signature.length === 0) return false;
  // Counted before the elements are scanned: /verify is unauthenticated, so the
  // bound has to be reached without first walking an arbitrarily long array.
  if (oe.signature.length > maxSignatureFelts) return false;
  // Every element must be a felt, by grammar and by value. Without the grammar
  // check, arbitrary strings reach CallData.compile, which byte-array-encodes
  // them into many more felts than the array has elements - so the length bound
  // above would not actually bound the compiled calldata. Without the value
  // check, a 64-hex-digit element above the field modulus is shipped to the
  // node, which refuses the request as malformed instead of answering about
  // the signature. Zero stays admissible: account signature encodings carry it.
  return oe.signature.every(
    s => typeof s === "string" && isFeltString(s) && BigInt(s) < STARK_PRIME,
  );
}

/**
 * Read a balance response, rejecting one that cannot be parsed as a u256.
 * Throwing keeps an unreadable response on the RPC-failure path, where it is
 * reported as a facilitator error rather than as a verdict about the payer.
 *
 * @param result - The raw `[low, high]` felt array from the token contract
 * @returns The balance as a bigint
 */
function requireBalance(result: string[]): bigint {
  const balance = parseU256(result);
  if (balance === null) throw new Error("token returned an unreadable balance");
  return balance;
}

/**
 * Whether a rejection is a structured JSON-RPC error of one of the given types,
 * as opposed to a transport fault. Only the former is an answer from the chain.
 *
 * The type parameter is the SDK's own error-name union, so a name that does not
 * exist fails to compile rather than silently never matching.
 *
 * @param error - The rejection reason to classify
 * @param types - The JSON-RPC error types that count as a structured answer
 * @returns True when the chain answered with one of those errors
 */
function isRpcErrorOfType(error: unknown, ...types: RpcErrorType[]): boolean {
  return error instanceof RpcError && types.some(t => error.isType(t));
}

/**
 * Read the payer's token balance, trying `balanceOf` then the snake_case
 * `balance_of` fallback. A token exposing neither getter throws a
 * `NoBalanceGetter`-tagged error (a requirements defect); other errors fail
 * closed.
 *
 * @param provider - The Starknet read provider
 * @param token - The token contract address
 * @param account - The account whose balance is read
 * @returns The balance as a bigint
 */
async function getBalance(provider: RpcProvider, token: string, account: string): Promise<bigint> {
  try {
    return requireBalance(
      await provider.callContract(
        {
          contractAddress: token,
          entrypoint: "balanceOf",
          calldata: [account],
        },
        READ_BLOCK,
      ),
    );
  } catch (error) {
    // Only a missing entry point justifies trying the other spelling. Falling
    // back on ANY error would let a transient fault on `balanceOf` be
    // reclassified by the second attempt, reporting a healthy token as a
    // requirements defect.
    if (!(error instanceof RpcError && error.isType("ENTRYPOINT_NOT_FOUND"))) throw error;

    // Cairo-1 tokens may expose only the snake_case entry point.
    try {
      return requireBalance(
        await provider.callContract(
          {
            contractAddress: token,
            entrypoint: "balance_of",
            calldata: [account],
          },
          READ_BLOCK,
        ),
      );
    } catch (fallbackError) {
      // A structured ENTRYPOINT_NOT_FOUND on the fallback too means the token
      // exposes neither getter, so the asset is unusable for this scheme. Any
      // other error (transient RPC, node fault) is not a requirements defect.
      if (fallbackError instanceof RpcError && fallbackError.isType("ENTRYPOINT_NOT_FOUND")) {
        const tagged = new Error("token exposes neither balanceOf nor balance_of");
        tagged.name = "NoBalanceGetter";
        throw tagged;
      }
      throw fallbackError;
    }
  }
}

// ---------------------------------------------------------------------------
// Verification rule groups. Each returns a rejection, or undefined to pass.
// They are pure over their inputs so the ruleset reads top to bottom in
// runVerification while each group stays small enough to reason about.
// ---------------------------------------------------------------------------

/**
 * Spec rule 1, requirements well-formedness. Fails closed on malformed
 * requirements - never let a missing field silently disable a dependent check
 * (e.g. a NaN window bound).
 *
 * @param requirements - The server-supplied payment requirements
 * @returns The parsed required amount, or a rejection
 */
function checkRequirementsShape(
  requirements: PaymentRequirements,
): { requiredAmount: bigint } | { rejection: VerifyResponse } {
  // Integer, not merely finite: `Execute Before` is a felt, so a fractional
  // window is unsignable and the defect belongs to the 402 that advertised it.
  if (
    typeof requirements.maxTimeoutSeconds !== "number" ||
    !Number.isInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds <= 0
  ) {
    return {
      rejection: invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "invalid maxTimeoutSeconds"),
    };
  }
  // A window at or under the settle floor is unsatisfiable: the client signs
  // `Execute Before = now + maxTimeoutSeconds`, and the floor rejects
  // `Execute Before <= now + MIN_REMAINING_WINDOW_SECONDS`, so such an
  // authorization is already too close to expiry the moment it is signed.
  // Reject those requirements once rather than every payment built from them.
  //
  // The bound is the floor alone, NOT floor + skew. The spec only says servers
  // SHOULD advertise comfortably above `skewMargin + minSettleMargin`; a
  // smaller-but-positive window stays legal and merely narrows how long a
  // signature remains usable, so rejecting it outright would refuse
  // spec-conformant requirements.
  if (requirements.maxTimeoutSeconds <= MIN_REMAINING_WINDOW_SECONDS) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        `maxTimeoutSeconds must exceed ${MIN_REMAINING_WINDOW_SECONDS}s`,
      ),
    };
  }
  let requiredAmount: bigint;
  try {
    requiredAmount = parseAmount(requirements.amount);
    if (requiredAmount <= 0n) throw new Error("non-positive");
  } catch {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "invalid amount in payment requirements",
      ),
    };
  }
  // Without these, a malformed asset/payTo makes feltEquals return false and
  // the defect surfaces at the accepted-vs-requirements comparison as
  // invalid_payload - blaming the client for the server's own bad 402.
  if (!isValidStarknetAddress(requirements.asset)) {
    return {
      rejection: invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "invalid asset address"),
    };
  }
  if (!isValidStarknetAddress(requirements.payTo)) {
    return {
      rejection: invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "invalid payTo address"),
    };
  }
  return { requiredAmount };
}

/**
 * Spec rules 1, 4 and 9 on `extra.feePayer`: the required SNIP-9 Caller, which
 * must be a concrete address this facilitator can itself settle through.
 *
 * @param requirements - The server-supplied payment requirements
 * @param payer - The payer account contract address from the payload
 * @param facilitatorFeePayers - The addresses this facilitator settles through
 * @returns The validated feePayer, or a rejection
 */
function checkFeePayer(
  requirements: PaymentRequirements,
  payer: string,
  facilitatorFeePayers: readonly string[],
): { feePayer: string } | { rejection: VerifyResponse } {
  const feePayerRaw = requirements.extra?.feePayer;
  // Shape only here, so the specific zero / sentinel diagnostics below stay
  // reachable. An out-of-range value is caught by the membership check at the
  // end of this block: it cannot be an address this facilitator manages.
  if (typeof feePayerRaw !== "string" || !STARKNET_ADDRESS_REGEX.test(feePayerRaw)) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer missing or invalid",
      ),
    };
  }
  const feePayer = feePayerRaw;
  // feePayer MUST be a concrete address (spec rules 1/4). Zero, the payer, and
  // the ANY_CALLER sentinel would each make the caller binding vacuous - the
  // sentinel silently turns a bound authorization back into a bearer one that
  // anyone could submit.
  // These are defects in the SERVER-SUPPLIED requirements, so they carry the
  // requirements code (spec rule 1), not the caller-binding code - which the
  // error table reserves for `message.Caller` != `extra.feePayer` (rule 4).
  if (feltEquals(feePayer, "0x0")) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer must not be zero",
      ),
    };
  }
  if (feltEquals(feePayer, ANY_CALLER)) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer must not be the ANY_CALLER sentinel",
      ),
    };
  }
  if (feltEquals(feePayer, payer)) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer must not equal the payer",
      ),
    };
  }
  // Range-checked here rather than in the shape gate above, so the zero and
  // sentinel diagnostics stay reachable while an out-of-field value is still
  // blamed on the requirements that carried it.
  if (!isFieldElement(feePayer)) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer is out of range",
      ),
    };
  }
  // Facilitator safety (spec rules 1/9): only announce/accept a feePayer this
  // facilitator can itself settle through. A stale or foreign value would
  // produce an authorization only some other party could execute.
  if (!facilitatorFeePayers.some(a => feltEquals(feePayer, a))) {
    return {
      rejection: invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer is not managed by this facilitator",
      ),
    };
  }
  return { feePayer };
}

/**
 * Spec rule 1: `accepted` must match the server-supplied requirements
 * field-by-field, and the protocol-reserved flow keys must carry the one value
 * this scheme implements wherever they appear.
 *
 * @param accepted - The client's echo of the requirements it paid against
 * @param requirements - The server-supplied payment requirements
 * @param feePayer - The validated `extra.feePayer` from the requirements
 * @returns A rejection, or undefined when everything matches
 */
function checkAcceptedMatchesRequirements(
  accepted: PaymentPayload["accepted"],
  requirements: PaymentRequirements,
  feePayer: string,
): VerifyResponse | undefined {
  if (
    !feltEquals(accepted.payTo, requirements.payTo) ||
    !feltEquals(accepted.asset, requirements.asset) ||
    !amountStringEquals(accepted.amount, requirements.amount) ||
    accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds
  ) {
    return invalid(CORE_REASONS.INVALID_PAYLOAD, "accepted does not match payment requirements");
  }
  if (
    typeof accepted.extra?.feePayer !== "string" ||
    !feltEquals(accepted.extra.feePayer, feePayer)
  ) {
    return invalid(
      CORE_REASONS.INVALID_PAYLOAD,
      "accepted.extra.feePayer does not match payment requirements",
    );
  }
  // The protocol-reserved flow keys are matched by VALUE, not by presence.
  // This scheme has one settlement path and one flow, so core omits both from
  // the wire and absence is the norm; but a resource server that announced a
  // different flow would be running a trust model this facilitator does not
  // implement, and verifying its payment under `authorization` semantics
  // anyway is the confusion worth refusing.
  if (!isDeclaredFlowValue(requirements.extra?.assetTransferMethod, DECLARED_ATM)) {
    return invalid(
      CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
      `extra.assetTransferMethod must be ${DECLARED_ATM} when present`,
    );
  }
  if (!isDeclaredFlowValue(requirements.extra?.paymentFlow, DECLARED_PAYMENT_FLOW)) {
    return invalid(
      CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
      `extra.paymentFlow must be ${DECLARED_PAYMENT_FLOW} when present`,
    );
  }
  if (
    !isDeclaredFlowValue(accepted.extra?.assetTransferMethod, DECLARED_ATM) ||
    !isDeclaredFlowValue(accepted.extra?.paymentFlow, DECLARED_PAYMENT_FLOW)
  ) {
    return invalid(
      CORE_REASONS.INVALID_PAYLOAD,
      "accepted.extra declares an unsupported payment flow",
    );
  }
  return undefined;
}

/**
 * Spec rule 7, payment intent and exactness, over the single call the parser
 * has already guaranteed (one call, three-felt calldata).
 *
 * @param message - The parsed OutsideExecution message
 * @param requirements - The server-supplied payment requirements
 * @param requiredAmount - The requirements amount as a bigint
 * @returns A rejection, or undefined when the call is exactly the payment
 */
function checkPaymentIntent(
  message: OutsideExecutionMessage,
  requirements: PaymentRequirements,
  requiredAmount: bigint,
): VerifyResponse | undefined {
  const call = message.Calls[0];
  if (!feltEquals(call.To, requirements.asset)) {
    return invalid(STARKNET_ERROR_REASONS.ASSET_MISMATCH);
  }
  if (!feltEquals(call.Selector, TRANSFER_SELECTOR)) {
    return invalid(CORE_REASONS.INVALID_PAYLOAD, "call is not a transfer");
  }
  const calldata = call.Calldata;
  if (!feltEquals(calldata[0], requirements.payTo)) {
    return invalid(STARKNET_ERROR_REASONS.RECIPIENT_MISMATCH);
  }
  const callAmount = readTransferAmount(calldata);
  if (callAmount === null) {
    return invalid(CORE_REASONS.INVALID_PAYLOAD, "non-canonical u256 limbs");
  }
  if (callAmount !== requiredAmount) {
    return invalid(
      STARKNET_ERROR_REASONS.AMOUNT_MISMATCH,
      `transfer amount ${callAmount}, required ${requiredAmount}`,
    );
  }
  return undefined;
}

/**
 * Read the u256 amount from a transfer call's `[recipient, low, high]` calldata,
 * requiring canonical limbs (each below 2^128).
 *
 * @param calldata - The three-felt transfer calldata
 * @returns The amount, or null when a limb is unparsable or out of range
 */
function readTransferAmount(calldata: string[]): bigint | null {
  let amountLow: bigint;
  let amountHigh: bigint;
  try {
    amountLow = BigInt(calldata[1]);
    amountHigh = BigInt(calldata[2]);
  } catch {
    return null;
  }
  if (amountLow < 0n || amountHigh < 0n || amountLow > U128_MAX || amountHigh > U128_MAX) {
    return null;
  }
  return amountLow + (amountHigh << 128n);
}

/**
 * Spec rule 5, the execution time window (Timeout Mapping). When
 * `settlementPhase` is true the verify-phase freshness lower band is skipped
 * (remaining validity necessarily shrinks between /verify and /settle) while
 * the minimum-remaining-window floor still applies.
 *
 * @param message - The parsed OutsideExecution message
 * @param requirements - The server-supplied payment requirements
 * @param now - The current time in epoch seconds
 * @param settlementPhase - Whether this is a settlement-time re-verification
 * @returns A rejection, or undefined when the window is acceptable
 */
function checkTimeWindow(
  message: OutsideExecutionMessage,
  requirements: PaymentRequirements,
  now: number,
  settlementPhase: boolean,
): VerifyResponse | undefined {
  const executeAfter = Number(message["Execute After"]);
  const executeBefore = Number(message["Execute Before"]);
  if (!Number.isFinite(executeAfter) || !Number.isFinite(executeBefore)) {
    return invalid(CORE_REASONS.INVALID_PAYLOAD, "invalid execution time bounds");
  }
  if (executeAfter >= now - SKEW_MARGIN_SECONDS) {
    return invalid(CORE_REASONS.INVALID_PAYLOAD, "Execute After is not sufficiently in the past");
  }
  if (executeBefore <= now + MIN_REMAINING_WINDOW_SECONDS) {
    return invalid(STARKNET_ERROR_REASONS.EXPIRED);
  }
  // Freshness band (verify phase only): the authorization must remain valid
  // for the full advertised settlement window. At settlement re-verification
  // the remaining window has necessarily shrunk, so only the minimum-window
  // floor above applies.
  if (
    !settlementPhase &&
    executeBefore < now + requirements.maxTimeoutSeconds - SKEW_MARGIN_SECONDS
  ) {
    return invalid(
      STARKNET_ERROR_REASONS.EXPIRED,
      "authorization does not remain valid for the advertised settlement window",
    );
  }
  if (executeBefore > now + requirements.maxTimeoutSeconds + SKEW_MARGIN_SECONDS) {
    return invalid(STARKNET_ERROR_REASONS.WINDOW_EXCEEDS_MAX_TIMEOUT);
  }
  return undefined;
}

/**
 * Spec rules 3, 6 and 8 (first half): classify the four parallel chain reads
 * in rule order. Every branch distinguishes a STRUCTURED contract-level answer
 * from a transport fault. Both arrive as a rejected promise, but they mean
 * opposite things: the contract answering "no such entry point" is a fact about
 * the payer's account, while a node timing out is the absence of an answer.
 * Reporting the latter as a domain verdict tells the client its payment is
 * defective when nothing about it was ever checked - and on the settle path a
 * nonce read that merely timed out would be reported as a consumed nonce,
 * permanently retiring an authorization that never executed. Unclassified
 * faults therefore fail closed as a retryable unexpected error.
 *
 * @param reads - The settled results of the deployment, signature, nonce and balance reads
 * @param reads.deployed - The class-hash read proving the account is deployed
 * @param reads.signature - The `is_valid_signature` call result
 * @param reads.nonce - The `is_valid_outside_execution_nonce` call result
 * @param reads.balance - The payer's asset balance read
 * @param payer - The payer account contract address
 * @param requiredAmount - The requirements amount as a bigint
 * @returns A rejection, or undefined when every read passes
 */
function classifyChainReads(
  reads: {
    deployed: PromiseSettledResult<unknown>;
    signature: PromiseSettledResult<string[]>;
    nonce: PromiseSettledResult<string[]>;
    balance: PromiseSettledResult<bigint>;
  },
  payer: string,
  requiredAmount: bigint,
): VerifyResponse | undefined {
  // account must be deployed
  if (reads.deployed.status === "rejected") {
    return isRpcErrorOfType(reads.deployed.reason, "CONTRACT_NOT_FOUND")
      ? invalid(STARKNET_ERROR_REASONS.ACCOUNT_NOT_DEPLOYED)
      : invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "account deployment check failed");
  }

  // signature over the canonical reconstruction - payer is trusted only once
  // this passes, so it is echoed on responses only from here on.
  if (reads.signature.status === "rejected") {
    // Only a reverting call is evidence about the signature; the spec scopes
    // this verdict to the account rejecting it, not to an unreachable node.
    return isRpcErrorOfType(reads.signature.reason, "CONTRACT_ERROR", "ENTRYPOINT_NOT_FOUND")
      ? invalid(STARKNET_ERROR_REASONS.INVALID_SIGNATURE, "onchain verification failed")
      : invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "signature check failed");
  }
  if (!feltEquals(reads.signature.value[0], VALID_SIGNATURE_MAGIC)) {
    return invalid(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);
  }

  // replay protection: SNIP-9 nonce must be unused. An account that answers
  // structurally but has no SNIP-9 v2 entry point cannot be replay-protected
  // by this facilitator, so that case stays a terminal rejection.
  if (reads.nonce.status === "rejected") {
    return isRpcErrorOfType(reads.nonce.reason, "CONTRACT_ERROR", "ENTRYPOINT_NOT_FOUND")
      ? invalid(
          STARKNET_ERROR_REASONS.NONCE_ALREADY_USED,
          "nonce check failed (account may not support SNIP-9 v2)",
          payer,
        )
      : invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "nonce check failed", payer);
  }
  if (!feltEquals(reads.nonce.value[0], "0x1")) {
    return invalid(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED, undefined, payer);
  }

  // chain-state preflight: balance. A token exposing neither getter is a
  // requirements defect; an RPC failure fails closed.
  if (reads.balance.status === "rejected") {
    const reason =
      reads.balance.reason instanceof Error && reads.balance.reason.name === "NoBalanceGetter"
        ? CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS
        : CORE_REASONS.UNEXPECTED_VERIFY_ERROR;
    return invalid(reason, "balance check failed", payer);
  }
  if (reads.balance.value < requiredAmount) {
    return invalid(
      CORE_REASONS.INSUFFICIENT_FUNDS,
      `balance ${reads.balance.value}, need ${requiredAmount}`,
      payer,
    );
  }
  return undefined;
}

/**
 * The transfer a settlement transaction must have performed, read from the
 * canonical (signed) message rather than from the requirements: after
 * verification the two agree, and on the pending-settlement path only the
 * signed content is bound to the remembered broadcast.
 */
interface ExpectedTransfer {
  asset: string;
  payTo: string;
  amount: bigint;
}

/**
 * Everything settlement needs to know about an authorization before spending a
 * single RPC: its identity for the pending-settlement store (the SNIP-12
 * message hash, which binds chain, payer, and every signed field), its
 * duplicate-guard key, and the transfer it authorizes.
 */
interface AuthorizationIdentity {
  payer: string;
  signature: string[];
  canonical: OutsideExecutionTypedData;
  message: CanonicalOutsideExecutionMessage;
  pendingKey: string;
  guardKey: string;
  transfer: ExpectedTransfer;
}

/**
 * Starknet facilitator implementation for the `exact` payment scheme.
 */
export class ExactStarknetScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "starknet:*";

  /**
   * Duplicate-settlement guard. Defaults to an instance-scoped cache so two
   * facilitators in one process cannot corrupt each other's guards; pass a
   * shared one to coordinate several schemes in the same process.
   *
   * Its API is synchronous, so it cannot be backed by a shared store. A
   * horizontally scaled facilitator therefore does not coordinate guards across
   * replicas: the onchain SNIP-9 nonce remains the authority, and a duplicate
   * `/settle` landing on another replica is resolved by that nonce rather than
   * by this cache.
   */
  private readonly cache: SettlementCache;

  /**
   * Broadcast-but-unconfirmed settlement hashes, keyed by the authorization's
   * SNIP-12 message hash. A settle attempt whose confirmation wait expired
   * records its hash here before returning `settlement_pending`; the resource
   * server's single automatic retry of the identical payload then reconciles
   * against that transaction instead of re-verifying and re-broadcasting.
   * Asynchronous by contract, so a multi-instance facilitator can inject a
   * shared, network-backed implementation.
   */
  private readonly pendingStore: PendingSettlementStore;

  /**
   * Authorizations whose remembered broadcast is being reconciled right now.
   * The store's `get` and `delete` are two awaits apart, so two concurrent
   * retries of the same payload could both observe the entry before either
   * removes it and both report success for one payment; this synchronous set
   * lets exactly one of them reconcile while the other is a duplicate.
   */
  private readonly reconciling = new Set<string>();

  /** Signature-length bound applied to every payload this facilitator reads. */
  private readonly maxSignatureFelts: number;

  /** Wall-clock budget for one receipt wait, fresh or reconciling. */
  private readonly confirmationTimeoutMs: number;

  /**
   * Creates a new ExactStarknetScheme facilitator.
   *
   * @param signer - The facilitator signer that announces feePayers and settles
   * @param config - Optional RPC URL override and settlement bookkeeping
   * @param config.rpcUrl - Custom JSON-RPC URL, per network resolution otherwise
   * @param config.providerFactory - Supplies the read provider, for a custom
   *   transport, retry policy, or an injected provider in tests. Supplying one
   *   opts out of `rpcTimeoutMs`: the factory owns the transport
   * @param config.rpcTimeoutMs - Per-request timeout for RPC reads
   * @param config.confirmationTimeoutMs - Wall-clock budget for waiting on a
   *   broadcast's receipt before answering `settlement_pending` (default 75 s,
   *   below core's 90 s facilitator HTTP timeout)
   * @param config.maxSignatureFelts - Upper bound on the felt-array signature
   *   length. The default admits multisig and guardian accounts; raise it to
   *   serve webauthn/passkey accounts, whose signatures are considerably longer
   * @param config.pendingSettlementStore - Lets a retried settle for the same
   *   payload reconcile against an already-broadcast transaction instead of
   *   re-verifying and re-broadcasting (see {@link PendingSettlementStore}).
   *   Defaults to a fresh in-memory store shared across all settle calls on
   *   this scheme instance. Inject a shared, network-backed implementation
   *   (e.g. Redis) for a multi-instance facilitator so a settle retry landing
   *   on a different replica still reconciles correctly
   * @param settlementCache - Optional shared duplicate-settlement guard
   */
  constructor(
    private readonly signer: FacilitatorStarknetSigner,
    private readonly config?: {
      rpcUrl?: string;
      providerFactory?: (network: Network) => RpcProvider;
      rpcTimeoutMs?: number;
      confirmationTimeoutMs?: number;
      maxSignatureFelts?: number;
      pendingSettlementStore?: PendingSettlementStore;
    },
    settlementCache?: SettlementCache,
  ) {
    this.cache = settlementCache ?? new SettlementCache();
    this.confirmationTimeoutMs = config?.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.confirmationTimeoutMs) || this.confirmationTimeoutMs <= 0) {
      throw new Error("confirmationTimeoutMs must be a positive integer number of milliseconds");
    }
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
    this.maxSignatureFelts = config?.maxSignatureFelts ?? MAX_SIGNATURE_FELTS;
    // Validated, not merely defaulted: a NaN would make every `length >` test
    // false and silently switch the pre-authentication bound off.
    if (!Number.isSafeInteger(this.maxSignatureFelts) || this.maxSignatureFelts <= 0) {
      throw new Error("maxSignatureFelts must be a positive integer");
    }
    // Surface a bad timeout at startup, not at the first payment. A supplied
    // providerFactory owns its transport, so there is nothing to validate.
    if (!config?.providerFactory) {
      resolveTimeoutMs(config?.rpcTimeoutMs);
    }
    // `extra.feePayer` is REQUIRED on every Starknet exact kind, and a facilitator
    // that cannot commit to a submitting address MUST NOT advertise the kind
    // (spec, Facilitator /supported Entry). Core pushes the kind whatever
    // `getExtra` returns, so the only place to enforce that is here.
    if (signer.getAddresses().length === 0) {
      throw new Error("A Starknet facilitator signer must announce at least one feePayer address");
    }
  }

  /**
   * Get the `extra` advertised for the supported-kinds endpoint. The announced
   * `feePayer` is the address the client MUST set as the SNIP-9 Caller.
   *
   * @param _ - The network identifier (unused)
   * @returns Extra data carrying the announced feePayer address
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    // Non-empty by construction - the constructor rejects a signer with none.
    const addresses = this.signer.getAddresses();
    return { feePayer: addresses[0] };
  }

  /**
   * Get the signer (feePayer) addresses this facilitator settles through.
   *
   * @param _ - The network identifier (unused)
   * @returns The facilitator-managed feePayer addresses
   */
  getSigners(_: string): string[] {
    // The spec asks for the accounts that actually SIGN the settlement INVOKE.
    // They equal the announced feePayers only in the direct-executor case; a
    // paymaster forwarder is a contract that can never sign.
    const signing = this.signer.getSettlementSigners?.();
    return signing ? [...signing] : [...this.signer.getAddresses()];
  }

  /**
   * Verify a payment payload against its requirements. Fails closed.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The server-supplied payment requirements
   * @returns The verification result with a bare enum reason on failure
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      if (!CHAIN_IDS[requirements.network]) {
        return invalid(CORE_REASONS.INVALID_NETWORK, `unsupported network ${requirements.network}`);
      }
      const provider = this.buildProvider(requirements.network);
      return await this.runVerification(payload, requirements, provider, false);
    } catch (error) {
      console.error("[verify] unexpected error:", error instanceof Error ? error.message : error);
      return invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "verification error");
    }
  }

  /**
   * Settle a payment: reconcile a remembered broadcast, or re-verify, guard
   * duplicates, broadcast, and confirm.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The server-supplied payment requirements
   * @returns The settlement result; success only after onchain confirmation
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    try {
      if (!CHAIN_IDS[network]) {
        return settleResponse({
          success: false,
          network,
          errorReason: CORE_REASONS.INVALID_NETWORK,
          errorMessage: `unsupported network ${network}`,
        });
      }
      const provider = this.buildProvider(network);
      return await this.runSettlement(payload, requirements, provider);
    } catch (error) {
      // Never leak raw RPC/paymaster internals to clients (spec settlement §7).
      console.error("[settle] unexpected error:", error instanceof Error ? error.message : error);
      return settleResponse({
        success: false,
        network,
        errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
        errorMessage: "settlement error",
      });
    }
  }

  /**
   * Build a read-only RpcProvider for a network, honoring the configured URL.
   *
   * @param network - The CAIP-2 network identifier
   * @returns An RpcProvider for the network
   */
  private buildProvider(network: Network): RpcProvider {
    if (this.config?.providerFactory) {
      return this.config.providerFactory(network);
    }
    return createStarknetProvider(network, this.config?.rpcUrl, this.config?.rpcTimeoutMs);
  }

  /**
   * Run the full facilitator verification ruleset. When `settlementPhase` is
   * true the verify-phase freshness lower band is skipped (remaining validity
   * necessarily shrinks between /verify and /settle) while the minimum-remaining
   * -window floor still applies.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The server-supplied payment requirements
   * @param provider - The Starknet read provider
   * @param settlementPhase - Whether this is a settlement-time re-verification
   * @returns The verification result with a bare enum reason on failure
   */
  private async runVerification(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    provider: RpcProvider,
    settlementPhase: boolean,
  ): Promise<VerifyResponse> {
    const now = Math.floor(Date.now() / 1000);
    const facilitatorFeePayers = this.signer.getAddresses();

    // --- Payload shape -------------------------------------------------------
    if (!isExactStarknetPayload(payload.payload, this.maxSignatureFelts)) {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, "malformed payment payload");
    }
    const inner = payload.payload;
    const payer = inner.from;
    const accepted = payload.accepted;
    // `accepted` arrives from the client over the wire, so its absence is a
    // malformed payload - not an internal error. Checked before any field read.
    if (!accepted || typeof accepted !== "object") {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, "payment payload is missing accepted");
    }

    // --- Version, scheme, and network ----------------------------------------
    if (payload.x402Version !== 2) {
      return invalid(CORE_REASONS.INVALID_X402_VERSION);
    }
    // `accepted` is client-supplied, so its values are never interpolated into a
    // diagnostic: the bare code already carries the meaning, and echoing
    // attacker-controlled text into whatever the resource server logs or renders
    // is gratuitous. Only facilitator-authored values appear in messages.
    if (requirements.scheme !== "exact" || accepted.scheme !== "exact") {
      return invalid(CORE_REASONS.INVALID_SCHEME, "expected scheme exact");
    }
    const expectedChainId = CHAIN_IDS[requirements.network];
    if (!expectedChainId) {
      return invalid(CORE_REASONS.INVALID_NETWORK, `unsupported network ${requirements.network}`);
    }
    if (accepted.network !== requirements.network) {
      return invalid(
        CORE_REASONS.INVALID_NETWORK,
        `accepted.network does not match ${requirements.network}`,
      );
    }

    // --- Requirements well-formedness and feePayer ---------------------------
    const shape = checkRequirementsShape(requirements);
    if ("rejection" in shape) return shape.rejection;
    const { requiredAmount } = shape;
    const feePayerCheck = checkFeePayer(requirements, payer, facilitatorFeePayers);
    if ("rejection" in feePayerCheck) return feePayerCheck.rejection;
    const { feePayer } = feePayerCheck;

    // --- accepted must match the server-supplied requirements field-by-field --
    const acceptedMismatch = checkAcceptedMatchesRequirements(accepted, requirements, feePayer);
    if (acceptedMismatch) return acceptedMismatch;

    if (!isValidStarknetAddress(payer)) {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, "bad sender address");
    }
    // Facilitator safety (spec rule 9): the payer must never be a
    // facilitator-managed feePayer - the facilitator would be signing away its
    // own tokens.
    if (facilitatorFeePayers.some(a => feltEquals(payer, a))) {
      return invalid(
        CORE_REASONS.INVALID_PAYLOAD,
        "payer must not be a facilitator-managed feePayer",
      );
    }

    // --- Typed data canonicalization -----------------------------------------
    const parsed = parseOutsideExecution(inner.outsideExecution.typedData);
    if (!parsed.ok) {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, parsed.reason);
    }
    const { chainId, message } = parsed;
    if (chainIdSafeToFelt(chainId) !== BigInt(expectedChainId)) {
      return invalid(
        CORE_REASONS.INVALID_NETWORK,
        `typed data chainId does not match ${requirements.network}`,
      );
    }

    // --- Payment intent and exactness (rule 7) ------------------------------
    const intentMismatch = checkPaymentIntent(message, requirements, requiredAmount);
    if (intentMismatch) return intentMismatch;

    // --- Caller binding (spec rule 4) ----------------------------------------
    // message.Caller MUST equal accepted.extra.feePayer. There is no sentinel
    // branch and no trusted-forwarder exception - any other value would revert
    // onchain and cannot be safely settled.
    if (!feltEquals(message.Caller, feePayer)) {
      return invalid(STARKNET_ERROR_REASONS.INVALID_CALLER, "Caller must equal extra.feePayer");
    }

    // --- Execution time window (spec rule 5) ---------------------------------
    const windowRejection = checkTimeWindow(message, requirements, now, settlementPhase);
    if (windowRejection) return windowRejection;

    // --- Onchain checks (fail closed on any RPC error) -----------------------
    // Independent reads run in parallel; failures are evaluated in rule order.
    //
    // Everything below queries the CANONICAL message, never the raw parse. The
    // two differ whenever a client sends a felt as a JSON number or a decimal
    // string, and the canonical form is the one that was hashed and that the
    // account's signature therefore covers - so asking the chain about the raw
    // form would check a nonce, and simulate a transfer, that no signature
    // authorized.
    let messageHash: string;
    let canonical: OutsideExecutionTypedData;
    try {
      canonical = buildCanonicalOutsideExecutionTypedData(chainId, message);
      messageHash = snTypedData.getMessageHash(canonical, payer);
    } catch {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, "cannot hash typed data");
    }

    // The four cheap reads run together. Simulation is deliberately NOT among
    // them: `starknet_simulateTransactions` over the full call tree is by far
    // the most expensive call in the flow, and /verify is unauthenticated, so
    // running it before the signature check would let anyone burn facilitator
    // node budget with forged payloads. It costs one extra round-trip on the
    // happy path.
    const [deployed, signature, nonce, balance] = await Promise.allSettled([
      provider.getClassHashAt(payer, READ_BLOCK),
      provider.callContract(
        {
          contractAddress: payer,
          entrypoint: "is_valid_signature",
          calldata: CallData.compile({
            hash: messageHash,
            signature: inner.outsideExecution.signature,
          }),
        },
        READ_BLOCK,
      ),
      provider.callContract(
        {
          contractAddress: payer,
          entrypoint: "is_valid_outside_execution_nonce",
          calldata: CallData.compile({ nonce: canonical.message.Nonce }),
        },
        READ_BLOCK,
      ),
      getBalance(provider, requirements.asset, payer),
    ]);
    const readRejection = classifyChainReads(
      { deployed, signature, nonce, balance },
      payer,
      requiredAmount,
    );
    if (readRejection) return readRejection;

    // Settlement simulation is mandatory (no disable switch) and runs only now
    // that the payload is authenticated. Only accounts the signer holds keys for
    // can originate the full call tree; a Caller bound to a forwarder
    // deterministically routes to the inner-transfer fallback.
    let simulationResult: SimulationResult;
    try {
      simulationResult = await simulateSettlement(
        provider,
        canonical.message,
        inner.outsideExecution.signature,
        payer,
        requirements,
        { originationSenders: this.signer.getOriginationSenders?.() ?? [] },
      );
    } catch {
      // Nothing was simulated, so this is not a verdict on the payment: it is
      // retryable, like every other fault.
      return invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "simulation errored", payer);
    }
    if (!simulationResult.ok) {
      // A simulation the node could not run is a fact about this facilitator,
      // not about the payment, so it is retryable rather than a verdict.
      if ("fault" in simulationResult) {
        return invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, simulationResult.reason, payer);
      }
      return invalid(STARKNET_ERROR_REASONS.SIMULATION_FAILED, simulationResult.reason, payer);
    }

    return { isValid: true, payer };
  }

  /**
   * Derive an authorization's identity from the payload alone, without any RPC
   * or signature check: its SNIP-12 message hash (the pending-settlement key),
   * its duplicate-guard key, and the transfer it authorizes. Returns undefined
   * for anything that does not parse, or whose typed data names a different
   * chain than the requirements - such a payload must never touch the store or
   * the guard, and is left to verification to reject.
   *
   * @param payload - The payment payload to identify
   * @param requirements - The server-supplied payment requirements
   * @returns The identity, or undefined when the payload cannot be identified
   */
  private identifyAuthorization(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): AuthorizationIdentity | undefined {
    if (!isExactStarknetPayload(payload.payload, this.maxSignatureFelts)) return undefined;
    const payer = payload.payload.from;
    if (!isValidStarknetAddress(payer)) return undefined;
    const parsed = parseOutsideExecution(payload.payload.outsideExecution.typedData);
    if (!parsed.ok) return undefined;
    const expectedChainId = CHAIN_IDS[requirements.network];
    if (!expectedChainId || chainIdSafeToFelt(parsed.chainId) !== BigInt(expectedChainId)) {
      return undefined;
    }
    try {
      const canonical = buildCanonicalOutsideExecutionTypedData(parsed.chainId, parsed.message);
      const messageHash = snTypedData.getMessageHash(canonical, payer);
      // The transfer is read from the CANONICAL call, the form the signature
      // covers; the raw parse may still carry decimal or numeric felts.
      const call = canonical.message.Calls[0];
      const amount = readTransferAmount(call.Calldata);
      if (amount === null) return undefined;
      return {
        payer,
        signature: payload.payload.outsideExecution.signature,
        canonical,
        message: canonical.message,
        // Normalized numerically: the hash is a felt, and the SDK's hex form
        // carries no padding guarantee across versions.
        pendingKey: BigInt(messageHash).toString(),
        guardKey: nonceKey(payer, canonical.message.Nonce),
        transfer: { asset: call.To, payTo: call.Calldata[0], amount },
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Reconcile a remembered broadcast, or re-verify, guard against duplicate
   * submissions, broadcast the signed OutsideExecution, and confirm the onchain
   * effect before reporting success.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The server-supplied payment requirements
   * @param provider - The Starknet read provider
   * @returns The settlement result
   */
  private async runSettlement(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    provider: RpcProvider,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const identity = this.identifyAuthorization(payload, requirements);

    if (identity) {
      // Fast path (spec settlement step 4): a prior settle attempt for this
      // exact authorization already broadcast a transaction whose confirmation
      // wait expired (settlement_pending). The resource server's single
      // automatic retry resends the identical payload, so check the
      // pending-settlement store before re-verifying or re-broadcasting and
      // reconcile against the already-broadcast transaction instead of
      // creating a second one. The key is the SNIP-12 message hash, so a hit
      // is by construction a payload this facilitator verified and broadcast.
      const pendingTx = await this.pendingStore.get(identity.pendingKey);
      if (pendingTx) {
        return this.reconcilePendingSettlement(provider, identity, pendingTx, network);
      }

      // Duplicate guard (spec Duplicate Settlement Mitigation, step 1): while a
      // settlement for this (payer, nonce) is unresolved, a repeat request is
      // rejected with `duplicate_settlement`. Consulted before re-verification
      // so a duplicate is shed before any RPC is spent. No `payer` on this
      // response: at this point the address is only the client's claim,
      // unverified by any onchain signature check (spec rule 9).
      this.cache.evictExpired(Math.floor(Date.now() / 1000));
      if (this.cache.isInFlight(identity.guardKey)) {
        return settleResponse({
          success: false,
          network,
          errorReason: STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
        });
      }
    }

    // Re-run all verification rules - never trust a prior /verify result.
    // Verification always simulates (the spec's mandatory pre-broadcast check).
    // Settlement phase: the verify-time freshness band is replaced by the
    // minimum-remaining-window check (spec Timeout Mapping).
    //
    // Every rejection here is terminal, `nonce_already_used` included: a
    // consumed nonce on a settle request that matched no remembered broadcast
    // is not this facilitator's lost response, and a settled SNIP-9 payload is
    // public (its signature sits in the settlement calldata), so answering it
    // with success would hand a scraped replay a fresh resource release.
    const verification = await this.runVerification(payload, requirements, provider, true);
    if (!verification.isValid) {
      return settleResponse({
        success: false,
        network,
        errorReason: verification.invalidReason,
        payer: verification.payer,
      });
    }
    // runVerification guarantees the payload shape, that the typed data parses
    // and that it names this network, so identification cannot fail here.
    if (!identity) {
      return settleResponse({
        success: false,
        network,
        errorReason: CORE_REASONS.INVALID_PAYLOAD,
      });
    }

    const { payer, guardKey } = identity;
    const nowSec = Math.floor(Date.now() / 1000);
    this.cache.evictExpired(nowSec);
    if (this.cache.isInFlight(guardKey)) {
      return settleResponse({
        success: false,
        network,
        errorReason: STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
        payer,
      });
    }
    // Guard held until the authorization can no longer execute even with
    // sequencer-timestamp lag (spec mitigation step 3).
    this.cache.hold(guardKey, Number(identity.message["Execute Before"]) + SKEW_MARGIN_SECONDS);

    const broadcast = await this.broadcast(identity, network);
    if ("response" in broadcast) return broadcast.response;

    // Finality + execution status + actual effect. ACCEPTED_ON_L2 alone is not
    // success (a tx can be accepted and REVERTED), and SUCCEEDED alone is not
    // success either - the receipt MUST show the exact payer → payTo transfer
    // (merchant-truth: the payer's own account could execute differently at
    // settlement than in the verify-time simulation).
    const confirmation = await confirmExecution(
      provider,
      broadcast.transactionHash,
      payer,
      identity.transfer,
      this.confirmationTimeoutMs,
    );
    return this.resolveConfirmation(confirmation, broadcast.transactionHash, identity, network);
  }

  /**
   * Submit the canonical reconstruction - exactly what the signature was
   * verified against - through the facilitator signer, classifying a failed
   * submission as definitive (guard released, retry allowed) or unresolved
   * (guard kept, no re-broadcast).
   *
   * @param identity - The verified authorization to broadcast
   * @param network - The CAIP-2 network identifier
   * @returns The broadcast hash, or the failure response to return
   */
  private async broadcast(
    identity: AuthorizationIdentity,
    network: Network,
  ): Promise<{ transactionHash: string } | { response: SettleResponse }> {
    const { payer, guardKey } = identity;
    const failed = (errorMessage: string): { response: SettleResponse } => ({
      response: settleResponse({
        success: false,
        network,
        errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
        errorMessage,
        payer,
      }),
    });
    try {
      const result = await this.signer.executeFromOutside(
        { payer, typedData: identity.canonical, signature: identity.signature },
        network,
      );
      const transactionHash = result.transactionHash;
      // The signer may be third-party infrastructure (a SNIP-29 paymaster), so
      // what it returns is untrusted input. An unchecked value flows into RPC
      // reads, the server log, and the wire `transaction` field, and would also
      // burn the confirmation deadline while holding the duplicate guard.
      if (!transactionHash || !isFeltString(transactionHash) || !isFieldElement(transactionHash)) {
        this.cache.release(guardKey); // definitive broadcast failure - allow retries
        return failed("settlement submission failed");
      }
      return { transactionHash };
    } catch (error) {
      // Log full detail server-side; return a generic message so raw
      // paymaster/RPC internals are not leaked over the wire.
      console.error(
        "[settle] execute_from_outside failed:",
        error instanceof Error ? error.message : error,
      );
      // A timeout or abort is NOT a definitive failure: the request may have
      // reached the paymaster and the transaction may still land. Releasing the
      // guard on it would invite a retry that broadcasts the same authorization
      // a second time. Hold the guard instead - it is TTL-bounded at
      // `Execute Before`, past which the authorization can no longer execute.
      // The outcome is as unresolved as an unconfirmed broadcast, but
      // `settlement_pending` MUST carry a transaction hash (x402 v2 §9) and none
      // exists here, so the wire code is the standard settle error; a repeat
      // request inside the guard window is answered `duplicate_settlement`, and
      // once the guard lapses a retry fails verification on the expired window
      // or the consumed nonce - terminal either way. Matched by type, not by
      // name: starknet's transports rethrow `LibraryError` untouched but rewrap
      // every other rejection as a plain `Error(message)`, so only
      // `timeoutFetch`'s own `TimeoutError` (a `LibraryError`) arrives intact.
      if (error instanceof TimeoutError) {
        return failed(
          "settlement submission timed out - the authorization is held against re-broadcast until its window lapses",
        );
      }
      this.cache.release(guardKey); // definitive broadcast failure - allow retries
      return failed("settlement submission failed");
    }
  }

  /**
   * Handle a pending-settlement store hit: wait on the remembered broadcast
   * and apply the same confirmation rules as a fresh one. The entry is removed
   * before reconciling (rather than after) so a concurrent retry of the same
   * payload misses here instead of also reconciling; the synchronous
   * `reconciling` set closes the gap between the store's `get` and `delete`.
   *
   * @param provider - The Starknet read provider
   * @param identity - The authorization the retry carries
   * @param transactionHash - The transaction hash remembered for it
   * @param network - The CAIP-2 network identifier
   * @returns The settlement result
   */
  private async reconcilePendingSettlement(
    provider: RpcProvider,
    identity: AuthorizationIdentity,
    transactionHash: string,
    network: Network,
  ): Promise<SettleResponse> {
    const { pendingKey, payer } = identity;
    // Payer-less like every other duplicate_settlement: the response shape
    // must not depend on whether this request's store read raced the
    // reconciler's delete.
    if (this.reconciling.has(pendingKey)) {
      return settleResponse({
        success: false,
        network,
        errorReason: STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
      });
    }
    this.reconciling.add(pendingKey);
    try {
      await this.pendingStore.delete(pendingKey);
      const confirmation = await confirmExecution(
        provider,
        transactionHash,
        payer,
        identity.transfer,
        this.confirmationTimeoutMs,
      );
      return await this.resolveConfirmation(confirmation, transactionHash, identity, network);
    } finally {
      this.reconciling.delete(pendingKey);
    }
  }

  /**
   * Map a confirmation outcome to the wire response, keeping the duplicate
   * guard and the pending-settlement store consistent with it: a revert
   * releases the guard (the nonce rolled back, so the authorization is
   * retryable), a mismatch keeps it (the nonce is spent), and an unresolved
   * confirmation records the hash for the caller's retry.
   *
   * @param confirmation - The classified confirmation result
   * @param transactionHash - The transaction that was waited on
   * @param identity - The authorization being settled
   * @param network - The CAIP-2 network identifier
   * @returns The settlement result
   */
  private async resolveConfirmation(
    confirmation: ConfirmationResult,
    transactionHash: string,
    identity: AuthorizationIdentity,
    network: Network,
  ): Promise<SettleResponse> {
    const { payer, guardKey } = identity;
    switch (confirmation.status) {
      case "succeeded":
        return settleResponse({
          success: true,
          transaction: transactionHash,
          network,
          payer,
          amount: identity.transfer.amount.toString(),
        });
      case "effect-mismatch":
        // The tx succeeded and consumed the nonce, but did not emit the expected
        // transfer - the authorization is spent, so no retry. The resource
        // server must NOT release the resource.
        return settleResponse({
          success: false,
          transaction: transactionHash,
          network,
          errorReason: CORE_REASONS.INVALID_TRANSACTION_STATE,
          errorMessage: `Transaction ${transactionHash} did not transfer the required amount`,
          payer,
        });
      case "reverted":
        // A revert rolls back the SNIP-9 nonce onchain - the signed authorization
        // is still valid, so allow the client to retry the same payment.
        this.cache.release(guardKey);
        return settleResponse({
          success: false,
          transaction: transactionHash,
          network,
          errorReason: CORE_REASONS.INVALID_TRANSACTION_STATE,
          errorMessage: `Transaction ${transactionHash} reverted`,
          payer,
        });
      case "indeterminate":
        return this.recordPendingSettlement(
          confirmation.detail,
          transactionHash,
          identity,
          network,
        );
    }
  }

  /**
   * Broadcast succeeded but confirmation could not be established. The transfer
   * may still land, so this is NON-TERMINAL: surface the tx hash under the
   * distinct `settlement_pending` code and remember it, so the caller's retry of
   * the identical payload reconciles against it rather than re-broadcasting.
   * The duplicate guard stays held meanwhile. If the hash cannot be persisted,
   * a retry would have nothing to reconcile against and would be told
   * `duplicate_settlement` or a consumed nonce instead, so the outcome is
   * downgraded to a terminal error that still carries the hash for manual
   * reconciliation. Detail is logged server-side, not leaked.
   *
   * @param detail - Why confirmation could not be established
   * @param transactionHash - The broadcast transaction hash
   * @param identity - The authorization being settled
   * @param network - The CAIP-2 network identifier
   * @returns The `settlement_pending` response, or the downgraded failure
   */
  private async recordPendingSettlement(
    detail: string,
    transactionHash: string,
    identity: AuthorizationIdentity,
    network: Network,
  ): Promise<SettleResponse> {
    const { payer, pendingKey } = identity;
    console.error(`[settle] indeterminate confirmation for ${transactionHash}: ${detail}`);
    try {
      await this.pendingStore.set(pendingKey, transactionHash);
    } catch (storeError) {
      console.error(
        "[settle] failed to persist pending settlement:",
        storeError instanceof Error ? storeError.message : storeError,
      );
      return settleResponse({
        success: false,
        transaction: transactionHash,
        network,
        errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
        errorMessage: "confirmation pending, but the transaction could not be recorded for retry",
        payer,
      });
    }
    return settleResponse({
      success: false,
      transaction: transactionHash,
      network,
      errorReason: STARKNET_ERROR_REASONS.SETTLEMENT_PENDING,
      errorMessage:
        "confirmation pending - retry with the same payload to reconcile the transaction",
      payer,
    });
  }
}

/**
 * Whether a receipt describes a transaction that is in a block, rather than one
 * still sitting in the pending block. Fails closed when finality cannot be read.
 *
 * @param receipt - The transaction receipt as returned by starknet.js
 * @returns True when the transaction is accepted on L2 (or L1) and in a block
 */
function isFinalized(receipt: GetTransactionReceiptResponse): boolean {
  const direct = receipt as Partial<{ finality_status: string; block_number: number }>;
  const wrapped = receipt as Partial<{
    value: Partial<{ finality_status: string; block_number: number }>;
  }>;
  const finality = direct.finality_status ?? wrapped.value?.finality_status;
  const blockNumber = direct.block_number ?? wrapped.value?.block_number;
  const accepted = finality === "ACCEPTED_ON_L2" || finality === "ACCEPTED_ON_L1";
  return accepted && typeof blockNumber === "number";
}

type ConfirmationResult =
  | { status: "succeeded" }
  | { status: "reverted" }
  | { status: "effect-mismatch" }
  | { status: "indeterminate"; detail: string };

/**
 * Wait for finality, then confirm both the execution status and the actual
 * effect. Success requires the transaction to be IN A BLOCK, its
 * `execution_status` to be SUCCEEDED, and its receipt to carry exactly the
 * expected payer → payTo transfer (spec settlement step 6: RPC acceptance or
 * pending status is never sufficient to release the resource).
 *
 * A single poller, bounded by a wall-clock deadline, owns the whole wait, and no
 * SDK wait helper may be started alongside it: those cannot be cancelled, so one
 * abandoned by a deadline keeps querying the node for the life of the process.
 * The deadline must be wall-clock rather than a retry count, because a node
 * steadily answering "still pending" never consumes retries.
 *
 * @param provider - The Starknet read provider
 * @param transactionHash - The broadcast settlement transaction hash
 * @param payer - The payer account contract address
 * @param expected - The transfer the signed authorization performs (asset, payTo, amount)
 * @param timeoutMs - Wall-clock budget for the wait
 * @returns The classified confirmation result
 */
async function confirmExecution(
  provider: RpcProvider,
  transactionHash: string,
  payer: string,
  expected: ExpectedTransfer,
  timeoutMs: number,
): Promise<ConfirmationResult> {
  const deadlineAt = Date.now() + timeoutMs;
  let lastError = "unknown";

  for (;;) {
    try {
      const receipt = await provider.getTransactionReceipt(transactionHash);
      const executionStatus = readExecutionStatus(receipt);
      if (executionStatus === "REVERTED") {
        // Acted on only once the receipt is in a block (settlement step 3 before
        // step 4): a pre-confirmed revert is not yet an outcome, and releasing
        // the guard on it would invite a re-broadcast while the first is still
        // unresolved.
        if (isFinalized(receipt)) return { status: "reverted" };
        lastError = "transaction reverted but is not yet in a block";
      } else if (executionStatus === "SUCCEEDED") {
        // A SUCCEEDED execution status on a pending-block receipt is not yet a
        // settled payment: require block inclusion.
        if (!isFinalized(receipt)) {
          lastError = "transaction is not yet in a block";
        } else {
          // Confirm the actual effect: the receipt MUST carry exactly the expected transfer.
          const effect = assertExactTransfer(
            readReceiptEvents(receipt),
            expected.asset,
            payer,
            expected.payTo,
            expected.amount,
          );
          return effect.ok ? { status: "succeeded" } : { status: "effect-mismatch" };
        }
      } else {
        lastError = `execution_status=${executionStatus ?? "unknown"}`;
      }
    } catch (error) {
      // A hash the node has not indexed yet reads as an error; keep polling.
      lastError = error instanceof Error ? error.message : "getTransactionReceipt failed";
    }
    if (Date.now() >= deadlineAt) return { status: "indeterminate", detail: lastError };
    await sleep(CONFIRM_RETRY_INTERVAL_MS);
  }
}

/**
 * Pause between confirmation polls.
 *
 * The timer is deliberately NOT unref-ed: by the time it runs, the settlement
 * transaction is already broadcast, and letting the process exit mid-wait would
 * abandon a payment that is landing onchain without ever reporting its outcome.
 * The wait is bounded by the confirmation deadline, so it cannot hang forever.
 *
 * @param ms - How long to wait, in milliseconds
 * @returns A promise resolving once the interval elapses
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read `execution_status` from a receipt. starknet.js returns either the raw
 * receipt or a `{ value }` wrapper depending on the call path, so both shapes
 * are read.
 *
 * @param receipt - The transaction receipt as returned by starknet.js
 * @returns The execution status, or undefined when absent
 */
function readExecutionStatus(receipt: GetTransactionReceiptResponse): string | undefined {
  const direct = receipt as Partial<{ execution_status: string }>;
  const wrapped = receipt as Partial<{ value: Partial<{ execution_status: string }> }>;
  return direct.execution_status ?? wrapped.value?.execution_status;
}

/**
 * Read the event list from a receipt, tolerating the same two shapes as
 * {@link readExecutionStatus}.
 *
 * @param receipt - The transaction receipt as returned by starknet.js
 * @returns The receipt's events, or an empty list when absent
 */
function readReceiptEvents(receipt: GetTransactionReceiptResponse): EventLike[] {
  const direct = receipt as Partial<{ events: EventLike[] }>;
  const wrapped = receipt as Partial<{ value: Partial<{ events: EventLike[] }> }>;
  return direct.events ?? wrapped.value?.events ?? [];
}
