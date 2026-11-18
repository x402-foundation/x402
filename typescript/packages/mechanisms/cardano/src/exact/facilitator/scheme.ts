import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { randomBytes } from "node:crypto";
import {
  ASSET_TRANSFER_METHOD_DEFAULT,
  ASSET_TRANSFER_METHOD_MASUMI,
  ASSET_TRANSFER_METHOD_SCRIPT,
  CARDANO_NETWORKS,
  CANONICAL_CARDANO_ASSET_REGEX,
  ERR_AMOUNT_INSUFFICIENT,
  ERR_ASSET_MISMATCH,
  ERR_CHAIN_LOOKUP_FAILED,
  ERR_DUPLICATE_SETTLEMENT,
  ERR_EVIDENCE_UNAVAILABLE,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_INVALID_PAYLOAD,
  ERR_INVALID_SIGNATURE,
  ERR_MIN_UTXO_INSUFFICIENT,
  ERR_NETWORK_ID_MISMATCH,
  ERR_NETWORK_MISMATCH,
  ERR_NONCE_INVALID,
  ERR_NONCE_NOT_IN_INPUTS,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_POLICY_INVALID,
  ERR_RECIPIENT_MISMATCH,
  ERR_REQUIREMENTS_INVALID,
  ERR_SCRIPT_ADDRESS_MISMATCH,
  ERR_SETTLEMENT_FAILED,
  ERR_SETTLEMENT_DEFINITIVELY_REJECTED,
  ERR_SETTLEMENT_NOT_CONFIRMED,
  ERR_SETTLEMENT_PENDING,
  ERR_TRANSACTION_DECODE_FAILED,
  ERR_TRANSACTION_PHASE1_INVALID,
  ERR_TRANSACTION_PHASE2_INVALID,
  ERR_TRANSACTION_UNSIGNED,
  ERR_TTL_EXPIRED,
  ERR_TTL_TOO_FAR,
  ERR_UNSUPPORTED_SCHEME,
  ERR_VALIDITY_NOT_YET_VALID,
  getCardanoNetworkId,
  isCardanoNetwork,
  MAX_L1_CONFIRMATIONS,
  MIN_L1_CONFIRMATIONS,
  normalizeCardanoNetwork,
  POSITIVE_CANONICAL_AMOUNT_REGEX,
  SCHEME_EXACT,
} from "../../constants";
import { MAX_CARDANO_INPUT_LOOKUP_CONCURRENCY, MAX_CARDANO_TRANSACTION_INPUTS } from "../../limits";
import {
  confirmationsSatisfy,
  resolveCardanoPolicies,
  type ResolvedCardanoPolicies,
} from "../../policy";
import type {
  CardanoExtra,
  CardanoExtraScript,
  DecodedCardanoTransaction,
  ExactCardanoPayload,
} from "../../types";
import type {
  CardanoProtocolParameters,
  CardanoSettlementEvidence,
  CardanoUtxoSnapshot,
  FacilitatorCardanoSigner,
} from "../../signer";
import {
  decodeCardanoPayload,
  decodeCardanoTransaction,
  minUtxoLovelace,
  parseUtxoRef,
  slotToPosixMs,
} from "../../utils";
import {
  InMemoryCardanoSettlementStore,
  type CardanoSettlementClaimResult,
  type CardanoSettlementStore,
} from "../../settlementStore";
import { buildSignedTerms, computeTermsDigest } from "../masumi/digests";
import { validateMasumiExtra } from "../masumi/schema";
import {
  verifyMasumiLock,
  type MasumiDeploymentValidator,
  type MasumiRegistryValidator,
} from "../masumi/verify";
import { checkMinimumFee, checkValueConservation } from "./phase1";
import { scriptAddressMatches } from "./scriptAddress";

/**
 * Optional configuration knobs for the Cardano facilitator scheme.
 */
export interface ExactCardanoFacilitatorConfig {
  /**
   * Duplicate-settlement guard shared by every facilitator worker. Defaults to
   * a bounded process-local {@link InMemoryCardanoSettlementStore}, which is
   * right for a single-instance facilitator. A deployment running several
   * replicas without session affinity should supply a shared, atomically
   * updating implementation so a retry landing on another replica still
   * resumes the same transaction instead of broadcasting it again.
   */
  settlementStore?: CardanoSettlementStore;
  /**
   * If `true` the facilitator may settle on authenticated mempool evidence when
   * the selected `confirmationPolicy` allows it (`l1Confirmations: -1`). Default
   * is `false`: mempool inclusion can be rolled back, so the facilitator refuses
   * it regardless of policy unless the operator opts in.
   */
  acceptMempool?: boolean;
  /**
   * How long one `settle()` call waits for evidence to reach the selected
   * `confirmationPolicy` before returning `settlement_pending`. Defaults to
   * 75s: the whole `settle()` call, including verification and broadcast,
   * must finish inside the resource server's facilitator-client timeout
   * (`@x402/core` defaults to 90s), since a timed-out call is a terminal
   * failure there. Core retries `settle()` exactly once on the pending
   * outcome, so a payment has roughly twice this wait to reach the policy —
   * on preprod a single block gap of 80s followed by a 36s one has been
   * observed, which two 60s waits did not cover.
   */
  confirmationTimeoutMs?: number;
  /**
   * Interval between evidence polls while waiting for confirmations.
   */
  confirmationPollMs?: number;
  /**
   * Independently validates a Masumi registry claim on the selected network.
   * Without one, a non-empty `terms.agentIdentifier` is rejected rather than
   * taken on trust; unregistered sellers are unaffected.
   */
  validateRegistryClaim?: MasumiRegistryValidator;
  /** Explicitly approves a non-canonical Masumi V2 deployment. */
  validateCustomMasumiDeployment?: MasumiDeploymentValidator;
}

/** Default bounded wait for evidence inside one `settle()` call. */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 75_000;
/** Default interval between evidence polls. */
const DEFAULT_CONFIRMATION_POLL_MS = 5_000;
/**
 * Wall-clock grace after a transaction's TTL before an unobserved transaction
 * is declared expired: a transaction included in the TTL block itself is still
 * indexing for a few seconds after the slot has passed.
 */
const VALIDITY_CLOSE_GRACE_MS = 120_000;

/**
 * Joins an error and its nested `.cause` chain into a single message, so a
 * settlement failure reports the real node/provider reason (e.g. `BadInputsUTxO`)
 * instead of only a shallow wrapper like "Blockfrost submitTx failed". Total;
 * never throws.
 *
 * @param error - The thrown value.
 * @param maxDepth - Maximum `.cause` links to include.
 * @returns The joined message chain.
 */
function describeErrorChain(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < maxDepth; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/**
 * The pure, lookup-free view of a payment: decoded payload, transaction and policy.
 */
interface ResolvedPayment {
  payload: ExactCardanoPayload;
  decoded: DecodedCardanoTransaction;
  policies: ResolvedCardanoPolicies;
}

/**
 * Everything `verify()` resolved, so `settle()` does not redo the work.
 */
interface VerifiedPayment extends ResolvedPayment {
  payer: string;
}

/**
 * Cardano facilitator implementation for the Exact payment scheme.
 *
 * Enforces the "Facilitator Verification Rules" of
 * `specs/schemes/exact/scheme_exact_cardano.md` before accepting a payment,
 * then broadcasts the client's signed transaction and waits, bounded, for the
 * evidence the selected `confirmationPolicy` requires. Below that threshold it
 * returns `settlement_pending` with the transaction id; the resource server's
 * automatic retry resumes observing the same transaction, which is never
 * broadcast twice.
 *
 * The duplicate-settlement guard is keyed by the **canonical Cardano
 * transaction ID**, never by the serialized CBOR: witness sets and equally
 * valid encodings differ without changing the ledger transaction, so an
 * encoding-level key is trivially bypassed. The default store is process-local
 * and bounded; a multi-instance facilitator should share a durable
 * {@link CardanoSettlementStore} across its replicas.
 *
 * A settled transaction is deliberately not one-shot: the spec requires a paid
 * retry to repeat the exact original `PAYMENT-SIGNATURE` and the verifier to
 * "resume observation of the same canonical transaction ID", which a terminal
 * state would break. What this facilitator guarantees is that one transaction
 * is broadcast at most once and always reports the same ledger truth. Binding a
 * settled transaction to a *single protected operation* is the resource
 * server's job, which the spec assigns it explicitly: it keys its record by
 * canonical transaction ID for `default` and `script`, and by `termsDigest` for
 * `masumi` (already enforced here, so a Masumi payment cannot be reused across
 * two 402s — each carries a fresh `sellerNonce`).
 */
export class ExactCardanoScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_EXACT;
  readonly caipFamily = "cardano:*";

  private readonly settlementStore: CardanoSettlementStore;
  private readonly acceptMempool: boolean;
  private readonly confirmationTimeoutMs: number;
  private readonly confirmationPollMs: number;
  private readonly validateRegistryClaim?: MasumiRegistryValidator;
  private readonly validateCustomMasumiDeployment?: MasumiDeploymentValidator;

  /**
   * Creates a new Cardano facilitator scheme.
   *
   * @param signer - The facilitator signer / chain query implementation.
   * @param config - Optional configuration knobs.
   */
  constructor(
    private readonly signer: FacilitatorCardanoSigner,
    config: ExactCardanoFacilitatorConfig = {},
  ) {
    this.settlementStore = config.settlementStore ?? new InMemoryCardanoSettlementStore();
    this.acceptMempool = config.acceptMempool ?? false;
    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    this.confirmationPollMs = config.confirmationPollMs ?? DEFAULT_CONFIRMATION_POLL_MS;
    this.validateRegistryClaim = config.validateRegistryClaim;
    this.validateCustomMasumiDeployment = config.validateCustomMasumiDeployment;
  }

  /**
   * Returns the capabilities advertised in the `/supported` response: the
   * transfer methods this facilitator can service and the L1 confirmation range
   * it can settle.
   *
   * `/supported` only describes capabilities — the selected policy always comes
   * from the 402 requirements.
   *
   * @param _network - The Cardano network identifier (unused).
   * @returns The advertised capability block.
   */
  getExtra(_network: string): Record<string, unknown> | undefined {
    void _network;
    return {
      assetTransferMethods: [
        ASSET_TRANSFER_METHOD_DEFAULT,
        ASSET_TRANSFER_METHOD_MASUMI,
        ASSET_TRANSFER_METHOD_SCRIPT,
      ],
      // The client builds and signs the whole transaction, so it balances the
      // fee against its own inputs. This facilitator only broadcasts.
      areFeesSponsored: false,
      l1Confirmations: {
        // Mempool-only evidence is refused unless the operator opted in.
        minimum: this.acceptMempool ? MIN_L1_CONFIRMATIONS : 0,
        // Depth above canonical inclusion needs an evidence hook to read it.
        maximum: this.canAuthenticateEvidence() ? MAX_L1_CONFIRMATIONS : 0,
      },
    };
  }

  /**
   * Returns the addresses managed by this facilitator for the supplied
   * network. Used by the `/supported` response.
   *
   * @param _network - The Cardano network identifier.
   * @returns The list of facilitator addresses.
   */
  getSigners(_network: string): string[] {
    void _network;
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a Cardano payment against the supplied requirements.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements being fulfilled.
   * @returns A verify response describing success or failure.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this.runVerification(payload, requirements);
    return result.response;
  }

  /**
   * Settles a Cardano payment.
   *
   * The canonical transaction id is claimed first, then the payment is
   * re-verified and broadcast, and this facilitator waits (bounded by
   * `confirmationTimeoutMs`) for the evidence `confirmationPolicy` requires.
   * `success` is `true` only once that threshold is met; below it the response
   * is the non-terminal `settlement_pending`. A retry with the same payload
   * finds the claim already `submitted`, skips every pre-broadcast precondition
   * (the transaction has spent its own inputs by then) while still checking
   * that it pays these requirements, and resumes observing without ever
   * broadcasting again.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements.
   * @returns A settle response describing success, pending or failure.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = payload.accepted.network;
    const fail = (
      errorReason: string,
      transaction: string,
      errorMessage?: string,
    ): SettleResponse => ({
      success: false,
      errorReason,
      ...(errorMessage ? { errorMessage } : {}),
      transaction,
      network,
    });

    const resolved = this.resolvePaymentState(payload, requirements);
    if (!resolved.ok) return fail(resolved.reason, "", resolved.message);
    const { decoded, policies } = resolved.state;
    const txHash = decoded.txHash;
    const required = policies.confirmationPolicy.l1Confirmations;

    // Claim the canonical transaction id and optional Masumi terms digest in
    // one atomic store operation before any chain lookup, so two concurrent
    // calls cannot both pass verification and reach the node. Splitting these
    // writes can bind a quote without reserving its transaction when the store
    // reaches capacity.
    const ownerToken = randomBytes(16).toString("hex");
    const claim = await this.claimSettlement(
      txHash,
      ownerToken,
      this.masumiTermsDigest(requirements),
    );
    if (claim === "capacity-exceeded") {
      return fail(ERR_SETTLEMENT_FAILED, txHash, "the Cardano settlement store is at capacity");
    }
    if (claim === "terms-conflict") {
      return fail(
        ERR_DUPLICATE_SETTLEMENT,
        txHash,
        "termsDigest is already bound to another transaction",
      );
    }
    if (claim === "rejected") {
      return fail(
        ERR_SETTLEMENT_DEFINITIVELY_REJECTED,
        txHash,
        "this transaction was definitively rejected before ledger acceptance",
      );
    }
    if (claim === "in-flight") {
      return fail(ERR_DUPLICATE_SETTLEMENT, txHash);
    }

    if (claim === "submitted") {
      // The pending-settlement retry: this facilitator already broadcast this
      // exact transaction. Its inputs are spent by now, so the pre-broadcast
      // preconditions no longer apply — but it must still pay *these*
      // requirements, or a second resource server sharing the facilitator could
      // collect on someone else's payment.
      const recheck = await this.verifyBroadcast(payload, requirements);
      if (!recheck.isValid) {
        // A provider outage while re-reading a transaction this facilitator
        // already broadcast is not a verdict on the payment: keep the outcome
        // non-terminal so a later attempt can observe the transaction once the
        // lookup recovers, instead of failing a payment that may be landing.
        if (
          recheck.invalidReason === ERR_CHAIN_LOOKUP_FAILED ||
          recheck.invalidReason === ERR_NONCE_NOT_ON_CHAIN
        ) {
          return this.pendingResponse(
            { transaction: txHash, network, payer: recheck.payer ?? "" },
            {},
            `the chain lookup failed while resuming a broadcast transaction${
              recheck.invalidMessage ? `: ${recheck.invalidMessage}` : ""
            }`,
          );
        }
        return fail(recheck.invalidReason ?? "verification_failed", txHash, recheck.invalidMessage);
      }
      const evidence = await this.awaitEvidence(txHash, requirements.network, required);
      return this.evidenceResponse(
        evidence,
        network,
        required,
        { ...resolved.state, payer: recheck.payer ?? "" },
        true,
      );
    }

    // Fresh claim. Dispatched through `this` so a subclass that tightens
    // `verify()` also governs settlement. Nothing was broadcast yet, so a
    // rejection here releases the claim and a corrected attempt can start over.
    const verifyResult = await this.verify(payload, requirements);
    if (!verifyResult.isValid) {
      await this.releaseClaim(txHash, ownerToken);
      return fail(
        verifyResult.invalidReason ?? "verification_failed",
        txHash,
        verifyResult.invalidMessage,
      );
    }
    const verified: VerifiedPayment = { ...resolved.state, payer: verifyResult.payer ?? "" };

    let submissionStatus: "confirmed" | "mempool";
    try {
      const submission = await this.signer.submitTransaction(
        verified.payload.transaction,
        requirements.network,
      );
      if (submission.txHash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error(`submitter returned transaction ${submission.txHash}, expected ${txHash}`);
      }
      submissionStatus = submission.status;
      await this.markSubmitted(txHash, ownerToken);
    } catch (cause) {
      // Submission threw. A throw does NOT prove the transaction never
      // reached the network: a signer that broadcasts and then waits for
      // confirmation throws on a timeout with the transaction already in
      // flight. Releasing the claim here would make the retry rebroadcast a
      // transaction that may already have landed, so the spec requires a
      // timeout, transport failure or unknown node result to RETAIN it.
      //
      // Ask the ledger before deciding. An `unknown` lookup is not proof that
      // no submission occurred; only the signer's explicit definitive-
      // rejection classifier may release the claim.
      let landed = false;
      if (this.canAuthenticateEvidence()) {
        try {
          const observed = await this.signer.getTransactionEvidence!(txHash, requirements.network);
          landed = observed.status !== "unknown";
        } catch {
          // Cannot tell — keep the claim rather than risk a rebroadcast.
          landed = true;
        }
      }
      if (landed) {
        // It is on the ledger despite the throw: record it as submitted so the
        // retry resumes observing instead of submitting again.
        await this.markSubmitted(txHash, ownerToken);
        const evidence = await this.awaitEvidence(txHash, requirements.network, required);
        return this.evidenceResponse(evidence, network, required, verified, false);
      }
      const definitive = this.signer.isDefinitiveSubmissionRejection?.(cause) === true;
      if (definitive) {
        // The protected handler has already run by this point. Keep both the
        // transaction and Masumi terms tombstones: accepting different bytes
        // for the same result would risk binding that result to another
        // payment, while releasing this transaction would rebroadcast bytes
        // the node has already rejected definitively.
        await this.markRejected(txHash, ownerToken);
      } else {
        // Unknown does not prove absence. Keep the canonical transaction ID
        // claimed so a paid retry cannot rebroadcast a transaction that may
        // still be valid and in flight.
        await this.markSubmitted(txHash, ownerToken);
      }
      return fail(
        definitive ? ERR_SETTLEMENT_DEFINITIVELY_REJECTED : ERR_SETTLEMENT_FAILED,
        txHash,
        describeErrorChain(cause),
      );
    }

    let evidence: CardanoSettlementEvidence;
    if (this.acceptMempool && required === MIN_L1_CONFIRMATIONS) {
      // The 402 asked for mempool-level evidence, the operator opted into
      // accepting it, and this facilitator broadcast the transaction itself —
      // the node's acceptance is exactly the evidence that policy describes.
      // Polling instead would wait for block inclusion, because providers like
      // Blockfrost cannot read the mempool at all and report an in-flight
      // transaction as `unknown`; that holds the response open for a whole
      // block and settles at a stronger level than the server asked for.
      evidence = {
        status: submissionStatus,
        confirmations: submissionStatus === "confirmed" ? 0 : MIN_L1_CONFIRMATIONS,
      };
    } else if (this.canAuthenticateEvidence()) {
      evidence = await this.awaitEvidence(txHash, requirements.network, required);
      // A transaction the node accepted may simply not be observable yet — most
      // providers expose no mempool read. That is the pending case, not
      // evidence that the claimed transaction does not exist.
      if (evidence.status === "unknown") {
        evidence = { status: "mempool", confirmations: MIN_L1_CONFIRMATIONS };
      }
    } else {
      // Without an evidence hook the submitter's own result is all we know:
      // inclusion means canonical depth 0, otherwise mempool acceptance.
      evidence = {
        status: submissionStatus,
        confirmations: submissionStatus === "confirmed" ? 0 : MIN_L1_CONFIRMATIONS,
      };
    }
    return this.evidenceResponse(evidence, network, required, verified, false);
  }

  /**
   * Verification for a transaction this facilitator already broadcast: the
   * pre-broadcast preconditions (unspent inputs, unexpired TTL, phase-1 checks,
   * script dry-run) are skipped because the transaction has consumed its own
   * inputs, while recipient, asset, amount and method checks still run.
   * Override together with `verify()` when tightening either.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements.
   * @returns A verify response describing success or failure.
   */
  protected async verifyBroadcast(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this.runVerification(payload, requirements, { alreadyBroadcast: true });
    return result.response;
  }

  /**
   * Runs the verification step that depends on the assetTransferMethod
   * declared in `requirements.extra`.
   *
   * - `default` / undefined: no extra verification beyond the asset+amount+
   *   address checks performed by the caller.
   * - `masumi`: verifies the payment locks funds into the Masumi `vested_pay`
   *   escrow with a valid `FundsLocked` datum matching the seller-signed terms.
   * - `script`: the facilitator reconstructs the script credential from the
   *   declared `script` (+ parameters) or `scriptHash` and confirms it equals
   *   the script payment credential of `requirements.payTo`. A non-script
   *   `payTo`, a missing descriptor, or a mismatch is rejected.
   *
   * @param requirements - The canonical payment requirements.
   * @param decoded - The decoded transaction (with output inline datums).
   * @param context - Payload, resolved payer and live protocol parameters.
   * @param context.payload - The decoded Cardano payload.
   * @param context.payer - The address that owns the nonce UTXO.
   * @param context.coinsPerUtxoByte - Live `coinsPerUtxoByte`, when available.
   * @param context.resource - The protected x402 resource, when available.
   * @param context.validateRegistryClaim - Independent registry validator, if any.
   * @param context.validateCustomDeployment - Explicit custom deployment validator, if any.
   * @returns Result describing success or a precise failure reason.
   */
  protected async runMethodSpecificChecks(
    requirements: PaymentRequirements,
    decoded: DecodedCardanoTransaction,
    context: {
      payload: ExactCardanoPayload;
      payer: string;
      coinsPerUtxoByte?: bigint;
      validateRegistryClaim?: MasumiRegistryValidator;
      resource?: PaymentPayload["resource"];
      validateCustomDeployment?: MasumiDeploymentValidator;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
    const extra = requirements.extra;
    const method =
      (extra as CardanoExtra | undefined)?.assetTransferMethod ?? ASSET_TRANSFER_METHOD_DEFAULT;
    if (method === ASSET_TRANSFER_METHOD_DEFAULT) {
      return { ok: true };
    }
    if (method === ASSET_TRANSFER_METHOD_MASUMI) {
      return verifyMasumiLock(extra, requirements, decoded, context);
    }
    if (method === ASSET_TRANSFER_METHOD_SCRIPT) {
      const scriptExtra = extra as CardanoExtraScript;
      if (!scriptExtra.scriptHash && !scriptExtra.script) {
        return { ok: false, reason: ERR_SCRIPT_ADDRESS_MISMATCH };
      }
      // SECURITY: confirm payTo is the script address implied by the declared
      // script + parameters (or scriptHash), so a server cannot redirect the
      // payment to an address unrelated to the advertised script.
      if (!scriptAddressMatches(scriptExtra, requirements.payTo)) {
        return { ok: false, reason: ERR_SCRIPT_ADDRESS_MISMATCH };
      }
      return { ok: true };
    }
    return { ok: false, reason: ERR_UNSUPPORTED_SCHEME };
  }

  /**
   * Decodes the payload, transaction and policy `settle()` needs before any
   * chain lookup. Pure — so overriding `verify()` stays the single authority on
   * whether a payment is acceptable.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements.
   * @returns The resolved state, or why it could not be derived.
   */
  private resolvePaymentState(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): { ok: true; state: ResolvedPayment } | { ok: false; reason: string; message?: string } {
    let cardanoPayload: ExactCardanoPayload;
    try {
      cardanoPayload = decodeCardanoPayload(payload.payload as Record<string, unknown>);
    } catch (cause) {
      return {
        ok: false,
        reason: ERR_INVALID_PAYLOAD,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    let decoded: DecodedCardanoTransaction;
    try {
      decoded = decodeCardanoTransaction(cardanoPayload.transaction);
    } catch (cause) {
      return {
        ok: false,
        reason: ERR_TRANSACTION_DECODE_FAILED,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    const policies = resolveCardanoPolicies(requirements.extra);
    if (!policies) return { ok: false, reason: ERR_POLICY_INVALID };
    return { ok: true, state: { payload: cardanoPayload, decoded, policies } };
  }

  /**
   * Runs verification and keeps the resolved state alongside the response.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements being fulfilled.
   * @param options - Verification options.
   * @param options.alreadyBroadcast - This facilitator broadcast the transaction
   *   earlier, so the pre-broadcast preconditions are skipped as they are for a
   *   transaction the ledger already reports.
   * @returns The verify response plus, on success, the resolved payment state.
   */
  private async runVerification(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options: { alreadyBroadcast?: boolean } = {},
  ): Promise<{ response: VerifyResponse; verified?: VerifiedPayment }> {
    try {
      if (payload.x402Version !== 2) {
        return {
          response: {
            isValid: false,
            invalidReason: `${ERR_INVALID_PAYLOAD}_unsupported_version`,
            payer: "",
          },
        };
      }

      if (payload.accepted.scheme !== SCHEME_EXACT || requirements.scheme !== SCHEME_EXACT) {
        return { response: { isValid: false, invalidReason: ERR_UNSUPPORTED_SCHEME, payer: "" } };
      }

      if (
        normalizeCardanoNetwork(payload.accepted.network) !==
        normalizeCardanoNetwork(requirements.network)
      ) {
        return { response: { isValid: false, invalidReason: ERR_NETWORK_MISMATCH, payer: "" } };
      }

      if (!isCardanoNetwork(requirements.network)) {
        return { response: { isValid: false, invalidReason: ERR_NETWORK_MISMATCH, payer: "" } };
      }
      if (
        !POSITIVE_CANONICAL_AMOUNT_REGEX.test(requirements.amount) ||
        !CANONICAL_CARDANO_ASSET_REGEX.test(requirements.asset)
      ) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_REQUIREMENTS_INVALID,
            invalidMessage: "amount and asset must use their positive canonical wire forms",
            payer: "",
          },
        };
      }

      let cardanoPayload: ExactCardanoPayload;
      try {
        cardanoPayload = decodeCardanoPayload(payload.payload as Record<string, unknown>);
      } catch (cause) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_INVALID_PAYLOAD,
            invalidMessage: cause instanceof Error ? cause.message : String(cause),
            payer: "",
          },
        };
      }

      // The confirmation policy always comes from the canonical server-supplied
      // requirements, never from the client-echoed `accepted`.
      const policies = resolveCardanoPolicies(requirements.extra);
      if (!policies) {
        return { response: { isValid: false, invalidReason: ERR_POLICY_INVALID, payer: "" } };
      }

      let parsedNonce: { txHash: string; index: number };
      try {
        parsedNonce = parseUtxoRef(cardanoPayload.nonce);
      } catch {
        return { response: { isValid: false, invalidReason: ERR_NONCE_INVALID, payer: "" } };
      }

      let decoded: DecodedCardanoTransaction;
      try {
        decoded = decodeCardanoTransaction(cardanoPayload.transaction);
      } catch (cause) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_TRANSACTION_DECODE_FAILED,
            invalidMessage: cause instanceof Error ? cause.message : String(cause),
            payer: "",
          },
        };
      }

      if (decoded.inputs.length > MAX_CARDANO_TRANSACTION_INPUTS) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_TRANSACTION_PHASE1_INVALID,
            invalidMessage: `transaction has ${decoded.inputs.length} inputs; verification permits at most ${MAX_CARDANO_TRANSACTION_INPUTS}`,
            payer: "",
          },
        };
      }

      // Rule 1: network validation. When the body declares a network_id it MUST
      // match the declared network. Absence of network_id is permitted: the
      // field is optional in the Cardano CBOR spec and many wallets omit it.
      // Network correctness is still enforced by Rule 2 (payTo address check):
      // Cardano addresses are network-tagged (addr_test1... vs addr1...), so a
      // testnet address cannot be submitted on mainnet and vice versa.
      const expectedNetworkId = getCardanoNetworkId(requirements.network);
      if (decoded.networkId !== undefined && decoded.networkId !== expectedNetworkId) {
        return { response: { isValid: false, invalidReason: ERR_NETWORK_ID_MISMATCH, payer: "" } };
      }
      // SECURITY: refuse unsigned transactions in verify() so /verify cannot
      // return a false-positive that would let callers grant access on an
      // unpaid request.
      if (decoded.vkeyWitnessCount === 0 && decoded.scriptWitnessCount === 0) {
        return { response: { isValid: false, invalidReason: ERR_TRANSACTION_UNSIGNED, payer: "" } };
      }
      if (!decoded.signaturesValid) {
        return { response: { isValid: false, invalidReason: ERR_INVALID_SIGNATURE, payer: "" } };
      }

      // Rule 5 (input check): nonce UTXO MUST appear as an input.
      const inputSet = new Set(decoded.inputs.map(i => i.toLowerCase()));
      if (inputSet.size !== decoded.inputs.length) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_TRANSACTION_PHASE1_INVALID,
            invalidMessage: "transaction contains duplicate inputs",
            payer: "",
          },
        };
      }
      const nonceLower = `${parsedNonce.txHash.toLowerCase()}#${parsedNonce.index}`;
      if (!inputSet.has(nonceLower)) {
        return { response: { isValid: false, invalidReason: ERR_NONCE_NOT_IN_INPUTS, payer: "" } };
      }

      // A transaction the ledger marked `is_valid = false` is a *failed script*
      // transaction: it lands under this exact id but consumes its collateral
      // instead of its inputs and creates none of its declared outputs. The
      // payment output decoded above would therefore never exist.
      if (!decoded.isValid) {
        return {
          response: { isValid: false, invalidReason: ERR_TRANSACTION_PHASE2_INVALID, payer: "" },
        };
      }

      // Look up authenticated evidence for this exact transaction whenever the
      // signer can. It recognizes a transaction this facilitator already
      // broadcast, which is what makes the pending-settlement retry able to
      // resume: once the transaction is on-chain its nonce is spent, so the
      // unspent-input and pre-broadcast checks below no longer apply to it.
      let evidence: CardanoSettlementEvidence | undefined;
      if (this.canAuthenticateEvidence()) {
        try {
          evidence = await this.signer.getTransactionEvidence!(
            decoded.txHash,
            requirements.network,
          );
        } catch {
          // Fall through to the unspent-input path.
        }
      }
      const acceptedByLedger =
        options.alreadyBroadcast === true ||
        (evidence !== undefined && evidence.status !== "unknown");

      // Rule 7: TTL. The transaction must not already have expired, and must not
      // reach further ahead than `maxTimeoutSeconds`. Slot boundaries are
      // converted to wall-clock through the network's era summary rather than
      // assuming one slot per second. Once evidence proves the ledger accepted
      // the transaction, an elapsed TTL no longer invalidates it.
      if (decoded.ttlSlot !== undefined || decoded.validityStartSlot !== undefined) {
        let currentSlot: bigint;
        try {
          currentSlot = await this.signer.getCurrentSlot(requirements.network);
        } catch (cause) {
          return {
            response: {
              isValid: false,
              invalidReason: ERR_CHAIN_LOOKUP_FAILED,
              invalidMessage: cause instanceof Error ? cause.message : String(cause),
              payer: "",
            },
          };
        }
        if (decoded.ttlSlot !== undefined) {
          if (!acceptedByLedger && decoded.ttlSlot <= currentSlot) {
            return { response: { isValid: false, invalidReason: ERR_TTL_EXPIRED, payer: "" } };
          }
          const ttlMs = slotToPosixMs(requirements.network, decoded.ttlSlot);
          const latestMs =
            slotToPosixMs(requirements.network, currentSlot) +
            requirements.maxTimeoutSeconds * 1000;
          if (ttlMs > latestMs) {
            return { response: { isValid: false, invalidReason: ERR_TTL_TOO_FAR, payer: "" } };
          }
        }
        if (decoded.validityStartSlot !== undefined && decoded.validityStartSlot > currentSlot) {
          return {
            response: { isValid: false, invalidReason: ERR_VALIDITY_NOT_YET_VALID, payer: "" },
          };
        }
      }

      // Resolve the inputs. Before the ledger has accepted the transaction its
      // inputs MUST still be unspent — a spent one guarantees the chain rejects
      // it at submission. Once accepted, this transaction is what spent them, so
      // only the owner address is read (implementations report it even for a
      // spent UTXO).
      let inputSnapshots: CardanoUtxoSnapshot[];
      try {
        inputSnapshots = [];
        for (
          let offset = 0;
          offset < decoded.inputs.length;
          offset += MAX_CARDANO_INPUT_LOOKUP_CONCURRENCY
        ) {
          inputSnapshots.push(
            ...(await Promise.all(
              decoded.inputs
                .slice(offset, offset + MAX_CARDANO_INPUT_LOOKUP_CONCURRENCY)
                .map(ref => this.signer.getUtxo(ref, requirements.network)),
            )),
          );
        }
      } catch (cause) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_CHAIN_LOOKUP_FAILED,
            invalidMessage: cause instanceof Error ? cause.message : String(cause),
            payer: "",
          },
        };
      }

      const nonceSnapshot =
        inputSnapshots[decoded.inputs.findIndex(ref => ref.toLowerCase() === nonceLower)];
      const payer = nonceSnapshot?.address ?? "";
      if (!acceptedByLedger) {
        if (!nonceSnapshot?.exists) {
          return {
            response: { isValid: false, invalidReason: ERR_NONCE_NOT_ON_CHAIN, payer },
          };
        }
        if (inputSnapshots.some(snapshot => !snapshot.exists)) {
          return { response: { isValid: false, invalidReason: ERR_INPUT_NOT_AVAILABLE, payer } };
        }
      }
      // Every method resolves the payer from the nonce UTXO's owner, and the
      // Masumi datum's `buyer` is matched against it. Failing closed here beats
      // letting an empty address flow into a credential comparison.
      if (payer.length === 0) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_NONCE_NOT_ON_CHAIN,
            invalidMessage: "could not resolve the owner of the nonce UTXO",
            payer: "",
          },
        };
      }

      // Fetch the live protocol parameters once (governance-settable): they feed
      // the fee floor, the generic min-UTXO check and the Masumi post-result
      // min-UTXO check. Undefined when the signer does not expose the hook.
      let protocolParameters: CardanoProtocolParameters | undefined;
      if (typeof this.signer.getProtocolParameters === "function") {
        try {
          protocolParameters = await this.signer.getProtocolParameters(requirements.network);
        } catch (cause) {
          return {
            response: {
              isValid: false,
              invalidReason: ERR_CHAIN_LOOKUP_FAILED,
              invalidMessage: cause instanceof Error ? cause.message : String(cause),
              payer,
            },
          };
        }
      }

      // Rule 6 (phase-1): the protected handler runs before broadcast, so an
      // otherwise well-formed transaction that the ledger would refuse must be
      // caught here. Value conservation and the fee floor are computable from
      // the input values and protocol parameters already fetched; a complete
      // phase-1 validator, when the operator can provide one, runs on top.
      if (!acceptedByLedger) {
        const phase1 = await this.checkPhase1(
          cardanoPayload.transaction,
          decoded,
          inputSnapshots,
          protocolParameters,
          requirements.network,
        );
        if (!phase1.ok) {
          return {
            response: {
              isValid: false,
              invalidReason: phase1.reason,
              invalidMessage: phase1.detail,
              payer,
            },
          };
        }
      }

      // Rules 2, 3, 4: at least one output MUST pay the requested amount of
      // the requested asset to the requested address. Lovelace is special-
      // cased because native ADA lives in `output.coin` rather than the
      // multi-asset map.
      const requestedAmount = BigInt(requirements.amount);
      const assetKey = requirements.asset.toLowerCase();
      const isLovelace = assetKey === "lovelace";
      let recipientFound = false;
      let assetFoundForRecipient = false;
      let bestAvailable = 0n;

      for (const output of decoded.outputs) {
        if (output.address !== requirements.payTo) {
          continue;
        }
        recipientFound = true;
        const available = isLovelace ? output.coin : output.assets[assetKey];
        if (available === undefined) {
          continue;
        }
        assetFoundForRecipient = true;
        if (available > bestAvailable) bestAvailable = available;
        if (available < requestedAmount) {
          continue;
        }
        const coinsPerUtxoByte = protocolParameters?.coinsPerUtxoByte;
        // Rule 8: reject outputs below the protocol min-UTXO (the node would
        // refuse them at submission). Skipped when coinsPerUtxoByte or the
        // serialized size is unavailable.
        if (coinsPerUtxoByte !== undefined && output.serializedSize !== undefined) {
          const minUtxo = minUtxoLovelace(output.serializedSize, coinsPerUtxoByte);
          if (output.coin < minUtxo) {
            return {
              response: {
                isValid: false,
                invalidReason: ERR_MIN_UTXO_INSUFFICIENT,
                invalidMessage: `output to ${requirements.payTo} carries ${output.coin} lovelace, min-UTXO requires ${minUtxo}`,
                payer,
              },
            };
          }
        }
        // SECURITY: Read assetTransferMethod from the canonical
        // server-supplied requirements, NOT from payload.accepted.extra
        // (which is client-echoed and could lie about the method to
        // bypass script-mode reconstruction checks).
        const methodCheck = await this.runMethodSpecificChecks(requirements, decoded, {
          payload: cardanoPayload,
          payer,
          coinsPerUtxoByte,
          validateRegistryClaim: this.validateRegistryClaim,
          resource: payload.resource,
          validateCustomDeployment: this.validateCustomMasumiDeployment,
        });
        if (!methodCheck.ok) {
          return {
            response: {
              isValid: false,
              invalidReason: methodCheck.reason,
              ...(methodCheck.detail ? { invalidMessage: methodCheck.detail } : {}),
              payer,
            },
          };
        }
        // Optional Plutus-script dry-run. `evaluateTransaction` computes
        // script execution units (Ogmios evaluateTransaction / Blockfrost
        // /utils/txs/evaluate); it does NOT validate vkey signatures. It only
        // adds a guard for script-mode payments, so it is a no-op for the
        // simple address-to-address transfers this base class accepts. An
        // already-accepted transaction has spent its inputs, so a dry-run
        // against the current UTXO set would fail on them.
        if (!acceptedByLedger && typeof this.signer.evaluateTransaction === "function") {
          try {
            await this.signer.evaluateTransaction(cardanoPayload.transaction, requirements.network);
          } catch (cause) {
            return {
              response: {
                isValid: false,
                invalidReason: ERR_CHAIN_LOOKUP_FAILED,
                invalidMessage: cause instanceof Error ? cause.message : String(cause),
                payer,
              },
            };
          }
        }
        if (policies.confirmationPolicy.l1Confirmations > 0 && !this.canAuthenticateEvidence()) {
          return {
            response: {
              isValid: false,
              invalidReason: ERR_EVIDENCE_UNAVAILABLE,
              invalidMessage:
                "confirmation depth above canonical inclusion requires transaction evidence",
              payer,
            },
          };
        }
        return {
          response: { isValid: true, payer },
          verified: { payload: cardanoPayload, decoded, policies, payer },
        };
      }

      if (!recipientFound) {
        return { response: { isValid: false, invalidReason: ERR_RECIPIENT_MISMATCH, payer } };
      }
      if (!assetFoundForRecipient) {
        return { response: { isValid: false, invalidReason: ERR_ASSET_MISMATCH, payer } };
      }
      return {
        response: {
          isValid: false,
          invalidReason: ERR_AMOUNT_INSUFFICIENT,
          invalidMessage: `output to ${requirements.payTo} pays ${bestAvailable}, requires ${requestedAmount}`,
          payer,
        },
      };
    } catch (error) {
      return {
        response: {
          isValid: false,
          invalidReason: `${ERR_INVALID_PAYLOAD}_verification_error`,
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer: "",
        },
      };
    }
  }

  /**
   * Phase-1 checks for a transaction the ledger has not accepted yet.
   *
   * Built in, from data every provider can serve: value conservation over the
   * authenticated input values, and the fee floor from live protocol
   * parameters (skipped when the signer exposes none). A transaction that
   * moves value outside its inputs and outputs (`mint`, `withdrawals`,
   * `certificates`, ...) cannot be balanced from provider data alone and is
   * accepted only through a complete `validatePhase1Transaction` hook, which
   * otherwise runs as an additional check on top of the built-in ones.
   *
   * @param transaction - The exact signed transaction (base64 CBOR).
   * @param decoded - The decoded transaction.
   * @param inputs - Authenticated snapshots of every input, in input order.
   * @param protocolParameters - Live protocol parameters, when available.
   * @param network - The x402 network identifier.
   * @returns Success, or the rejection reason and detail.
   */
  private async checkPhase1(
    transaction: string,
    decoded: DecodedCardanoTransaction,
    inputs: readonly CardanoUtxoSnapshot[],
    protocolParameters: CardanoProtocolParameters | undefined,
    network: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
    const fullValidator = this.signer.validatePhase1Transaction;
    if (decoded.balanceChangingOperations.length > 0) {
      if (!fullValidator) {
        return {
          ok: false,
          reason: ERR_TRANSACTION_PHASE1_INVALID,
          detail: `transaction carries ${decoded.balanceChangingOperations.join(", ")}; without a complete phase-1 validator only plain payments are accepted`,
        };
      }
    } else {
      const conserved = checkValueConservation(decoded, inputs);
      if (!conserved.ok) return conserved;
    }
    if (protocolParameters) {
      const fee = checkMinimumFee(decoded, protocolParameters);
      if (!fee.ok) return fee;
    }
    if (fullValidator) {
      try {
        await fullValidator.call(this.signer, transaction, network);
      } catch (cause) {
        return {
          ok: false,
          reason: ERR_TRANSACTION_PHASE1_INVALID,
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
    return { ok: true };
  }

  /**
   * Turns settlement evidence into a settle response, applying the confirmation
   * policy and the operator's mempool opt-in.
   *
   * Below the policy the outcome is the non-terminal `settlement_pending`
   * whenever more evidence can still arrive: the transaction was broadcast and
   * either sits in the mempool or has fewer confirmations than required. It is
   * terminal only when nothing further can be learned — the signer has no
   * evidence hook, or the transaction's validity window closed without it ever
   * being observed.
   *
   * @param evidence - The strongest verified evidence.
   * @param network - The network to report.
   * @param required - The `l1Confirmations` threshold.
   * @param verified - The resolved payment state.
   * @param resumed - Whether this call resumed an earlier broadcast.
   * @returns The settle response.
   */
  private async evidenceResponse(
    evidence: CardanoSettlementEvidence,
    network: Network,
    required: number,
    verified: VerifiedPayment,
    resumed: boolean,
  ): Promise<SettleResponse> {
    const txHash = verified.decoded.txHash;
    const base = { transaction: txHash, network, payer: verified.payer };
    const pending = (extra: Record<string, unknown>): SettleResponse =>
      this.pendingResponse(base, extra);

    if (evidence.status === "unknown") {
      // Broadcast, but the provider cannot see it yet. Once the validity
      // window has closed without the ledger ever recording it, it can no
      // longer land and waiting further is pointless.
      if (resumed && (await this.validityWindowClosed(verified.decoded, network))) {
        return {
          ...base,
          success: false,
          errorReason: ERR_SETTLEMENT_FAILED,
          errorMessage: "the transaction's validity window closed before it was included",
          extra: { status: "expired" },
        };
      }
      return pending({});
    }

    const extra: Record<string, unknown> = {
      status: evidence.status,
      confirmations: evidence.confirmations,
    };
    if (evidence.status === "mempool") {
      // Mempool inclusion can be rolled back, so refuse it unless the operator
      // explicitly opted in, even when the policy would allow `-1`.
      if (this.acceptMempool && confirmationsSatisfy(evidence.confirmations, required)) {
        return { ...base, success: true, extra };
      }
      // Inclusion in a block will satisfy any policy `-1` would not; it can be
      // observed only through an evidence hook.
      if (this.canAuthenticateEvidence()) return pending(extra);
      return { ...base, success: false, errorReason: ERR_SETTLEMENT_NOT_CONFIRMED, extra };
    }
    if (!confirmationsSatisfy(evidence.confirmations, required)) {
      return pending(extra);
    }
    return { ...base, success: true, extra };
  }

  /**
   * The non-terminal settle response for a broadcast transaction that has not
   * yet met the required evidence; `@x402/core` retries `settle()` once with
   * the same payload and the facilitator resumes observing the transaction.
   *
   * @param base - Identity of the payment being reported.
   * @param base.transaction - The canonical transaction id.
   * @param base.network - The network to report.
   * @param base.payer - The resolved payer, or empty when unknown.
   * @param extra - Evidence fields to report alongside the pending status.
   * @param errorMessage - Why the settlement is pending.
   * @returns The pending settle response.
   */
  private pendingResponse(
    base: { transaction: string; network: Network; payer: string },
    extra: Record<string, unknown>,
    errorMessage = "the transaction was broadcast and is awaiting the required confirmations",
  ): SettleResponse {
    return {
      ...base,
      success: false,
      errorReason: ERR_SETTLEMENT_PENDING,
      errorMessage,
      extra: { ...extra, status: "pending", transactionId: base.transaction },
    };
  }

  /**
   * Whether the transaction's validity upper bound passed long enough ago that
   * a provider would have indexed it had it landed. A transaction without a TTL
   * never expires. A slot lookup failure is treated as "not yet", so a transient
   * provider error cannot turn a pending payment into a failure.
   *
   * @param decoded - The decoded transaction.
   * @param network - The x402 network identifier.
   * @returns True once the TTL plus the indexing grace is behind the current slot.
   */
  private async validityWindowClosed(
    decoded: DecodedCardanoTransaction,
    network: string,
  ): Promise<boolean> {
    if (decoded.ttlSlot === undefined) return false;
    try {
      const currentSlot = await this.signer.getCurrentSlot(network);
      return (
        slotToPosixMs(network, currentSlot) >
        slotToPosixMs(network, decoded.ttlSlot) + VALIDITY_CLOSE_GRACE_MS
      );
    } catch {
      return false;
    }
  }

  /**
   * Polls the evidence hook until the threshold is met or the confirmation
   * timeout elapses, returning the strongest evidence seen.
   *
   * @param txHash - The canonical transaction id.
   * @param network - The x402 network identifier.
   * @param required - The `l1Confirmations` threshold.
   * @returns The strongest verified evidence.
   */
  private async awaitEvidence(
    txHash: string,
    network: string,
    required: number,
  ): Promise<CardanoSettlementEvidence> {
    if (!this.canAuthenticateEvidence()) {
      return { status: "unknown", confirmations: MIN_L1_CONFIRMATIONS - 1 };
    }
    const deadline = Date.now() + this.confirmationTimeoutMs;
    let latest: CardanoSettlementEvidence = {
      status: "unknown",
      confirmations: MIN_L1_CONFIRMATIONS - 1,
    };
    for (;;) {
      try {
        latest = await this.signer.getTransactionEvidence!(txHash, network);
      } catch {
        // A transient provider error must not be reported as absent evidence;
        // keep the strongest result seen so far and retry until the deadline.
      }
      if (latest.status !== "unknown" && confirmationsSatisfy(latest.confirmations, required)) {
        return latest;
      }
      if (Date.now() + this.confirmationPollMs >= deadline) return latest;
      await new Promise(resolve => setTimeout(resolve, this.confirmationPollMs));
    }
  }

  /**
   * Whether the signer can authenticate settlement evidence for a transaction.
   *
   * @returns True when the optional evidence hook is implemented.
   */
  private canAuthenticateEvidence(): boolean {
    return typeof this.signer.getTransactionEvidence === "function";
  }

  /**
   * Returns the canonical Masumi terms digest, when this is a Masumi payment.
   *
   * @param requirements - Accepted payment requirements.
   * @returns Canonical terms digest, or undefined for another transfer method.
   */
  private masumiTermsDigest(requirements: PaymentRequirements): string | undefined {
    const extra = requirements.extra as CardanoExtra | undefined;
    if (extra?.assetTransferMethod !== ASSET_TRANSFER_METHOD_MASUMI) return undefined;
    const schema = validateMasumiExtra(extra, requirements.network);
    return schema.ok ? computeTermsDigest(buildSignedTerms(schema.extra, requirements)) : undefined;
  }

  /**
   * Atomically claim a canonical transaction id for submission.
   *
   * - `fresh` — nothing claimed this transaction; the caller submits it.
   * - `in-flight` — another call is mid-submission; this is the race the
   *   duplicate-settlement mitigation exists for, and it is refused.
   * - `submitted` — this exact transaction was already broadcast. The caller
   *   MUST NOT submit it again, but the pending-settlement retry has to resume
   *   observing it, so this is not a rejection.
   * - `rejected` — the node definitively rejected these bytes; never resubmit.
   * - `terms-conflict` — the Masumi terms are bound to a different transaction.
   *
   * @param txHash - The canonical Cardano transaction id.
   * @param ownerToken - Unpredictable token that owns a fresh claim.
   * @param termsDigest - Optional Masumi terms binding.
   * @returns The claim outcome.
   */
  private async claimSettlement(
    txHash: string,
    ownerToken: string,
    termsDigest?: string,
  ): Promise<CardanoSettlementClaimResult> {
    return this.settlementStore.claimSettlement({
      txHash,
      ownerToken,
      ...(termsDigest ? { termsDigest } : {}),
    });
  }

  /**
   * Marks a claimed transaction as broadcast, so a later retry resumes
   * observing it instead of submitting it again.
   *
   * @param txHash - The canonical Cardano transaction id.
   * @param ownerToken - Token that owns the claim.
   * @returns Nothing.
   */
  private async markSubmitted(txHash: string, ownerToken: string): Promise<void> {
    await this.settlementStore.markSubmitted(txHash, ownerToken);
  }

  /**
   * Permanently records a definitive pre-ledger rejection.
   *
   * @param txHash - Canonical transaction ID.
   * @param ownerToken - Token that owns the claim.
   */
  private async markRejected(txHash: string, ownerToken: string): Promise<void> {
    await this.settlementStore.markRejected(txHash, ownerToken);
  }

  /**
   * Gives a fresh claim back when verification rejected the payment before
   * anything was broadcast.
   *
   * @param txHash - Canonical transaction ID.
   * @param ownerToken - Token that owns the claim.
   */
  private async releaseClaim(txHash: string, ownerToken: string): Promise<void> {
    await this.settlementStore.releaseClaim(txHash, ownerToken);
  }
}

/**
 * Convenience helper exposing the list of networks this scheme supports.
 *
 * @returns The supported Cardano CAIP-style network identifiers.
 */
export function supportedCardanoNetworks(): readonly string[] {
  return CARDANO_NETWORKS;
}
