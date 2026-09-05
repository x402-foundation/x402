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
  ERR_EVIDENCE_MISMATCH,
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
  ERR_PAYMENT_PENDING,
  ERR_POLICY_INVALID,
  ERR_RECIPIENT_MISMATCH,
  ERR_REQUIREMENTS_INVALID,
  ERR_SCRIPT_ADDRESS_MISMATCH,
  ERR_SETTLEMENT_LAYER_MISMATCH,
  ERR_SETTLEMENT_FAILED,
  ERR_SETTLEMENT_DEFINITIVELY_REJECTED,
  ERR_SETTLEMENT_NOT_CONFIRMED,
  ERR_SUBMISSION_MODE_MISMATCH,
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
  normalizeSubmissionMode,
  resolveCardanoPolicies,
  submissionModeAllowed,
  type ResolvedCardanoPolicies,
} from "../../policy";
import type {
  CardanoExtra,
  CardanoExtraScript,
  CardanoSubmissionMode,
  DecodedCardanoTransaction,
  ExactCardanoPayload,
} from "../../types";
import type {
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
import { InMemoryCardanoSettlementStore, type CardanoSettlementStore } from "../../idempotency";
import { buildSignedTerms, computeTermsDigest } from "../masumi/digests";
import { validateMasumiExtra } from "../masumi/schema";
import {
  verifyMasumiLock,
  type MasumiDeploymentValidator,
  type MasumiRegistryValidator,
} from "../masumi/verify";
import { scriptAddressMatches } from "./scriptAddress";

/**
 * Optional configuration knobs for the Cardano facilitator scheme.
 */
export interface ExactCardanoFacilitatorConfig {
  /**
   * Atomic durable transaction and Masumi-terms claim store shared by every
   * worker and deployment. Replay tombstones must survive process restarts.
   */
  settlementStore?: CardanoSettlementStore;
  /**
   * Entry limit for an explicitly selected process-local settlement store.
   * Supplying this opts into volatile replay state and is suitable only for
   * tests and disposable development facilitators.
   */
  inMemorySettlementStoreMaxEntries?: number;
  /**
   * If `true` the facilitator may settle on authenticated mempool evidence when
   * the selected `confirmationPolicy` allows it (`l1Confirmations: -1`). Default
   * is `false`: mempool inclusion can be rolled back, so the facilitator refuses
   * it regardless of policy unless the operator opts in.
   */
  acceptMempool?: boolean;
  /**
   * How long `settle()` waits for evidence to reach the selected
   * `confirmationPolicy` before reporting `payment_pending`. Defaults to 90s.
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
  /**
   * Allows a client-submitted payment to run Plutus scripts. Default `false`:
   * only a script-running transaction can land phase-2 invalid — creating none
   * of the outputs it declares — and the `is_valid` flag that marks it is
   * outside the transaction id, so a client can broadcast the failing form and
   * present the passing one. Enable only with an evidence provider that
   * verifies `valid_contract`.
   */
  allowClientScriptExecution?: boolean;
}

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
 * Everything `verify()` resolved, so `settle()` does not redo the work.
 */
interface VerifiedPayment {
  payload: ExactCardanoPayload;
  decoded: DecodedCardanoTransaction;
  policies: ResolvedCardanoPolicies;
  mode: CardanoSubmissionMode;
  payer: string;
}

/**
 * Cardano facilitator implementation for the Exact payment scheme.
 *
 * Enforces the "Facilitator Verification Rules" of
 * `specs/schemes/exact/scheme_exact_cardano.md` (rules 1-9) before accepting a
 * payment, then settles according to the selected submission policy: in server
 * mode it submits the transaction, in client mode it authenticates evidence for
 * the transaction the client already broadcast and never submits it again.
 *
 * The duplicate-settlement cache is keyed by the **canonical Cardano transaction
 * ID**, never by the serialized CBOR: witness sets and equally valid encodings
 * differ without changing the ledger transaction, so an encoding-level key is
 * trivially bypassed. Production deployments must configure an atomic durable
 * shared {@link CardanoSettlementStore}; process-local storage is explicit and
 * intended only for tests or disposable development.
 *
 * **Idempotency boundary.** `settle()` is deliberately idempotent per
 * transaction id rather than one-shot: the spec requires a paid retry to repeat
 * the exact original `PAYMENT-SIGNATURE` and the verifier to "resume observation
 * of the same canonical transaction ID", which a terminal state would break —
 * a payment that needed more confirmations than one call could wait for would
 * become permanently unsettleable. What this facilitator guarantees is that one
 * transaction is broadcast at most once and always reports the same ledger
 * truth. Binding a settled transaction to a *single protected operation* is the
 * resource server's job, which the spec assigns it explicitly: it keys its
 * record by canonical transaction ID for `default` and `script`, and by
 * `termsDigest` for `masumi` (already enforced here, so a Masumi payment cannot
 * be reused across two 402s — each carries a fresh `sellerNonce`).
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
  private readonly allowClientScriptExecution: boolean;

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
    if (config.settlementStore) {
      this.settlementStore = config.settlementStore;
    } else if (config.inMemorySettlementStoreMaxEntries !== undefined) {
      this.settlementStore = new InMemoryCardanoSettlementStore(
        config.inMemorySettlementStoreMaxEntries,
      );
    } else {
      throw new Error(
        "Cardano facilitators require a durable settlementStore; pass inMemorySettlementStoreMaxEntries explicitly only for tests or disposable development",
      );
    }
    this.acceptMempool = config.acceptMempool ?? false;
    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? 90_000;
    this.confirmationPollMs = config.confirmationPollMs ?? 5_000;
    this.validateRegistryClaim = config.validateRegistryClaim;
    this.validateCustomMasumiDeployment = config.validateCustomMasumiDeployment;
    this.allowClientScriptExecution = config.allowClientScriptExecution ?? false;
  }

  /**
   * Returns the capabilities advertised in the `/supported` response: the
   * transfer methods, settlement layers and submission modes this facilitator
   * can actually service, plus the L1 confirmation range per mode.
   *
   * `/supported` only describes capabilities — the selected policies always come
   * from the 402 requirements.
   *
   * @param _network - The Cardano network identifier (unused).
   * @returns The advertised capability block.
   */
  getExtra(_network: string): Record<string, unknown> | undefined {
    void _network;
    const supportsServerSubmission = typeof this.signer.validatePhase1Transaction === "function";
    const supportsClientSubmission = this.canAuthenticateEvidence();
    return {
      assetTransferMethods: [
        ASSET_TRANSFER_METHOD_DEFAULT,
        ASSET_TRANSFER_METHOD_MASUMI,
        ASSET_TRANSFER_METHOD_SCRIPT,
      ],
      // Hydra needs head-authenticated evidence this facilitator cannot produce.
      settlementLayers: ["l1"],
      // The client builds and signs the whole transaction, so it balances the
      // fee against its own inputs. This facilitator only broadcasts.
      areFeesSponsored: false,
      submissionModes: [
        ...(supportsServerSubmission ? ["server"] : []),
        ...(supportsClientSubmission ? ["client"] : []),
      ],
      l1Confirmations: {
        // Mempool-only evidence is refused unless the operator opted in.
        ...(supportsServerSubmission
          ? {
              server: {
                minimum: this.acceptMempool ? MIN_L1_CONFIRMATIONS : 0,
                maximum: supportsClientSubmission ? MAX_L1_CONFIRMATIONS : 0,
              },
            }
          : {}),
        ...(supportsClientSubmission
          ? {
              client: {
                minimum: this.acceptMempool ? MIN_L1_CONFIRMATIONS : 0,
                maximum: MAX_L1_CONFIRMATIONS,
              },
            }
          : {}),
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
   * In server mode the transaction is re-verified and submitted. In client mode
   * it was already broadcast by the client, so the facilitator only
   * authenticates evidence for that exact transaction and MUST NOT submit it
   * again. Either way the response reports the strongest verified evidence, and
   * `success` is `true` only once it meets `confirmationPolicy`.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements.
   * @returns A settle response describing success or failure.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    // Dispatched through `this` so a subclass that tightens `verify()` also
    // governs settlement.
    const verifyResult = await this.verify(payload, requirements);
    if (!verifyResult.isValid) {
      return {
        success: false,
        errorReason: verifyResult.invalidReason ?? "verification_failed",
        ...(verifyResult.invalidMessage ? { errorMessage: verifyResult.invalidMessage } : {}),
        transaction: "",
        network: payload.accepted.network,
      };
    }
    const state = this.resolvePaymentState(payload, requirements, verifyResult.payer ?? "");
    if (!state.ok) {
      return {
        success: false,
        errorReason: state.reason,
        ...(state.message ? { errorMessage: state.message } : {}),
        transaction: "",
        network: payload.accepted.network,
      };
    }
    const verified = state.verified;

    const { decoded, mode, policies } = verified;
    const network = payload.accepted.network;
    const required = policies.confirmationPolicy.l1Confirmations;

    // Claim the canonical transaction id, submission mode and optional Masumi
    // terms digest in one atomic store operation. Splitting these writes can bind
    // a quote without reserving its transaction when the store reaches capacity.
    const ownerToken = randomBytes(16).toString("hex");
    const claim = await this.claimSettlement(
      decoded.txHash,
      mode,
      ownerToken,
      this.masumiTermsDigest(requirements),
    );
    if (claim === "capacity-exceeded") {
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_FAILED,
        errorMessage: "the Cardano settlement store is at capacity",
        transaction: decoded.txHash,
        network,
      };
    }
    if (claim === "mode-conflict") {
      return {
        success: false,
        errorReason: ERR_SUBMISSION_MODE_MISMATCH,
        errorMessage: "this transaction was already settled under the other submission mode",
        transaction: decoded.txHash,
        network,
      };
    }
    if (claim === "terms-conflict") {
      return {
        success: false,
        errorReason: ERR_DUPLICATE_SETTLEMENT,
        errorMessage: "termsDigest is already bound to another transaction",
        transaction: decoded.txHash,
        network,
      };
    }
    if (claim === "rejected") {
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_DEFINITIVELY_REJECTED,
        errorMessage: "this transaction was definitively rejected before ledger acceptance",
        transaction: decoded.txHash,
        network,
      };
    }
    if (claim === "in-flight") {
      return {
        success: false,
        errorReason: ERR_DUPLICATE_SETTLEMENT,
        transaction: decoded.txHash,
        network,
      };
    }

    if (mode === "client") {
      // The client already broadcast; the facilitator MUST NOT submit it again.
      await this.markSubmitted(decoded.txHash, ownerToken);
      const evidence = await this.awaitEvidence(decoded.txHash, network, required);
      return this.evidenceResponse(evidence, decoded.txHash, network, mode, required, verified);
    }

    let submissionStatus: "confirmed" | "mempool" | undefined;
    if (claim === "fresh") {
      try {
        const submission = await this.signer.submitTransaction(
          verified.payload.transaction,
          requirements.network,
        );
        if (submission.txHash.toLowerCase() !== decoded.txHash.toLowerCase()) {
          throw new Error(
            `submitter returned transaction ${submission.txHash}, expected ${decoded.txHash}`,
          );
        }
        submissionStatus = submission.status;
        await this.markSubmitted(decoded.txHash, ownerToken);
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
            const observed = await this.signer.getTransactionEvidence!(
              decoded.txHash,
              requirements.network,
            );
            landed = observed.status !== "unknown";
          } catch {
            // Cannot tell — keep the claim rather than risk a rebroadcast.
            landed = true;
          }
        }
        if (landed) {
          // It is on the ledger despite the throw: record it as submitted so the
          // retry resumes observing instead of submitting again.
          await this.markSubmitted(decoded.txHash, ownerToken);
          const evidence = await this.awaitEvidence(decoded.txHash, requirements.network, required);
          return this.evidenceResponse(evidence, decoded.txHash, network, mode, required, verified);
        }
        const definitive = this.signer.isDefinitiveSubmissionRejection?.(cause) === true;
        if (definitive) {
          // The protected handler has already run by this point. Keep both the
          // transaction and Masumi terms tombstones: accepting different bytes
          // for the same result would risk binding that result to another
          // payment, while releasing this transaction would rebroadcast bytes
          // the node has already rejected definitively.
          await this.markRejected(decoded.txHash, ownerToken);
        } else {
          // Unknown does not prove absence. Keep the canonical transaction ID
          // claimed so a paid retry cannot rebroadcast a transaction that may
          // still be valid and in flight.
          await this.markSubmitted(decoded.txHash, ownerToken);
        }
        return {
          success: false,
          errorReason: definitive ? ERR_SETTLEMENT_DEFINITIVELY_REJECTED : ERR_SETTLEMENT_FAILED,
          errorMessage: describeErrorChain(cause),
          transaction: decoded.txHash,
          network,
        };
      }
    }
    // `claim === "submitted"` is the pending-confirmation retry: this exact
    // transaction was already broadcast, so resume observing it instead of
    // submitting it again.

    let evidence: CardanoSettlementEvidence;
    if (submissionStatus !== undefined && this.acceptMempool && required === MIN_L1_CONFIRMATIONS) {
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
    } else if (this.canAuthenticateEvidence() || submissionStatus === undefined) {
      evidence = await this.awaitEvidence(decoded.txHash, requirements.network, required);
      // A transaction the node accepted may simply not be observable yet — most
      // providers expose no mempool read. That is the pending-confirmation case,
      // not evidence that the claimed transaction does not exist.
      if (evidence.status === "unknown" && submissionStatus !== undefined) {
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
    return this.evidenceResponse(evidence, decoded.txHash, network, mode, required, verified);
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
      if (context.payload.settlementLayer !== undefined || context.payload.headId !== undefined) {
        return { ok: false, reason: ERR_SETTLEMENT_LAYER_MISMATCH };
      }
      return { ok: true };
    }
    if (method === ASSET_TRANSFER_METHOD_MASUMI) {
      return verifyMasumiLock(extra, requirements, decoded, context);
    }
    if (method === ASSET_TRANSFER_METHOD_SCRIPT) {
      if (context.payload.settlementLayer !== undefined || context.payload.headId !== undefined) {
        return { ok: false, reason: ERR_SETTLEMENT_LAYER_MISMATCH };
      }
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
   * Re-derives the state `settle()` needs from an already-verified payment.
   * Pure — no chain lookups — so overriding `verify()` stays the single
   * authority on whether a payment is acceptable.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements.
   * @param payer - The payer `verify()` resolved.
   * @returns The resolved state, or why it could not be derived.
   */
  private resolvePaymentState(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payer: string,
  ): { ok: true; verified: VerifiedPayment } | { ok: false; reason: string; message?: string } {
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
    const mode = normalizeSubmissionMode(cardanoPayload.submissionMode);
    if (mode === null || !submissionModeAllowed(policies.submissionPolicy, mode)) {
      return { ok: false, reason: ERR_SUBMISSION_MODE_MISMATCH };
    }
    return { ok: true, verified: { payload: cardanoPayload, decoded, policies, mode, payer } };
  }

  /**
   * Runs verification and keeps the resolved state alongside the response.
   *
   * @param payload - The Cardano payment payload.
   * @param requirements - The payment requirements being fulfilled.
   * @returns The verify response plus, on success, the resolved payment state.
   */
  private async runVerification(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
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

      // The submission and confirmation policies always come from the canonical
      // server-supplied requirements, never from the client-echoed `accepted`.
      const policies = resolveCardanoPolicies(requirements.extra);
      if (!policies) {
        return { response: { isValid: false, invalidReason: ERR_POLICY_INVALID, payer: "" } };
      }

      // Rule 6: an absent mode normalizes to `server`, and the normalized mode
      // MUST be allowed by the selected policy.
      const mode = normalizeSubmissionMode(cardanoPayload.submissionMode);
      if (mode === null || !submissionModeAllowed(policies.submissionPolicy, mode)) {
        return {
          response: { isValid: false, invalidReason: ERR_SUBMISSION_MODE_MISMATCH, payer: "" },
        };
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
      // signer can. Client mode REQUIRES it — the client already broadcast, so
      // the facilitator authenticates instead of submitting. Server mode uses it
      // to recognize a transaction it already submitted, which is what makes the
      // spec's pending-confirmation retry able to resume: once the transaction
      // is on-chain its nonce is spent, so the unspent-input precondition below
      // no longer applies to it.
      let evidence: CardanoSettlementEvidence | undefined;
      if (mode === "client" && !this.canAuthenticateEvidence()) {
        return {
          response: { isValid: false, invalidReason: ERR_EVIDENCE_UNAVAILABLE, payer: "" },
        };
      }
      // The `is_valid` flag lives outside the transaction body, so it is not
      // covered by the transaction id: a client can broadcast the failing
      // (`is_valid = false`) form and hand the facilitator an identical payload
      // claiming `true`. Evidence keyed by that id would then point at a
      // transaction that created no outputs. A correct evidence provider
      // reports such a transaction as unknown, but only a transaction that runs
      // a Plutus script can be phase-2 invalid at all — so refusing redeemers
      // in client mode closes the hole without depending on the provider. A
      // client paying an invoice pays *to* addresses and never needs one.
      if (mode === "client" && decoded.redeemerCount > 0 && !this.allowClientScriptExecution) {
        return {
          response: {
            isValid: false,
            invalidReason: ERR_TRANSACTION_PHASE2_INVALID,
            invalidMessage:
              "client-submitted payments must not run Plutus scripts; such a transaction can land phase-2 invalid and create no outputs",
            payer: "",
          },
        };
      }
      if (this.canAuthenticateEvidence()) {
        try {
          evidence = await this.signer.getTransactionEvidence!(
            decoded.txHash,
            requirements.network,
          );
        } catch (cause) {
          // Server mode can still proceed on the unspent-input path; client mode
          // has nothing else to stand on.
          if (mode === "client") {
            return {
              response: {
                isValid: false,
                invalidReason: ERR_CHAIN_LOOKUP_FAILED,
                invalidMessage: cause instanceof Error ? cause.message : String(cause),
                payer: "",
              },
            };
          }
        }
        if (
          mode === "client" &&
          evidence?.status !== "confirmed" &&
          evidence?.status !== "mempool"
        ) {
          return { response: { isValid: false, invalidReason: ERR_EVIDENCE_MISMATCH, payer: "" } };
        }
      }
      const acceptedByLedger = evidence !== undefined && evidence.status !== "unknown";

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

      // Resolve the nonce UTXO. Before the ledger has accepted the transaction
      // its inputs MUST still be unspent — a spent one guarantees the chain
      // rejects it at submission. Once accepted, this transaction is what spent
      // them, so only the owner address is read (implementations report it even
      // for a spent UTXO).
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

      // In server mode the protected handler can run before submitTransaction,
      // so an approximation is unsafe: fee, size and other live protocol rules
      // can still make an otherwise balanced transaction ledger-invalid. Require
      // a complete phase-1 validator. Client mode already has authenticated
      // ledger acceptance evidence for this exact transaction.
      if (!acceptedByLedger) {
        if (!this.signer.validatePhase1Transaction) {
          return {
            response: {
              isValid: false,
              invalidReason: ERR_TRANSACTION_PHASE1_INVALID,
              invalidMessage: "server submission requires a complete Cardano phase-1 validator",
              payer,
            },
          };
        }
        try {
          await this.signer.validatePhase1Transaction(
            cardanoPayload.transaction,
            requirements.network,
          );
        } catch (cause) {
          return {
            response: {
              isValid: false,
              invalidReason: ERR_TRANSACTION_PHASE1_INVALID,
              invalidMessage: cause instanceof Error ? cause.message : String(cause),
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
        // Fetch the live coinsPerUtxoByte once (governance-settable): it feeds
        // both the generic min-UTXO check and the Masumi post-result min-UTXO
        // check. Undefined when the signer does not expose the hook.
        let coinsPerUtxoByte: bigint | undefined;
        if (typeof this.signer.getCoinsPerUtxoByte === "function") {
          try {
            coinsPerUtxoByte = await this.signer.getCoinsPerUtxoByte(requirements.network);
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
        // simple address-to-address transfers this base class accepts. A
        // client-submitted transaction is already on the ledger, so a dry-run
        // against the current UTXO set would fail on its own spent inputs.
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
          verified: { payload: cardanoPayload, decoded, policies, mode, payer },
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
   * Turns settlement evidence into a settle response, applying the confirmation
   * policy and the operator's mempool opt-in.
   *
   * @param evidence - The strongest verified evidence.
   * @param txHash - The canonical transaction id.
   * @param network - The network to report.
   * @param mode - The normalized submission mode.
   * @param required - The `l1Confirmations` threshold.
   * @param verified - The resolved payment state.
   * @returns The settle response.
   */
  private evidenceResponse(
    evidence: CardanoSettlementEvidence,
    txHash: string,
    network: Network,
    mode: CardanoSubmissionMode,
    required: number,
    verified: VerifiedPayment,
  ): SettleResponse {
    const status = evidence.status === "confirmed" ? "confirmed" : "mempool";
    const extra: Record<string, unknown> = {
      status,
      submissionMode: mode,
      confirmations: evidence.confirmations,
      ...(verified.payload.settlementLayer
        ? { settlementLayer: verified.payload.settlementLayer }
        : {}),
      ...(verified.payload.headId ? { headId: verified.payload.headId } : {}),
    };

    if (evidence.status === "unknown") {
      return {
        success: false,
        errorReason: ERR_EVIDENCE_MISMATCH,
        transaction: txHash,
        network,
        payer: verified.payer,
        extra: { ...extra, status: "pending" },
      };
    }
    // Mempool inclusion can be rolled back, so refuse it unless the operator
    // explicitly opted in, even when the policy would allow `-1`.
    if (evidence.status === "mempool" && !this.acceptMempool) {
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_NOT_CONFIRMED,
        transaction: txHash,
        network,
        payer: verified.payer,
        extra,
      };
    }
    if (!confirmationsSatisfy(evidence.confirmations, required)) {
      return {
        success: false,
        errorReason: ERR_PAYMENT_PENDING,
        transaction: txHash,
        network,
        payer: verified.payer,
        extra: { ...extra, status: "pending", transactionId: txHash },
      };
    }
    return {
      success: true,
      transaction: txHash,
      network,
      payer: verified.payer,
      extra,
    };
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
   * Atomically claim a canonical transaction id for submission. Synchronous so
   * concurrent settle() calls cannot all race past the check.
   *
   * - `fresh` — nothing claimed this transaction; the caller submits it.
   * - `in-flight` — another call is mid-submission; this is the race the
   *   duplicate-settlement mitigation exists for, and it is refused.
   * - `submitted` — this exact transaction was already broadcast. The caller
   *   MUST NOT submit it again, but the spec's pending-confirmation retry has to
   *   resume observing it, so this is not a rejection.
   * - `rejected` — the node definitively rejected these bytes; never resubmit.
   * - `mode-conflict` — a retry for this transaction arrived under the other
   *   normalized submission mode, which the spec forbids.
   *
   * @param txHash - The canonical Cardano transaction id.
   * @param mode - The normalized submission mode this settlement uses.
   * @param ownerToken - Unpredictable token that owns a fresh claim.
   * @param termsDigest - Optional Masumi terms binding.
   * @returns The claim outcome.
   */
  private async claimSettlement(
    txHash: string,
    mode: CardanoSubmissionMode,
    ownerToken: string,
    termsDigest?: string,
  ): Promise<
    | "fresh"
    | "in-flight"
    | "submitted"
    | "rejected"
    | "mode-conflict"
    | "terms-conflict"
    | "capacity-exceeded"
  > {
    return this.settlementStore.claimSettlement({
      txHash,
      mode,
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
}

/**
 * Convenience helper exposing the list of networks this scheme supports.
 *
 * @returns The supported Cardano CAIP-style network identifiers.
 */
export function supportedCardanoNetworks(): readonly string[] {
  return CARDANO_NETWORKS;
}
