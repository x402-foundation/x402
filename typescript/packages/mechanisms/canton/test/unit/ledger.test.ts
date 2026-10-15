/**
 * Settle-side ledger reads, with stubbed transports:
 *
 * - /execute failures: only a definite 4xx refusal is a rejection; timeouts,
 *   transport errors, 5xx, 408 and 409 are an unknown outcome.
 * - completion parsing: settled needs an OK status AND an updateId; rejected
 *   needs a numeric non-zero code; anything else is unreadable.
 * - reconciliation: a submission is found by its completion, else by its signed
 *   command id among the payer's transactions; an unreadable ledger is unknown.
 * - Scan never receives the ledger token.
 */
import { describe, it, expect } from "vitest";
import { CantonClient, CantonError } from "../../src/ledger/client.js";
import {
  TransferFactoryService,
  SubmissionOutcomeUnknownError,
  isDefiniteExecuteRefusal,
  type TransferFactoryDeps,
} from "../../src/ledger/transfer-factory.js";
import { generateKeyPairSync } from "node:crypto";
import { toClientCantonSigner } from "../../src/signer-factory.js";

const PAYER = "payer::1220" + "aa".repeat(32);
const PKG = "0f".repeat(32);

function service(over: Partial<TransferFactoryDeps["client"]> = {}) {
  const client: TransferFactoryDeps["client"] = {
    getLedgerEnd: async () => ({ offset: 1 }),
    interactiveSubmissionExecute: async () => ({ updateId: "1220-u", completionOffset: 2 }),
    pollCompletionUpdateId: async () => "1220-u",
    findCompletion: async () => ({ kind: "absent" }),
    findCommandUpdateId: async () => undefined,
    isPartyLocal: async () => true,
    ...over,
  };
  return new TransferFactoryService({ client, userId: "u" });
}

const execInput = () => ({
  payer: PAYER,
  preparedTransaction: "",
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
  partySignatures: { signatures: [] },
  submissionId: "s",
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

describe("execute outcome", () => {
  it("returns the updateId /execute answers with", async () => {
    expect(await service().execute(execInput())).toEqual({ updateId: "1220-u" });
  });

  it("polls the completion when /execute answers without an updateId", async () => {
    const svc = service({
      interactiveSubmissionExecute: async () => ({ updateId: "", completionOffset: 0 }),
      pollCompletionUpdateId: async () => "1220-polled",
    });
    expect(await svc.execute(execInput())).toEqual({ updateId: "1220-polled" });
  });

  it("a rejected completion is a definite refusal", async () => {
    const rejected = new CantonError("rejected", "SUBMISSION_FAILED");
    const svc = service({
      interactiveSubmissionExecute: async () => ({ updateId: "", completionOffset: 0 }),
      pollCompletionUpdateId: async () => {
        throw rejected;
      },
    });
    await expect(svc.execute(execInput())).rejects.toBe(rejected);
  });

  it("a duplicate-command completion is an unknown outcome, not a refusal", async () => {
    const svc = service({
      interactiveSubmissionExecute: async () => ({ updateId: "", completionOffset: 0 }),
      pollCompletionUpdateId: async () => {
        throw new CantonError("outcome not readable: duplicate", "INVALID_RESPONSE");
      },
    });
    await expect(svc.execute(execInput())).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("an unknown outcome carries the offset read before submitting", async () => {
    const svc = service({
      getLedgerEnd: async () => ({ offset: 42 }),
      interactiveSubmissionExecute: async () => {
        throw new CantonError("aborted", "TIMEOUT");
      },
    });
    const err = await svc.execute(execInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionOutcomeUnknownError);
    expect((err as SubmissionOutcomeUnknownError).beginOffset).toBe(42);
  });
});

describe("submission lookup", () => {
  const input = { payer: PAYER, submissionId: "s", commandId: "cmd", beginOffset: 5 };

  it("a settled completion → committed", async () => {
    const svc = service({ findCompletion: async () => ({ kind: "settled", updateId: "1220-c" }) });
    expect(await svc.lookup(input)).toEqual({ status: "committed", updateId: "1220-c" });
  });

  it("a rejected completion → rejected", async () => {
    const svc = service({ findCompletion: async () => ({ kind: "rejected", message: "no" }) });
    expect(await svc.lookup(input)).toEqual({ status: "rejected" });
  });

  it("an unreadable completion → unknown", async () => {
    const svc = service({ findCompletion: async () => ({ kind: "malformed", message: "?" }) });
    expect(await svc.lookup(input)).toEqual({ status: "unknown" });
  });

  it("no completion, but the command id is on the ledger → committed", async () => {
    const asked: unknown[] = [];
    const svc = service({
      findCommandUpdateId: async (...a) => {
        asked.push(a);
        return "1220-by-command";
      },
    });
    expect(await svc.lookup(input)).toEqual({ status: "committed", updateId: "1220-by-command" });
    expect(asked).toEqual([[PAYER, "cmd", 5]]);
  });

  it("a duplicate-command completion with no transaction found → unknown, never absent", async () => {
    const svc = service({ findCompletion: async () => ({ kind: "duplicate", message: "dup" }) });
    expect(await svc.lookup(input)).toEqual({ status: "unknown" });
  });

  it("HTTP 409 at /execute is an unknown outcome flagged as a duplicate", async () => {
    const svc = service({
      interactiveSubmissionExecute: async () => {
        throw new CantonError("409", "HTTP_ERROR", 409);
      },
    });
    const err = await svc.execute(execInput()).catch((e: unknown) => e);
    expect(err).toMatchObject({ duplicate: true });
  });

  it("a duplicate-command completion still searches by command id", async () => {
    const svc = service({
      findCompletion: async () => ({ kind: "duplicate", message: "already exists" }),
      findCommandUpdateId: async () => "1220-first-relay",
    });
    expect(await svc.lookup(input)).toEqual({ status: "committed", updateId: "1220-first-relay" });
  });

  it("nowhere on the ledger of a participant hosting the payer → absent", async () => {
    expect(await service().lookup(input)).toEqual({ status: "absent" });
  });

  it("a miss on a participant that does not host the payer proves nothing → unknown", async () => {
    const svc = service({ isPartyLocal: async () => false });
    expect(await svc.lookup(input)).toEqual({ status: "unknown" });
  });

  it("a failed hosting check → unknown", async () => {
    const svc = service({
      isPartyLocal: async () => {
        throw new CantonError("forbidden", "HTTP_ERROR", 403);
      },
    });
    expect(await svc.lookup(input)).toEqual({ status: "unknown" });
  });

  it("a failed ledger read → unknown, never absent", async () => {
    const svc = service({
      findCommandUpdateId: async () => {
        throw new CantonError("down", "HTTP_ERROR", 503);
      },
    });
    expect(await svc.lookup(input)).toEqual({ status: "unknown" });
  });
});

describe("isPartyLocal", () => {
  const clientWith = (body: unknown) =>
    new CantonClient({
      participantUrl: "http://p.invalid",
      token: "t",
      fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    });

  it("true only for the party itself reported as local", async () => {
    expect(
      await clientWith({ partyDetails: [{ party: PAYER, isLocal: true }] }).isPartyLocal(PAYER),
    ).toBe(true);
    expect(
      await clientWith({ partyDetails: [{ party: PAYER, isLocal: false }] }).isPartyLocal(PAYER),
    ).toBe(false);
    expect(
      await clientWith({ partyDetails: [{ party: "other", isLocal: true }] }).isPartyLocal(PAYER),
    ).toBe(false);
    expect(await clientWith({}).isPartyLocal(PAYER)).toBe(false);
  });
});

describe("findCommandUpdateId", () => {
  function clientWith(end: number, updates: unknown, status = 200) {
    const bodies: unknown[] = [];
    const client = new CantonClient({
      participantUrl: "http://p.invalid",
      token: "t",
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: end }), { status: 200 });
        }
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(updates), { status });
      }) as typeof fetch,
    });
    return { client, bodies };
  }
  const tx = (commandId: string, updateId: string) => ({
    update: { Transaction: { value: { commandId, updateId } } },
  });

  it("reads the closed range up to the ledger end and matches the command id", async () => {
    const { client, bodies } = clientWith(30, [tx("other", "1220-a"), tx("cmd", "1220-b")]);
    expect(await client.findCommandUpdateId(PAYER, "cmd", 10)).toBe("1220-b");
    expect(bodies[0]).toMatchObject({ beginExclusive: 10, endInclusive: 30 });
  });

  it("undefined when the command id is not in the range", async () => {
    const { client } = clientWith(30, [tx("other", "1220-a")]);
    expect(await client.findCommandUpdateId(PAYER, "cmd", 10)).toBeUndefined();
  });

  it("undefined without a read when nothing was recorded since the offset", async () => {
    const { client, bodies } = clientWith(10, []);
    expect(await client.findCommandUpdateId(PAYER, "cmd", 10)).toBeUndefined();
    expect(bodies).toHaveLength(0);
  });

  it("throws on a failed read", async () => {
    const { client } = clientWith(30, { code: "X" }, 500);
    await expect(client.findCommandUpdateId(PAYER, "cmd", 10)).rejects.toBeInstanceOf(CantonError);
  });

  it("throws on a response that is not a list", async () => {
    const { client } = clientWith(30, { not: "a list" });
    await expect(client.findCommandUpdateId(PAYER, "cmd", 10)).rejects.toBeInstanceOf(CantonError);
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

  it("ALREADY_EXISTS (an accepted duplicate) → duplicate, not rejected", async () => {
    const r = await clientWith({ status: { code: 6, message: "dup" } }).findCompletion(
      "u",
      PAYER,
      "s",
      0,
    );
    expect(r).toEqual({ kind: "duplicate", message: "dup" });
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

describe("client signer — Scan auth", () => {
  const MERCHANT = "m::1220" + "bb".repeat(32);
  const ADMIN = "dso::1220" + "cc".repeat(32);

  function signer(opts: { scanToken?: string } = {}) {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization });
      if (url.endsWith("/v2/state/ledger-end")) {
        return new Response(JSON.stringify({ offset: 7 }), { status: 200 });
      }
      if (url.endsWith("/v2/state/active-contracts")) {
        return new Response(
          JSON.stringify([
            {
              contractEntry: {
                JsActiveContract: {
                  createdEvent: {
                    contractId: "h1",
                    templateId: `${PKG}:Splice.Amulet:Amulet`,
                    interfaceViews: [
                      {
                        interfaceId: `${PKG}:Splice.Api.Token.HoldingV1:Holding`,
                        viewValue: {
                          owner: PAYER,
                          instrumentId: { admin: ADMIN, id: "Amulet" },
                          amount: "5.0",
                        },
                      },
                    ],
                  },
                },
              },
            },
          ]),
          { status: 200 },
        );
      }
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
      if (url.endsWith("/v2/interactive-submission/prepare")) {
        return new Response(
          JSON.stringify({ preparedTransaction: "AA==", preparedTransactionHash: "AA==" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const s = toClientCantonSigner({
      participantUrl: "http://participant.invalid",
      token: "LEDGER-SECRET",
      userId: "u",
      synchronizerId: "global-domain::1220test",
      scanUrl: "http://scan.invalid",
      party: PAYER,
      privateKeyPem: generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      fetch: fetchStub,
      ...opts,
    });
    return { s, calls };
  }
  const input = {
    receiver: MERCHANT,
    amount: "1.0",
    instrumentId: { admin: ADMIN, id: "Amulet" },
    executeBeforeSeconds: 60,
  };

  it("sends no Authorization to Scan by default (never the ledger token)", async () => {
    const { s, calls } = signer();
    await s.prepareTransfer(input);
    const scanCalls = calls.filter(c => c.url.startsWith("http://scan.invalid"));
    expect(scanCalls.length).toBeGreaterThan(0);
    expect(scanCalls.every(c => c.auth === undefined)).toBe(true);
  });

  it("sends only the dedicated scanToken to Scan", async () => {
    const { s, calls } = signer({ scanToken: "SCAN-ONLY" });
    await s.prepareTransfer(input);
    const scanCalls = calls.filter(c => c.url.startsWith("http://scan.invalid"));
    expect(scanCalls.every(c => c.auth === "Bearer SCAN-ONLY")).toBe(true);
    const ledgerCalls = calls.filter(c => c.url.startsWith("http://participant.invalid"));
    expect(ledgerCalls.every(c => c.auth === "Bearer LEDGER-SECRET")).toBe(true);
  });
});
