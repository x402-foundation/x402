/**
 * Canton facilitator implementation of the `exact` scheme.
 *
 * `verify` proves the payer-signed inline transfer against the merchant's
 * requirements (see verify-inline.ts). `settle` re-verifies, then relays the
 * signed transaction through the injected `FacilitatorCantonSigner`
 * (ExecuteSubmission) and succeeds only once the transaction is committed.
 *
 * When the outcome of a relay cannot be read, settle returns the non-terminal
 * `settlement_pending` and remembers the submission. A retry of the same payload
 * reconciles against it instead of relaying again. The signed transaction can
 * only commit before its deadline (its `executeBefore`, enforced through its
 * ledger time, plus the synchronizer's ledger-time tolerance), so once that has
 * passed a submission that is still nowhere on the ledger never will be, and
 * the failure is final.
 */
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import { CANTON_CAIP_FAMILY } from "../../constants.js";
import type { CantonErrorCode } from "../../types.js";
import type { FacilitatorCantonSigner, CantonSchemeConfig } from "../../signer.js";
import { verifyInlineTransfer, type InlineVerifyResult } from "./verify-inline.js";
import {
  isFacilitatorSideRefusal,
  SubmissionOutcomeUnknownError,
} from "../../ledger/transfer-factory.js";

/** Default allowance between a transaction's ledger-time deadline and the last
 *  record time it can commit at: the synchronizer's ledger-time/record-time
 *  tolerance (Canton's default is 60s) plus room for the participant to catch up. */
const DEFAULT_LEDGER_TIME_TOLERANCE_MS = 120_000;

/** What settle remembers about a relay whose outcome it could not read. */
interface PendingSubmission {
  kind: "pending";
  submissionId: string;
  commandId: string;
  /** Ledger offset read before submitting; the outcome, if any, lies after it. */
  beginOffset: number;
  /** After this instant (ms) the transaction can no longer commit. */
  finalAfterMs: number;
  /** When the payload was verified, so a retry re-proves it as it stood then. */
  verifiedAtMs: number;
  /** The participant reported the command as already accepted: an earlier
   *  relay may have committed before `beginOffset`, so absence proves nothing. */
  duplicate: boolean;
}

/** Options for the Canton facilitator scheme. */
export interface CantonFacilitatorOptions extends CantonSchemeConfig {
  /** The Global Synchronizer id this facilitator settles on, advertised in the
   *  402 `extra.synchronizerId` via {@link ExactCantonScheme.getExtra}. */
  synchronizerId?: string;
  /** The exact Canton networks this scheme serves; requirements on any other
   *  network are rejected with `invalid_network`. Required, so a scheme
   *  registered under a wildcard still refuses a network it does not settle on. */
  networks: readonly Network[];
  /** Remembers relays whose outcome could not be read, so a retry reconciles
   *  instead of relaying again. Defaults to a per-process in-memory store; a
   *  facilitator running several replicas should supply a shared one. */
  pendingSettlementStore?: PendingSettlementStore;
  /** The synchronizer's ledger-time/record-time tolerance plus participant lag,
   *  in ms. Added to a transaction's deadline to know when it can no longer
   *  commit. Defaults to 120000. */
  ledgerTimeToleranceMs?: number;
}

/** Facilitator-side `exact` scheme for Canton networks. */
export class ExactCantonScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = CANTON_CAIP_FAMILY;
  private readonly pendingStore: PendingSettlementStore;

  /**
   * Construct the facilitator-side Canton exact scheme.
   *
   * @param signer - Ledger access + facilitator relaying key(s).
   * @param options - Served networks, trust anchors, registry config, and the synchronizer id.
   */
  constructor(
    private readonly signer: FacilitatorCantonSigner,
    private readonly options: CantonFacilitatorOptions,
  ) {
    if (options.networks.length === 0) {
      throw new Error("ExactCantonScheme: `networks` must name at least one Canton network");
    }
    this.pendingStore = options.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
  }

  /**
   * Mechanism `extra` for the /supported response: this facilitator's feePayer
   * and the synchronizer it settles on.
   *
   * @param _ - The network identifier (unused; one facilitator identity here).
   * @returns The `{ feePayer, synchronizerId }` extra, or undefined when neither is set.
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const feePayer = this.signer.getAddresses()[0];
    const extra: Record<string, unknown> = {};
    if (feePayer) extra.feePayer = feePayer;
    if (this.options.synchronizerId) extra.synchronizerId = this.options.synchronizerId;
    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  /**
   * Facilitator parties that relay (and pay the Global Synchronizer traffic).
   *
   * @param _ - The network identifier (unused).
   * @returns The facilitator relaying parties.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Validate a payer-signed inline transfer against the merchant's requirements.
   *
   * @param payload - The x402 payment payload (inline carriage).
   * @param requirements - The merchant's payment requirements.
   * @returns Whether the payment is valid, with the proven payer or a reason.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const r = await verifyInlineTransfer(payload, requirements, this.signer, this.options);
    if (r.ok) {
      return { isValid: true, payer: r.payer };
    }
    return {
      isValid: false,
      invalidReason: r.reason,
      ...(r.payer ? { payer: r.payer } : {}),
    };
  }

  /**
   * Verify, then relay the signed transaction; succeed once it is committed.
   * A retry of a payload whose earlier relay ended `settlement_pending`
   * reconciles against that relay instead of submitting again.
   *
   * @param payload - The x402 payment payload (inline carriage).
   * @param requirements - The merchant's payment requirements.
   * @returns The settlement result: on success the on-ledger updateId.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const earlier = await this.earlierRelay(payload, requirements);
    if (earlier?.status === "unverifiable") {
      return this.pendingResponse(earlier.key, earlier.payer, network);
    }
    if (earlier) return this.reconcile(earlier.key, earlier.record, earlier.payer, requirements);

    const v = await verifyInlineTransfer(payload, requirements, this.signer, this.options);
    if (!v.ok) return this.settleFailure(v.reason, network, v.payer);
    const verifiedAtMs = Date.now();
    // Derived from the signed transaction, so every relay of it uses one id.
    const submissionId = `x402-settle-${v.preparedTxHashHex}`;

    try {
      const exec = await this.signer.executeSubmission({
        preparedTransactionBytes: v.preparedTransactionBytes,
        signatureB64: v.signatureB64,
        payer: v.payer,
        hashingSchemeVersion: v.hashingSchemeVersion,
        submissionId,
      });
      // A commit is not remembered: answering a later settle of the same payload
      // from memory would make the payment replayable. That retry relays again,
      // and the ledger answers it as a duplicate or a spend of archived inputs.
      return { success: true, payer: v.payer, transaction: exec.updateId, network };
    } catch (err) {
      if (!(err instanceof SubmissionOutcomeUnknownError)) {
        // Refused before submission for a reason of the facilitator's own (its
        // credentials, a missing route, a rate limit) is not the payment's fault.
        const reason = isFacilitatorSideRefusal(err)
          ? "unexpected_canton_ledger_error"
          : "invalid_exact_canton_execute_failed";
        return this.settleFailure(reason, network, v.payer);
      }
      await this.remember(v.preparedTxHashHex, {
        kind: "pending",
        submissionId,
        commandId: v.commandId,
        beginOffset: err.beginOffset,
        finalAfterMs: v.commitDeadlineMs + this.toleranceMs(),
        verifiedAtMs,
        duplicate: err.duplicate,
      });
      return this.pendingResponse(v.preparedTxHashHex, v.payer, network);
    }
  }

  /**
   * The earlier relay of this payload, if settle remembers one. The store is
   * keyed by the prepared-transaction hash; the payload's own claimed hash only
   * finds the entry. It counts only when the payload re-verifies, as of the
   * original verification, against these requirements and to that same hash, so
   * a different payload claiming the hash cannot take over the original's
   * outcome. If the re-verification cannot be completed (a ledger read failed),
   * the earlier relay's outcome stays open.
   *
   * @param payload - The x402 payment payload.
   * @param requirements - The merchant's payment requirements.
   * @returns The earlier relay with the proven payer, an unverifiable one, or undefined.
   */
  private async earlierRelay(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<
    | { status: "found"; key: string; record: PendingSubmission; payer: string }
    | { status: "unverifiable"; key: string; payer: string }
    | undefined
  > {
    const claimed = (payload.payload as { preparedTxHash?: unknown } | undefined)?.preparedTxHash;
    if (typeof claimed !== "string" || claimed.length === 0) return undefined;
    const key = claimed.toLowerCase();
    const stored = await this.pendingStore.get(key);
    const record = stored ? parseStored(stored) : undefined;
    if (!record) return undefined;
    const v: InlineVerifyResult = await verifyInlineTransfer(
      payload,
      requirements,
      this.signer,
      this.options,
      record.verifiedAtMs,
    );
    if (v.ok && v.preparedTxHashHex === key)
      return { status: "found", key, record, payer: v.payer };
    if (!v.ok && v.reason === "unexpected_canton_ledger_error") {
      return { status: "unverifiable", key, payer: v.payer };
    }
    return undefined;
  }

  /**
   * Resolve a relay that ended `settlement_pending`. The entry is removed first
   * so a concurrent retry does not reconcile it twice, and re-recorded only when
   * the outcome is still open: a commit is answered as success exactly once.
   *
   * @param key - The prepared-transaction hash the relay is stored under.
   * @param record - What was remembered about the relay.
   * @param payer - The proven payer.
   * @param requirements - The merchant's payment requirements.
   * @returns Success, a final failure, or `settlement_pending` again.
   */
  private async reconcile(
    key: string,
    record: PendingSubmission,
    payer: string,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    await this.pendingStore.delete(key);
    // Read the clock before the ledger: an absence observed after this instant
    // covers every commit that could still have happened before it.
    const checkedAtMs = Date.now();
    const found = await this.signer.lookupSubmission({
      payer,
      submissionId: record.submissionId,
      commandId: record.commandId,
      beginOffset: record.beginOffset,
    });
    if (found.status === "committed") {
      // Answered once; the entry stays deleted, so this commit is never served again.
      return { success: true, payer, transaction: found.updateId, network };
    }
    if (found.status === "rejected") {
      return this.settleFailure("invalid_exact_canton_execute_failed", network, payer);
    }
    if (found.status === "absent" && !record.duplicate && checkedAtMs > record.finalAfterMs) {
      // Past the deadline and nowhere on the ledger: it can never commit, so
      // the payer may safely pay again.
      return this.settleFailure("invalid_exact_canton_execute_failed", network, payer);
    }
    await this.remember(key, record);
    return this.pendingResponse(key, payer, network);
  }

  /**
   * Remember a relay's outcome. Best effort: without the entry a retry relays
   * the same transaction again, which the participant deduplicates (reported
   * as a duplicate, which settle never turns into a failure) or refuses for
   * spent inputs.
   *
   * @param key - The prepared-transaction hash.
   * @param record - What to remember.
   */
  private async remember(key: string, record: PendingSubmission): Promise<void> {
    try {
      await this.pendingStore.set(key, JSON.stringify(record));
    } catch {
      // See above: losing the entry costs a second relay, never a wrong answer.
    }
  }

  /**
   * The `settlement_pending` response.
   *
   * @param key - The prepared-transaction hash.
   * @param payer - The proven payer.
   * @param network - The requirements' network.
   * @returns The pending response.
   */
  private pendingResponse(key: string, payer: string, network: Network): SettleResponse {
    return {
      success: false,
      errorReason: "settlement_pending",
      errorMessage: "the transfer was relayed but its outcome is not known yet",
      // No updateId exists until the transaction commits; the prepared
      // transaction's hash identifies it until then.
      transaction: key,
      network,
      payer,
    };
  }

  /**
   * The configured ledger-time tolerance.
   *
   * @returns Milliseconds added to a transaction's deadline.
   */
  private toleranceMs(): number {
    return this.options.ledgerTimeToleranceMs ?? DEFAULT_LEDGER_TIME_TOLERANCE_MS;
  }

  /**
   * Build a failed SettleResponse.
   *
   * @param reason - The Canton error code.
   * @param network - The requirements' network.
   * @param payer - The proven payer, when known.
   * @returns The failure response.
   */
  private settleFailure(reason: CantonErrorCode, network: Network, payer: string): SettleResponse {
    return {
      success: false,
      errorReason: reason,
      transaction: "",
      network,
      ...(payer ? { payer } : {}),
    };
  }
}

/**
 * Parse a stored entry, or undefined when it is not one.
 *
 * @param stored - The stored JSON.
 * @returns The pending record.
 */
function parseStored(stored: string): PendingSubmission | undefined {
  let r: { [K in keyof PendingSubmission]?: unknown };
  try {
    r = JSON.parse(stored) as typeof r;
  } catch {
    return undefined;
  }
  const isNumber = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (
    r.kind === "pending" &&
    typeof r.submissionId === "string" &&
    typeof r.commandId === "string" &&
    typeof r.duplicate === "boolean" &&
    [r.beginOffset, r.finalAfterMs, r.verifiedAtMs].every(isNumber)
  ) {
    return r as unknown as PendingSubmission;
  }
  return undefined;
}
