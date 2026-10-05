/**
 * transfer-factory settle primitive — interactive-execute a payer-signed
 * `TransferFactory_Transfer` and confirm funds moved. The facilitator signs
 * nothing for the payer: the prepared tx + signature come from the inline
 * payload. The Canton analog of EIP-3009 `transferWithAuthorization`.
 *
 * Ported from the production facilitator's TransferFactoryService, adapted to
 * this package's local ledger client.
 */
import type { CantonClient } from "./client.js";

const AMULET_SUFFIX_RE = /:Splice\.Amulet:Amulet$/;
/** A pending two-step transfer: the token standard's instruction under any
 *  implementation name (`Splice.AmuletTransferInstruction:AmuletTransferInstruction`,
 *  a registry's `...:TransferInstruction`) or a legacy wallet `TransferOffer`. */
const PENDING_TRANSFER_SUFFIX_RE = /:(?:\w*TransferInstruction|TransferOffer)$/;

/**
 * Positive proof a registry transfer delivered, read from the token standard's
 * own result discriminator. `TransferFactory_Transfer` returns a
 * TransferInstructionResult whose `output.tag` is `TransferInstructionResult_Completed`
 * on a direct settle and a Pending tag on a two-step transfer. Returns undefined
 * when the result is not readable — the caller then keeps the previous behaviour
 * rather than inventing a negative.
 *
 * @param events - The transaction's ledger-effects events.
 * @returns True when completed, false when pending, undefined when unreadable.
 */
export function transferCompletedFromResult(
  events: ReadonlyArray<{
    ExercisedEvent?: { choice?: string; exerciseResult?: unknown };
  }>,
): boolean | undefined {
  for (const ev of events) {
    const ex = ev.ExercisedEvent;
    if (!ex || ex.choice !== "TransferFactory_Transfer") continue;
    const out = (ex.exerciseResult as { output?: { tag?: unknown } } | undefined)?.output;
    const tag = typeof out?.tag === "string" ? out.tag : undefined;
    if (tag === undefined) return undefined;
    return tag === "TransferInstructionResult_Completed";
  }
  return undefined;
}

/** HTTP statuses on which /execute provably did not accept the submission.
 *  Deliberately an allow-list: 408 (timeout), 409 (duplicate — the first may be
 *  committing), 499 (cancelled) and any unlisted status stay unknown. */
const DEFINITE_EXECUTE_REFUSALS = new Set([400, 401, 403, 404, 413, 422, 429]);

/**
 * True when an /execute failure is a definite refusal (an allow-listed HTTP
 * status). Everything else, including every non-HTTP failure, is unknown.
 *
 * @param err - The error thrown by interactiveSubmissionExecute.
 * @returns True when the request was provably not accepted.
 */
export function isDefiniteExecuteRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  if (e?.code !== "HTTP_ERROR" || typeof e.status !== "number") return false;
  return DEFINITE_EXECUTE_REFUSALS.has(e.status);
}

/** Dependencies for {@link TransferFactoryService}. */
export interface TransferFactoryDeps {
  client: Pick<
    CantonClient,
    | "interactiveSubmissionExecute"
    | "getLedgerEnd"
    | "pollCompletionUpdateId"
    | "getTransactionById"
  >;
  /** The ledger user the relay executes as (holds CanActAs on the payer party). */
  userId: string;
  /** getTransactionById confirmation retry (the payer projection can lag). */
  confirmRetry?: { attempts: number; delayMs: number };
}

/** Which funds-moved signal applies: Canton Coin (archived Amulet) or a CIP-56
 *  registry token (the standard's Completed result tag). */
export type TransferKind = "amulet" | "registry";

/** Result of {@link TransferFactoryService.execute}. */
export interface TfExecuteResult {
  updateId: string;
  /** True when the settle tx provably moved funds (archived Amulet with no
   *  pending TransferInstruction, or the CIP-56 Completed result). */
  transferred: boolean;
  /** True when the funds-moved read was inconclusive and `transferred` fell back
   *  to the committed-execute signal. */
  confirmInconclusive: boolean;
}

const DEFAULT_CONFIRM_RETRY = { attempts: 4, delayMs: 500 };

/** The submission was accepted by the participant but its outcome could not be
 *  read — it may be committing right now. Distinct from a definite refusal so
 *  /settle never reports an unknown outcome as a rejection. */
export class SubmissionOutcomeUnknownError extends Error {
  /**
   * Construct a submission-outcome-unknown error.
   *
   * @param cause - The underlying read failure.
   */
  constructor(readonly cause: unknown) {
    super(
      `interactive submission accepted but its outcome could not be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SubmissionOutcomeUnknownError";
  }
}

/** Executes a payer-signed transfer and confirms funds moved. */
export class TransferFactoryService {
  /**
   * Construct the transfer-factory settle service.
   *
   * @param deps - The ledger client, ledger user, retry, and registry config.
   */
  constructor(private readonly deps: TransferFactoryDeps) {}

  /**
   * Interactive-execute the signed submission and confirm funds moved. Throws on
   * a ledger/transport error (the caller maps it to a settle failure). A
   * committed-but-did-not-move-funds outcome returns `transferred:false`.
   *
   * @param input - The payer, prepared transaction, signature envelope, scheme
   *   version, submission id, optional begin offset, and transfer kind.
   * @returns The updateId and funds-moved verdict.
   */
  async execute(input: {
    payer: string;
    preparedTransaction: string;
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
    partySignatures: {
      signatures: Array<{ party: string; signatures: Array<Record<string, unknown>> }>;
    };
    submissionId: string;
    beginExclusive?: number;
    transferKind: TransferKind;
  }): Promise<TfExecuteResult> {
    const offset0 = input.beginExclusive ?? (await this.deps.client.getLedgerEnd()).offset;
    let r: Awaited<ReturnType<TransferFactoryDeps["client"]["interactiveSubmissionExecute"]>>;
    try {
      r = await this.deps.client.interactiveSubmissionExecute({
        preparedTransaction: input.preparedTransaction,
        hashingSchemeVersion: input.hashingSchemeVersion,
        partySignatures: input.partySignatures,
        submissionId: input.submissionId,
        deduplicationPeriod: { Empty: {} },
      });
    } catch (err) {
      // Only a definite refusal of the request means nothing was submitted. A
      // timeout, a dropped connection, an unreadable body or a 5xx may have
      // reached the ledger — that outcome is unknown, never a rejection.
      if (isDefiniteExecuteRefusal(err)) throw err;
      throw new SubmissionOutcomeUnknownError(err);
    }
    // /execute is async: it normally answers `{}` with the updateId on the
    // completion stream. Everything below reads the outcome of a submission
    // already in flight — it can classify a payment, never unmake it.
    let updateId = r.updateId;
    if (!updateId) {
      try {
        updateId = await this.deps.client.pollCompletionUpdateId(
          this.deps.userId,
          input.payer,
          input.submissionId,
          offset0,
        );
      } catch (err) {
        // A completion carrying a non-zero status is a real refusal — nothing
        // moved. Any other read failure is an unknown outcome, never a rejection.
        if ((err as { code?: unknown } | null)?.code === "SUBMISSION_FAILED") throw err;
        throw new SubmissionOutcomeUnknownError(err);
      }
    }
    return this.confirmTransferred(input.payer, updateId, input.transferKind);
  }

  /**
   * Did the funds actually move under this updateId? Reads the payer's
   * projection; an unreadable read is inconclusive (trust the commit), never
   * "did not happen".
   *
   * @param payer - The payer party whose projection to read.
   * @param updateId - The committed update to confirm.
   * @param transferKind - Selects the Amulet vs registry funds-moved signal.
   * @returns The updateId and funds-moved verdict.
   */
  async confirmTransferred(
    payer: string,
    updateId: string,
    transferKind: TransferKind,
  ): Promise<TfExecuteResult> {
    const isRegistry = transferKind === "registry";
    const cfg = this.deps.confirmRetry ?? DEFAULT_CONFIRM_RETRY;
    for (let i = 0; i < cfg.attempts; i++) {
      let events: Awaited<
        ReturnType<TransferFactoryDeps["client"]["getTransactionById"]>
      >["events"] = [];
      try {
        // A registry token's proof of delivery is the exercise result, which the
        // narrow projection does not carry — ask for the full effects tree there.
        // The Amulet path reads the flat projection, whose archived Amulet is its
        // positive signal (the effects tree reports archives as exercises).
        events = (
          await this.deps.client.getTransactionById({
            updateId,
            requestingParties: [payer],
            ...(isRegistry ? { fullEffects: true } : {}),
          })
        ).events;
      } catch {
        events = []; // unreadable == inconclusive, never == "did not happen"
      }
      let sawArchivedAmulet = false;
      let sawPendingInstruction = false;
      let sawAnyEvent = false;
      for (const ev of events) {
        sawAnyEvent = true;
        if (ev.ArchivedEvent && AMULET_SUFFIX_RE.test(ev.ArchivedEvent.templateId ?? "")) {
          sawArchivedAmulet = true;
        }
        if (ev.CreatedEvent && PENDING_TRANSFER_SUFFIX_RE.test(ev.CreatedEvent.templateId ?? "")) {
          sawPendingInstruction = true;
        }
      }
      if (sawAnyEvent) {
        // Amulet emits an archived `Splice.Amulet:Amulet` as the consumed input
        // (the positive "funds moved" signal). A registry token archives its own
        // (unknown-to-us) Holding, so for a registry instrument the signal is the
        // standard's Completed result tag, falling back to "committed + not
        // pending" when the tag cannot be read. For Amulet, a created pending
        // instruction means the input was only locked, not delivered.
        const completedByResult = transferCompletedFromResult(events);
        return {
          updateId,
          transferred: isRegistry
            ? (completedByResult ?? !sawPendingInstruction)
            : sawArchivedAmulet && !sawPendingInstruction,
          confirmInconclusive: false,
        };
      }
      if (i < cfg.attempts - 1) {
        await new Promise(res => setTimeout(res, cfg.delayMs));
      }
    }
    // Inconclusive read after retries: the execute committed (we have an
    // updateId) and the preapproval gate already excluded the Pending case. Trust
    // the committed signal; flag it.
    return { updateId, transferred: true, confirmInconclusive: true };
  }
}
