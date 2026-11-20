import { beforeEach, describe, expect, it, vi } from "vitest";
import { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";
import type {
  HTTPAdapter,
  HTTPRequestContext,
  RouteConfig,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import type { VerifyResponse } from "../../../src/types";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "../../../src/http";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSettleResponse,
  buildSupportedResponse,
  buildVerifyResponse,
} from "../../mocks";

describe("HTTP payment failure response overrides", () => {
  const network = "eip155:8453" as const;
  let facilitator: MockFacilitatorClient;
  let server: x402ResourceServer;
  let route: RouteConfig;
  let context: HTTPRequestContext;
  const requirements = buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: "0xabc",
    asset: "USDC",
    amount: "1000000",
  });
  const payload = buildPaymentPayload({ accepted: requirements });

  beforeEach(async () => {
    facilitator = new MockFacilitatorClient(
      buildSupportedResponse({ kinds: [{ x402Version: 2, scheme: "exact", network }] }),
      buildVerifyResponse({ isValid: true }),
    );
    server = new x402ResourceServer(facilitator);
    server.register(network, new MockSchemeNetworkServer("exact"));
    await server.initialize();
    route = { accepts: { scheme: "exact", network, payTo: "0xabc", price: "$1.00" } };
    const paymentHeader = encodePaymentSignatureHeader(payload);
    const adapter: HTTPAdapter = {
      getHeader: name => (name.toLowerCase() === "payment-signature" ? paymentHeader : undefined),
      getMethod: () => "GET",
      getPath: () => "/buy",
      getUrl: () => "https://example.com/buy",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "Vitest",
    };
    context = { adapter, path: "/buy", method: "GET", paymentHeader };
  });

  const httpServer = () => new x402HTTPResourceServer(server, { "GET /buy": route });

  it.each([409, 503])("preserves a %i response after an afterVerify abort", async status => {
    server.onAfterVerify(async () => ({ abort: true, reason: "payment_in_progress" }));
    const override = vi.fn(async (_request: HTTPRequestContext, failure: VerifyResponse) => {
      expect(failure.invalidReason).toBe("payment_in_progress");
      return {
        status,
        headers: { "Retry-After": "2", "cache-control": "public" },
        body: { retry: "same_payment" },
      };
    });
    route.verificationFailedResponse = override;

    const result = await httpServer().processHTTPRequest(context);
    expect(result.type).toBe("payment-error");
    if (result.type !== "payment-error") throw new Error("expected refusal");
    expect(result.response.status).toBe(status);
    expect(result.response.body).toEqual({ retry: "same_payment" });
    const headers = new Headers(result.response.headers);
    expect(headers.get("retry-after")).toBe("2");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.has("payment-required")).toBe(false);
    expect(override).toHaveBeenCalledOnce();
    expect(override.mock.calls[0][0].routePattern).toBe("/buy");
  });

  it("keeps the existing 402 challenge when no override is provided", async () => {
    server.onAfterVerify(async () => ({ abort: true, reason: "blocked" }));
    const result = await httpServer().processHTTPRequest(context);
    expect(result.type).toBe("payment-error");
    if (result.type !== "payment-error") throw new Error("expected refusal");
    expect(result.response.status).toBe(402);
    expect(new Headers(result.response.headers).has("payment-required")).toBe(true);
  });

  it("falls back to 402 when the verification callback declines an override", async () => {
    server.onAfterVerify(async () => ({ abort: true, reason: "blocked" }));
    route.verificationFailedResponse = () => undefined;
    const result = await httpServer().processHTTPRequest(context);
    expect(result.type === "payment-error" && result.response.status).toBe(402);
  });

  it("does not call the failure callback for a verified payment", async () => {
    const override = vi.fn();
    route.verificationFailedResponse = override;
    expect((await httpServer().processHTTPRequest(context)).type).toBe("payment-verified");
    expect(override).not.toHaveBeenCalled();
  });

  it("preserves settlement metadata with a custom 503 response", async () => {
    facilitator.setSettleResponse(
      buildSettleResponse({
        success: false,
        errorReason: "payment_unresolved",
        transaction: "0xsubmitted",
        network,
      }),
    );
    route.settlementFailedResponse = (_request, failure) => ({
      status: 503,
      headers: { "Retry-After": "5", "payment-response": "not-a-receipt" },
      body: { error: failure.errorReason, transaction: failure.transaction },
    });
    const result = await httpServer().processSettlement(payload, requirements, undefined, {
      request: context,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected refusal");
    expect(result.response.status).toBe(503);
    expect(result.response.body).toEqual({
      error: "payment_unresolved",
      transaction: "0xsubmitted",
    });
    const headers = new Headers(result.response.headers);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("retry-after")).toBe("5");
    expect(decodePaymentResponseHeader(headers.get("payment-response")!).transaction).toBe(
      "0xsubmitted",
    );
  });

  it("preserves the legacy settlement body when the callback returns undefined", async () => {
    facilitator.setSettleResponse(
      buildSettleResponse({ success: false, errorReason: "failed", network }),
    );
    route.settlementFailedResponse = () => undefined;
    route.settlementFailedResponseBody = () => ({ contentType: "text/plain", body: "legacy" });
    const result = await httpServer().processSettlement(payload, requirements, undefined, {
      request: context,
    });
    if (result.success) throw new Error("expected refusal");
    expect(result.response.status).toBe(402);
    expect(result.response.body).toBe("legacy");
    expect(new Headers(result.response.headers).get("content-type")).toBe("text/plain");
  });

  it("does not call a route callback without HTTP request context", async () => {
    facilitator.setSettleResponse(
      buildSettleResponse({ success: false, errorReason: "failed", network }),
    );
    const override = vi.fn();
    route.settlementFailedResponse = override;
    const result = await httpServer().processSettlement(payload, requirements);
    expect(!result.success && result.response.status).toBe(402);
    expect(override).not.toHaveBeenCalled();
  });

  it("does not override a successful settlement", async () => {
    const override = vi.fn();
    route.settlementFailedResponse = override;
    expect(
      (await httpServer().processSettlement(payload, requirements, undefined, { request: context }))
        .success,
    ).toBe(true);
    expect(override).not.toHaveBeenCalled();
  });

  it("propagates verification callback errors instead of generating a fresh 402", async () => {
    server.onAfterVerify(async () => ({ abort: true, reason: "blocked" }));
    const cause = new Error("recovery storage unavailable");
    route.verificationFailedResponse = () => {
      throw cause;
    };
    await expect(httpServer().processHTTPRequest(context)).rejects.toMatchObject({ cause });
  });

  it("does not invoke a failing settlement callback twice", async () => {
    facilitator.setSettleResponse(
      buildSettleResponse({ success: false, errorReason: "failed", network }),
    );
    const cause = new Error("recovery storage unavailable");
    const override = vi.fn(async () => {
      throw cause;
    });
    route.settlementFailedResponse = override;
    await expect(
      httpServer().processSettlement(payload, requirements, undefined, { request: context }),
    ).rejects.toMatchObject({ cause });
    expect(override).toHaveBeenCalledOnce();
  });

  it.each([200, 302, 600, 409.5])(
    "rejects invalid failure status %i rather than reporting success",
    async status => {
      server.onAfterVerify(async () => ({ abort: true, reason: "blocked" }));
      route.verificationFailedResponse = () => ({ status, headers: {} });
      await expect(httpServer().processHTTPRequest(context)).rejects.toThrow("HTTP error status");
      facilitator.setSettleResponse(
        buildSettleResponse({ success: false, errorReason: "failed", network }),
      );
      route.settlementFailedResponse = () => ({ status, headers: {} });
      await expect(
        httpServer().processSettlement(payload, requirements, undefined, { request: context }),
      ).rejects.toThrow("HTTP error status");
    },
  );
});
