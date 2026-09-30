import { beforeEach, describe, expect, it } from "vitest";
import { x402HTTPResourceServer, HTTPAdapter } from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { FacilitatorResponseError, Network, SettleError } from "../../../src/types";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildPaymentPayload,
  buildPaymentRequirements,
  buildSettleResponse,
  buildSupportedResponse,
} from "../../mocks";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "../../../src/http";

class MockHTTPAdapter implements HTTPAdapter {
  constructor(private readonly headers: Record<string, string> = {}) {}

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  getMethod(): string {
    return "GET";
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

describe("x402HTTPResourceServer facilitator response errors", () => {
  let resourceServer: x402ResourceServer;
  let facilitator: MockFacilitatorClient;
  let httpServer: x402HTTPResourceServer;
  const network = "eip155:8453" as Network;

  beforeEach(async () => {
    facilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network }],
      }),
    );

    resourceServer = new x402ResourceServer(facilitator);
    resourceServer.register(network, new MockSchemeNetworkServer("exact"));
    await resourceServer.initialize();

    httpServer = new x402HTTPResourceServer(resourceServer, {
      "/api/test": {
        accepts: {
          scheme: "exact",
          payTo: "0xabc",
          price: "$1.00",
          network,
        },
      },
    });
  });

  it("rethrows FacilitatorResponseError during verification", async () => {
    facilitator.setVerifyResponse(
      new FacilitatorResponseError("Facilitator verify returned invalid JSON: not-json"),
    );

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const payload = buildPaymentPayload({
      x402Version: 2,
      accepted,
    });

    await expect(
      httpServer.processHTTPRequest({
        adapter: new MockHTTPAdapter({
          "payment-signature": encodePaymentSignatureHeader(payload),
        }),
        path: "/api/test",
        method: "GET",
        paymentHeader: encodePaymentSignatureHeader(payload),
      }),
    ).rejects.toThrow(FacilitatorResponseError);
  });

  it("rethrows FacilitatorResponseError during settlement", async () => {
    facilitator.setSettleResponse(
      new FacilitatorResponseError('Facilitator settle returned invalid data: {"success":true}'),
    );

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    await expect(
      httpServer.processSettlement(buildPaymentPayload({ x402Version: 2, accepted }), accepted),
    ).rejects.toThrow(FacilitatorResponseError);
  });

  it.each([
    { x402Version: 1 as const, accepted: undefined },
    { x402Version: 1 as const, accepted: null },
    { x402Version: 2 as const, accepted: undefined },
    { x402Version: 2 as const, accepted: null },
  ])(
    "returns a stable payment error when v$x402Version accepted is $accepted",
    async ({ x402Version, accepted }) => {
      const payload = Object.assign(buildPaymentPayload({ x402Version }), { accepted });
      const paymentHeader = encodePaymentSignatureHeader(payload);

      const result = await httpServer.processHTTPRequest({
        adapter: new MockHTTPAdapter({ "payment-signature": paymentHeader }),
        path: "/api/test",
        method: "GET",
        paymentHeader,
      });

      expect(result.type).toBe("payment-error");
      if (result.type !== "payment-error") {
        throw new Error("Expected payment-error");
      }

      const response = decodePaymentRequiredHeader(result.response.headers["PAYMENT-REQUIRED"]);
      expect(response.error).toBe("No matching payment requirements");
      expect(facilitator.verifyCalls).toHaveLength(0);
    },
  );

  it("keeps the transaction hash for a settlement_pending settle failure (direct response)", async () => {
    facilitator.setSettleResponse(
      buildSettleResponse({
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xpendingtx",
        network,
      }),
    );

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const result = await httpServer.processSettlement(
      buildPaymentPayload({ x402Version: 2, accepted }),
      accepted,
    );

    expect(result.success).toBe(false);
    expect(result.transaction).toBe("0xpendingtx");
    const decoded = decodePaymentResponseHeader(result.headers["PAYMENT-RESPONSE"]);
    expect(decoded.transaction).toBe("0xpendingtx");
  });

  it("keeps the transaction hash for a settlement_pending settle failure (thrown SettleError)", async () => {
    facilitator.setSettleResponse(
      new SettleError(402, {
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xpendingtx",
        network,
      }),
    );

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const result = await httpServer.processSettlement(
      buildPaymentPayload({ x402Version: 2, accepted }),
      accepted,
    );

    expect(result.success).toBe(false);
    expect(result.transaction).toBe("0xpendingtx");
    const decoded = decodePaymentResponseHeader(result.headers["PAYMENT-RESPONSE"]);
    expect(decoded.transaction).toBe("0xpendingtx");
  });

  it("returns payment-error when client extension echo mismatches before facilitator verify", async () => {
    const httpServerWithExtensions = new x402HTTPResourceServer(resourceServer, {
      "/api/test": {
        accepts: {
          scheme: "exact",
          payTo: "0xabc",
          price: "$1.00",
          network,
        },
        extensions: {
          bazaar: { info: { tool: "search" } },
        },
      },
    });

    const accepted = buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: "0xabc",
      asset: "USDC",
      amount: "1000000",
    });
    const payload = buildPaymentPayload({
      x402Version: 2,
      accepted,
      extensions: {
        bazaar: { info: { tool: "modified" } },
      },
    });

    const result = await httpServerWithExtensions.processHTTPRequest({
      adapter: new MockHTTPAdapter({
        "payment-signature": encodePaymentSignatureHeader(payload),
      }),
      path: "/api/test",
      method: "GET",
      paymentHeader: encodePaymentSignatureHeader(payload),
    });

    expect(result.type).toBe("payment-error");
    expect(facilitator.verifyCalls).toHaveLength(0);
  });
});
