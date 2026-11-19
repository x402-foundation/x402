/**
 * ScanClient against a stubbed transport: where each read goes, which errors
 * are retried and failed over, and that the Scan credential only reaches Scan.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CantonError } from "../../src/ledger/client.js";
import { ScanClient } from "../../src/ledger/scan.js";

type Call = { url: string; auth: string | undefined; body: unknown };
type Answer = Response | Error | ((url: string) => Response | Error);

/**
 * A ScanClient whose transport answers from `answers` in order (the last one
 * repeats), recording each call.
 *
 * @param answers - Responses, errors to throw, or functions of the URL.
 * @param opts - Extra client options.
 * @returns The client and its recorded calls.
 */
function scanWith(
  answers: Answer[],
  opts: Partial<ConstructorParameters<typeof ScanClient>[0]> = {},
) {
  const calls: Call[] = [];
  let i = 0;
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      auth: headers.Authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    const r = typeof a === "function" ? a(url) : a;
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  const scan = new ScanClient({
    scanUrl: "http://sv.invalid",
    flavor: "sv",
    fetch: fetchStub,
    ...opts,
  });
  return { scan, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response("nope", { status: code });
const factory = {
  factoryId: "f1",
  transferKind: "direct",
  choiceContext: { choiceContextData: {}, disclosedContracts: [] },
};
const resolveArgs = {
  sender: "s::1220",
  receiver: "r::1220",
  amount: "1.0",
  admin: "dso::1220",
  id: "Amulet",
  inputHoldingCids: ["h1"],
};

afterEach(() => vi.useRealTimers());

describe("ScanClient.resolveTransferFactory", () => {
  it("resolves Canton Coin on the SV registry root", async () => {
    const { scan, calls } = scanWith([ok(factory)]);
    const r = await scan.resolveTransferFactory({ ...resolveArgs, meta: { "x402.memo": "m" } });
    expect(r.factoryId).toBe("f1");
    expect(calls[0]!.url).toBe(
      "http://sv.invalid/registry/transfer-instruction/v1/transfer-factory",
    );
    expect(calls[0]!.body).toMatchObject({
      choiceArguments: {
        transfer: { inputHoldingCids: ["h1"], meta: { values: { "x402.memo": "m" } } },
      },
    });
  });

  it("resolves a registry token on its registrar's utility, without the Scan token", async () => {
    const { scan, calls } = scanWith([ok(factory)], { token: "SCAN" });
    await scan.resolveTransferFactory({
      ...resolveArgs,
      registryBaseUrl: "http://utility.invalid",
    });
    expect(calls[0]!.url).toBe(
      "http://utility.invalid/api/token-standard/v0/registrars/dso%3A%3A1220/registry/transfer-instruction/v1/transfer-factory",
    );
    expect(calls[0]!.auth).toBeUndefined();
  });

  it("refuses a Canton Coin resolve on a validator scan-proxy", async () => {
    const { scan } = scanWith([ok(factory)], { flavor: "validator" });
    await expect(scan.resolveTransferFactory(resolveArgs)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("ScanClient transport", () => {
  it("sends the Scan token to every SV base, resolved when it is a function", async () => {
    const { scan, calls } = scanWith([ok({ transfer_preapproval: null })], {
      token: async () => "T",
    });
    await scan.getTransferPreapprovalByParty("m::1220");
    expect(calls[0]!.auth).toBe("Bearer T");
  });

  it("retries a transient error, then fails over to the next base", async () => {
    vi.useFakeTimers();
    const { scan, calls } = scanWith(
      [
        url =>
          url.startsWith("http://sv.invalid") ? status(503) : ok({ transfer_preapproval: null }),
      ],
      { fallbackUrls: ["http://sv2.invalid"] },
    );
    const p = scan.getTransferPreapprovalByParty("m::1220");
    await vi.runAllTimersAsync();
    expect(await p).toBeNull();
    expect(calls.filter(c => c.url.startsWith("http://sv.invalid"))).toHaveLength(4);
    expect(calls.at(-1)!.url.startsWith("http://sv2.invalid")).toBe(true);
  });

  it("does not retry a definite error", async () => {
    const { scan, calls } = scanWith([status(404)], { fallbackUrls: ["http://sv2.invalid"] });
    await expect(scan.getTransferPreapprovalByParty("m::1220")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 404,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a transport failure and a timeout with their own codes", async () => {
    vi.useFakeTimers();
    const transport = scanWith([new TypeError("socket hang up")]);
    const p1 = transport.scan.getTransferPreapprovalByParty("m::1220").catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await p1).toMatchObject({ code: "TRANSPORT_ERROR" });

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const timeout = scanWith([abort]);
    const p2 = timeout.scan.getTransferPreapprovalByParty("m::1220").catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await p2).toBeInstanceOf(CantonError);
    expect(await p2).toMatchObject({ code: "TIMEOUT" });
  });
});

describe("ScanClient reads", () => {
  it("reads a preapproval, and none when Scan has no record or no expiry", async () => {
    const record = {
      transfer_preapproval: {
        contract: {
          contract_id: "p1",
          payload: {
            dso: "dso",
            receiver: "m",
            provider: "v",
            validFrom: "2026-01-01T00:00:00Z",
            lastRenewedAt: "2026-02-01T00:00:00Z",
            expiresAt: "2027-01-01T00:00:00Z",
          },
        },
      },
    };
    expect(await scanWith([ok(record)]).scan.getTransferPreapprovalByParty("m")).toMatchObject({
      contractId: "p1",
      provider: "v",
      validFrom: "2026-01-01T00:00:00Z",
      lastRenewedAt: "2026-02-01T00:00:00Z",
    });
    const noExpiry = { transfer_preapproval: { contract: { contract_id: "p1", payload: {} } } };
    expect(await scanWith([ok(noExpiry)]).scan.getTransferPreapprovalByParty("m")).toBeNull();
  });

  it("refuses an amulet-rules answer without a contract", async () => {
    const { scan } = scanWith([ok({ amulet_rules_update: {} })]);
    await expect(scan.getAmuletRules()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reads empty round lists when Scan returns none", async () => {
    expect(await scanWith([ok({})]).scan.getOpenAndIssuingMiningRounds()).toEqual({
      open: [],
      issuing: [],
    });
    expect(
      await scanWith([ok({})], { flavor: "validator" }).scan.getOpenAndIssuingMiningRounds(),
    ).toEqual({ open: [], issuing: [] });
  });
});
