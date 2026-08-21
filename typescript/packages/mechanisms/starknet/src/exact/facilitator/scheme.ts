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
 */

import {
  CallData,
  RpcError,
  TimeoutError,
  type GetTransactionReceiptResponse,
  type RpcProvider,
  hash,
  num,
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
  ANY_CALLER,
  CHAIN_IDS,
  STARKNET_ADDRESS_REGEX,
  MAX_SIGNATURE_FELTS,
  MIN_REMAINING_WINDOW_SECONDS,
  READ_BLOCK,
  SKEW_MARGIN_SECONDS,
  STARK_PRIME,
  STARKNET_ERROR_REASONS,
  TRANSFER_EVENT_SELECTOR,
  TRANSFER_SELECTOR,
  U128_MAX,
  VALID_SIGNATURE_MAGIC,
} from "../../constants";
import type { ExactStarknetPayload } from "../../types";
import {
  buildCanonicalOutsideExecutionTypedData,
  parseOutsideExecution,
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
  containsExactTransfer,
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

/**
 * Floor on the rescue's scan window, and the span the block-time probe measures
 * over. The window itself is derived from elapsed TIME (see
 * {@link rescueScanFromBlock}) because a fixed block count silently shrinks in
 * wall-clock terms every time the chain gets faster.
 */
const RESCUE_SCAN_BLOCKS = 500;

/**
 * Ceiling on the derived window. `starknet_getEvents` may refuse a range that
 * reaches too far back (`TOO_MANY_BLOCKS_BACK`), and an unbounded range would
 * also be an unbounded read. Reaching this is reported rather than silently
 * truncating the search.
 */
const RESCUE_SCAN_MAX_BLOCKS = 20_000;

/** Slack added to the measured span, covering clock skew and the probe's own error. */
const RESCUE_SCAN_MARGIN_SECONDS = 15 * 60;

/**
 * Sub-window width for the legacy-layout pass, whose filter cannot push
 * payer/payTo down to the node. `starknet_getEvents` returns events ASCENDING
 * from `from_block`, so one wide range would spend the whole page budget on the
 * window's OLDEST events; the pass instead walks sub-windows this wide from the
 * head BACKWARD, so coverage is newest-first and each sub-window is small
 * enough that ascending order inside it cannot starve the budget.
 */
const RESCUE_LEGACY_SCAN_BLOCKS = 50;

/** Total getEvents calls the legacy backward walk may spend. */
const RESCUE_LEGACY_MAX_CALLS = 6;

/** Pages of 100 events each pass will read before giving up. */
const RESCUE_SCAN_PAGES = 3;

/** The SNIP-9 v2 entry point a settlement transaction calls on the payer. */
const EXECUTE_FROM_OUTSIDE_V2_SELECTOR = hash.getSelectorFromName("execute_from_outside_v2");

/** Poll interval for post-broadcast confirmation. */
const CONFIRM_RETRY_INTERVAL_MS = 1500;

/**
 * Wall-clock budget for post-broadcast confirmation. Past this the settlement
 * resolves to the non-terminal `settlement_pending` outcome carrying the
 * transaction hash, so the caller reconciles onchain instead of the request
 * hanging on a stuck transaction.
 */
const CONFIRM_DEADLINE_MS = 120_000;

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
 * How long ago this facilitator attempted the authorization, in seconds. The
 * consuming transaction cannot be older than that (plus the margin the scan
 * adds), so it is what bounds the rescue's search window.
 *
 * @param cache - The settlement bookkeeping holding the attempt record
 * @param key - The composite `payer:nonce` key
 * @returns Seconds since the attempt, or 0 when none is on record
 */
function elapsedSinceAttempt(cache: SettlementCache, key: string): number {
  const at = cache.attemptedAt(key);
  if (at === undefined) return 0;
  return Math.max(0, Math.floor(Date.now() / 1000) - at);
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

/**
 * Starknet facilitator implementation for the `exact` payment scheme.
 */
export class ExactStarknetScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "starknet:*";

  /**
   * Settlement bookkeeping. Defaults to an instance-scoped cache so two
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

  /** Signature-length bound applied to every payload this facilitator reads. */
  private readonly maxSignatureFelts: number;

  /**
   * Creates a new ExactStarknetScheme facilitator.
   *
   * @param signer - The facilitator signer that announces feePayers and settles
   * @param config - Optional RPC URL override and L1-finality preference
   * @param config.rpcUrl - Custom JSON-RPC URL, per network resolution otherwise
   * @param config.requireL1Finality - Require ACCEPTED_ON_L1 before reporting
   *   success. L1 acceptance takes hours, past the confirmation deadline, so a
   *   settlement resolves to `settlement_pending` and a later retry of the same
   *   payload reports success once the transaction is L1-final, for as long as
   *   the attempt record is retained
   * @param config.providerFactory - Supplies the read provider, for a custom
   *   transport, retry policy, or an injected provider in tests. Supplying one
   *   opts out of `rpcTimeoutMs`: the factory owns the transport
   * @param config.rpcTimeoutMs - Per-request timeout for RPC reads
   * @param config.maxSignatureFelts - Upper bound on the felt-array signature
   *   length. The default admits multisig and guardian accounts; raise it to
   *   serve webauthn/passkey accounts, whose signatures are considerably longer
   * @param settlementCache - Optional shared settlement bookkeeping
   */
  constructor(
    private readonly signer: FacilitatorStarknetSigner,
    private readonly config?: {
      rpcUrl?: string;
      requireL1Finality?: boolean;
      providerFactory?: (network: Network) => RpcProvider;
      rpcTimeoutMs?: number;
      maxSignatureFelts?: number;
    },
    settlementCache?: SettlementCache,
  ) {
    this.cache = settlementCache ?? new SettlementCache();
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
   * Settle a payment: re-verify, guard duplicates, broadcast, and confirm.
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

    // --- Requirements well-formedness ----------------------------------------
    // Fail closed on malformed requirements - never let a missing field silently
    // disable a dependent check (e.g. a NaN window bound).
    // Integer, not merely finite: `Execute Before` is a felt, so a fractional
    // window is unsignable and the defect belongs to the 402 that advertised it.
    if (
      typeof requirements.maxTimeoutSeconds !== "number" ||
      !Number.isInteger(requirements.maxTimeoutSeconds) ||
      requirements.maxTimeoutSeconds <= 0
    ) {
      return invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "invalid maxTimeoutSeconds");
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
      return invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        `maxTimeoutSeconds must exceed ${MIN_REMAINING_WINDOW_SECONDS}s`,
      );
    }
    let requiredAmount: bigint;
    try {
      requiredAmount = parseAmount(requirements.amount);
      if (requiredAmount <= 0n) throw new Error("non-positive");
    } catch {
      return invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "invalid amount in payment requirements",
      );
    }
    // Without these, a malformed asset/payTo makes feltEquals return false and
    // the defect surfaces at the accepted-vs-requirements comparison as
    // invalid_payload - blaming the client for the server's own bad 402.
    if (!isValidStarknetAddress(requirements.asset)) {
      return invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "invalid asset address");
    }
    if (!isValidStarknetAddress(requirements.payTo)) {
      return invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "invalid payTo address");
    }

    // --- feePayer (merged spec: required SNIP-9 Caller) ----------------------
    const feePayerRaw = requirements.extra?.feePayer;
    // Shape only here, so the specific zero / sentinel diagnostics below stay
    // reachable. An out-of-range value is caught by the membership check at the
    // end of this block: it cannot be an address this facilitator manages.
    if (typeof feePayerRaw !== "string" || !STARKNET_ADDRESS_REGEX.test(feePayerRaw)) {
      return invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer missing or invalid",
      );
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
      return invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "extra.feePayer must not be zero");
    }
    if (feltEquals(feePayer, ANY_CALLER)) {
      return invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer must not be the ANY_CALLER sentinel",
      );
    }
    if (feltEquals(feePayer, payer)) {
      return invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer must not equal the payer",
      );
    }
    // Range-checked here rather than in the shape gate above, so the zero and
    // sentinel diagnostics stay reachable while an out-of-field value is still
    // blamed on the requirements that carried it.
    if (!isFieldElement(feePayer)) {
      return invalid(CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS, "extra.feePayer is out of range");
    }
    // Facilitator safety (spec rules 1/9): only announce/accept a feePayer this
    // facilitator can itself settle through. A stale or foreign value would
    // produce an authorization only some other party could execute.
    if (!facilitatorFeePayers.some(a => feltEquals(feePayer, a))) {
      return invalid(
        CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS,
        "extra.feePayer is not managed by this facilitator",
      );
    }

    // --- accepted must match the server-supplied requirements field-by-field --
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

    // --- Payment intent and exactness ----------------------------------------
    // The single call and its three-felt calldata are structural, so the parser
    // has already enforced both.
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
    let amountLow: bigint;
    let amountHigh: bigint;
    try {
      amountLow = BigInt(calldata[1]);
      amountHigh = BigInt(calldata[2]);
    } catch {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, "unparsable transfer amount");
    }
    if (amountLow < 0n || amountHigh < 0n || amountLow > U128_MAX || amountHigh > U128_MAX) {
      return invalid(CORE_REASONS.INVALID_PAYLOAD, "non-canonical u256 limbs");
    }
    const callAmount = amountLow + (amountHigh << 128n);
    if (callAmount !== requiredAmount) {
      return invalid(
        STARKNET_ERROR_REASONS.AMOUNT_MISMATCH,
        `transfer amount ${callAmount}, required ${requiredAmount}`,
      );
    }

    // --- Caller binding (spec rule 4) ----------------------------------------
    // message.Caller MUST equal accepted.extra.feePayer. There is no sentinel
    // branch and no trusted-forwarder exception - any other value would revert
    // onchain and cannot be safely settled.
    if (!feltEquals(message.Caller, feePayer)) {
      return invalid(STARKNET_ERROR_REASONS.INVALID_CALLER, "Caller must equal extra.feePayer");
    }

    // --- Execution time window (spec rule 5) ---------------------------------
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
    const [deployed, sigResult, nonceResult, balanceResult] = await Promise.allSettled([
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

    // Every branch below distinguishes a STRUCTURED contract-level answer from a
    // transport fault. Both arrive here as a rejected promise, but they mean
    // opposite things: the contract answering "no such entry point" is a fact
    // about the payer's account, while a node timing out is the absence of an
    // answer. Reporting the latter as a domain verdict tells the client its
    // payment is defective when nothing about it was ever checked - and on the
    // settle path a nonce read that merely timed out would be reported as a
    // consumed nonce, permanently retiring an authorization that never executed.
    // Unclassified faults therefore fail closed as a retryable unexpected error.

    // account must be deployed
    if (deployed.status === "rejected") {
      return isRpcErrorOfType(deployed.reason, "CONTRACT_NOT_FOUND")
        ? invalid(STARKNET_ERROR_REASONS.ACCOUNT_NOT_DEPLOYED)
        : invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "account deployment check failed");
    }

    // signature over the canonical reconstruction - payer is trusted only once
    // this passes, so it is echoed on responses only from here on.
    if (sigResult.status === "rejected") {
      // Only a reverting call is evidence about the signature; the spec scopes
      // this verdict to the account rejecting it, not to an unreachable node.
      return isRpcErrorOfType(sigResult.reason, "CONTRACT_ERROR", "ENTRYPOINT_NOT_FOUND")
        ? invalid(STARKNET_ERROR_REASONS.INVALID_SIGNATURE, "onchain verification failed")
        : invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "signature check failed");
    }
    if (!feltEquals(sigResult.value[0], VALID_SIGNATURE_MAGIC)) {
      return invalid(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);
    }

    // replay protection: SNIP-9 nonce must be unused. An account that answers
    // structurally but has no SNIP-9 v2 entry point cannot be replay-protected
    // by this facilitator, so that case stays a terminal rejection.
    if (nonceResult.status === "rejected") {
      return isRpcErrorOfType(nonceResult.reason, "CONTRACT_ERROR", "ENTRYPOINT_NOT_FOUND")
        ? invalid(
            STARKNET_ERROR_REASONS.NONCE_ALREADY_USED,
            "nonce check failed (account may not support SNIP-9 v2)",
            payer,
          )
        : invalid(CORE_REASONS.UNEXPECTED_VERIFY_ERROR, "nonce check failed", payer);
    }
    if (!feltEquals(nonceResult.value[0], "0x1")) {
      return invalid(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED, undefined, payer);
    }

    // chain-state preflight: balance. A token exposing neither getter is a
    // requirements defect; an RPC failure fails closed.
    if (balanceResult.status === "rejected") {
      const reason =
        balanceResult.reason instanceof Error && balanceResult.reason.name === "NoBalanceGetter"
          ? CORE_REASONS.INVALID_PAYMENT_REQUIREMENTS
          : CORE_REASONS.UNEXPECTED_VERIFY_ERROR;
      return invalid(reason, "balance check failed", payer);
    }
    if (balanceResult.value < requiredAmount) {
      return invalid(
        CORE_REASONS.INSUFFICIENT_FUNDS,
        `balance ${balanceResult.value}, need ${requiredAmount}`,
        payer,
      );
    }

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
   * Re-verify, guard against duplicate submissions, broadcast the signed
   * OutsideExecution, and confirm the onchain effect before reporting success.
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
    const rawInner = payload.payload as { from?: unknown } | undefined;
    const payer = typeof rawInner?.from === "string" ? rawInner.from : "";

    // Duplicate guard FIRST (spec Duplicate Settlement Mitigation, step 1): while
    // a settlement for this (payer, nonce) is unresolved, a repeat request MUST
    // be rejected with `duplicate_settlement`. Consulting it only after
    // re-verification would answer a retry during the settlement_pending window
    // with a terminal code - the caller would stop reconciling a payment that may
    // still land. Cheap to check, so it also sheds duplicate load before the RPCs.
    const earlyParsed = parseOutsideExecution(
      (payload.payload as { outsideExecution?: { typedData?: unknown } } | undefined)
        ?.outsideExecution?.typedData,
    );
    if (earlyParsed.ok && isValidStarknetAddress(payer)) {
      this.cache.evictExpired(Math.floor(Date.now() / 1000));
      const key = nonceKey(payer, earlyParsed.message.Nonce);
      // While the guard holds - whether the settlement is still confirming or
      // already succeeded - every repeat request is a duplicate (spec Duplicate
      // Settlement Mitigation, step 1). Answering success for a repeat inside
      // the guard window would let one payment release the resource N times.
      // After eviction a legitimate retry re-enters verification, fails on the
      // consumed nonce, and the rescue path re-authenticates the payload before
      // resolving idempotently - so a lost success response is recoverable
      // without ever trusting the cache alone.
      if (this.cache.isInFlight(key)) {
        // No `payer` on this response: at this point the address is only the
        // client's claim, unverified by any onchain signature check (spec rule 9
        // - echo the payer only once its signature has been independently
        // verified).
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
    const verification = await this.runVerification(payload, requirements, provider, true);
    const parsed = parseOutsideExecution(
      (payload.payload as { outsideExecution?: { typedData?: unknown } } | undefined)
        ?.outsideExecution?.typedData,
    );

    if (!verification.isValid) {
      // Consumed-nonce resolution (spec step 5): if the payment already executed
      // onchain, report success with the landed hash. NONCE_ALREADY_USED is
      // emitted only after verify's signature check; EXPIRED is emitted before
      // it, so a post-eviction retry of an expired-but-landed payload also routes
      // here. rescueLandedTransfer re-confirms authenticity itself, so a forged
      // or expired payload naming a victim's transfer can never rescue-succeed.
      const rescuable =
        verification.invalidReason === STARKNET_ERROR_REASONS.NONCE_ALREADY_USED ||
        verification.invalidReason === STARKNET_ERROR_REASONS.EXPIRED;
      if (
        rescuable &&
        parsed.ok &&
        isExactStarknetPayload(payload.payload, this.maxSignatureFelts)
      ) {
        const rescueKey = nonceKey(payer, parsed.message.Nonce);
        // The guard must be re-checked HERE, not only at entry: a concurrent
        // request can pass the early gate before the winner holds the guard,
        // then observe the consumed nonce once the winner's broadcast lands.
        // Without this check that straggler would rescue the winner's own
        // settlement and one payment would release the resource twice. When
        // the guard is held by this instance, the settlement is in flight or
        // settled - a repeat is a duplicate, full stop.
        if (this.cache.isInFlight(rescueKey)) {
          return settleResponse({
            success: false,
            network,
            errorReason: STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
            payer: verification.payer,
          });
        }
        // Only rescue an authorization THIS facilitator actually attempted. A
        // settled SNIP-9 payload is public - signature included, compiled into
        // the settlement transaction's calldata - so without this, anyone who
        // reads the chain could replay a completed payment and be handed a
        // fresh success. Caller binding means only this facilitator (or a
        // replica sharing its feePayer, which needs the shared store) can ever
        // consume the nonce, so no local attempt means this is not a retry.
        // Report what verification actually observed: EXPIRED short-circuits
        // before the onchain nonce read, so claiming nonce_already_used here
        // would assert a consumption this facilitator never checked.
        if (!this.cache.hasAttempted(rescueKey)) {
          return settleResponse({
            success: false,
            network,
            errorReason: verification.invalidReason,
            payer: verification.payer,
          });
        }
        const executedTx = await rescueLandedTransfer(
          provider,
          payer,
          parsed.chainId,
          parsed.message,
          payload.payload.outsideExecution.signature,
          requirements,
          this.cache,
          this.config?.requireL1Finality ?? false,
          elapsedSinceAttempt(this.cache, rescueKey),
        );
        if (executedTx) {
          // Re-checked after the search, not only at rescue entry: the search
          // is many RPC round-trips, and a concurrent settlement of a fresh
          // payload sharing this (payer, nonce) can hold the guard and land in
          // that window. Crediting now would report one payment twice.
          if (this.cache.isInFlight(rescueKey)) {
            return settleResponse({
              success: false,
              network,
              errorReason: STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
              payer: verification.payer,
            });
          }
          return settleResponse({
            success: true,
            transaction: executedTx,
            network,
            payer,
            amount: requirements.amount,
          });
        }
      }
      return settleResponse({
        success: false,
        network,
        errorReason: verification.invalidReason,
        payer: verification.payer,
      });
    }

    // runVerification guarantees the payload shape and that the typed data parses.
    if (!parsed.ok || !isExactStarknetPayload(payload.payload, this.maxSignatureFelts)) {
      return settleResponse({
        success: false,
        network,
        errorReason: CORE_REASONS.INVALID_PAYLOAD,
        payer,
      });
    }
    const inner = payload.payload;

    const nowSec = Math.floor(Date.now() / 1000);
    this.cache.evictExpired(nowSec);

    // Submit the canonical reconstruction - exactly what the signature was
    // verified against.
    const canonicalTypedData = buildCanonicalOutsideExecutionTypedData(
      parsed.chainId,
      parsed.message,
    );

    const key = nonceKey(payer, parsed.message.Nonce);
    if (this.cache.isInFlight(key)) {
      return settleResponse({
        success: false,
        network,
        errorReason: STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT,
        payer,
      });
    }
    // Guard held until the authorization can no longer execute even with
    // sequencer-timestamp lag (spec mitigation step 3).
    this.cache.hold(key, Number(parsed.message["Execute Before"]) + SKEW_MARGIN_SECONDS);

    let transactionHash: string;
    try {
      const result = await this.signer.executeFromOutside(
        { payer, typedData: canonicalTypedData, signature: inner.outsideExecution.signature },
        network,
      );
      transactionHash = result.transactionHash;
      // The signer may be third-party infrastructure (a SNIP-29 paymaster), so
      // what it returns is untrusted input. An unchecked value flows into RPC
      // reads, the server log, and the wire `transaction` field, and would also
      // burn the confirmation deadline while holding the duplicate guard.
      if (!transactionHash || !isFeltString(transactionHash) || !isFieldElement(transactionHash)) {
        this.cache.release(key); // definitive broadcast failure - allow retries
        return settleResponse({
          success: false,
          network,
          errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
          errorMessage: "settlement submission failed",
          payer,
        });
      }
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
      // `Execute Before`, and once it lapses the recorded attempt lets the
      // consumed-nonce rescue resolve whatever actually happened. The outcome is
      // as unresolved as an unconfirmed broadcast, but `settlement_pending` MUST
      // carry a transaction hash (x402 v2 §9) and none exists here, so the wire
      // code is the standard settle error; a repeat request inside the guard
      // window is answered `duplicate_settlement`. Matched by type, not by name:
      // starknet's transports rethrow `LibraryError` untouched but rewrap every
      // other rejection as a plain `Error(message)`, so only `timeoutFetch`'s
      // own `TimeoutError` (a `LibraryError`) arrives intact.
      if (error instanceof TimeoutError) {
        return settleResponse({
          success: false,
          network,
          errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
          errorMessage:
            "settlement submission timed out - the authorization is held against re-broadcast until its window lapses",
          payer,
        });
      }
      this.cache.release(key); // definitive broadcast failure - allow retries
      return settleResponse({
        success: false,
        network,
        errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
        errorMessage: "settlement submission failed",
        payer,
      });
    }

    // Finality + execution status + actual effect. ACCEPTED_ON_L2 alone is not
    // success (a tx can be accepted and REVERTED), and SUCCEEDED alone is not
    // success either - the receipt MUST show the exact payer → payTo transfer
    // (merchant-truth: the payer's own account could execute differently at
    // settlement than in the verify-time simulation).
    const confirmation = await confirmExecution(
      provider,
      transactionHash,
      payer,
      requirements,
      this.config?.requireL1Finality ?? false,
    );

    if (confirmation.status === "effect-mismatch") {
      // The tx succeeded and consumed the nonce, but did not emit the expected
      // transfer - the authorization is spent, so no retry. The resource server
      // must NOT release the resource.
      return settleResponse({
        success: false,
        transaction: transactionHash,
        network,
        errorReason: CORE_REASONS.INVALID_TRANSACTION_STATE,
        errorMessage: `Transaction ${transactionHash} did not transfer the required amount`,
        payer,
      });
    }

    if (confirmation.status === "reverted") {
      // Our transaction reverted. That rolls back the SNIP-9 nonce, so by
      // itself nothing executed. The only case worth rescuing is a race in
      // which some OTHER transaction executed this same authorization first
      // and ours reverted because the nonce was already gone.
      //
      // rescueLandedTransfer is the authenticated gate: it re-checks the
      // signature and, crucially, that the nonce really IS consumed onchain.
      // Scanning for a matching transfer without that check would credit any
      // unrelated payer -> payTo transfer of the right size to this payment.
      const executedTx = await rescueLandedTransfer(
        provider,
        payer,
        parsed.chainId,
        parsed.message,
        inner.outsideExecution.signature,
        requirements,
        this.cache,
        this.config?.requireL1Finality ?? false,
        elapsedSinceAttempt(this.cache, key),
      );
      if (executedTx && !feltEquals(executedTx, transactionHash)) {
        return settleResponse({
          success: true,
          transaction: executedTx,
          network,
          payer,
          amount: requirements.amount,
        });
      }
      // A revert rolls back the SNIP-9 nonce onchain - the signed authorization
      // is still valid, so allow the client to retry the same payment.
      this.cache.release(key);
      return settleResponse({
        success: false,
        transaction: transactionHash,
        network,
        errorReason: CORE_REASONS.INVALID_TRANSACTION_STATE,
        errorMessage: `Transaction ${transactionHash} reverted`,
        payer,
      });
    }

    if (confirmation.status === "indeterminate") {
      // Broadcast succeeded but confirmation could not be established. The
      // transfer may still land, so this is NON-TERMINAL: surface the tx hash
      // under a distinct settlement_pending code (not a plain failure) and keep
      // the nonce cached so a blind retry cannot double-submit. The caller MUST
      // reconcile the hash onchain before treating the payment as failed. A
      // later retry of the same payload resolves via findExecutedTransfer / the
      // onchain nonce for as long as the attempt record is retained. Detail is
      // logged server-side, not leaked.
      console.error(
        `[settle] indeterminate confirmation for ${transactionHash}: ${confirmation.detail}`,
      );
      return settleResponse({
        success: false,
        transaction: transactionHash,
        network,
        errorReason: STARKNET_ERROR_REASONS.SETTLEMENT_PENDING,
        errorMessage:
          "confirmation pending - reconcile the transaction hash onchain before retrying",
        payer,
      });
    }

    // Bind our own settled tx so it can never later be attributed to a different
    // nonce. A false here means the executor returned a hash already credited to
    // another authorization - one payment about to be counted twice - so it is
    // surfaced rather than silently dropped.
    if (!this.cache.bindTxToNonce(transactionHash, payer, parsed.message.Nonce)) {
      console.error(
        `[settle] refusing to credit ${transactionHash} to a second authorization for ${payer}`,
      );
      return settleResponse({
        success: false,
        network,
        errorReason: CORE_REASONS.UNEXPECTED_SETTLE_ERROR,
        errorMessage: "settlement transaction is already credited to another authorization",
        payer,
      });
    }
    return settleResponse({
      success: true,
      transaction: transactionHash,
      network,
      payer,
      amount: requirements.amount,
    });
  }
}

/**
 * Confirm - safely - that an authorization already executed onchain, and
 * return its transaction hash. Guards the consumed-nonce rescue: because a
 * verify-time rejection (EXPIRED) can precede verify's onchain signature check,
 * this independently re-confirms the payload is authentic (valid signature over
 * the canonical reconstruction) and its nonce is actually consumed before
 * treating any onchain transfer as this payment. Without it, /settle would
 * release a resource for a forged payload naming a victim's recent transfer.
 * Fails closed (null) on any check failure or RPC error.
 *
 * @param provider - The Starknet read provider
 * @param payer - The payer account contract address
 * @param chainId - The chain id felt from the parsed typed data
 * @param message - The parsed OutsideExecution message
 * @param signature - The felt-array signature over the canonical typed data
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @param cache - The instance's settlement bookkeeping, for the replay guard
 * @param requireL1Finality - Require ACCEPTED_ON_L1 on the consuming receipt
 * @param secondsToCover - How long ago this facilitator attempted the broadcast,
 *   which bounds how far back the consuming transaction can be
 * @returns The consuming transaction hash, or null when nothing safely matched
 */
async function rescueLandedTransfer(
  provider: RpcProvider,
  payer: string,
  chainId: string,
  message: OutsideExecutionMessage,
  signature: string[],
  requirements: PaymentRequirements,
  cache: SettlementCache,
  requireL1Finality: boolean,
  secondsToCover: number,
): Promise<string | null> {
  // The canonical form is what the signature covers, so it is also what the
  // nonce read and the event scan must ask about.
  const canonical = buildCanonicalOutsideExecutionTypedData(chainId, message);
  const canonicalNonce = canonical.message.Nonce;
  try {
    await provider.getClassHashAt(payer, READ_BLOCK); // must be deployed
    const messageHash = snTypedData.getMessageHash(canonical, payer);
    const sig = await provider.callContract(
      {
        contractAddress: payer,
        entrypoint: "is_valid_signature",
        calldata: CallData.compile({ hash: messageHash, signature }),
      },
      READ_BLOCK,
    );
    if (!feltEquals(sig[0], VALID_SIGNATURE_MAGIC)) return null;
    const nonce = await provider.callContract(
      {
        contractAddress: payer,
        entrypoint: "is_valid_outside_execution_nonce",
        calldata: CallData.compile({ nonce: canonicalNonce }),
      },
      READ_BLOCK,
    );
    if (feltEquals(nonce[0], "0x1")) return null; // still unused → nothing executed
  } catch {
    return null;
  }
  const executedTx = await findExecutedTransfer(
    provider,
    payer,
    requirements,
    canonical.message.Caller,
    canonicalNonce,
    requireL1Finality,
    secondsToCover,
  );
  if (!executedTx) return null;
  return cache.bindTxToNonce(executedTx, payer, canonicalNonce) ? executedTx : null;
}

/**
 * Best-effort search for the transaction that already executed THIS payment
 * (front-run / retry resolution, spec settlement step 5).
 *
 * The event scan only nominates candidates; nothing it finds is trusted on its
 * own. A candidate is accepted only after it (a) carries this payload's SNIP-9
 * nonce in its calldata, so a different same-amount payment cannot masquerade as
 * this one, and (b) has a receipt showing `execution_status` SUCCEEDED that
 * contains the expected Transfer. Without (b) a transaction still sitting in the
 * pending block - which may yet be dropped - would be reported as a completed
 * payment.
 *
 * Two passes, because no single key filter sees both Transfer layouts. RPC key
 * filters match by POSITION, so the keyed layout's indexed `from`/`to` can be
 * pushed to the node, while the legacy unkeyed layout carries both in `data` and
 * matches only on the selector. A selector-only filter alone would be a
 * correctness bug on an active asset: `starknet_getEvents` returns events in
 * ascending block order from `from_block`, so a bounded page budget would be
 * spent on the OLDEST transfers in the window and never reach this payment.
 *
 * @param provider - The Starknet read provider
 * @param payer - The payer account contract address
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @param caller - The SNIP-9 Caller this authorization is bound to
 * @param outsideExecutionNonce - The SNIP-9 nonce the consuming tx must carry
 * @param requireL1Finality - Require ACCEPTED_ON_L1 on the consuming receipt
 * @param secondsToCover - How far back in time the scan must reach
 * @returns The consuming transaction hash, or null when none matched
 */
async function findExecutedTransfer(
  provider: RpcProvider,
  payer: string,
  requirements: PaymentRequirements,
  caller: string,
  outsideExecutionNonce: string,
  requireL1Finality: boolean,
  secondsToCover: number,
): Promise<string | null> {
  try {
    const latest = await provider.getBlockNumber();
    const fromBlock = await rescueScanFromBlock(provider, latest, secondsToCover);

    // Pass 1 - keyed layout (`keys = [selector, from, to]`). The node does the
    // payer/payTo filtering, so the candidate stream is tiny and the whole
    // window fits in the page budget.
    const keyed = await scanForConsumingTx(
      provider,
      requirements,
      payer,
      caller,
      outsideExecutionNonce,
      requireL1Finality,
      {
        keys: [
          [TRANSFER_EVENT_SELECTOR],
          [num.toHex(BigInt(payer))],
          [num.toHex(BigInt(requirements.payTo))],
        ],
        fromBlock,
      },
    );
    if (keyed) return keyed;

    // Pass 2 - legacy unkeyed layout (`keys = [selector]`), which the filter
    // above structurally cannot match. Only the selector can be pushed down, so
    // the pass walks fixed-width sub-windows backward from the head, covering
    // as much of the same time-derived window as its call budget allows,
    // newest blocks first - the consuming transaction of a fresh retry sits
    // near the head, and an older one is still reached before the budget runs
    // out on unrelated early events.
    let hi = latest;
    for (let call = 0; call < RESCUE_LEGACY_MAX_CALLS && hi >= fromBlock; call++) {
      const lo = Math.max(fromBlock, hi - RESCUE_LEGACY_SCAN_BLOCKS + 1);
      const found = await scanForConsumingTx(
        provider,
        requirements,
        payer,
        caller,
        outsideExecutionNonce,
        requireL1Finality,
        { keys: [[TRANSFER_EVENT_SELECTOR]], fromBlock: lo, toBlock: hi, pages: 1 },
      );
      if (found) return found;
      hi = lo - 1;
    }
    return null;
  } catch {
    // best-effort only - fall through to the normal failure path
    return null;
  }
}

/**
 * Derive the first block a rescue scan must reach, from how far back in TIME the
 * consuming transaction could be.
 *
 * A fixed block count cannot express this: it is a wall-clock window only for
 * one particular block time, and Starknet's has been falling. The same 500
 * blocks that spanned hours at 30-second blocks span minutes at 2-second ones,
 * which would put a payment that really did land outside the search and report
 * it as unpaid.
 *
 * The chain's own recent pace is measured rather than assumed, over the probe
 * span. If the timestamps cannot be read the window falls back to the fixed
 * count, which is no worse than before.
 *
 * @param provider - The Starknet read provider
 * @param latest - The current head block number
 * @param secondsToCover - How far back in time the scan must reach
 * @returns The first block number to scan from
 */
async function rescueScanFromBlock(
  provider: RpcProvider,
  latest: number,
  secondsToCover: number,
): Promise<number> {
  const probeAt = Math.max(0, latest - RESCUE_SCAN_BLOCKS);
  if (probeAt === latest) return 0;

  let secondsPerBlock: number;
  try {
    const [head, probe] = await Promise.all([
      provider.getBlockWithTxHashes(latest),
      provider.getBlockWithTxHashes(probeAt),
    ]);
    const span = readBlockTimestamp(head) - readBlockTimestamp(probe);
    secondsPerBlock = span / (latest - probeAt);
    if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0) {
      return unpacedFromBlock(latest, secondsToCover);
    }
  } catch {
    return unpacedFromBlock(latest, secondsToCover);
  }

  const needed = Math.ceil((secondsToCover + RESCUE_SCAN_MARGIN_SECONDS) / secondsPerBlock);
  if (needed > RESCUE_SCAN_MAX_BLOCKS) {
    console.error(
      `[settle] rescue scan capped at ${RESCUE_SCAN_MAX_BLOCKS} blocks; ` +
        `covering ${secondsToCover}s at ${secondsPerBlock}s/block would need ${needed}`,
    );
  }
  const blocksBack = Math.min(Math.max(needed, RESCUE_SCAN_BLOCKS), RESCUE_SCAN_MAX_BLOCKS);
  return Math.max(0, latest - blocksBack);
}

/**
 * Fallback scan start when the chain's pace cannot be measured: assume the
 * fastest plausible block time (1s), so the window can only err wide - erring
 * narrow is what silently loses a landed payment. Still bounded by the cap.
 *
 * @param latest - The current head block number
 * @param secondsToCover - How far back in time the scan must reach
 * @returns The first block number to scan from
 */
function unpacedFromBlock(latest: number, secondsToCover: number): number {
  console.error("[settle] rescue scan window could not be sized from block timestamps");
  const widest = Math.ceil(secondsToCover + RESCUE_SCAN_MARGIN_SECONDS);
  const blocksBack = Math.min(Math.max(widest, RESCUE_SCAN_BLOCKS), RESCUE_SCAN_MAX_BLOCKS);
  return Math.max(0, latest - blocksBack);
}

/**
 * Read a block's timestamp.
 *
 * @param block - The block as returned by starknet.js
 * @returns The block timestamp in epoch seconds
 */
function readBlockTimestamp(
  block: Awaited<ReturnType<RpcProvider["getBlockWithTxHashes"]>>,
): number {
  const { timestamp } = block;
  if (typeof timestamp !== "number") throw new Error("block has no timestamp");
  return timestamp;
}

/**
 * Page one event filter, returning the first candidate that passes every gate.
 *
 * @param provider - The Starknet read provider
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @param payer - The payer account contract address
 * @param caller - The SNIP-9 Caller this authorization is bound to
 * @param outsideExecutionNonce - The SNIP-9 nonce the consuming tx must carry
 * @param requireL1Finality - Require ACCEPTED_ON_L1 on the consuming receipt
 * @param filter - The event filter to page over
 * @param filter.keys - Positional key filter for `starknet_getEvents`
 * @param filter.fromBlock - First block of the scan window
 * @param filter.toBlock - Last block of the scan window; latest accepted otherwise
 * @param filter.pages - Page budget for this filter; the default otherwise
 * @returns The consuming transaction hash, or null when none matched
 */
async function scanForConsumingTx(
  provider: RpcProvider,
  requirements: PaymentRequirements,
  payer: string,
  caller: string,
  outsideExecutionNonce: string,
  requireL1Finality: boolean,
  filter: { keys: string[][]; fromBlock: number; toBlock?: number; pages?: number },
): Promise<string | null> {
  const requiredAmount = BigInt(requirements.amount);
  const nonceFelt = BigInt(outsideExecutionNonce);
  const considered = new Set<string>();
  let continuationToken: string | undefined;

  for (let page = 0; page < (filter.pages ?? RESCUE_SCAN_PAGES); page++) {
    const chunk = await provider.getEvents({
      address: requirements.asset,
      keys: filter.keys,
      from_block: { block_number: filter.fromBlock },
      // Only accepted blocks: a pending transaction can still be dropped, and
      // reporting it as a completed payment would release the resource for a
      // payment that never lands. A numeric bound is itself an accepted block.
      to_block: filter.toBlock !== undefined ? { block_number: filter.toBlock } : "latest",
      chunk_size: 100,
      continuation_token: continuationToken,
    });
    for (const event of chunk.events ?? []) {
      const txHash = event.transaction_hash;
      if (!txHash || considered.has(txHash)) continue;
      if (
        !containsExactTransfer(
          [event],
          requirements.asset,
          payer,
          requirements.payTo,
          requiredAmount,
        )
      ) {
        continue;
      }
      considered.add(txHash);
      if (!(await transactionConsumedNonce(provider, txHash, payer, caller, nonceFelt))) continue;
      if (await transactionLandedTransfer(provider, txHash, payer, requirements, requireL1Finality))
        return txHash;
    }
    continuationToken = chunk.continuation_token;
    if (!continuationToken) break;
  }
  return null;
}

/**
 * Confirm a candidate transaction actually completed the payment: its receipt
 * must be FINALIZED (accepted into a block, not merely pending), report
 * `execution_status` SUCCEEDED, and contain the expected Transfer (containment,
 * per settlement step 5 - the transaction was not submitted by this settlement
 * attempt, so its other contents are not ours to constrain).
 *
 * The finality gate is what makes this safe to trust. `execution_status` alone
 * is SUCCEEDED on a pending-block receipt too, and a pending transaction can
 * still be dropped or reorged - reporting one as a completed payment would
 * release the resource for a payment that never lands.
 *
 * @param provider - The Starknet read provider
 * @param txHash - The candidate transaction hash
 * @param payer - The payer account contract address
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @param requireL1Finality - Require ACCEPTED_ON_L1, not merely ACCEPTED_ON_L2
 * @returns True when the receipt proves the payment landed
 */
async function transactionLandedTransfer(
  provider: RpcProvider,
  txHash: string,
  payer: string,
  requirements: PaymentRequirements,
  requireL1Finality: boolean,
): Promise<boolean> {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!isFinalized(receipt, requireL1Finality)) return false;
    if (readExecutionStatus(receipt) !== "SUCCEEDED") return false;
    return containsExactTransfer(
      readReceiptEvents(receipt),
      requirements.asset,
      payer,
      requirements.payTo,
      BigInt(requirements.amount),
    );
  } catch {
    return false;
  }
}

/**
 * Whether a receipt describes a transaction that is in a block, rather than one
 * still sitting in the pending block. Fails closed when finality cannot be read.
 *
 * @param receipt - The transaction receipt as returned by starknet.js
 * @param requireL1 - Require settlement on L1, not just acceptance on L2
 * @returns True when the transaction is accepted at the required depth
 */
function isFinalized(receipt: GetTransactionReceiptResponse, requireL1 = false): boolean {
  const direct = receipt as Partial<{ finality_status: string; block_number: number }>;
  const wrapped = receipt as Partial<{
    value: Partial<{ finality_status: string; block_number: number }>;
  }>;
  const finality = direct.finality_status ?? wrapped.value?.finality_status;
  const blockNumber = direct.block_number ?? wrapped.value?.block_number;
  const accepted = requireL1
    ? finality === "ACCEPTED_ON_L1"
    : finality === "ACCEPTED_ON_L2" || finality === "ACCEPTED_ON_L1";
  return accepted && typeof blockNumber === "number";
}

/**
 * Check whether a transaction actually executed THIS payload's authorization,
 * by locating the `execute_from_outside_v2` call frame in its execution trace.
 *
 * The trace is the right evidence: frames are call boundaries the node itself
 * executed, so the search works for every settlement topology - a direct
 * executor calling the payer, or a relayer routing through the paymaster's
 * forwarder contract - and cannot be satisfied by payer-chosen felts sitting at
 * the right offsets inside some unrelated call's arguments, the way a raw
 * calldata scan could.
 *
 * The frame's calldata head is the serialized OutsideExecution, `[caller,
 * nonce, ...]`. Matching the `caller` alongside the nonce is what makes this an
 * identity test: SNIP-9 nonces are per-account, so the payer can consume the
 * same nonce with a different authorization it signed itself - one naming
 * ANY_CALLER, say - and that is not the authorization the merchant was
 * promised.
 *
 * @param provider - The Starknet read provider
 * @param txHash - The candidate transaction hash
 * @param payer - The account the OutsideExecution must have executed on
 * @param caller - The SNIP-9 Caller this authorization is bound to
 * @param nonceFelt - The SNIP-9 nonce as a bigint
 * @returns True when the transaction consumed this authorization
 */
async function transactionConsumedNonce(
  provider: RpcProvider,
  txHash: string,
  payer: string,
  caller: string,
  nonceFelt: bigint,
): Promise<boolean> {
  try {
    const trace = (await provider.getTransactionTrace(txHash)) as {
      execute_invocation?: TraceCallFrame | { revert_reason: string };
    };
    const root = trace.execute_invocation;
    // A reverted trace consumed nothing; a missing one proves nothing.
    if (!root || typeof root !== "object" || "revert_reason" in root) return false;
    return frameExecutedAuthorization(root, payer, caller, nonceFelt);
  } catch {
    return false;
  }
}

/** The subset of a trace call frame the authorization search reads. */
interface TraceCallFrame {
  contract_address?: string;
  entry_point_selector?: string;
  calldata?: string[];
  calls?: TraceCallFrame[];
}

/**
 * Depth-first search for the frame proving this authorization executed:
 * `execute_from_outside_v2` on the payer, whose OutsideExecution argument
 * carries exactly this caller and nonce.
 *
 * @param frame - The trace call frame to search from
 * @param payer - The account the OutsideExecution must have executed on
 * @param caller - The SNIP-9 Caller this authorization is bound to
 * @param nonceFelt - The SNIP-9 nonce as a bigint
 * @returns True when a matching frame exists in this subtree
 */
function frameExecutedAuthorization(
  frame: TraceCallFrame,
  payer: string,
  caller: string,
  nonceFelt: bigint,
): boolean {
  if (
    frame.contract_address !== undefined &&
    frame.entry_point_selector !== undefined &&
    Array.isArray(frame.calldata) &&
    frame.calldata.length >= 2 &&
    feltEquals(frame.entry_point_selector, EXECUTE_FROM_OUTSIDE_V2_SELECTOR) &&
    feltEquals(frame.contract_address, payer) &&
    feltEquals(frame.calldata[0], caller) &&
    feltEquals(frame.calldata[1], nonceFelt)
  ) {
    return true;
  }
  return (frame.calls ?? []).some(c => frameExecutedAuthorization(c, payer, caller, nonceFelt));
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
 * @param requirements - The payment requirements (asset, payTo, amount)
 * @param requireL1Finality - Whether to wait for ACCEPTED_ON_L1
 * @returns The classified confirmation result
 */
async function confirmExecution(
  provider: RpcProvider,
  transactionHash: string,
  payer: string,
  requirements: PaymentRequirements,
  requireL1Finality: boolean,
): Promise<ConfirmationResult> {
  const deadlineAt = Date.now() + CONFIRM_DEADLINE_MS;
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
        // settled payment: require block inclusion (and L1 when configured).
        if (!isFinalized(receipt, requireL1Finality)) {
          lastError = "transaction is not yet in a block";
        } else {
          // Confirm the actual effect: the receipt MUST carry exactly the expected transfer.
          const effect = assertExactTransfer(
            readReceiptEvents(receipt),
            requirements.asset,
            payer,
            requirements.payTo,
            BigInt(requirements.amount),
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
