import { beforeEach, describe, expect, it } from "vitest";
import { x402HTTPResourceServer, HTTPAdapter } from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { Network } from "../../../src/types";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSupportedResponse,
} from "../../mocks";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "../../../src/http";

/**
 * A HEAD response carries no content (RFC 9110 9.3.2), so settling a payment
 * on one charges for a result that cannot be delivered.
 *
 * HEAD reaches a paid route at all because route matching falls back to the
 * GET rule. That fallback is deliberate and closes a bypass where HEAD
 * reached paid GET handlers unpaid. These tests cover the other half: the
 * challenge must still be served over HEAD, so the price stays discoverable,
 * while a HEAD that carries a payment must be refused before settlement.
 *
 * The failure this guards against is invisible from both ends - the server
 * records a settlement and the client records an empty success - so it has
 * to be asserted rather than noticed.
 */
class MockHTTPAdapter implements HTTPAdapter {
  constructor(
    private readonly headers: Record<string, string> = {},
    private readonly method: string = "GET",
  ) {}

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  getMethod(): string {
    return this.method;
  }
  getPath(): string {
    return "/api/test";
  }
  getUrl(): string {
    return "https://example.com/api/test";
  }
  getAcceptHeader(): string {
    return "application/json";
  }
  getUserAgent(): string {
    return "Vitest";
  }
}

describe("a HEAD request cannot settle a payment", () => {
  const network = "eip155:8453" as Network;
  let facilitator: MockFacilitatorClient;
  let httpServer: x402HTTPResourceServer;

  beforeEach(async () => {
    facilitator = new MockFacilitatorClient(
      buildSupportedResponse({ kinds: [{ x402Version: 2, scheme: "exact", network }] }),
    );
    const resourceServer = new x402ResourceServer(facilitator);
    resourceServer.register(network, new MockSchemeNetworkServer("exact"));
    await resourceServer.initialize();

    // Configured for GET only. HEAD matches it through the GET fallback.
    httpServer = new x402HTTPResourceServer(resourceServer, {
      "GET /api/test": {
        accepts: { scheme: "exact", payTo: "0xabc", price: "$1.00", network },
      },
    });
  });

  const paidHead = () => {
    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const header = encodePaymentSignatureHeader(
      buildPaymentPayload({ x402Version: 2, accepted }),
    );
    return httpServer.processHTTPRequest({
      adapter: new MockHTTPAdapter({ "payment-signature": header }, "HEAD"),
      path: "/api/test",
      method: "HEAD",
      paymentHeader: header,
    });
  };

  it("still challenges an unpaid HEAD, so the bypass stays closed", async () => {
    const result = await httpServer.processHTTPRequest({
      adapter: new MockHTTPAdapter({}, "HEAD"),
      path: "/api/test",
      method: "HEAD",
    });

    expect(result.type).toBe("payment-error");
    if (result.type !== "payment-error") return;
    expect(result.response.status).toBe(402);
  });

  it("refuses a paid HEAD without settling", async () => {
    const result = await paidHead();

    expect(result.type).toBe("payment-error");
    if (result.type !== "payment-error") return;
    expect(result.response.status).toBe(402);
  });

  it("names the method to retry with, rather than failing opaquely", async () => {
    const result = await paidHead();
    if (result.type !== "payment-error") throw new Error("expected a payment error");

    const header = result.response.headers?.["PAYMENT-REQUIRED"];
    expect(header, "challenge must still be present so the price is readable").toBeTruthy();
    const challenge = decodePaymentRequiredHeader(header as string);
    expect(challenge.error).toMatch(/HEAD/i);
    expect(challenge.error).toMatch(/GET/);
  });

  it("does not call the facilitator at all for a paid HEAD", async () => {
    // The point of the fix: nothing is verified and nothing is settled, so
    // the buyer is never charged for a response that cannot carry a body.
    const before = {
      verify: facilitator.verifyCalls?.length ?? 0,
      settle: facilitator.settleCalls?.length ?? 0,
    };
    await paidHead();
    expect(facilitator.settleCalls?.length ?? 0).toBe(before.settle);
    expect(facilitator.verifyCalls?.length ?? 0).toBe(before.verify);
  });

  it("leaves a paid GET working, so the guard is not over-broad", async () => {
    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const header = encodePaymentSignatureHeader(
      buildPaymentPayload({ x402Version: 2, accepted }),
    );

    const result = await httpServer.processHTTPRequest({
      adapter: new MockHTTPAdapter({ "payment-signature": header }, "GET"),
      path: "/api/test",
      method: "GET",
      paymentHeader: header,
    });

    expect(result.type).not.toBe("payment-error");
  });
});
