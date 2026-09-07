/**
 * Low-level JSON Ledger API v2 client for Canton — the subset the exact-scheme
 * signer needs: interactive submission (prepare/execute), completion polling,
 * transaction read-back (funds-moved confirmation), and the synchronizer topology
 * read that recovers a payer's Ed25519 signing key.
 *
 * Encodes the Canton 3.4+ gotchas so callers don't have to:
 *   - Template IDs use the `#package-name:Module:Entity` form (leading `#`).
 *   - Daml `Int`/`Decimal` are JSON STRINGS; pass through, never parse to number.
 *   - Discriminators are wrapping keys (`{"ExerciseCommand": {...}}`).
 *
 * All methods throw `CantonError` on transport failure or non-2xx response,
 * preserving the HTTP status so callers can distinguish 4xx from 5xx.
 *
 * Ported from the production `@ftptech/x402-canton-ledger` client (live on
 * MainNet); trimmed to the signer's surface.
 */

/**
 * Resolves a bearer token on each ledger call. A plain string is accepted for
 * static-token deployments; a resolver lets an OIDC integration refresh.
 */
export type TokenProvider = () => Promise<string>;

/** Constructor options for {@link CantonClient}. */
export interface CantonClientOptions {
  participantUrl: string;
  /** Static bearer, or a resolver for OIDC. */
  token: string | TokenProvider;
  /** Request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override the fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** A `{"ExerciseCommand": {...}}` JSON Ledger API command. */
export type ExerciseCommand = {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
};

/** A disclosed-contract entry required to exercise a choice on a DSO-signed or
 *  registry contract. */
export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

/** Body for `/v2/interactive-submission/prepare`. */
export interface InteractivePrepareBody {
  userId: string;
  commandId: string;
  actAs: string[];
  readAs?: string[];
  synchronizerId: string;
  verboseHashing?: boolean;
  packageIdSelectionPreference?: string[];
  commands: ExerciseCommand[];
  disclosedContracts?: DisclosedContract[];
}

/** Result of `/v2/interactive-submission/prepare`. */
export interface PreparedSubmission {
  /** Base64 `PreparedTransaction` protobuf. Opaque — pass through to execute. */
  preparedTransaction: string;
  /** Base64 hash of the prepared transaction; the external party signs it. */
  preparedTransactionHash: string;
}

/** Body for `/v2/interactive-submission/execute`. */
export interface InteractiveExecuteBody {
  submissionId?: string;
  preparedTransaction: string;
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
  partySignatures: {
    signatures: Array<{
      party: string;
      signatures: Array<Record<string, unknown>>;
    }>;
  };
  deduplicationPeriod?:
    | { Empty: Record<string, never> }
    | { DeduplicationDuration: { duration: string } };
}

/** Result of `/v2/interactive-submission/execute`. */
export interface InteractiveExecuteResult {
  updateId: string;
  completionOffset: number;
}

/** A created contract as returned by transaction / ACS reads. */
export interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
  signatories: string[];
  observers: string[];
  packageName: string;
  /** CIP-56 interface views — populated when the query sets includeInterfaceView
   *  and the contract implements the interface (e.g. HoldingV1). */
  interfaceViews?: Array<{ interfaceId: string; viewValue: Record<string, unknown> }>;
}

/** Filter for `/v2/state/active-contracts`. */
export interface ActiveContractsFilter {
  filtersByParty: Record<
    string,
    {
      cumulative: Array<{
        identifierFilter?: {
          InterfaceFilter?: {
            value: {
              interfaceId: string;
              includeInterfaceView: boolean;
              includeCreatedEventBlob: boolean;
            };
          };
        };
      }>;
    }
  >;
}

/** One unlocked HoldingV1 holding owned by a party. */
export interface HoldingV1Row {
  cid: string;
  /** Ledger Decimal amount as the STRING the view carries. */
  amount: string;
}

/** A Canton ledger error carrying the HTTP status when the failure was a response. */
export class CantonError extends Error {
  /**
   * Construct a Canton ledger error.
   *
   * @param message - Human-readable description.
   * @param code - Stable machine code (e.g. `HTTP_ERROR`, `TIMEOUT`).
   * @param status - HTTP status when the failure was a response.
   * @param responseBody - Truncated response body for diagnostics.
   */
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "CantonError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** JSON Ledger API v2 client — the signer subset. */
export class CantonClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  /**
   * Construct a Canton JSON Ledger API client.
   *
   * @param opts - Participant URL, token, and optional timeout/fetch overrides.
   */
  constructor(private readonly opts: CantonClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * POST `/v2/interactive-submission/prepare` — build (but do not submit) the
   * transaction for an external party, returning the serialized prepared
   * transaction and its hash.
   *
   * @param body - The prepare request (actAs, synchronizerId, commands, ...).
   * @returns The prepared transaction and its hash.
   */
  async interactiveSubmissionPrepare(body: InteractivePrepareBody): Promise<PreparedSubmission> {
    const response = await this.post<{
      preparedTransaction?: string;
      preparedTransactionHash?: string;
    }>("/v2/interactive-submission/prepare", {
      // The participant REQUIRES packageIdSelectionPreference (omitting it → HTTP
      // 400); verboseHashing defaults false. Any explicit value in `body` wins.
      verboseHashing: false,
      packageIdSelectionPreference: [],
      ...body,
    });
    if (!response.preparedTransaction || !response.preparedTransactionHash) {
      throw new CantonError(
        "interactive-submission/prepare returned incomplete response",
        "INVALID_RESPONSE",
      );
    }
    return {
      preparedTransaction: response.preparedTransaction,
      preparedTransactionHash: response.preparedTransactionHash,
    };
  }

  /**
   * POST `/v2/interactive-submission/execute` — submit a prepared transaction
   * plus the external party's signature. The route is async: it may return `{}`
   * with the updateId arriving on the completion stream, so a missing updateId is
   * NOT an error here (poll the completion instead).
   *
   * @param body - The execute request (prepared tx, signatures, ...).
   * @returns The updateId (possibly empty) and completion offset.
   */
  async interactiveSubmissionExecute(
    body: InteractiveExecuteBody,
  ): Promise<InteractiveExecuteResult> {
    const response = await this.post<{
      updateId?: string;
      completionOffset?: number;
    }>("/v2/interactive-submission/execute", body);
    return {
      updateId: response.updateId ?? "",
      completionOffset: response.completionOffset ?? 0,
    };
  }

  /**
   * GET `/v2/state/ledger-end` — the current ledger end offset. Throws on a
   * missing/non-numeric offset rather than defaulting to 0 (which would silently
   * search the oldest snapshot).
   *
   * @returns The ledger end offset.
   */
  async getLedgerEnd(): Promise<{ offset: number }> {
    const response = await this.get<{ offset?: number }>("/v2/state/ledger-end");
    if (typeof response.offset !== "number" || !Number.isFinite(response.offset)) {
      throw new CantonError(
        "getLedgerEnd: participant returned no numeric offset",
        "INVALID_RESPONSE",
      );
    }
    return { offset: response.offset };
  }

  /**
   * POST `/v2/updates/transaction-by-id` (or `update-by-id` for full effects) —
   * look up a transaction's events scoped to the requesting parties. The
   * funds-moved confirmation reads the payer's projection here.
   *
   * @param args - updateId, requestingParties, and whether to request the full
   *   ledger-effects tree (needed for a registry token's exercise result).
   * @returns The transaction's events.
   */
  async getTransactionById(args: {
    fullEffects?: boolean;
    updateId: string;
    requestingParties: string[];
  }): Promise<{
    updateId: string;
    offset: number;
    events: Array<{
      CreatedEvent?: CreatedEvent;
      ExercisedEvent?: {
        contractId: string;
        templateId: string;
        choice: string;
        exerciseResult?: unknown;
      };
      ArchivedEvent?: { contractId: string; templateId: string };
    }>;
  }> {
    const response = await this.post<{
      transaction?: {
        updateId?: string;
        offset?: number;
        events?: Array<{
          CreatedEvent?: CreatedEvent;
          ExercisedEvent?: {
            contractId: string;
            templateId: string;
            choice: string;
            exerciseResult?: unknown;
          };
          ArchivedEvent?: { contractId: string; templateId: string };
        }>;
      };
    }>(
      args.fullEffects ? "/v2/updates/update-by-id" : "/v2/updates/transaction-by-id",
      args.fullEffects
        ? {
            // The same party sees different events per request shape. update-by-id
            // + wildcard filter yields the full ledger-effects tree including the
            // TransferFactory_Transfer WITH its exerciseResult — where a registry
            // token's funds-moved proof lives.
            updateId: args.updateId,
            updateFormat: {
              includeTransactions: {
                eventFormat: {
                  filtersByParty: Object.fromEntries(
                    args.requestingParties.map(p => [
                      p,
                      {
                        cumulative: [
                          {
                            identifierFilter: {
                              WildcardFilter: {
                                value: { includeCreatedEventBlob: false },
                              },
                            },
                          },
                        ],
                      },
                    ]),
                  ),
                  verbose: false,
                },
                transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
              },
            },
          }
        : {
            updateId: args.updateId,
            requestingParties: args.requestingParties,
            transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
          },
    );
    // The two endpoints wrap the transaction differently:
    //   transaction-by-id -> { transaction: { events } }
    //   update-by-id      -> { update: { Transaction: { value: { events } } } }
    const wrapped = (
      response as unknown as {
        update?: {
          Transaction?: {
            value?: { updateId?: string; offset?: number; events?: unknown[] };
          };
        };
      }
    ).update?.Transaction?.value;
    const tx = (args.fullEffects ? wrapped : response.transaction) ?? {};
    return {
      updateId: tx.updateId ?? args.updateId,
      offset: tx.offset ?? 0,
      events: (tx.events ?? []) as Awaited<
        ReturnType<CantonClient["getTransactionById"]>
      >["events"],
    };
  }

  /**
   * ONE pass over the completion stream for a submissionId — no waiting, no
   * retry. The three-way outcome (settled / rejected / not there yet) has a
   * single reading here so callers cannot drift.
   *
   * @param userId - The ledger user the submission was made as.
   * @param party - The acting party.
   * @param submissionId - The submission to find.
   * @param beginExclusive - Offset to read completions after.
   * @returns The settled updateId, a rejection message, or absent.
   */
  async findCompletion(
    userId: string,
    party: string,
    submissionId: string,
    beginExclusive: number,
  ): Promise<
    | { kind: "settled"; updateId: string }
    | { kind: "rejected"; message: string }
    | { kind: "absent" }
  > {
    for (const v of await this.readCompletions(userId, party, beginExclusive)) {
      if (v.submissionId !== submissionId) continue;
      if (!v.status || v.status.code === 0) {
        return { kind: "settled", updateId: v.updateId ?? "" };
      }
      return {
        kind: "rejected",
        message: v.status.message || `status ${v.status.code}`,
      };
    }
    return { kind: "absent" };
  }

  /**
   * Poll the completion stream for the updateId of an interactive submission
   * whose `/execute` returned `{}`. Throws `SUBMISSION_FAILED` when the completion
   * carries a non-zero status.
   *
   * @param userId - The ledger user the submission was made as.
   * @param party - The acting party.
   * @param submissionId - The submission to poll.
   * @param beginExclusive - Offset to read completions after.
   * @returns The committed updateId.
   */
  async pollCompletionUpdateId(
    userId: string,
    party: string,
    submissionId: string,
    beginExclusive: number,
  ): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = await this.findCompletion(userId, party, submissionId, beginExclusive);
      if (found.kind === "settled") return found.updateId;
      if (found.kind === "rejected") {
        throw new CantonError(
          `interactive submission rejected: ${found.message}`,
          "SUBMISSION_FAILED",
        );
      }
      await new Promise(r => setTimeout(r, 600));
    }
    throw new CantonError("no completion for submissionId within timeout", "INVALID_RESPONSE");
  }

  /**
   * Read an external party's Ed25519 SIGNING public keys from synchronizer
   * topology, as raw 32-byte keys.
   *
   * A party id carries a one-way FINGERPRINT, so verifying a payer's signature
   * needs a topology read — this one. Our participant need NOT host the party:
   * the endpoint resolves against the broadcast synchronizer topology store, so
   * any party on a connected synchronizer is readable. An empty array (unknown
   * party, or a participant too old to serve the route) MUST be treated as
   * "cannot verify", never as "no keys, so accept".
   *
   * @param synchronizerId - The synchronizer to read topology from.
   * @param party - The party whose signing keys to read.
   * @returns The party's raw 32-byte Ed25519 signing keys.
   */
  async getPartySigningKeys(synchronizerId: string, party: string): Promise<Buffer[]> {
    const res = await this.get<{
      keys?: Array<{ kty?: string; crv?: string; x?: string }>;
    }>(
      `/v2/jose/jwks/synchronizer/${encodeURIComponent(
        synchronizerId,
      )}/party/${encodeURIComponent(party)}`,
    );
    const out: Buffer[] = [];
    for (const k of res.keys ?? []) {
      // Pin the curve: an OKP entry for a different curve would decode to the
      // wrong length/algorithm; silently skipping the check would let a
      // non-Ed25519 key reach an Ed25519 verify.
      if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
      // `x` is base64url, unpadded, RFC 8032 — the raw point node's verify wants.
      const raw = Buffer.from(k.x, "base64url");
      if (raw.length === 32) out.push(raw);
    }
    return out;
  }

  /**
   * POST `/v2/state/active-contracts` — fetch the current ledger end and query
   * the ACS at that offset. Extracts created events from both the nested
   * `contractEntry.JsActiveContract.createdEvent` and flat shapes.
   *
   * @param filter - The active-contracts filter (per-party interface/template).
   * @returns The matching created events.
   */
  async queryActiveContracts(filter: ActiveContractsFilter): Promise<CreatedEvent[]> {
    const end = await this.getLedgerEnd();
    type AcsEntry = {
      contractEntry?: { JsActiveContract?: { createdEvent?: CreatedEvent } };
      createdEvent?: CreatedEvent;
    };
    type AcsResponse = AcsEntry[] | { contractEntries?: AcsEntry[] };
    const response = await this.post<AcsResponse>("/v2/state/active-contracts", {
      filter,
      verbose: false,
      activeAtOffset: end.offset,
    });
    const entries: AcsEntry[] = Array.isArray(response)
      ? response
      : (response.contractEntries ?? []);
    const events: CreatedEvent[] = [];
    for (const entry of entries) {
      const created = entry.contractEntry?.JsActiveContract?.createdEvent ?? entry.createdEvent;
      if (created) events.push(created);
    }
    return events;
  }

  /**
   * Read a party's unlocked HoldingV1 holdings for one instrument. A registry
   * token's concrete Holding template is the issuer's own, so it is queried by
   * the `Splice.Api.Token.HoldingV1:Holding` interface and read from the view —
   * one read serves any registry instrument.
   *
   * @param party - The owning party.
   * @param instrument - The instrument `{admin, id}` to filter to.
   * @returns The unlocked, positive holdings owned by the party for the instrument.
   */
  async readHoldingsV1(
    party: string,
    instrument: { admin: string; id: string },
  ): Promise<HoldingV1Row[]> {
    const events = await this.queryActiveContracts({
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
                    includeInterfaceView: true,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });
    const rows: HoldingV1Row[] = [];
    for (const e of events) {
      const view = e.interfaceViews?.find(v =>
        v.interfaceId.endsWith(":Splice.Api.Token.HoldingV1:Holding"),
      )?.viewValue as
        | {
            owner?: string;
            instrumentId?: { admin?: string; id?: string };
            amount?: string;
            lock?: unknown;
          }
        | undefined;
      const amount = typeof view?.amount === "string" ? view.amount : "0";
      const locked = view?.lock !== null && view?.lock !== undefined;
      if (
        e.contractId &&
        !locked &&
        Number(amount) > 0 &&
        view?.owner === party &&
        view?.instrumentId?.admin === instrument.admin &&
        view?.instrumentId?.id === instrument.id
      ) {
        rows.push({ cid: e.contractId, amount });
      }
    }
    return rows;
  }

  private async readCompletions(
    userId: string,
    party: string,
    beginExclusive: number,
  ): Promise<
    Array<{
      submissionId?: string;
      updateId?: string;
      status?: { code?: number; message?: string };
    }>
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const tok = typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
      const res = await this.fetchFn(`${this.opts.participantUrl}/v2/commands/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ userId, parties: [party], beginExclusive }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (buf.length > 500_000) break;
        }
      } catch {
        /* aborted by timeout — parse what we have */
      }
      let str = buf.trim();
      if (!str.startsWith("[")) return [];
      if (!str.endsWith("]")) str = str.replace(/,\s*$/, "") + "]";
      const arr = JSON.parse(str) as Array<{
        completionResponse?: { Completion?: { value?: unknown } };
      }>;
      return arr
        .map(c => c.completionResponse?.Completion?.value)
        .filter(
          (
            v,
          ): v is {
            submissionId?: string;
            updateId?: string;
            status?: { code?: number; message?: string };
          } => !!v,
        );
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const tok = typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchFn(`${this.opts.participantUrl}${path}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CantonError(
          `${method} ${path} returned HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          text.slice(0, 1024),
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof CantonError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new CantonError(`${method} ${path} aborted after ${this.timeoutMs}ms`, "TIMEOUT");
      }
      throw new CantonError(
        `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        "TRANSPORT_ERROR",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
