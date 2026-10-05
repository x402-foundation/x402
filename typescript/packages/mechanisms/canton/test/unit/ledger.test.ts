/**
 * Settle-side ledger reads, with stubbed transports:
 *
 * - /execute failures: only a definite 4xx refusal is a rejection; timeouts,
 *   transport errors, 5xx, 408 and 409 are an unknown outcome.
 * - completion parsing: settled needs an OK status AND an updateId; rejected
 *   needs a numeric non-zero code; anything else is unreadable.
 * - funds-moved: a pending AmuletTransferInstruction / TransferOffer is not a
 *   delivery; the registry path reads the standard's result tag.
 * - Scan never receives the ledger token; the factory id is cached.
 */
import { describe, it, expect } from "vitest";
import { CantonClient, CantonError } from "../../src/ledger/client.js";
import {
  TransferFactoryService,
  SubmissionOutcomeUnknownError,
  isDefiniteExecuteRefusal,
  type TransferFactoryDeps,
} from "../../src/ledger/transfer-factory.js";
import { toFacilitatorCantonSigner } from "../../src/signer-factory.js";

const PAYER = "payer::1220" + "aa".repeat(32);
const PKG = "0f".repeat(32);

type Events = Awaited<ReturnType<TransferFactoryDeps["client"]["getTransactionById"]>>["events"];

function service(over: Partial<TransferFactoryDeps["client"]> = {}, events: Events = []) {
  const client: TransferFactoryDeps["client"] = {
    getLedgerEnd: async () => ({ offset: 1 }),
    interactiveSubmissionExecute: async () => ({ updateId: "1220-u", completionOffset: 2 }),
    pollCompletionUpdateId: async () => "1220-u",
    getTransactionById: async () => ({ updateId: "1220-u", offset: 2, events }),
    ...over,
  };
  return new TransferFactoryService({
    client,
    userId: "u",
    confirmRetry: { attempts: 1, delayMs: 0 },
  });
}

const execInput = (transferKind: "amulet" | "registry" = "amulet") => ({
  payer: PAYER,
  preparedTransaction: "",
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
  partySignatures: { signatures: [] },
  submissionId: "s",
  transferKind,
});

describe("execute failure classification", () => {
  const cases: Array<[string, unknown, "unknown" | "refused"]> = [
    ["timeout", new CantonError("aborted", "TIMEOUT"), "unknown"],
    ["transport", new CantonError("reset", "TRANSPORT_ERROR"), "unknown"],
    ["HTTP 500", new CantonError("500", "HTTP_ERROR", 500), "unknown"],
    ["HTTP 503", new CantonError("503", "HTTP_ERROR", 503), "unknown"],
    ["HTTP 408", new CantonError("408", "HTTP_ERROR", 408), "unknown"],
    ["HTTP 409 (duplicate)", new CantonError("409", "HTTP_ERROR", 409), "unknown"],
    ["non-Canton error", new Error("boom"), "unknown"],
    ["HTTP 400", new CantonError("400", "HTTP_ERROR", 400), "refused"],
    ["HTTP 403", new CantonError("403", "HTTP_ERROR", 403), "refused"],
    ["HTTP 429", new CantonError("429", "HTTP_ERROR", 429), "refused"],
    ["HTTP 499 (cancelled)", new CantonError("499", "HTTP_ERROR", 499), "unknown"],
    ["HTTP 418 (unlisted)", new CantonError("418", "HTTP_ERROR", 418), "unknown"],
  ];
  for (const [name, err, want] of cases) {
    it(`${name} → ${want}`, async () => {
      const svc = service({
        interactiveSubmissionExecute: async () => {
          throw err;
        },
      });
      const p = svc.execute(execInput());
      if (want === "unknown") {
        await expect(p).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
      } else {
        await expect(p).rejects.toBe(err);
      }
      expect(isDefiniteExecuteRefusal(err)).toBe(want === "refused");
    });
  }
});

describe("funds-moved confirmation", () => {
  const archivedAmulet = {
    ArchivedEvent: { contractId: "c1", templateId: `${PKG}:Splice.Amulet:Amulet` },
  };
  const created = (templateId: string) => ({
    CreatedEvent: { contractId: "c2", templateId } as never,
  });

  it("Amulet: archived input and nothing pending → transferred", async () => {
    const r = await service({}, [archivedAmulet]).execute(execInput());
    expect(r.transferred).toBe(true);
  });

  it("Amulet: a pending AmuletTransferInstruction → not transferred", async () => {
    const r = await service({}, [
      archivedAmulet,
      created(`${PKG}:Splice.AmuletTransferInstruction:AmuletTransferInstruction`),
    ]).execute(execInput());
    expect(r.transferred).toBe(false);
  });

  it("Amulet: a TransferOffer → not transferred", async () => {
    const r = await service({}, [
      archivedAmulet,
      created(`${PKG}:Splice.Wallet.TransferOffer:TransferOffer`),
    ]).execute(execInput());
    expect(r.transferred).toBe(false);
  });

  it("registry: reads the full effects and trusts the result tag", async () => {
    const asked: Array<boolean | undefined> = [];
    const tagged = (tag: string): Events => [
      {
        ExercisedEvent: {
          contractId: "f",
          templateId: "t",
          choice: "TransferFactory_Transfer",
          exerciseResult: { output: { tag } },
        },
      },
    ];
    const run = async (tag: string) =>
      service(
        {
          getTransactionById: async args => {
            asked.push(args.fullEffects);
            return { updateId: "1220-u", offset: 2, events: tagged(tag) };
          },
        },
        [],
      ).execute(execInput("registry"));
    expect((await run("TransferInstructionResult_Completed")).transferred).toBe(true);
    expect((await run("TransferInstructionResult_Pending")).transferred).toBe(false);
    expect(asked).toEqual([true, true]);
  });
});

describe("completion parsing", () => {
  function clientWith(completion: Record<string, unknown>): CantonClient {
    const body = JSON.stringify([
      { completionResponse: { Completion: { value: { submissionId: "s", ...completion } } } },
    ]);
    return new CantonClient({
      participantUrl: "http://p.invalid",
      token: "t",
      fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });
  }

  it("OK status with an updateId → settled", async () => {
    const r = await clientWith({ updateId: "1220-u", status: { code: 0 } }).findCompletion(
      "u",
      PAYER,
      "s",
      0,
    );
    expect(r).toEqual({ kind: "settled", updateId: "1220-u" });
  });

  it("an empty status (proto3 omits code 0) with an updateId → settled", async () => {
    const r = await clientWith({ updateId: "1220-u", status: {} }).findCompletion(
      "u",
      PAYER,
      "s",
      0,
    );
    expect(r).toEqual({ kind: "settled", updateId: "1220-u" });
  });

  it("no status at all with an updateId → settled", async () => {
    const r = await clientWith({ updateId: "1220-u" }).findCompletion("u", PAYER, "s", 0);
    expect(r).toEqual({ kind: "settled", updateId: "1220-u" });
  });

  it("an empty status without an updateId → not settled", async () => {
    const r = await clientWith({ status: {} }).findCompletion("u", PAYER, "s", 0);
    expect(r.kind).toBe("malformed");
  });

  it("OK status without an updateId → not settled", async () => {
    const r = await clientWith({ status: { code: 0 } }).findCompletion("u", PAYER, "s", 0);
    expect(r.kind).toBe("malformed");
  });

  it("non-numeric status code → not a rejection", async () => {
    const r = await clientWith({ updateId: "1220-u", status: { code: "ABORTED" } }).findCompletion(
      "u",
      PAYER,
      "s",
      0,
    );
    expect(r.kind).toBe("malformed");
  });

  it("numeric non-zero code → rejected", async () => {
    const r = await clientWith({ status: { code: 9, message: "no" } }).findCompletion(
      "u",
      PAYER,
      "s",
      0,
    );
    expect(r).toEqual({ kind: "rejected", message: "no" });
  });

  it("an unreadable completion surfaces as an unknown outcome at settle", async () => {
    const svc = service({
      interactiveSubmissionExecute: async () => ({ updateId: "", completionOffset: 0 }),
      pollCompletionUpdateId: (...a) =>
        clientWith({ status: { code: 0 } }).pollCompletionUpdateId(...a),
    });
    await expect(svc.execute(execInput())).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });
});

describe("facilitator signer — Scan auth and factory cache", () => {
  function signer(opts: { scanToken?: string } = {}) {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization });
      if (url.includes("transfer-factory")) {
        return new Response(
          JSON.stringify({
            factoryId: "00factory",
            transferKind: "direct",
            choiceContext: { choiceContextData: {}, disclosedContracts: [] },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const s = toFacilitatorCantonSigner({
      participantUrl: "http://participant.invalid",
      token: "LEDGER-SECRET",
      userId: "u",
      synchronizerId: "global-domain::1220test",
      scanUrl: "http://scan.invalid",
      facilitatorParties: ["fac::1220" + "ff".repeat(32)],
      fetch: fetchStub,
      ...opts,
    });
    return { s, calls };
  }
  const args = {
    sender: PAYER,
    receiver: "m::1220" + "bb".repeat(32),
    amount: "1.0",
    instrumentId: { admin: "dso::1220" + "cc".repeat(32), id: "Amulet" },
    inputHoldingCids: ["h1"],
  };

  it("sends no Authorization to Scan by default (never the ledger token)", async () => {
    const { s, calls } = signer();
    await s.resolveTransferFactoryId(args);
    const scanCalls = calls.filter(c => c.url.startsWith("http://scan.invalid"));
    expect(scanCalls.length).toBeGreaterThan(0);
    expect(scanCalls.every(c => c.auth === undefined)).toBe(true);
  });

  it("sends only the dedicated scanToken to Scan", async () => {
    const { s, calls } = signer({ scanToken: "SCAN-ONLY" });
    await s.resolveTransferFactoryId(args);
    const scanCalls = calls.filter(c => c.url.startsWith("http://scan.invalid"));
    expect(scanCalls.every(c => c.auth === "Bearer SCAN-ONLY")).toBe(true);
  });

  it("refuses a non-sv Scan flavor at construction", () => {
    expect(() =>
      toFacilitatorCantonSigner({
        participantUrl: "http://participant.invalid",
        token: "t",
        userId: "u",
        synchronizerId: "global-domain::1220test",
        scanUrl: "http://scan.invalid",
        scanFlavor: "validator",
        facilitatorParties: ["fac::1220" + "ff".repeat(32)],
      }),
    ).toThrow(/requires scanFlavor "sv"/);
  });

  it("keys the cache unambiguously (a party id contains `::`)", async () => {
    const { s, calls } = signer();
    await s.resolveTransferFactoryId({ ...args, instrumentId: { admin: "R::1220ab", id: "X" } });
    await s.resolveTransferFactoryId({ ...args, instrumentId: { admin: "R", id: "1220ab::X" } });
    expect(calls.filter(c => c.url.includes("transfer-factory"))).toHaveLength(2);
  });

  it("caches the factory id and throttles forced refreshes", async () => {
    const { s, calls } = signer();
    expect(await s.resolveTransferFactoryId(args)).toBe("00factory");
    await s.resolveTransferFactoryId(args);
    await s.resolveTransferFactoryId({ ...args, refresh: true });
    expect(calls.filter(c => c.url.includes("transfer-factory"))).toHaveLength(1);
  });
});
