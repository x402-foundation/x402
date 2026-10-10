/**
 * Real-node flow on regtest: x402HTTPClient -> x402HTTPResourceServer ->
 * x402Facilitator, with LND paying (alice) and receiving (bob).
 *
 * Start the nodes with `test/regtest/setup.sh`; the suite reads
 * `test/regtest/.data/env` (or the same variables from the environment) and
 * skips when they are absent. The regtest network id and `bcrt` currency are
 * harness-only: the specification defines mainnet and testnet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
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
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryReplayStore, httpRequestBinding } from "../../src";
import { ExactLnbtcScheme as LnbtcClient } from "../../src/exact/client";
import { ExactLnbtcScheme as LnbtcFacilitator } from "../../src/exact/facilitator";
import { ExactLnbtcScheme as LnbtcServer, httpTransportBinding } from "../../src/exact/server";
import { decodeWithLnd, lndNode, lndPayer, lndReceiver, lookupInvoice, type LndNode } from "./lnd";

const REGTEST: Network = "lnbtc:0f9188f13cb7b2c71f2a335e3a4fc328";
const NETWORKS = { [REGTEST]: "bcrt" };
const ORIGIN = "https://api.example.com";

const envFile = join(__dirname, "../regtest/.data/env");
const fileEnv: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .filter(line => line.includes("="))
        .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    )
  : {};
const env = (name: string) => process.env[name] ?? fileEnv[name];
const missing = !env("LNBTC_REGTEST_RECEIVER_REST") || !env("LNBTC_REGTEST_PAYER_REST");

class LocalFacilitatorClient implements FacilitatorClient {
  /**
   * Wraps an in-process facilitator.
   *
   * @param facilitator - Facilitator
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Delegates verify.
   *
   * @param p - Payload
   * @param r - Requirements
   * @returns Verify response
   */
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(p, r);
  }

  /**
   * Delegates settle.
   *
   * @param p - Payload
   * @param r - Requirements
   * @returns Settle response
   */
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(p, r);
  }

  /**
   * Delegates supported kinds.
   *
   * @returns Supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

describe.skipIf(missing)("exact lnbtc on regtest LND", () => {
  let payer: LndNode;
  let receiver: LndNode;
  let receiverPubkey: string;
  let httpServer: x402HTTPResourceServer;

  const article = (id: string) => `${ORIGIN}/article/${id}`;
  // Builds getUrl() like the Express and Fastify adapters: protocol, the raw
  // Host (or HTTP/2 :authority) header, and the raw target.
  const adapter = (path: string, given: Record<string, string> = {}): HTTPAdapter => {
    const headers =
      given.host === undefined && given[":authority"] === undefined
        ? { host: "localhost:4021", ...given }
        : given;
    return {
      getHeader: name => headers[name.toUpperCase()] ?? headers[name],
      getMethod: () => "GET",
      getPath: () => path,
      getUrl: () => `http://${headers.host ?? headers[":authority"]}${path}`,
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "lnbtc-integration",
    };
  };
  const request = (path: string, headers?: Record<string, string>) =>
    httpServer.processHTTPRequest({ adapter: adapter(path, headers), path, method: "GET" });

  const clientFor = (url: string) =>
    new x402HTTPClient(
      new x402Client().setSpendControls(false).register(
        REGTEST,
        new LnbtcClient({
          payer: lndPayer(payer),
          networks: NETWORKS,
          requestBinding: () =>
            httpRequestBinding({
              method: "GET",
              url,
              boundHeaders: [],
              getHeader: () => undefined,
            }),
        }),
      ),
    );

  const challenge = async (path: string) => {
    const result = await request(path);
    expect(result.type).toBe("payment-error");
    return (result as { response: HTTPResponseInstructions }).response;
  };

  const payFor = async (path: string, url = `${ORIGIN}${path}`) => {
    const response = await challenge(path);
    const client = clientFor(url);
    const required = client.getPaymentRequiredResponse(
      name => response.headers[name],
      response.body,
    );
    const payload = await client.createPaymentPayload(required);
    return { payload, headers: await client.encodePaymentSignatureHeader(payload) };
  };

  beforeAll(async () => {
    payer = lndNode(
      env("LNBTC_REGTEST_PAYER_REST")!,
      env("LNBTC_REGTEST_PAYER_MACAROON")!,
      env("LNBTC_REGTEST_PAYER_TLS_CERT")!,
    );
    receiver = lndNode(
      env("LNBTC_REGTEST_RECEIVER_REST")!,
      env("LNBTC_REGTEST_RECEIVER_MACAROON")!,
      env("LNBTC_REGTEST_RECEIVER_TLS_CERT")!,
    );
    receiverPubkey = env("LNBTC_REGTEST_RECEIVER_PUBKEY")!;

    const facilitator = new x402Facilitator().register(
      REGTEST,
      new LnbtcFacilitator({ replayStore: new InMemoryReplayStore(), networks: NETWORKS }),
    );
    const resourceServer = new x402ResourceServer(new LocalFacilitatorClient(facilitator));
    resourceServer.register(
      REGTEST,
      new LnbtcServer({
        receiver: lndReceiver(receiver),
        requestBinding: httpTransportBinding({ publicOrigin: ORIGIN }),
        networks: NETWORKS,
      }),
    );
    await resourceServer.initialize();

    const route = (id: string, price: string) => ({
      accepts: {
        scheme: "exact",
        payTo: receiverPubkey,
        price,
        network: REGTEST,
        maxTimeoutSeconds: 300,
      },
      resource: article(id),
    });
    httpServer = new x402HTTPResourceServer(resourceServer, {
      "GET /article/A": route("A", "21 sats"),
      "GET /article/B": route("B", "21 sats"),
      "GET /article/C": route("C", "21.5 sats"),
      "GET /article/D": route("D", "21 sats"),
      "GET /article/E": route("E", "21 sats"),
      "GET /article/F": {
        ...route("F", "21 sats"),
        accepts: [route("F", "21 sats").accepts, route("F", "22 sats").accepts],
      },
      "GET /expensive": { ...route("X", "5000000 sats"), resource: `${ORIGIN}/expensive` },
    });
    await httpServer.initialize();
  });

  it("answers an unpaid request with a request-bound invoice from the receiver", async () => {
    const response = await challenge("/article/A");
    expect(response.status).toBe(402);
    const client = clientFor(article("A"));
    const [requirements] = client.getPaymentRequiredResponse(
      name => response.headers[name],
      response.body,
    ).accepts;
    const decoded = await decodeWithLnd(payer, requirements.extra.invoice as string);
    expect(decoded.destination).toBe(receiverPubkey);
    expect(decoded.numMsat).toBe("21000");
    expect(decoded.descriptionHash).toBe(requirements.extra.requestHash);
  });

  it("pays, settles before the handler, and refuses a replay", async () => {
    const { payload, headers } = await payFor("/article/A");
    const paid = await request("/article/A", headers);
    expect(paid.type).toBe("payment-verified");
    const settlement = (
      paid as { beforeHandlerSettlement?: { result: { success: boolean; transaction: string } } }
    ).beforeHandlerSettlement;
    expect(settlement?.result.success).toBe(true);

    const invoice = await lookupInvoice(receiver, settlement!.result.transaction);
    expect(invoice).toEqual({ state: "SETTLED", amtPaidMsat: "21000" });
    expect(payload.payload.preimage).toMatch(/^[0-9a-f]{64}$/);

    const replay = await request("/article/A", headers);
    expect(replay.type).toBe("payment-error");
    const replayHeader = (replay as { response: HTTPResponseInstructions }).response.headers[
      "PAYMENT-RESPONSE"
    ];
    expect(JSON.parse(Buffer.from(replayHeader, "base64").toString()).errorReason).toBe(
      "duplicate_settlement",
    );
  });

  it("refuses a proof for another route without consuming it", async () => {
    const { headers } = await payFor("/article/D");
    expect((await request("/article/E", headers)).type).toBe("payment-error");
    expect((await request("/article/D", headers)).type).toBe("payment-verified");
  });

  it("refuses a Host header that would bind another route's proof, without consuming it", async () => {
    const { headers } = await payFor("/article/D");
    // Express would build http://x/article/D#/article/E for a request to /article/E.
    await expect(request("/article/E", { ...headers, host: "x/article/D#" })).rejects.toThrow(
      "invalid_exact_lnbtc_request_binding",
    );
    expect((await request("/article/D", headers)).type).toBe("payment-verified");
  });

  it("refuses an HTTP/2 :authority that would move the request target", async () => {
    const { headers } = await payFor("/article/D");
    // The URL becomes http://x/article/D?/article/E for a request routed to /article/E.
    await expect(
      request("/article/E", { ...headers, ":authority": "x/article/D?" }),
    ).rejects.toThrow("invalid_exact_lnbtc_request_binding");
    expect((await request("/article/D", headers)).type).toBe("payment-verified");
  });

  it("issues one invoice per accept and settles the one the client chose", async () => {
    const response = await challenge("/article/F");
    const client = clientFor(article("F"));
    const required = client.getPaymentRequiredResponse(
      name => response.headers[name],
      response.body,
    );
    expect(required.accepts.map(r => r.amount)).toEqual(["21000", "22000"]);
    const invoices = required.accepts.map(r => r.extra.invoice as string);
    expect(new Set(invoices).size).toBe(2);
    for (const [i, invoice] of invoices.entries()) {
      expect((await decodeWithLnd(payer, invoice)).numMsat).toBe(required.accepts[i].amount);
    }
    const payload = await client.createPaymentPayload(required);
    const paid = await request("/article/F", await client.encodePaymentSignatureHeader(payload));
    expect(paid.type).toBe("payment-verified");
  });

  it("settles a fractional-sat price as exact millisatoshis", async () => {
    const { payload, headers } = await payFor("/article/C");
    expect(payload.accepted.amount).toBe("21500");
    expect((await request("/article/C", headers)).type).toBe("payment-verified");
  });

  it("refuses to pay a challenge bound to a different request", async () => {
    await expect(payFor("/article/B", article("A"))).rejects.toThrow();
  });

  it("reports an unroutable payment as not paid and builds no proof", async () => {
    await expect(payFor("/expensive")).rejects.toThrow("exact_lnbtc_payment_not_paid");
  });
});
