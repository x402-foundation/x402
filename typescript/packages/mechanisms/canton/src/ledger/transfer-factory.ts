/**
 * transfer-factory settle primitive — interactive-execute a payer-signed
 * `TransferFactory_Transfer` and learn its outcome. The facilitator signs
 * nothing for the payer: the prepared tx + signature come from the inline
 * payload. The Canton analog of EIP-3009 `transferWithAuthorization`.
 *
 * A committed update IS the settlement: confirming participants re-interpret
 * the signed transaction and commit exactly it, so its effects are the ones
 * verify proved from the signed bytes. There is no separate funds-moved read.
 */
import type { CantonClient } from "./client.js";

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

/** Definite refusals caused by the facilitator's own access (credentials, a
 *  missing route, a rate limit), as opposed to the submitted transaction. */
const FACILITATOR_SIDE_REFUSALS = new Set([401, 403, 404, 429]);

/**
 * True when /execute refused the request for a reason on the facilitator's
 * side rather than the transaction's.
 *
 * @param err - The error a relay threw.
 * @returns True for an HTTP 401, 403, 404 or 429 refusal.
 */
export function isFacilitatorSideRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  return (
    e?.code === "HTTP_ERROR" &&
    typeof e.status === "number" &&
    FACILITATOR_SIDE_REFUSALS.has(e.status)
  );
}

/**
 * True when `err` is an HTTP response with this status.
 *
 * @param err - The error thrown by the client.
 * @param status - The HTTP status.
 * @returns Whether it matches.
 */
function isHttpStatus(err: unknown, status: number): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  return e?.code === "HTTP_ERROR" && e.status === status;
}

/** Dependencies for {@link TransferFactoryService}. */
export interface TransferFactoryDeps {
  client: Pick<
    CantonClient,
    | "interactiveSubmissionExecute"
    | "getLedgerEnd"
    | "pollCompletionUpdateId"
    | "findCompletion"
    | "findCommandUpdateId"
    | "isPartyLocal"
  >;
  /** The ledger user the relay executes as (holds CanActAs on the payer party). */
  userId: string;
}

/** What the ledger says about a submission whose outcome was not read. */
export type SubmissionLookup =
  /** Committed under this updateId. */
  | { status: "committed"; updateId: string }
  /** Definitely rejected: nothing moved. */
  | { status: "rejected" }
  /** No completion, and no transaction carrying its command id up to the ledger
   *  end of a participant that hosts the payer (so it sees all the payer's
   *  transactions). Final only once the transaction can no longer be recorded
   *  (see the facilitator scheme's settlement deadline), and only when no relay
   *  of it was ever reported as a duplicate. */
  | { status: "absent" }
  /** The ledger could not be read conclusively. */
  | { status: "unknown" };

/** The submission was accepted by the participant but its outcome could not be
 *  read — it may be committing right now. Distinct from a definite refusal so
 *  /settle never reports an unknown outcome as a rejection. */
export class SubmissionOutcomeUnknownError extends Error {
  /**
   * Construct a submission-outcome-unknown error.
   *
   * @param cause - The underlying read failure.
   * @param beginOffset - The ledger offset read before submitting; the outcome,
   *   if any, lies after it.
   * @param duplicate - The participant reported the command as already accepted,
   *   so an earlier relay of it may have committed before `beginOffset`.
   */
  constructor(
    readonly cause: unknown,
    readonly beginOffset: number,
    readonly duplicate = false,
  ) {
    super(
      `interactive submission accepted but its outcome could not be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SubmissionOutcomeUnknownError";
  }
}

/** Executes a payer-signed transfer and reads its outcome. */
export class TransferFactoryService {
  /**
   * Construct the transfer-factory settle service.
   *
   * @param deps - The ledger client and ledger user.
   */
  constructor(private readonly deps: TransferFactoryDeps) {}

  /**
   * Interactive-execute the signed submission and return its committed
   * updateId. Throws the ledger's error on a definite refusal or rejection, and
   * {@link SubmissionOutcomeUnknownError} when the outcome could not be read.
   *
   * @param input - The payer, prepared transaction, signature envelope, scheme
   *   version and submission id.
   * @returns The committed updateId.
   */
  async execute(input: {
    payer: string;
    preparedTransaction: string;
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
    partySignatures: {
      signatures: Array<{ party: string; signatures: Array<Record<string, unknown>> }>;
    };
    submissionId: string;
  }): Promise<{ updateId: string }> {
    const offset0 = (await this.deps.client.getLedgerEnd()).offset;
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
      throw new SubmissionOutcomeUnknownError(err, offset0, isHttpStatus(err, 409));
    }
    // /execute is async: it normally answers `{}` with the updateId on the
    // completion stream.
    if (r.updateId) return { updateId: r.updateId };
    try {
      const updateId = await this.deps.client.pollCompletionUpdateId(
        this.deps.userId,
        input.payer,
        input.submissionId,
        offset0,
      );
      return { updateId };
    } catch (err) {
      // A completion carrying a non-zero status is a real refusal — nothing
      // moved. Any other read failure is an unknown outcome, never a rejection.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "SUBMISSION_FAILED") throw err;
      throw new SubmissionOutcomeUnknownError(err, offset0, code === "DUPLICATE_SUBMISSION");
    }
  }

  /**
   * Look up a submission whose outcome was not read. The completion stream is
   * checked first; when it has nothing, the payer's transactions from
   * `beginOffset` to the ledger end are searched for the signed command id. That
   * search proves absence only on a participant that hosts the payer; elsewhere
   * a miss stays unknown.
   *
   * @param input - The payer, submission id, signed command id and the offset
   *   read before submitting.
   * @returns The submission's status.
   */
  async lookup(input: {
    payer: string;
    submissionId: string;
    commandId: string;
    beginOffset: number;
  }): Promise<SubmissionLookup> {
    try {
      const completion = await this.deps.client.findCompletion(
        this.deps.userId,
        input.payer,
        input.submissionId,
        input.beginOffset,
      );
      if (completion.kind === "settled") {
        return { status: "committed", updateId: completion.updateId };
      }
      if (completion.kind === "rejected") return { status: "rejected" };
      if (completion.kind === "malformed") return { status: "unknown" };
      const updateId = await this.deps.client.findCommandUpdateId(
        input.payer,
        input.commandId,
        input.beginOffset,
      );
      if (updateId) return { status: "committed", updateId };
      // An earlier relay of this command was accepted; it may have committed
      // before the searched range, so a miss proves nothing.
      if (completion.kind === "duplicate") return { status: "unknown" };
      const hostsPayer = await this.deps.client.isPartyLocal(input.payer);
      return hostsPayer ? { status: "absent" } : { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }
}
