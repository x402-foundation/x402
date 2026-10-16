/**
 * Runs the shared cross-SDK vectors in
 * `specs/schemes/exact/vectors/exact_lnbtc.json` (format in the README next to
 * it). The Python mechanism (x402-foundation/x402 PR #1873) loads the same file.
 *
 * Cases the specification leaves open accept any one of their listed outcomes;
 * `OPEN_OUTCOMES` pins the outcome this SDK takes today, so a change of
 * behavior on an open question is a visible test change.
 *
 * The second half keeps the end-to-end SDK flows ported from #1873's
 * `test_sdk.py` and `test_settlement.py` that a data vector cannot express.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { encodePaymentSignatureHeader, type HTTPTransportContext } from "@x402/core/http";
import {
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { httpRequestBinding, mcpToolCallBinding, type RequestBinding } from "../../src/binding";
import { decodeInvoice } from "../../src/bolt11";
import { LNBTC_MAINNET, LNBTC_TESTNET } from "../../src/constants";
import { ExactLnbtcScheme as LnbtcClient } from "../../src/exact/client";
import { ExactLnbtcScheme as LnbtcFacilitator } from "../../src/exact/facilitator";
import { ExactLnbtcScheme as LnbtcServer, httpTransportBinding } from "../../src/exact/server";
import { InMemoryReplayStore } from "../../src/replayStore";
import type {
  CreateInvoiceParams,
  LightningPayer,
  LightningPayment,
  LightningReceiver,
  ReplayStore,
} from "../../src/types";
import { makeInvoice, RECEIVER_PUBKEY } from "./helpers";

// ---------------------------------------------------------------------------
// The vector file
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Expect = Record<string, Json>;
type PatchOp = { op: "add" | "remove" | "replace"; path: string; value?: Json };

interface HttpInput {
  method: string;
  url: string;
  body_hex: string;
  bound_headers: string[];
  header_lines: [string, string][];
}
interface McpInput {
  server: string;
  bound_metadata: string[];
  params?: Record<string, unknown>;
  params_json?: string;
}
interface Case {
  id: string;
  note: string;
  expect: Expect;
}
interface Vectors {
  fixture_version: number;
  open_questions: Record<string, { question: string; outcomes: Record<string, string> }>;
  http_binding: (Case & { input: HttpInput })[];
  http_server_adapter: (Case & {
    config: { public_origin: string; bound_headers: string[] };
    input: { method: string; url: string; header_lines: [string, string][]; body_hex: string };
  })[];
  mcp_binding: (Case & { input: McpInput })[];
  client: { base: Json; cases: (Case & { now: number; skew: number; patch: PatchOp[] })[] };
  facilitator_settle: {
    base: Json;
    cases: {
      id: string;
      note: string;
      group: string;
      steps: { now: number; skew: number; patch: PatchOp[]; expect: Expect }[];
    }[];
  };
}

const VECTORS = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../../specs/schemes/exact/vectors/exact_lnbtc.json"),
    "utf8",
  ),
) as Vectors;

/** The outcome this SDK takes on each case the specification leaves open. */
const OPEN_OUTCOMES: Record<string, string> = {
  "http_binding/url-port-zero": "bind",
  "http_server_adapter/request-origin-not-configured": "bind_configured_origin",
  "http_server_adapter/host-differs-from-url": "reject_binding",
  "http_server_adapter/no-authority-header": "reject",
  "mcp_binding/integer-2-53-plus-1": "bind_as_double",
  "mcp_binding/integer-2-64": "bind_as_double",
  "client/invoice-at-end": "reject",
};

/**
 * Applies an RFC 6902 patch (add, remove, replace on object members).
 *
 * @param base - Base document
 * @param ops - Patch operations
 * @returns A patched deep copy
 */
function applyPatch<T>(base: Json, ops: PatchOp[]): T {
  const doc = structuredClone(base) as Record<string, Json>;
  for (const { op, path, value } of ops) {
    const parts = path
      .split("/")
      .slice(1)
      .map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = parts.pop()!;
    let node = doc;
    for (const part of parts) node = node[part] as Record<string, Json>;
    if (op === "remove") delete node[last];
    else node[last] = structuredClone(value as Json);
  }
  return doc as T;
}

const lookup =
  (lines: [string, string][]) =>
  (name: string): string[] | undefined => {
    const values = lines.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
    return values.length === 0 ? undefined : values;
  };

const httpBinding = (input: HttpInput) =>
  httpRequestBinding({
    method: input.method,
    url: input.url,
    body: hexToBytes(input.body_hex),
    boundHeaders: input.bound_headers,
    getHeader: lookup(input.header_lines),
  });

const mcpBinding = (input: McpInput) => {
  const params = (
    input.params_json === undefined ? input.params : JSON.parse(input.params_json)
  ) as Record<string, unknown>;
  return mcpToolCallBinding({
    server: input.server,
    name: params.name as string,
    arguments: params.arguments,
    meta: params._meta,
    boundMetadata: input.bound_metadata,
  });
};

type Outcome = { value?: RequestBinding; error?: string };

const attempt = async (fn: () => RequestBinding | Promise<RequestBinding>): Promise<Outcome> => {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

const bindingMatches = (result: Outcome, expect: Expect) =>
  "request_hash" in expect
    ? result.value?.requestHash === expect.request_hash
    : result.error !== undefined && result.error.includes(expect.error as string);

/**
 * Asserts a result against an expectation, resolving open cases through
 * {@link OPEN_OUTCOMES}.
 *
 * @param key - `<section>/<id>`
 * @param want - The case expectation
 * @param matches - Whether the result satisfies one expectation
 */
function assertExpect(key: string, want: Expect, matches: (e: Expect) => boolean): void {
  if (!("open" in want)) {
    expect(matches(want)).toBe(true);
    return;
  }
  const outcomes = want.outcomes as Record<string, Expect>;
  const taken = Object.keys(outcomes).filter(name => matches(outcomes[name]));
  expect(taken).toEqual([OPEN_OUTCOMES[key]]);
}

describe("shared vectors: file", () => {
  it("is the fixture version this loader targets", () => {
    expect(VECTORS.fixture_version).toBe(1);
  });

  it("pins an outcome for exactly the open cases", () => {
    const open = [
      ...VECTORS.http_binding.map(c => ["http_binding", c] as const),
      ...VECTORS.http_server_adapter.map(c => ["http_server_adapter", c] as const),
      ...VECTORS.mcp_binding.map(c => ["mcp_binding", c] as const),
      ...VECTORS.client.cases.map(c => ["client", c] as const),
    ]
      .filter(([, c]) => "open" in c.expect)
      .map(([section, c]) => `${section}/${c.id}`);
    expect(open.sort()).toEqual(Object.keys(OPEN_OUTCOMES).sort());
  });
});

describe("shared vectors: http_binding", () => {
  it.each(VECTORS.http_binding.map(c => [c.id, c] as const))("%s", async (id, c) => {
    const result = await attempt(() => httpBinding(c.input));
    assertExpect(`http_binding/${id}`, c.expect, e => bindingMatches(result, e));
    if ("canonical_description" in c.expect) {
      const description = new TextEncoder().encode(c.expect.canonical_description as string);
      expect(bytesToHex(sha256(description))).toBe(c.expect.request_hash);
    }
  });
});

describe("shared vectors: http_server_adapter", () => {
  it.each(VECTORS.http_server_adapter.map(c => [c.id, c] as const))("%s", async (id, c) => {
    const result = await attempt(() =>
      httpTransportBinding({
        publicOrigin: c.config.public_origin,
        boundHeaders: c.config.bound_headers,
        rawBody: () => hexToBytes(c.input.body_hex),
      })({
        request: {
          adapter: {
            getMethod: () => c.input.method,
            getUrl: () => c.input.url,
            getHeader: (name: string) => lookup(c.input.header_lines)(name)?.join(", "),
          },
        },
      } as unknown as HTTPTransportContext),
    );
    assertExpect(`http_server_adapter/${id}`, c.expect, e => bindingMatches(result, e));
    if ("forbidden_request_hash" in c.expect) {
      expect(result.value?.requestHash).not.toBe(c.expect.forbidden_request_hash);
    }
  });
});

describe("shared vectors: mcp_binding", () => {
  it.each(VECTORS.mcp_binding.map(c => [c.id, c] as const))("%s", async (id, c) => {
    const result = await attempt(() => mcpBinding(c.input));
    assertExpect(`mcp_binding/${id}`, c.expect, e => bindingMatches(result, e));
  });
});

interface ClientDoc {
  intended_request: { profile: "http:1"; http: HttpInput } | { profile: "mcp:1"; mcp: McpInput };
  payment_required: PaymentRequired;
  payer_result: {
    status: LightningPayment["status"];
    invoice: string;
    payment_hash: string;
    amount_msat: string;
    preimage: string | null;
  };
}

describe("shared vectors: client", () => {
  it.each(VECTORS.client.cases.map(c => [c.id, c] as const))("%s", async (id, c) => {
    const doc = applyPatch<ClientDoc>(VECTORS.client.base, c.patch);
    const intended = doc.intended_request;
    const result = doc.payer_result;
    const payer: LightningPayer = {
      payInvoice: vi.fn(
        async () =>
          ({
            invoice: result.invoice,
            paymentHash: result.payment_hash,
            amountMsat: BigInt(result.amount_msat),
            status: result.status,
            preimage: result.preimage,
          }) as LightningPayment,
      ),
    };
    const client = new x402Client().setSpendControls(false).register(
      doc.payment_required.accepts[0].network as Network,
      new LnbtcClient({
        payer,
        requestBinding: () =>
          intended.profile === "http:1" ? httpBinding(intended.http) : mcpBinding(intended.mcp),
        clock: () => c.now,
        clockSkewSeconds: c.skew,
      }),
    );
    let outcome: { payload?: PaymentPayload; error?: string };
    try {
      outcome = { payload: await client.createPaymentPayload(doc.payment_required) };
    } catch (error) {
      outcome = { error: (error as Error).message };
    }
    const calls = vi.mocked(payer.payInvoice).mock.calls.length;
    assertExpect(`client/${id}`, c.expect, e =>
      "error" in e
        ? outcome.error !== undefined &&
          outcome.error.includes(e.error as string) &&
          calls === (e.payer_called ? 1 : 0)
        : outcome.payload?.payload.preimage === e.preimage && calls === 1,
    );
  });
});

describe("shared vectors: facilitator_settle", () => {
  it.each(VECTORS.facilitator_settle.cases.map(c => [`${c.group} ${c.id}`, c] as const))(
    "%s",
    async (_, c) => {
      const rows: [string, number][] = [];
      const inner = new InMemoryReplayStore();
      const store: ReplayStore = {
        consume: async (key, retainUntil) => {
          const inserted = await inner.consume(key, retainUntil);
          if (inserted) rows.push([key, retainUntil]);
          return inserted;
        },
      };
      for (const step of c.steps) {
        const { requirements, payload } = applyPatch<{
          requirements: PaymentRequirements;
          payload: PaymentPayload;
        }>(VECTORS.facilitator_settle.base, step.patch);
        const facilitator = new LnbtcFacilitator({
          replayStore: store,
          clock: () => step.now,
          clockSkewSeconds: step.skew,
        });
        const before = rows.length;
        const result = await facilitator.settle(payload, requirements);
        const e = step.expect;
        if (e.success) {
          expect(result).toEqual({
            success: true,
            transaction: e.transaction,
            network: e.network,
          });
          expect(rows).toHaveLength(before + 1);
          expect(rows.at(-1)![0]).toBe(e.replay_key);
          expect(rows.at(-1)![1]).toBeGreaterThanOrEqual(e.retain_until_at_least as number);
        } else {
          expect(result.success).toBe(false);
          expect(result.errorReason).toBe(e.error_reason);
          expect(rows).toHaveLength(before);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// SDK flows ported from #1873 (test_sdk.py, test_settlement.py)
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000;
const KEY = hexToBytes("0".repeat(63) + "1");
const PREIMAGE = "42".repeat(32);
const URL_A = "https://api.example.com/article/A";
const ORIGIN = "https://api.example.com";
const MCP_SERVER = "https://api.example.com/mcp";

const invoiceFor = (
  digest: string,
  o: { preimage?: string; amount?: bigint; expiry?: number; currency?: string } = {},
) =>
  makeInvoice({
    preimage: o.preimage ?? PREIMAGE,
    paymentSecret: "23".repeat(32),
    amountMsat: o.amount ?? 21000n,
    expiry: o.expiry ?? 300,
    timestamp: NOW,
    currency: o.currency ?? "bc",
    key: KEY,
    descriptionHash: digest,
  }).invoice;

// The n-th invoice uses preimage sha256(str(n)), as #1873's test receiver does.
const receiverStub = () => {
  const preimages = new Map<string, string>();
  const receiver: LightningReceiver & { preimages: Map<string, string> } = {
    preimages,
    createInvoice: vi.fn(async (params: CreateInvoiceParams) => {
      const preimage = bytesToHex(sha256(new TextEncoder().encode(String(preimages.size))));
      const invoice = invoiceFor(params.descriptionHash, {
        preimage,
        amount: params.amountMsat,
        expiry: params.expirySeconds,
        currency: params.network === LNBTC_TESTNET ? "tb" : "bc",
      });
      preimages.set(invoice, preimage);
      return invoice;
    }),
  };
  return receiver;
};

const payerFor = (receiver: ReturnType<typeof receiverStub>): LightningPayer => ({
  payInvoice: vi.fn(async (invoice: string) => {
    const decoded = decodeInvoice(invoice);
    return {
      invoice,
      paymentHash: decoded.paymentHash,
      amountMsat: decoded.amountMsat,
      status: "paid" as const,
      preimage: receiver.preimages.get(invoice),
    };
  }),
});

const httpA = () =>
  httpRequestBinding({ method: "GET", url: URL_A, boundHeaders: [], getHeader: () => undefined });

const facilitatorAt = (store: ReplayStore = new InMemoryReplayStore()) =>
  new LnbtcFacilitator({ replayStore: store, clock: () => NOW });

const local = (facilitator: x402Facilitator): FacilitatorClient => ({
  verify: (p, r) => facilitator.verify(p, r),
  settle: (p, r) => facilitator.settle(p, r),
  getSupported: () => Promise.resolve(facilitator.getSupported() as SupportedResponse),
});

const sdkClient = () =>
  new x402Client().setSpendControls({
    allowedAssets: [LNBTC_MAINNET, LNBTC_TESTNET].map(network => ({
      network,
      asset: "BTC",
      maxAmountPerPayment: "25000",
    })),
  });

const routeConfig = (network: Network) => ({
  scheme: "exact",
  network,
  payTo: RECEIVER_PUBKEY,
  price: "21 sats",
  maxTimeoutSeconds: 300,
});

// One in-process stack: x402Facilitator -> x402ResourceServer -> x402Client.
const stack = async (network: Network, current: () => RequestBinding) => {
  const receiver = receiverStub();
  const facilitator = new x402Facilitator().register(network, facilitatorAt());
  const resourceServer = new x402ResourceServer(local(facilitator));
  resourceServer.register(
    network,
    new LnbtcServer({ receiver, requestBinding: () => current(), clock: () => NOW }),
  );
  await resourceServer.initialize();
  const client = sdkClient().register(
    network,
    new LnbtcClient({
      payer: payerFor(receiver),
      requestBinding: () => current(),
      clock: () => NOW,
    }),
  );
  const issue = async () =>
    resourceServer.createPaymentRequiredResponse(
      await resourceServer.buildPaymentRequirements(routeConfig(network)),
      { url: URL_A },
    );
  return { resourceServer, client, issue };
};

describe("SDK flows", () => {
  it.each([
    [LNBTC_MAINNET, "http"],
    [LNBTC_MAINNET, "mcp"],
    [LNBTC_TESTNET, "http"],
    [LNBTC_TESTNET, "mcp"],
  ] as const)(
    "a new challenge accepts two distinct payments for the same request [%s %s]",
    async (network, profile) => {
      const current =
        profile === "http"
          ? httpA()
          : mcpToolCallBinding({
              server: MCP_SERVER,
              name: "get_article",
              arguments: { article: "A" },
              boundMetadata: [],
            });
      const { resourceServer, client, issue } = await stack(network, () => current);
      const first = await issue();
      const second = await issue();
      expect(first.accepts[0].extra.invoice).not.toBe(second.accepts[0].extra.invoice);
      const payloads = [];
      for (const required of [first, second])
        payloads.push(await client.createPaymentPayload(required));
      for (const payload of payloads) {
        const matched = resourceServer.findMatchingRequirements(second.accepts, payload);
        expect(matched).toBeDefined();
        expect((await resourceServer.settlePayment(payload, matched!)).success).toBe(true);
        expect((await resourceServer.settlePayment(payload, matched!)).errorReason).toBe(
          "duplicate_settlement",
        );
      }
    },
  );

  // Requirements are recomputed for each request (requestHash is not a dynamic
  // field), so a stale request no longer matches the payload, and settling it
  // anyway fails at the facilitator.
  it("a paid retry for a different actual request does not match or settle", async () => {
    let current = httpA();
    const { resourceServer, client, issue } = await stack(LNBTC_MAINNET, () => current);
    const payload = await client.createPaymentPayload(await issue());
    const retry = async () =>
      resourceServer.createPaymentRequiredResponse(
        await resourceServer.buildPaymentRequirements(routeConfig(LNBTC_MAINNET)),
        { url: current.resourceUrl! },
        undefined,
        undefined,
        {
          request: {
            adapter: {
              getHeader: (name: string) =>
                name === "payment-signature" ? encodePaymentSignatureHeader(payload) : undefined,
            },
          },
        },
      );

    current = httpRequestBinding({
      method: "GET",
      url: "https://api.example.com/article/B",
      boundHeaders: [],
      getHeader: () => undefined,
    });
    const stale = (await retry()).accepts;
    expect(resourceServer.findMatchingRequirements(stale, payload)).toBeUndefined();
    const forced: SettleResponse = await resourceServer.settlePayment(payload, {
      ...stale[0],
      extra: { ...stale[0].extra, invoice: payload.accepted.extra.invoice },
    });
    expect(forced.errorReason).toBe("invalid_exact_lnbtc_request_mismatch");

    current = httpA();
    const matched = resourceServer.findMatchingRequirements((await retry()).accepts, payload);
    expect((await resourceServer.settlePayment(payload, matched!)).success).toBe(true);
  });

  // x402HTTPResourceServer over a framework-style adapter that builds its URL
  // from the Host header like Express. The handler runs only for a
  // `payment-verified` result whose before-handler settlement succeeded.
  it("runs the HTTP handler only after a single successful settlement", async () => {
    const receiver = receiverStub();
    const mechanism = facilitatorAt();
    const verify = vi.spyOn(mechanism, "verify").mockImplementation(() => {
      throw new Error("upfront must never verify");
    });
    const facilitator = new x402Facilitator().register(LNBTC_MAINNET, mechanism);
    const resourceServer = new x402ResourceServer(local(facilitator));
    resourceServer.register(
      LNBTC_MAINNET,
      new LnbtcServer({
        receiver,
        requestBinding: httpTransportBinding({ publicOrigin: ORIGIN }),
        clock: () => NOW,
      }),
    );
    await resourceServer.initialize();
    const route = { accepts: routeConfig(LNBTC_MAINNET) };
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "GET /article/A": route,
      "GET /article/B": route,
    });
    await httpServer.initialize();

    const handled: string[] = [];
    const adapter = (path: string, given: Record<string, string>): HTTPAdapter => {
      const headers: Record<string, string> = { host: "api.example.com" };
      for (const [name, value] of Object.entries(given)) headers[name.toLowerCase()] = value;
      return {
        getHeader: name => headers[name.toLowerCase()],
        getMethod: () => "GET",
        getPath: () => path,
        getUrl: () => `https://${headers.host}${path}`,
        getAcceptHeader: () => "application/json",
        getUserAgent: () => "shared-vectors",
      };
    };
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const result = await httpServer.processHTTPRequest({
        adapter: adapter(path, headers),
        path,
        method: "GET",
      });
      const settled = (result as { beforeHandlerSettlement?: { result: SettleResponse } })
        .beforeHandlerSettlement?.result;
      if (result.type === "payment-verified" && settled?.success) handled.push(path);
      return result;
    };

    const unpaid = await get("/article/A");
    expect(unpaid.type).toBe("payment-error");
    const response = (unpaid as { response: HTTPResponseInstructions }).response;
    expect(response.status).toBe(402);

    const httpClient = new x402HTTPClient(
      sdkClient().register(
        LNBTC_MAINNET,
        new LnbtcClient({
          payer: payerFor(receiver),
          requestBinding: httpA,
          clock: () => NOW,
        }),
      ),
    );
    const required = httpClient.getPaymentRequiredResponse(
      name => response.headers[name],
      response.body,
    );
    const header = httpClient.encodePaymentSignatureHeader(
      await httpClient.createPaymentPayload(required),
    );

    // A Host that would rewrite /article/B into /article/A is refused.
    await expect(
      get("/article/B", { ...header, host: "api.example.com/article/A?q=" }),
    ).rejects.toThrow("invalid_exact_lnbtc_request_binding");
    expect(handled).toEqual([]);

    const paid = await get("/article/A", header);
    expect(paid.type).toBe("payment-verified");
    expect(handled).toEqual(["/article/A"]);

    const replayed = await get("/article/A", header);
    expect(replayed.type).toBe("payment-error");
    const replay = (replayed as { response: HTTPResponseInstructions }).response;
    expect(replay.status).toBe(402);
    expect(
      JSON.parse(Buffer.from(replay.headers["PAYMENT-RESPONSE"], "base64").toString()).errorReason,
    ).toBe("duplicate_settlement");
    expect(handled).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("twelve instances on one store settle once, and a restarted instance sees the claim", async () => {
    const shared = new InMemoryReplayStore();
    const rows: [string, number][] = [];
    const store: ReplayStore = {
      consume: async (key, retainUntil) => {
        const inserted = await shared.consume(key, retainUntil);
        if (inserted) rows.push([key, retainUntil]);
        return inserted;
      },
    };
    const digest = httpA().requestHash;
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: LNBTC_MAINNET,
      amount: "21000",
      asset: "BTC",
      payTo: RECEIVER_PUBKEY,
      maxTimeoutSeconds: 300,
      extra: {
        requestHash: digest,
        requestBindingProfile: "http:1",
        requestBindingParams: { headers: [] },
        paymentFlow: "upfront",
        invoice: invoiceFor(digest),
      },
    };
    const payload = { x402Version: 2, accepted: requirements, payload: { preimage: PREIMAGE } };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        facilitatorAt(store).settle(structuredClone(payload), structuredClone(requirements)),
      ),
    );
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(results.filter(r => r.errorReason === "duplicate_settlement")).toHaveLength(11);
    expect((await facilitatorAt(store).settle(payload, requirements)).errorReason).toBe(
      "duplicate_settlement",
    );
    const winner = results.find(r => r.success)!;
    expect(rows).toEqual([[`${LNBTC_MAINNET}:${winner.transaction}`, NOW + 300 + 60 + 3600]]);
  });
});
