import { describe, it, expect, beforeEach } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPRequestContext,
  HTTPAdapter,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "../../mocks";
import { Network, Price } from "../../../src/types";

// Mock HTTP Adapter
/**
 *
 */
class MockHTTPAdapter implements HTTPAdapter {
  private headers: Record<string, string> = {};

  /**
   *
   * @param headers
   */
  constructor(headers: Record<string, string> = {}) {
    this.headers = headers;
  }

  /**
   *
   * @param name
   */
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  /**
   *
   */
  getMethod(): string {
    return "GET";
  }

  /**
   *
   */
  getPath(): string {
    return "/api/test";
  }

  /**
   *
   */
  getUrl(): string {
    return "https://example.com/api/test";
  }

  /**
   *
   */
  getAcceptHeader(): string {
    return "application/json";
  }

  /**
   *
   */
  getUserAgent(): string {
    return "TestClient/1.0";
  }

  /**
   *
   * @param name
   * @param value
   */
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
}

describe("x402HTTPResourceServer", () => {
  let ResourceServer: x402ResourceServer;
  let mockFacilitator: MockFacilitatorClient;
  let mockScheme: MockSchemeNetworkServer;

  beforeEach(async () => {
    mockFacilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
      }),
      buildVerifyResponse({ isValid: true }),
    );

    ResourceServer = new x402ResourceServer(mockFacilitator);

    mockScheme = new MockSchemeNetworkServer("exact", {
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: {},
    });

    ResourceServer.register("eip155:8453" as Network, mockScheme);
    await ResourceServer.initialize();
  });

  describe("Construction", () => {
    it("should accept ResourceServer and routes via composition", () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      expect(httpServer).toBeDefined();
    });

    it("should compile single route config", () => {
      const singleRoute = {
        accepts: {
          scheme: "exact",
          payTo: "0xabc",
          price: 1.0 as Price,
          network: "eip155:8453" as Network,
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, singleRoute);

      expect(httpServer).toBeDefined();
    });

    it("should compile multiple route configs", () => {
      const routes = {
        "GET /api/route1": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: 1.0 as Price,
            network: "eip155:8453" as Network,
          },
        },
        "POST /api/route2": {
          accepts: {
            scheme: "exact",
            payTo: "0xdef",
            price: 2.0 as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      expect(httpServer).toBeDefined();
    });
  });

  describe("Dynamic pricing", () => {
    it("should resolve dynamic price function", async () => {
      let contextReceived: HTTPRequestContext | null = null;

      const routes = {
        "/api/dynamic": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: async (context: HTTPRequestContext) => {
              contextReceived = context;
              return "$5.00" as Price;
            },
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/dynamic",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(contextReceived).toBeDefined();
      expect((contextReceived as HTTPRequestContext | null)?.path).toBe("/api/dynamic");
      expect(result.type).toBe("payment-error"); // No payment provided
    });

    it("should use static price if not a function", async () => {
      const routes = {
        "/api/static": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/static",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error");
    });

    it("should have access to request headers in dynamic price", async () => {
      let headerValue: string | undefined;

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: async (context: HTTPRequestContext) => {
              headerValue = context.adapter.getHeader("x-api-key");
              return "$1.00" as Price;
            },
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter({ "x-api-key": "secret123" });
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "GET",
      };

      await httpServer.processHTTPRequest(context);

      expect(headerValue).toBe("secret123");
    });
  });

  describe("Dynamic payTo", () => {
    it("should resolve dynamic payTo function", async () => {
      let contextReceived: HTTPRequestContext | null = null;

      const routes = {
        "/api/dynamic": {
          accepts: {
            scheme: "exact",
            payTo: async (context: HTTPRequestContext) => {
              contextReceived = context;
              return "0xdynamic";
            },
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/dynamic",
        method: "GET",
      };

      await httpServer.processHTTPRequest(context);

      expect(contextReceived).toBeDefined();
      expect((contextReceived as HTTPRequestContext | null)?.path).toBe("/api/dynamic");
    });

    it("should use static payTo if not a function", async () => {
      const routes = {
        "/api/static": {
          accepts: {
            scheme: "exact",
            payTo: "0xstatic",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/static",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error");
    });
  });

  describe("Route matching", () => {
    it("should match exact path", async () => {
      const routes = {
        "/api/exact": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/exact",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error"); // Route matched, no payment
    });

    it("should match wildcard paths", async () => {
      const routes = {
        "/api/*": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/anything",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error"); // Route matched
    });

    it("should match Express-style :param dynamic routes", async () => {
      const routes = {
        "/api/chapters/:seriesId/:chapterId": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/chapters/abc123/chapter-7",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error"); // Route matched
    });

    it("should match Express-style :param with HTTP method prefix", async () => {
      const routes = {
        "GET /api/users/:id": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/users/42",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error"); // Route matched
    });

    it("should not match :param against paths with extra segments", async () => {
      const routes = {
        "/api/users/:id": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/users/42/posts",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("no-payment-required");
    });

    it("should return no-payment-required for unmatched routes", async () => {
      const routes = {
        "/api/protected": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/public", // Different path
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("no-payment-required");
    });

    it("should match HTTP methods", async () => {
      const routes = {
        "POST /api/create": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      adapter.getMethod = () => "POST";

      const context: HTTPRequestContext = {
        adapter,
        path: "/api/create",
        method: "POST",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error"); // Route matched
    });

    it("should not match wrong HTTP method", async () => {
      const routes = {
        "POST /api/create": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/create",
        method: "GET", // Wrong method
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("no-payment-required");
    });

    describe("malformed percent-encoding", () => {
      it("should require payment for path with trailing malformed %", async () => {
        const routes = {
          "/paywall/[param]": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/paywall/test%",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);
        expect(result.type).toBe("payment-error");
      });

      it("should require payment for path with malformed %c0 sequence", async () => {
        const routes = {
          "/api/*": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/resource%c0",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);
        expect(result.type).toBe("payment-error");
      });

      it("should require payment for path with multiple malformed sequences", async () => {
        const routes = {
          "/protected/*": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/protected/data%c0%c1%",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);
        expect(result.type).toBe("payment-error");
      });

      it("should correctly identify requiresPayment for malformed paths", async () => {
        const routes = {
          "/paywall/[id]": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/paywall/test%",
          method: "GET",
        };

        expect(httpServer.requiresPayment(context)).toBe(true);
      });
    });
  });

  describe("Payment processing", () => {
    it("should return payment-error if no payment provided", async () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        expect(result.response.status).toBe(402);
        expect(result.response.headers["PAYMENT-REQUIRED"]).toBeDefined();
      }
    });

    it("should return 412 Precondition Failed for permit2_allowance_required error", async () => {
      // Override mock to simulate permit2 allowance required error
      mockFacilitator.setVerifyResponse({
        isValid: false,
        invalidReason: "permit2_allowance_required",
      });

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Build requirements that match the route exactly (including amount/asset from mock scheme)
      const matchingRequirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        payTo: "0xabc",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        maxTimeoutSeconds: 300,
        extra: {},
      });

      // Create payment payload with matching requirements
      const payload = buildPaymentPayload({
        accepted: matchingRequirements,
      });

      // Use proper encoding for payment header
      const { encodePaymentSignatureHeader } = await import("../../../src/http");
      const paymentHeader = encodePaymentSignatureHeader(payload);

      const adapter = new MockHTTPAdapter({
        "payment-signature": paymentHeader,
      });

      const context: HTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      // Verify that the mock was called
      expect(mockFacilitator.verifyCalls.length).toBe(1);

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        // Should return 412 for permit2_allowance_required
        expect(result.response.status).toBe(412);
        expect(result.response.headers["PAYMENT-REQUIRED"]).toBeDefined();
      }
    });

    it("threads the failed payment payload into 402 response enrichment", async () => {
      mockFacilitator.setVerifyResponse(
        buildVerifyResponse({ isValid: false, invalidReason: "stale_state" }),
      );
      const scheme = mockScheme as MockSchemeNetworkServer & {
        enrichPaymentRequiredResponse: NonNullable<
          import("../../../src/types").SchemeNetworkServer["enrichPaymentRequiredResponse"]
        >;
      };
      let sawFailedPayload = false;
      scheme.enrichPaymentRequiredResponse = async ctx => {
        if (ctx.error !== "stale_state") {
          return;
        }
        sawFailedPayload = ctx.paymentPayload?.payload.signature === "test_signature";
        ctx.requirements[0].extra.ChannelState = { channelId: "0x123" };
      };

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };
      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);
      const matchingRequirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        payTo: "0xabc",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        maxTimeoutSeconds: 300,
        extra: {},
      });
      const payload = buildPaymentPayload({ accepted: matchingRequirements });
      const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import(
        "../../../src/http"
      );
      const adapter = new MockHTTPAdapter({
        "payment-signature": encodePaymentSignatureHeader(payload),
      });

      const result = await httpServer.processHTTPRequest({
        adapter,
        path: "/api/test",
        method: "GET",
      });

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );
        expect(sawFailedPayload).toBe(true);
        expect(paymentRequired.accepts[0].extra.ChannelState).toEqual({ channelId: "0x123" });
      }
    });

    it("should delegate verification to resource service", async () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Create valid payment header
      const adapter = new MockHTTPAdapter({
        "payment-signature": "valid_payment_signature",
      });

      const context: HTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "GET",
      };

      // This would normally fail because we don't have a real payment,
      // but it shows delegation happens
      await httpServer.processHTTPRequest(context);

      // Verification was attempted (may fail on decoding, but that's ok for this test)
    });
  });

  describe("Settlement processing", () => {
    it("should return success with headers on successful settlement", async () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await httpServer.processSettlement(payload, requirements);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
      expect(mockFacilitator.settleCalls.length).toBe(1);
    });

    it("should return failure when settlement fails", async () => {
      // Override mock to simulate failure
      mockFacilitator.settle = async () => ({
        success: false,
        errorReason: "Insufficient funds",
        transaction: "",
        network: "eip155:8453" as Network,
      });

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      const result = await httpServer.processSettlement(payload, requirements);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorReason).toBe("Insufficient funds");
        expect(result.headers).toBeDefined();
        expect(result.headers["PAYMENT-RESPONSE"]).toBeDefined();
      }
    });

    it("should forward explicit settlementOverrides to settlePayment", async () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      const result = await httpServer.processSettlement(
        payload,
        requirements,
        undefined,
        undefined,
        { amount: "500000" },
      );

      expect(result.success).toBe(true);
      // Verify the facilitator received the overridden amount
      expect(mockFacilitator.settleCalls[0].requirements.amount).toBe("500000");
    });

    it("should extract overrides from responseHeaders in transport context", async () => {
      const { SETTLEMENT_OVERRIDES_HEADER } = await import(
        "../../../src/http/x402HTTPResourceServer"
      );

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      const result = await httpServer.processSettlement(payload, requirements, undefined, {
        request: {
          adapter: new MockHTTPAdapter(),
          path: "/api/test",
          method: "GET",
        },
        responseHeaders: {
          [SETTLEMENT_OVERRIDES_HEADER]: JSON.stringify({ amount: "300000" }),
        },
      });

      expect(result.success).toBe(true);
      expect(mockFacilitator.settleCalls[0].requirements.amount).toBe("300000");
    });

    it("should ignore malformed overrides header gracefully", async () => {
      const { SETTLEMENT_OVERRIDES_HEADER } = await import(
        "../../../src/http/x402HTTPResourceServer"
      );

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      const result = await httpServer.processSettlement(payload, requirements, undefined, {
        request: {
          adapter: new MockHTTPAdapter(),
          path: "/api/test",
          method: "GET",
        },
        responseHeaders: {
          [SETTLEMENT_OVERRIDES_HEADER]: "not-valid-json{{{",
        },
      });

      // Should succeed with original amount (malformed header is ignored)
      expect(result.success).toBe(true);
      expect(mockFacilitator.settleCalls[0].requirements.amount).toBe("1000000");
    });

    it("should prefer explicit overrides over header overrides", async () => {
      const { SETTLEMENT_OVERRIDES_HEADER } = await import(
        "../../../src/http/x402HTTPResourceServer"
      );

      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const payload = buildPaymentPayload();
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        amount: "1000000",
      });

      const result = await httpServer.processSettlement(
        payload,
        requirements,
        undefined,
        {
          request: {
            adapter: new MockHTTPAdapter(),
            path: "/api/test",
            method: "GET",
          },
          responseHeaders: {
            [SETTLEMENT_OVERRIDES_HEADER]: JSON.stringify({ amount: "999999" }),
          },
        },
        { amount: "100000" }, // explicit takes precedence
      );

      expect(result.success).toBe(true);
      expect(mockFacilitator.settleCalls[0].requirements.amount).toBe("100000");
    });
  });

  describe("Browser detection", () => {
    it("should detect web browser from accept header and user agent", async () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      adapter.getAcceptHeader = () => "text/html,application/xhtml+xml";
      adapter.getUserAgent = () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

      const context: HTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      // Should return HTML paywall for browsers
      if (result.type === "payment-error") {
        expect(result.response.isHtml).toBe(true);
      }
    });

    it("should bypass the resource handler when an AfterVerifyHook returns skipHandler", async () => {
      mockFacilitator.setVerifyResponse({
        isValid: true,
        payer: "0xpayer",
      });

      ResourceServer.onAfterVerify(async () => ({
        skipHandler: true,
        response: {
          contentType: "application/json",
          body: { message: "Refund acknowledged" },
        },
      }));

      const routes = {
        "/api/refund": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const matchingRequirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        payTo: "0xabc",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        maxTimeoutSeconds: 300,
        extra: {},
      });
      const payload = buildPaymentPayload({ accepted: matchingRequirements });
      const { encodePaymentSignatureHeader } = await import("../../../src/http");
      const paymentHeader = encodePaymentSignatureHeader(payload);

      const adapter = new MockHTTPAdapter({ "payment-signature": paymentHeader });
      const context: HTTPRequestContext = {
        adapter,
        path: "/api/refund",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      expect(mockFacilitator.verifyCalls.length).toBe(1);
      expect(mockFacilitator.settleCalls.length).toBe(1);

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        expect(result.response.status).toBe(200);
        expect(result.response.headers["PAYMENT-RESPONSE"]).toBeDefined();
        expect(result.response.body).toEqual({ message: "Refund acknowledged" });
      }
    });

    it("should not treat API clients as browsers", async () => {
      const routes = {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          },
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter();
      adapter.getAcceptHeader = () => "application/json";
      adapter.getUserAgent = () => "TestClient/1.0";

      const context: HTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      // Should return JSON response for API clients
      if (result.type === "payment-error") {
        expect(result.response.isHtml).toBeFalsy();
      }
    });
  });
});
