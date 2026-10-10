import { encodePaymentSignatureHeader, type HTTPTransportContext } from "@x402/core/http";
import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentRequirements, SchemePaymentRequiredContext } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { LNBTC_MAINNET, LNBTC_TESTNET } from "../../src/constants";
import {
  ExactLnbtcScheme,
  httpTransportBinding,
  mcpTransportBinding,
} from "../../src/exact/server";
import type { CreateInvoiceParams, LightningReceiver } from "../../src/types";
import {
  HTTP_A_HASH,
  MCP_A_HASH,
  OTHER_KEY,
  RECEIVER_PUBKEY,
  SPEC_INVOICE,
  SPEC_TIME,
  httpArticle,
  makeInvoice,
  mcpArticle,
  payloadFor,
  requirementsFor,
} from "./helpers";

const RESOURCE = "https://api.example.com/article/A";

const receiverReturning = (invoice: unknown = SPEC_INVOICE) => {
  const receiver: LightningReceiver = {
    createInvoice: vi.fn(async (_params: CreateInvoiceParams) => invoice as string),
  };
  return receiver;
};

// Issues a distinct, valid invoice per call, with the currency of the network.
const freshReceiver = () => {
  let n = 0;
  const receiver: LightningReceiver = {
    createInvoice: vi.fn(async (params: CreateInvoiceParams) => {
      n += 1;
      return makeInvoice({
        currency: params.network === LNBTC_TESTNET ? "tb" : "bc",
        amountMsat: params.amountMsat,
        preimage: n.toString(16).padStart(64, "0"),
      }).invoice;
    }),
  };
  return receiver;
};

const server = (
  receiver: LightningReceiver = receiverReturning(),
  allowInvoice?: (transportContext: unknown) => boolean | Promise<boolean>,
  binding = httpArticle(),
) =>
  new ExactLnbtcScheme({
    receiver,
    requestBinding: () => binding,
    allowInvoice,
    clock: () => SPEC_TIME,
  });

const base = (network: Network = LNBTC_MAINNET, amount = "25000"): PaymentRequirements => {
  const r = requirementsFor();
  r.network = network;
  r.amount = amount;
  r.extra = { assetTransferMethod: "bolt11", paymentFlow: "upfront" };
  return r;
};

const ctx = (overrides: Partial<SchemePaymentRequiredContext> = {}): SchemePaymentRequiredContext =>
  ({
    requirements: [base()],
    resourceInfo: { url: RESOURCE },
    paymentRequiredResponse: { x402Version: 2, resource: { url: "" }, accepts: [] },
    ...overrides,
  }) as SchemePaymentRequiredContext;

const headerContext = (header: string) =>
  ({
    request: {
      adapter: { getHeader: (name: string) => (name === "payment-signature" ? header : undefined) },
    },
  }) as unknown as HTTPTransportContext;

describe("parsePrice", () => {
  const s = server();
  it.each([
    [{ asset: "BTC", amount: "21000" }, "21000"],
    ["21 sats", "21000"],
    ["1 sat", "1000"],
    ["21.5 sats", "21500"],
    ["0.001 sat", "1"],
    ["1.2340 sats", "1234"],
    ["021 sats", "21000"],
    ["99999999999999999999 sats", "99999999999999999999000"],
  ])("converts %o to %s msat", async (price, msat) => {
    expect(await s.parsePrice(price, LNBTC_MAINNET)).toEqual({ asset: "BTC", amount: msat });
  });

  it.each([
    "21",
    21,
    "$1",
    "1 USD",
    "0.0001 BTC",
    "0.0001 sat",
    "-1 sats",
    "0 sats",
    "0.000 sats",
    "21 Sats",
    "21sats",
    "1e3 sats",
    " 21 sats",
    "21. sats",
  ])("rejects %o without a registered parser", async price => {
    await expect(s.parsePrice(price, LNBTC_MAINNET)).rejects.toThrow();
  });

  it.each(["0 sats", "0.000 sats", "0.0001 sat", "1.0001 sats", "1.0000000001 sats"])(
    "rejects %o as a non-positive or sub-millisatoshi amount",
    async price => {
      await expect(s.parsePrice(price, LNBTC_MAINNET)).rejects.toThrow(
        "invalid_exact_lnbtc_amount",
      );
    },
  );

  it("points callers at an explicit AssetAmount", async () => {
    await expect(s.parsePrice("21", LNBTC_MAINNET)).rejects.toThrow(
      /explicit AssetAmount \{ asset: "BTC", amount: "<millisatoshis>" \}/,
    );
  });

  it("rejects wrong assets, bad amounts, and unsupported networks", async () => {
    await expect(s.parsePrice({ asset: "USDC", amount: "1" }, LNBTC_MAINNET)).rejects.toThrow(
      "invalid_exact_lnbtc_asset",
    );
    for (const amount of ["1.5", "0", "01", 21000]) {
      await expect(
        s.parsePrice({ asset: "BTC", amount } as never, LNBTC_MAINNET),
        String(amount),
      ).rejects.toThrow("invalid_exact_lnbtc_amount");
    }
    for (const network of ["eip155:8453", "constructor", "toString", "__proto__"]) {
      await expect(s.parsePrice("1 sat", network as never), network).rejects.toThrow(
        "unsupported_network",
      );
    }
  });

  it("uses registered conversions for other forms", async () => {
    const converted = server().registerMoneyParser(async price =>
      price === "$1" ? { asset: "BTC", amount: "1500000" } : null,
    );
    expect(await converted.parsePrice("$1", LNBTC_MAINNET)).toEqual({
      asset: "BTC",
      amount: "1500000",
    });
    await expect(converted.parsePrice("$2", LNBTC_MAINNET)).rejects.toThrow();
    const sloppy = server().registerMoneyParser(async () => ({ asset: "BTC", amount: "0.5" }));
    await expect(sloppy.parsePrice("$1", LNBTC_MAINNET)).rejects.toThrow(
      "invalid_exact_lnbtc_amount",
    );
  });
});

describe("requirements and challenges", () => {
  it("declares the bolt11/upfront flow and the dynamic invoice field", async () => {
    const s = server();
    expect(s.defaultAssetTransferMethod).toBe("bolt11");
    expect(s.paymentFlows).toEqual({ bolt11: { supported: ["upfront"], default: "upfront" } });
    expect(s.dynamicExtraFields).toEqual(["invoice"]);
    const enhanced = await s.enhancePaymentRequirements(
      { ...base(), extra: {} },
      { x402Version: 2, scheme: "exact", network: LNBTC_MAINNET },
      [],
    );
    expect(enhanced.extra).toEqual({ assetTransferMethod: "bolt11", paymentFlow: "upfront" });
  });

  it("binds the challenge to the request and issues a fresh invoice", async () => {
    const receiver = receiverReturning();
    const [r] = await server(receiver).enrichPaymentRequiredResponse(ctx());
    expect(r).toEqual(requirementsFor());
    expect(receiver.createInvoice).toHaveBeenCalledWith({
      amountMsat: 25_000n,
      descriptionHash: HTTP_A_HASH,
      expirySeconds: 300,
      network: LNBTC_MAINNET,
    });
  });

  it("takes the request hash from the request, never from a paid retry's echo", async () => {
    // The client echoes article B's binding, but the request is for article A.
    const echoed = payloadFor(requirementsFor(httpArticle("B")));
    const [r] = await server().enrichPaymentRequiredResponse(
      ctx({ transportContext: headerContext(encodePaymentSignatureHeader(echoed)) }),
    );
    expect(r.extra.requestHash).toBe(HTTP_A_HASH);
    expect(r.extra.requestBindingParams).toEqual({ headers: [] });
  });

  describe("paid retry (payment present, no error)", () => {
    it.each([
      [
        "PAYMENT-SIGNATURE header",
        { transportContext: headerContext(encodePaymentSignatureHeader(payloadFor())) },
      ],
      [
        "paymentHeader on the request context",
        {
          transportContext: {
            request: { paymentHeader: encodePaymentSignatureHeader(payloadFor()) },
          },
        },
      ],
      ["MCP _meta", { transportContext: { meta: { "x402/payment": payloadFor() } } }],
      ["core payload", { paymentPayload: payloadFor() }],
    ])("reuses the accepted invoice from the %s without issuing", async (_name, overrides) => {
      const receiver = freshReceiver();
      const [r] = await server(receiver).enrichPaymentRequiredResponse(ctx(overrides as never));
      expect(r.extra.invoice).toBe(SPEC_INVOICE);
      expect(r.extra.requestHash).toBe(HTTP_A_HASH);
      expect(receiver.createInvoice).not.toHaveBeenCalled();
    });

    it("never issues for a payment on another scheme or network", async () => {
      const receiver = freshReceiver();
      const evm = payloadFor({ ...requirementsFor(), network: "eip155:8453" });
      const testnet = payloadFor({ ...requirementsFor(), network: LNBTC_TESTNET });
      const upto = payloadFor({ ...requirementsFor(), scheme: "upto" });
      for (const payload of [evm, testnet, upto]) {
        const [r] = await server(receiver).enrichPaymentRequiredResponse(
          ctx({ paymentPayload: payload }),
        );
        expect(r.extra.invoice).toBeUndefined();
        expect(r.extra.requestHash).toBe(HTTP_A_HASH);
      }
      const noInvoice = payloadFor();
      delete noInvoice.accepted.extra.invoice;
      const [r] = await server(receiver).enrichPaymentRequiredResponse(
        ctx({ paymentPayload: noInvoice }),
      );
      expect(r.extra.invoice).toBeUndefined();
      expect(receiver.createInvoice).not.toHaveBeenCalled();
    });

    it("issues fresh invoices when an error is reported or no payload is readable", async () => {
      const receiver = freshReceiver();
      await server(receiver).enrichPaymentRequiredResponse(
        ctx({ paymentPayload: payloadFor(), error: "No matching payment requirements" }),
      );
      await server(receiver).enrichPaymentRequiredResponse(
        ctx({ transportContext: headerContext("!!") }),
      );
      await server(receiver).enrichPaymentRequiredResponse(ctx({ transportContext: { meta: {} } }));
      expect(receiver.createInvoice).toHaveBeenCalledTimes(3);
    });
  });

  it("binds one requirement per call, in order, and stops once all are bound", async () => {
    const receiver = freshReceiver();
    const s = server(receiver);
    const first = await s.enrichPaymentRequiredResponse(
      ctx({ requirements: [base(), base(LNBTC_TESTNET)] }),
    );
    expect(first.map(r => r.extra.requestHash)).toEqual([HTTP_A_HASH, undefined]);
    const second = await s.enrichPaymentRequiredResponse(ctx({ requirements: first }));
    expect(second[0]).toBe(first[0]);
    expect(second[1].extra.requestHash).toBe(HTTP_A_HASH);
    expect(await s.enrichPaymentRequiredResponse(ctx({ requirements: second }))).toBe(second);
    expect(receiver.createInvoice).toHaveBeenCalledTimes(2);
  });

  it("passes through requirements of other schemes and unsupported networks", async () => {
    const receiver = freshReceiver();
    const other = { ...base(), scheme: "upto" };
    const evm = { ...base(), network: "eip155:8453" };
    const proto = { ...base(), network: "constructor" };
    const reqs = [other, evm, proto] as PaymentRequirements[];
    const out = await server(receiver).enrichPaymentRequiredResponse(ctx({ requirements: reqs }));
    expect(out).toEqual(reqs);
    expect(receiver.createInvoice).not.toHaveBeenCalled();
  });

  describe("through x402ResourceServer", () => {
    const resourceServer = (scheme: ExactLnbtcScheme) => {
      const rs = new x402ResourceServer({} as FacilitatorClient);
      rs.register(LNBTC_MAINNET, scheme);
      rs.register(LNBTC_TESTNET, scheme);
      return rs;
    };

    it("issues exactly one invoice per lnbtc accept, even when core calls the hook per accept", async () => {
      const receiver = freshReceiver();
      const accepts = [base(LNBTC_MAINNET), base(LNBTC_TESTNET), base(LNBTC_MAINNET, "50000")];
      const response = await resourceServer(server(receiver)).createPaymentRequiredResponse(
        accepts,
        { url: RESOURCE },
        "Payment required",
      );
      expect(receiver.createInvoice).toHaveBeenCalledTimes(3);
      const invoices = response.accepts.map(r => r.extra.invoice);
      expect(new Set(invoices).size).toBe(3);
      expect(response.accepts.map(r => r.extra.requestHash)).toEqual([
        HTTP_A_HASH,
        HTTP_A_HASH,
        HTTP_A_HASH,
      ]);
    });

    it("computes the binding once per response", async () => {
      const requestBinding = vi.fn(() => httpArticle());
      const scheme = new ExactLnbtcScheme({
        receiver: freshReceiver(),
        requestBinding,
        clock: () => SPEC_TIME,
      });
      await resourceServer(scheme).createPaymentRequiredResponse(
        [base(LNBTC_MAINNET), base(LNBTC_TESTNET)],
        { url: RESOURCE },
        "Payment required",
      );
      expect(requestBinding).toHaveBeenCalledTimes(1);
    });

    it("works with a separate scheme instance per network", async () => {
      const receiver = freshReceiver();
      const rs = new x402ResourceServer({} as FacilitatorClient);
      rs.register(LNBTC_MAINNET, server(receiver));
      rs.register(LNBTC_TESTNET, server(receiver));
      const response = await rs.createPaymentRequiredResponse(
        [base(LNBTC_TESTNET), base(LNBTC_MAINNET)],
        { url: RESOURCE },
        "Payment required",
      );
      expect(response.accepts.map(r => typeof r.extra.invoice)).toEqual(["string", "string"]);
      expect(receiver.createInvoice).toHaveBeenCalledTimes(2);
    });

    it("matches a paid retry against the accepted invoice and the recomputed binding", async () => {
      const rs = resourceServer(server(freshReceiver()));
      const required = await rs.createPaymentRequiredResponse(
        [base(LNBTC_TESTNET), base(LNBTC_MAINNET)],
        { url: RESOURCE },
        undefined,
        undefined,
        headerContext(encodePaymentSignatureHeader(payloadFor())),
      );
      const match = rs.findMatchingRequirements(required.accepts, payloadFor());
      expect(match?.network).toBe(LNBTC_MAINNET);
      expect(match?.extra.invoice).toBe(SPEC_INVOICE);
      expect(required.accepts[0].extra.invoice).toBeUndefined();
    });
  });

  it("requires PaymentRequired.resource.url to equal the http:1 request URL", async () => {
    await expect(
      server().enrichPaymentRequiredResponse(
        ctx({ resourceInfo: { url: "http://internal:8080/article/A" } }),
      ),
    ).rejects.toThrow("PaymentRequired.resource.url");
    // MCP resources name the tool, not the binding URL.
    const mcpInvoice = makeInvoice({ descriptionHash: MCP_A_HASH }).invoice;
    const mcp = server(receiverReturning(mcpInvoice), undefined, mcpArticle());
    const [r] = await mcp.enrichPaymentRequiredResponse(
      ctx({ resourceInfo: { url: "mcp://tool/get_article" } }),
    );
    expect(r.extra.requestBindingProfile).toBe("mcp:1");
  });

  it("asks the limiter with the transport context before each new invoice", async () => {
    const receiver = receiverReturning();
    const allow = vi.fn(async () => false);
    const transportContext = { meta: {} };
    await expect(
      server(receiver, allow).enrichPaymentRequiredResponse(ctx({ transportContext })),
    ).rejects.toThrow("exact_lnbtc_invoice_issuance_denied");
    expect(allow).toHaveBeenCalledWith(transportContext);
    expect(receiver.createInvoice).not.toHaveBeenCalled();
    const allowed = receiverReturning();
    await server(allowed, async () => true).enrichPaymentRequiredResponse(ctx());
    expect(allowed.createInvoice).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ key: OTHER_KEY }, "invalid_exact_lnbtc_invoice_payee_mismatch"],
    [{ descriptionHash: MCP_A_HASH }, "invalid_exact_lnbtc_invoice_request_mismatch"],
    [{ description: "x", descriptionHash: null }, "invalid_exact_lnbtc_invoice_description"],
    [{ currency: "tb" }, "invalid_exact_lnbtc_invoice_currency_mismatch"],
    [{ amountMsat: 1_000n }, "invalid_exact_lnbtc_invoice_amount_mismatch"],
    [{ expiry: 3600 }, "invalid_exact_lnbtc_invoice_expiry_mismatch"],
    [{ timestamp: SPEC_TIME + 61 }, "invalid_exact_lnbtc_invoice_created_in_future"],
    [{ timestamp: SPEC_TIME - 300 }, "invalid_exact_lnbtc_invoice_expired"],
  ])("refuses a receiver invoice with %o", async (spec, reason) => {
    const receiver = receiverReturning(makeInvoice(spec).invoice);
    await expect(server(receiver).enrichPaymentRequiredResponse(ctx())).rejects.toThrow(reason);
  });

  it("accepts a receiver invoice at the creation-time skew boundary", async () => {
    const receiver = receiverReturning(makeInvoice({ timestamp: SPEC_TIME + 60 }).invoice);
    await expect(server(receiver).enrichPaymentRequiredResponse(ctx())).resolves.toHaveLength(1);
  });

  it.each([
    [null, "invalid_exact_lnbtc_invoice_missing"],
    ["", "invalid_exact_lnbtc_invoice_missing"],
    [42, "invalid_exact_lnbtc_invoice_decode_failed"],
    ["lnbc1garbage", "invalid_exact_lnbtc_invoice_decode_failed"],
  ])("refuses a receiver result %o", async (invoice, reason) => {
    await expect(
      server(receiverReturning(invoice)).enrichPaymentRequiredResponse(ctx()),
    ).rejects.toThrow(reason);
  });

  it("validates the requirements before calling the limiter or the receiver", async () => {
    const receiver = receiverReturning();
    const allow = vi.fn(() => true);
    for (const r of [
      { ...base(), payTo: RECEIVER_PUBKEY.toUpperCase() },
      { ...base(), amount: "1.5" },
      { ...base(), maxTimeoutSeconds: 0 },
      { ...base(), extra: { paymentFlow: "authorization" } },
    ]) {
      await expect(
        server(receiver, allow).enrichPaymentRequiredResponse(ctx({ requirements: [r] })),
      ).rejects.toThrow(/^invalid_exact_lnbtc_/);
    }
    expect(allow).not.toHaveBeenCalled();
    expect(receiver.createInvoice).not.toHaveBeenCalled();
  });

  it("uses the system clock by default and works without a response object", async () => {
    const now = Math.floor(Date.now() / 1000);
    const scheme = new ExactLnbtcScheme({
      receiver: receiverReturning(makeInvoice({ timestamp: now }).invoice),
      requestBinding: () => httpArticle(),
    });
    const [r] = await scheme.enrichPaymentRequiredResponse(
      ctx({ paymentRequiredResponse: undefined as never }),
    );
    expect(r.extra.requestHash).toBe(HTTP_A_HASH);
    const stale = new ExactLnbtcScheme({
      receiver: receiverReturning(),
      requestBinding: () => httpArticle(),
    });
    await expect(stale.enrichPaymentRequiredResponse(ctx())).rejects.toThrow(
      "invalid_exact_lnbtc_invoice_expired",
    );
  });

  it("rejects a skew that is negative or fractional", () => {
    const options = { receiver: receiverReturning(), requestBinding: () => httpArticle() };
    expect(() => new ExactLnbtcScheme({ ...options, clockSkewSeconds: -1 })).toThrow(RangeError);
    expect(() => new ExactLnbtcScheme({ ...options, clockSkewSeconds: 0.5 })).toThrow(RangeError);
  });
});

describe("transport bindings", () => {
  // Like a first-party adapter: the Host header carries the URL's authority
  // unless a test supplies its own authority headers.
  const adapter = (url: string, headers: Record<string, string> = {}, method = "GET") => {
    const own = "host" in headers || ":authority" in headers || "x-forwarded-host" in headers;
    const host = /^[a-z]+:\/\/([^/?#]*)/i.exec(url)?.[1];
    const all: Record<string, string> = own || host === undefined ? headers : { host, ...headers };
    return {
      getMethod: () => method,
      getUrl: () => url,
      getHeader: (name: string) => all[name],
    };
  };
  const http = (
    url: string,
    headers?: Record<string, string>,
    body?: Uint8Array,
    bound?: string[],
  ) =>
    httpTransportBinding({
      publicOrigin: "https://api.example.com/",
      boundHeaders: bound,
      rawBody: () => body,
    })({ request: { adapter: adapter(url, headers) } });
  const BINDING_ERROR = "invalid_exact_lnbtc_request_binding";

  it("uses the configured origin, never the Host header", async () => {
    expect((await http("http://evil.example:8080/article/A")).requestHash).toBe(HTTP_A_HASH);
    expect((await http("http://[::1]:8080/article/A")).requestHash).toBe(HTTP_A_HASH);
  });

  it("refuses a Host header that would move the request target", async () => {
    // Express builds getUrl() as `${protocol}://${Host}${originalUrl}`: a Host of
    // `x/article/A#` makes a request for /article/B look like /article/A.
    for (const host of ["x/article/A#", "x/article", "x?a=", "x#", "u@x", "x\\y", "x y"]) {
      const url = `http://${host}/article/B`;
      await expect(http(url, { host }), host).rejects.toThrow(BINDING_ERROR);
      await expect(http(url, { "x-forwarded-host": host }), host).rejects.toThrow(BINDING_ERROR);
    }
    expect((await http("http://x:1/article/A", { host: "x:1" })).requestHash).toBe(HTTP_A_HASH);
  });

  it("refuses an authority the URL took from a header it was not validated against", async () => {
    // Host injection through a source other than Host itself (HTTP/2 :authority,
    // or a header the binding cannot see): the URL's authority must match a
    // validated authority header.
    const url = "http://x/search?q=/article/B";
    await expect(http(url, { ":authority": "x/search?q=" }), ":authority").rejects.toThrow(
      BINDING_ERROR,
    );
    await expect(http(url, { host: "api.example.com" }), "mismatch").rejects.toThrow(BINDING_ERROR);
    await expect(http("http://x/article/A?/article/B", { host: "x" })).resolves.toBeDefined();
    const noHeaders = httpTransportBinding({ publicOrigin: "https://api.example.com" });
    const bare = { getMethod: () => "GET", getUrl: () => url, getHeader: () => undefined };
    await expect(noHeaders({ request: { adapter: bare } }), "no source").rejects.toThrow(
      BINDING_ERROR,
    );
  });

  it.each([
    ["api.example.com", "https://api.example.com/article/A"],
    ["API.Example.COM:443", "https://api.example.com/article/A"],
    ["api.example.com:80", "http://api.example.com/article/A"],
    ["api.example.com:", "http://api.example.com:/article/A"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/article/A"],
    ["[::1]:8080", "http://[::1]:8080/article/A"],
    ["[v1.fe80::a+en1]", "http://[v1.fe80::a+en1]/article/A"],
    ["xn--bcher-kva.example", "http://xn--bcher-kva.example/article/A"],
    ["a%2Db.example", "http://a%2Db.example/article/A"],
  ])("accepts the authority %s for %s", async (host, url) => {
    expect((await http(url, { host })).requestHash).toBe(HTTP_A_HASH);
  });

  it.each([
    "",
    "a b",
    "u@x",
    "x:8080:1",
    "x:port",
    "[::1",
    "::1",
    "x%zz",
    "b\u00fccher.example",
    "x,y",
  ])("refuses the authority header %j", async host => {
    await expect(http(`http://${host}/article/A`, { host })).rejects.toThrow(BINDING_ERROR);
  });

  it("trims only spaces and tabs (RFC 9110 OWS) from authority and protocol hops", async () => {
    const url = "https://api.example.com/article/A";
    for (const name of ["host", ":authority", "x-forwarded-host"]) {
      for (const ws of ["\r\n", "\n", "\r", "\v", "\f", " ", "﻿"]) {
        await expect(http(url, { [name]: `api.example.com${ws}` }), name).rejects.toThrow(
          BINDING_ERROR,
        );
      }
    }
    await expect(
      http(url, { host: "api.example.com", "x-forwarded-proto": "https\r\n" }),
    ).rejects.toThrow(BINDING_ERROR);
    const padded = { host: " \tapi.example.com\t ", "x-forwarded-proto": "\thttps , http " };
    expect((await http(url, padded)).requestHash).toBe(HTTP_A_HASH);
  });

  it("accepts an HTTP/2 :authority without a Host header", async () => {
    const url = "https://api.example.com/article/A";
    expect((await http(url, { ":authority": "api.example.com" })).requestHash).toBe(HTTP_A_HASH);
  });

  it("checks every hop of a forwarded host", async () => {
    await expect(
      http("http://api.example.com/article/A", {
        host: "api.example.com",
        "x-forwarded-host": "api.example.com, x/search?q=",
      }),
    ).rejects.toThrow(BINDING_ERROR);
    // Fastify behind a trusted proxy builds the URL from X-Forwarded-Host.
    expect(
      (
        await http("https://public.example/article/A", {
          host: "10.0.0.5:3000",
          "x-forwarded-host": "edge.example, public.example",
        })
      ).requestHash,
    ).toBe(HTTP_A_HASH);
  });

  it("refuses a forwarded protocol that would move the request target", async () => {
    // With a trusted proxy, Express builds getUrl() from X-Forwarded-Proto, so
    // `http://x/pay?u=https` turns a request for /article/B into /pay?u=https://...
    const proto = "http://x/pay?u=https";
    const url = `${proto}://api.example.com/article/B`;
    await expect(http(url, { "x-forwarded-proto": proto })).rejects.toThrow(BINDING_ERROR);
    await expect(http(url, { "x-forwarded-proto": `https, ${proto}` })).rejects.toThrow(
      BINDING_ERROR,
    );
  });

  it("accepts well-formed proxy header lists", async () => {
    const headers = {
      host: "api.example.com",
      "x-forwarded-host": "api.example.com, edge.internal:8080",
      "x-forwarded-proto": "https, http",
    };
    expect((await http("https://api.example.com/article/A", headers)).requestHash).toBe(
      HTTP_A_HASH,
    );
    await expect(http("https://x/article/A", { host: "" })).rejects.toThrow(BINDING_ERROR);
  });

  it("refuses an adapter URL whose target is not origin-form", async () => {
    for (const url of [
      "https://api.example.com/article/A#frag",
      "https://api.example.com//evil/article/A",
      "https://api.example.com?article=A",
      "api.example.com/article/A",
    ]) {
      await expect(http(url), url).rejects.toThrow(BINDING_ERROR);
    }
  });

  it("preserves the raw target and binds configured headers and the body", async () => {
    const a = await http("https://x/article/A?b=2&a=1");
    const b = await http("https://x/article/A?a=1&b=2");
    expect(a.resourceUrl).toBe("https://api.example.com/article/A?b=2&a=1");
    expect(a.requestHash).not.toBe(b.requestHash);
    expect((await http("https://x/article/%41")).resourceUrl).toBe(
      "https://api.example.com/article/%41",
    );
    const withHeader = await http("https://x/article/A", { accept: "text/plain" }, undefined, [
      "accept",
    ]);
    expect(withHeader.requestBindingParams).toEqual({ headers: ["accept"] });
    expect(withHeader.requestHash).not.toBe(
      (await http("https://x/article/A", {}, undefined, ["accept"])).requestHash,
    );
    expect((await http("https://x/article/A", {}, Uint8Array.of(1))).requestHash).not.toBe(
      HTTP_A_HASH,
    );
    expect((await http("https://api.example.com")).resourceUrl).toBe("https://api.example.com/");
  });

  it("accepts an asynchronous rawBody accessor", async () => {
    const bind = httpTransportBinding({
      publicOrigin: "https://api.example.com",
      rawBody: async () => Uint8Array.of(0x78),
    });
    const expected = httpArticle("A", { body: Uint8Array.of(0x78) }).requestHash;
    expect((await bind({ request: { adapter: adapter("https://x/article/A") } })).requestHash).toBe(
      expected,
    );
  });

  it("validates the configured origin and bound headers up front", () => {
    for (const publicOrigin of [
      "ftp://api.example.com",
      "https://api.example.com?x=1",
      "https://api.example.com#x",
      "https://user@api.example.com",
      "/relative",
    ]) {
      expect(() => httpTransportBinding({ publicOrigin }), publicOrigin).toThrow(BINDING_ERROR);
    }
    expect(() =>
      httpTransportBinding({ publicOrigin: "https://a.example", boundHeaders: ["B", "a"] }),
    ).toThrow(BINDING_ERROR);
  });

  describe("default body source", () => {
    const bind = httpTransportBinding({ publicOrigin: "https://api.example.com" });
    const ctxWith = (body: unknown, headers: Record<string, string> = {}) => ({
      request: { adapter: { ...adapter("https://x/article/A", headers), getBody: () => body } },
    });

    it("hashes adapter bytes, including bytes resolved asynchronously", async () => {
      const expected = httpArticle("A", { body: Uint8Array.of(1) }).requestHash;
      expect((await bind(ctxWith(Uint8Array.of(1)))).requestHash).toBe(expected);
      expect((await bind(ctxWith(Promise.resolve(Uint8Array.of(1))))).requestHash).toBe(expected);
    });

    it.each([
      ["no getBody", undefined, {}],
      ["undefined", undefined, {}],
      ["null", null, {}],
      ["empty string", "", {}],
      ["empty object", {}, { "content-length": "0" }],
      ["zero content-length", {}, { "content-length": " 00 " }],
    ])("treats %s without content as an empty body", async (name, body, headers) => {
      const ctx =
        name === "no getBody"
          ? { request: { adapter: adapter("https://x/article/A") } }
          : ctxWith(body, headers as Record<string, string>);
      expect((await bind(ctx)).requestHash).toBe(HTTP_A_HASH);
    });

    it.each([
      ["a parsed body with content-length", { a: 1 }, { "content-length": "7" }],
      ["a chunked body", undefined, { "transfer-encoding": "chunked" }],
      ["a parsed body without length headers (HTTP/2)", { a: 1 }, {}],
      ["a parsed string body", "x", {}],
      ["a parsed array body", [], {}],
      ["an async parsed body (Hono, Next)", Promise.resolve({ a: 1 }), {}],
    ])("refuses %s", async (_name, body, headers) => {
      await expect(bind(ctxWith(body, headers as Record<string, string>))).rejects.toThrow(
        "raw request body",
      );
    });
  });

  it("rejects a missing transport context", async () => {
    const bind = httpTransportBinding({ publicOrigin: "https://a.example" });
    await expect(bind(undefined)).rejects.toThrow(BINDING_ERROR);
    await expect(bind({ request: {} })).rejects.toThrow(BINDING_ERROR);
  });

  it("binds MCP tool calls from the wrapper context", async () => {
    const bind = mcpTransportBinding({ server: "https://api.example.com/mcp" });
    expect((await bind({ toolName: "get_article", arguments: { article: "A" } })).requestHash).toBe(
      MCP_A_HASH,
    );
    expect(() => bind({ arguments: {} })).toThrow(BINDING_ERROR);
    expect(() => bind(undefined)).toThrow(BINDING_ERROR);
  });

  it("binds the raw tool call when @x402/mcp captured it, before schema defaults", async () => {
    const bind = mcpTransportBinding({ server: "https://api.example.com/mcp" });
    const validated = { article: "A", lang: "en" };
    const raw = await bind({
      toolName: "paid_tool",
      arguments: validated,
      rawToolCall: { name: "get_article", arguments: { article: "A" } },
    });
    expect(raw.requestHash).toBe(MCP_A_HASH);
    const fallback = await bind({ toolName: "get_article", arguments: validated });
    expect(fallback.requestHash).not.toBe(MCP_A_HASH);
    const omitted = await bind({
      toolName: "x",
      arguments: {},
      rawToolCall: { name: "get_article" },
    });
    expect(omitted.requestHash).toBe(
      (await bind({ toolName: "get_article", arguments: {} })).requestHash,
    );
    const withMeta = await bind({
      toolName: "get_article",
      arguments: { article: "A" },
      meta: { tier: "validated" },
      rawToolCall: { name: "get_article", arguments: { article: "A" }, _meta: { tier: "raw" } },
    });
    const bound = mcpTransportBinding({
      server: "https://api.example.com/mcp",
      boundMetadata: ["tier"],
    });
    expect(
      (
        await bound({
          toolName: "get_article",
          arguments: { article: "A" },
          meta: { tier: "validated" },
          rawToolCall: { name: "get_article", arguments: { article: "A" }, _meta: { tier: "raw" } },
        })
      ).requestHash,
    ).toBe(
      (await bound({ toolName: "get_article", arguments: { article: "A" }, meta: { tier: "raw" } }))
        .requestHash,
    );
    expect(withMeta.requestHash).toBe(MCP_A_HASH);
    expect(() => bind({ toolName: "get_article", rawToolCall: { name: 7 } })).toThrow(
      BINDING_ERROR,
    );
  });

  it("reads authority headers from a Fetch Headers adapter (Hono, Next)", async () => {
    const headers = new Headers({ host: "api.example.com" });
    expect(() => headers.get(":authority")).toThrow();
    const fetchAdapter = {
      getMethod: () => "GET",
      getUrl: () => "http://api.example.com/article/A",
      getHeader: (name: string) => headers.get(name) ?? undefined,
      getBody: () => undefined,
    };
    const bind = httpTransportBinding({ publicOrigin: "https://api.example.com" });
    expect((await bind({ request: { adapter: fetchAdapter } })).requestHash).toBe(HTTP_A_HASH);
    const spoofed = new Headers({ host: "x/search?q=" });
    const spoofAdapter = {
      ...fetchAdapter,
      getUrl: () => "http://x/search?q=/article/B",
      getHeader: (name: string) => spoofed.get(name) ?? undefined,
    };
    await expect(bind({ request: { adapter: spoofAdapter } })).rejects.toThrow(BINDING_ERROR);
    const failing = {
      ...fetchAdapter,
      getHeader: (name: string) => (name === "host" ? headers.get(":bad") : undefined),
    };
    await expect(bind({ request: { adapter: failing } })).rejects.toThrow();
  });
});
