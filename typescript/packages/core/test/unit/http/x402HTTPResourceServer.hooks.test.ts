import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPRequestContext,
  HTTPAdapter,
  RouteConfig,
  ProtectedRequestHook,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer, type VerifyContext } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
  buildSettleResponse,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "../../mocks";
import {
  Network,
  Price,
  ResourceServerExtension,
  SettleResultContext,
  PaymentRequiredContext,
} from "../../../src/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "../../../src/http";

// Mock HTTP Adapter
class MockHTTPAdapter implements HTTPAdapter {
  private headers: Record<string, string> = {};

  constructor(headers: Record<string, string> = {}) {
    this.headers = headers;
  }

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
    return "TestClient/1.0";
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
}

describe("x402HTTPResourceServer Hooks", () => {
  describe("Extension Hooks", () => {
    let extensionResourceServer: x402ResourceServer;
    let extensionMockFacilitator: MockFacilitatorClient;
    let extensionMockScheme: MockSchemeNetworkServer;

    beforeEach(async () => {
      // Create a fresh ResourceServer for extension tests to avoid interference
      extensionMockFacilitator = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        buildVerifyResponse({ isValid: true }),
      );

      extensionResourceServer = new x402ResourceServer(extensionMockFacilitator);

      extensionMockScheme = new MockSchemeNetworkServer("exact", {
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {},
      });

      extensionResourceServer.register("eip155:8453" as Network, extensionMockScheme);
      await extensionResourceServer.initialize();
    });

    describe("enrichSettlementResponse", () => {
      it("should enrich settlement response with extensions", async () => {
        const receiptExtension: ResourceServerExtension = {
          key: "receipt",
          enrichSettlementResponse: async (
            _declaration: unknown,
            _context: SettleResultContext,
          ) => {
            // Return just the extension data for this key, not the entire result
            return {
              receipt: "Receipt",
            };
          },
        };

        extensionResourceServer.registerExtension(receiptExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              receipt: {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        });

        // Set up mock to return a successful settlement
        extensionMockFacilitator.setSettleResponse(
          buildSettleResponse({
            success: true,
            transaction: "0x40d32f49a3fa2356275083e348d53fca876df3a140d72a71cf26c9cbaab359d9",
            network: "eip155:8453" as Network,
            payer: "0xE33A295AF5C90A0649DFBECfDf9D604789B892e2",
          }),
        );

        const result = await httpServer.processSettlement(
          payload,
          requirements,
          routes["/api/test"].extensions,
        );

        expect(result.success).toBe(true);
        if (result.success) {
          // Check that extensions were added
          expect((result as any).extensions).toBeDefined();
          expect((result as any).extensions.receipt).toBeDefined();
          expect((result as any).extensions.receipt.receipt).toBe("Receipt");
          expect(result.transaction).toBe(
            "0x40d32f49a3fa2356275083e348d53fca876df3a140d72a71cf26c9cbaab359d9",
          );
          expect(result.network).toBe("eip155:8453");
          expect(result.payer).toBe("0xE33A295AF5C90A0649DFBECfDf9D604789B892e2");
        }
      });

      it("should handle multiple extensions enriching settlement response", async () => {
        const receiptExtension: ResourceServerExtension = {
          key: "receipt",
          enrichSettlementResponse: async (_declaration: unknown, context: SettleResultContext) => {
            return {
              ...context.result,
              extensions: {
                ...(context.result.extensions || {}),
                receipt: { receipt: "Receipt" },
              },
            };
          },
        };

        const attestationExtension: ResourceServerExtension = {
          key: "attestation",
          enrichSettlementResponse: async (_declaration: unknown, context: SettleResultContext) => {
            return {
              ...context.result,
              extensions: {
                ...(context.result.extensions || {}),
                attestation: { attestationId: "attest-123" },
              },
            };
          },
        };

        extensionResourceServer.registerExtension(receiptExtension);
        extensionResourceServer.registerExtension(attestationExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              receipt: {},
              attestation: {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        });

        extensionMockFacilitator.setSettleResponse(buildSettleResponse({ success: true }));

        const result = await httpServer.processSettlement(
          payload,
          requirements,
          routes["/api/test"].extensions,
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect((result as any).extensions).toBeDefined();
          expect((result as any).extensions.receipt).toBeDefined();
          expect((result as any).extensions.attestation).toBeDefined();
        }
      });

      it("should continue processing if extension hook throws error", async () => {
        const errorExtension: ResourceServerExtension = {
          key: "error-extension",
          enrichSettlementResponse: async (
            _declaration: unknown,
            _context: SettleResultContext,
          ) => {
            throw new Error("Extension error");
          },
        };

        extensionResourceServer.registerExtension(errorExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              "error-extension": {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        });

        extensionMockFacilitator.setSettleResponse(buildSettleResponse({ success: true }));

        // Should not throw, should continue with unenriched response
        const result = await httpServer.processSettlement(
          payload,
          requirements,
          routes["/api/test"].extensions,
        );

        expect(result.success).toBe(true);
      });

      it("should pass transportContext to enrichSettlementResponse hook", async () => {
        let receivedContext: SettleResultContext | undefined;

        const transportAwareExtension: ResourceServerExtension = {
          key: "transport-aware",
          enrichSettlementResponse: async (_declaration: unknown, context: SettleResultContext) => {
            receivedContext = context;
            return { transportAware: true };
          },
        };

        extensionResourceServer.registerExtension(transportAwareExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              "transport-aware": { config: "value" },
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        });

        extensionMockFacilitator.setSettleResponse(buildSettleResponse({ success: true }));

        const transportContext = {
          request: { path: "/api/test", method: "POST" },
          responseBody: Buffer.from("test response body"),
        };

        const result = await httpServer.processSettlement(
          payload,
          requirements,
          routes["/api/test"].extensions,
          transportContext,
        );

        expect(result.success).toBe(true);
        expect(receivedContext).toBeDefined();
        expect(receivedContext?.transportContext).toBeDefined();
        expect(receivedContext?.transportContext).toEqual(transportContext);
      });

      it("should merge nested scheme settlement response enrichment", async () => {
        const schemeWithEnrichment = extensionMockScheme as MockSchemeNetworkServer & {
          enrichSettlementResponse: () => Promise<Record<string, unknown>>;
        };
        schemeWithEnrichment.enrichSettlementResponse = async () => ({
          chargedAmount: "1000",
          channelState: {
            chargedCumulativeAmount: "1000",
          },
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
        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);
        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        });

        extensionMockFacilitator.setSettleResponse(
          buildSettleResponse({
            success: true,
            network: "eip155:8453" as Network,
            extra: {
              channelState: {
                channelId: "0xchannel",
                balance: "10000",
              },
            },
          }),
        );

        const result = await httpServer.processSettlement(payload, requirements);

        expect(result.success).toBe(true);
        expect(result.extra).toEqual({
          chargedAmount: "1000",
          channelState: {
            channelId: "0xchannel",
            balance: "10000",
            chargedCumulativeAmount: "1000",
          },
        });
      });

      it("should have undefined transportContext when not provided", async () => {
        let receivedContext: SettleResultContext | undefined;

        const extension: ResourceServerExtension = {
          key: "context-checker",
          enrichSettlementResponse: async (_declaration: unknown, context: SettleResultContext) => {
            receivedContext = context;
            return { checked: true };
          },
        };

        extensionResourceServer.registerExtension(extension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              "context-checker": {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const payload = buildPaymentPayload();
        const requirements = buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        });

        extensionMockFacilitator.setSettleResponse(buildSettleResponse({ success: true }));

        // Call without transportContext
        const result = await httpServer.processSettlement(
          payload,
          requirements,
          routes["/api/test"].extensions,
        );

        expect(result.success).toBe(true);
        expect(receivedContext).toBeDefined();
        expect(receivedContext?.transportContext).toBeUndefined();
      });
    });

    describe("enrichPaymentRequiredResponse", () => {
      it("should enrich PaymentRequired response before sending 402", async () => {
        const paymentRequiredExtension: ResourceServerExtension = {
          key: "payment-required-enricher",
          enrichPaymentRequiredResponse: async (
            _declaration: unknown,
            _context: PaymentRequiredContext,
          ) => {
            // Return just the extension data for this key, not the entire response
            return {
              metadata: "test-metadata",
            };
          },
        };

        extensionResourceServer.registerExtension(paymentRequiredExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              existing: "existing-value",
              "payment-required-enricher": {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/test",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(result.type).toBe("payment-error");
        if (result.type === "payment-error") {
          const paymentRequiredHeader = result.response.headers["PAYMENT-REQUIRED"];
          const decoded = decodePaymentRequiredHeader(paymentRequiredHeader);
          expect(decoded.extensions).toBeDefined();
          if (decoded.extensions) {
            expect(decoded.extensions["payment-required-enricher"]).toBeDefined();
            expect((decoded.extensions["payment-required-enricher"] as any).metadata).toBe(
              "test-metadata",
            );
          }
        }
      });

      it("should pass transportContext to enrichPaymentRequiredResponse hook", async () => {
        let receivedContext: PaymentRequiredContext | undefined;

        const transportAwareExtension: ResourceServerExtension = {
          key: "transport-aware-402",
          enrichPaymentRequiredResponse: async (
            _declaration: unknown,
            context: PaymentRequiredContext,
          ) => {
            receivedContext = context;
            return { transportAware: true };
          },
        };

        extensionResourceServer.registerExtension(transportAwareExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              "transport-aware-402": { config: "value" },
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/test",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(result.type).toBe("payment-error");
        expect(receivedContext).toBeDefined();
        expect(receivedContext?.transportContext).toBeDefined();
        // The transport context should contain the request
        const transportCtx = receivedContext?.transportContext as { request: HTTPRequestContext };
        expect(transportCtx.request).toBeDefined();
        expect(transportCtx.request.path).toBe("/api/test");
        expect(transportCtx.request.method).toBe("GET");
      });

      it("should pass transportContext in all PaymentRequired error scenarios", async () => {
        let receivedContexts: PaymentRequiredContext[] = [];

        const contextCapturingExtension: ResourceServerExtension = {
          key: "context-capturer",
          enrichPaymentRequiredResponse: async (
            _declaration: unknown,
            context: PaymentRequiredContext,
          ) => {
            receivedContexts.push(context);
            return { captured: true };
          },
        };

        extensionResourceServer.registerExtension(contextCapturingExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              "context-capturer": {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        // Test 1: No payment provided (main call)
        const adapter1 = new MockHTTPAdapter();
        const context1: HTTPRequestContext = {
          adapter: adapter1,
          path: "/api/test",
          method: "GET",
        };

        await httpServer.processHTTPRequest(context1);
        expect(receivedContexts.length).toBe(1);
        expect(receivedContexts[0].transportContext).toBeDefined();

        // Test 2: Invalid payment (verification failure)
        // The hook is called twice: once to build the base paymentRequired object,
        // and once when verification fails to generate the error response
        receivedContexts = [];
        extensionMockFacilitator.setVerifyResponse(
          buildVerifyResponse({ isValid: false, invalidReason: "invalid_signature" }),
        );

        const paymentRequired = await extensionResourceServer.createPaymentRequiredResponse(
          await extensionResourceServer.buildPaymentRequirements({
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          }),
          { url: "/api/test", description: "", mimeType: "" },
        );

        const payload = buildPaymentPayload({
          accepted: paymentRequired.accepts[0],
          resource: paymentRequired.resource,
        });
        const paymentHeader = encodePaymentSignatureHeader(payload);

        const adapter2 = new MockHTTPAdapter({
          "payment-signature": paymentHeader,
        });

        const context2: HTTPRequestContext = {
          adapter: adapter2,
          path: "/api/test",
          method: "GET",
        };

        await httpServer.processHTTPRequest(context2);
        // Called twice: once for base paymentRequired, once for error response
        expect(receivedContexts.length).toBe(2);
        // Both should have transportContext
        expect(receivedContexts[0].transportContext).toBeDefined();
        expect(receivedContexts[1].transportContext).toBeDefined();
      });
    });

    describe("verifyPayment declaredExtensions from HTTP", () => {
      it("passes route extensions map to manual onBeforeVerify", async () => {
        extensionMockFacilitator.setVerifyResponse(buildVerifyResponse({ isValid: true }));

        let verifyCtx: VerifyContext | undefined;
        extensionResourceServer.onBeforeVerify(async ctx => {
          verifyCtx = ctx;
        });

        const routes: Record<string, RouteConfig> = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              bazaar: { tool: "x" },
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        const paymentRequired = await extensionResourceServer.createPaymentRequiredResponse(
          await extensionResourceServer.buildPaymentRequirements({
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00" as Price,
            network: "eip155:8453" as Network,
          }),
          { url: "/api/test", description: "", mimeType: "" },
          undefined,
          routes["/api/test"].extensions,
        );

        const payload = buildPaymentPayload({
          accepted: paymentRequired.accepts[0],
          resource: paymentRequired.resource,
        });
        const paymentHeader = encodePaymentSignatureHeader(payload);
        const adapter = new MockHTTPAdapter({ "payment-signature": paymentHeader });
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/test",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);
        expect(result.type).toBe("payment-verified");
        expect(verifyCtx).toBeDefined();
        expect(verifyCtx!.declaredExtensions).toEqual({ bazaar: { tool: "x" } });
        expect(verifyCtx!.transportContext).toBeDefined();
      });
    });

    describe("Integration: All hooks together", () => {
      it("should apply all extension hooks in sequence", async () => {
        const allHooksExtension: ResourceServerExtension = {
          key: "all-hooks",
          enrichPaymentRequiredResponse: async (
            _declaration: unknown,
            _context: PaymentRequiredContext,
          ) => {
            // Return just the extension data for this key
            return {
              paymentRequiredEnriched: true,
            };
          },
          enrichSettlementResponse: async (
            _declaration: unknown,
            _context: SettleResultContext,
          ) => {
            // Return just the extension data for this key
            return {
              receipt: {
                receipt: "Receipt",
              },
            };
          },
        };

        extensionResourceServer.registerExtension(allHooksExtension);

        const routes = {
          "/api/test": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00" as Price,
              network: "eip155:8453" as Network,
            },
            extensions: {
              "all-hooks": {},
            },
          },
        };

        const httpServer = new x402HTTPResourceServer(extensionResourceServer, routes);

        // Test payment requirements enrichment
        const adapter1 = new MockHTTPAdapter();
        const context1: HTTPRequestContext = {
          adapter: adapter1,
          path: "/api/test",
          method: "GET",
        };

        const result1 = await httpServer.processHTTPRequest(context1);
        expect(result1.type).toBe("payment-error");
        if (result1.type !== "payment-error") {
          throw new Error("Expected payment-error");
        }

        const paymentRequiredHeader = result1.response.headers["PAYMENT-REQUIRED"];
        const decoded = decodePaymentRequiredHeader(paymentRequiredHeader);
        expect(decoded.extensions).toBeDefined();
        if (decoded.extensions) {
          expect((decoded.extensions["all-hooks"] as any).paymentRequiredEnriched).toBe(true);
        }

        // Test verification and settlement enrichment
        // Get requirements from the PaymentRequired response
        const paymentRequired = decoded;

        const payload = buildPaymentPayload({
          accepted: paymentRequired.accepts[0],
          resource: paymentRequired.resource,
        });
        const paymentHeader = encodePaymentSignatureHeader(payload);

        const adapter2 = new MockHTTPAdapter({
          "payment-signature": paymentHeader,
        });

        const context2: HTTPRequestContext = {
          adapter: adapter2,
          path: "/api/test",
          method: "GET",
        };

        extensionMockFacilitator.setVerifyResponse(buildVerifyResponse({ isValid: true }));
        extensionMockFacilitator.setSettleResponse(
          buildSettleResponse({
            success: true,
            transaction: "0x40d32f49a3fa2356275083e348d53fca876df3a140d72a71cf26c9cbaab359d9",
            network: "eip155:8453" as Network,
            payer: "0xE33A295AF5C90A0649DFBECfDf9D604789B892e2",
          }),
        );

        const result2 = await httpServer.processHTTPRequest(context2);
        expect(result2.type).toBe("payment-verified");

        if (result2.type === "payment-verified") {
          const settleResult = await httpServer.processSettlement(
            result2.paymentPayload,
            result2.paymentRequirements,
            routes["/api/test"].extensions,
          );

          expect(settleResult.success).toBe(true);
          if (settleResult.success) {
            expect((settleResult as any).extensions).toBeDefined();
            expect((settleResult as any).extensions["all-hooks"]).toBeDefined();
            expect((settleResult as any).extensions["all-hooks"].receipt).toBeDefined();
            expect((settleResult as any).extensions["all-hooks"].receipt.receipt).toBe("Receipt");
          }
        }
      });
    });
  });

  describe("ProtectedRequestHook", () => {
    let ResourceServer: x402ResourceServer;
    let mockFacilitator: MockFacilitatorClient;
    let mockScheme: MockSchemeNetworkServer;

    const testNetwork = "eip155:8453" as Network;
    const testRoutes = {
      "/api/protected": {
        accepts: {
          scheme: "exact",
          payTo: "0xabc",
          price: "$1.00" as Price,
          network: testNetwork,
        },
      },
    };

    beforeEach(async () => {
      mockFacilitator = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: testNetwork }],
        }),
        buildVerifyResponse({ isValid: true }),
      );

      ResourceServer = new x402ResourceServer(mockFacilitator);

      mockScheme = new MockSchemeNetworkServer("exact", {
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {},
      });

      ResourceServer.register(testNetwork, mockScheme);
      await ResourceServer.initialize();
    });

    describe("hook registration", () => {
      it("should return this for chaining", () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook: ProtectedRequestHook = async () => {};

        const result = httpServer.onProtectedRequest(hook);

        expect(result).toBe(httpServer);
      });
    });

    describe("hook returning void", () => {
      it("should continue to payment processing when hook returns void", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook = vi.fn().mockResolvedValue(undefined);

        httpServer.onProtectedRequest(hook);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook).toHaveBeenCalled();
        expect(result.type).toBe("payment-error"); // No payment provided
        if (result.type === "payment-error") {
          expect(result.response.status).toBe(402);
        }
      });
    });

    describe("hook returning grantAccess", () => {
      it("should grant access without payment when hook returns grantAccess", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook = vi.fn().mockResolvedValue({ grantAccess: true });

        httpServer.onProtectedRequest(hook);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook).toHaveBeenCalled();
        expect(result.type).toBe("no-payment-required");
      });
    });

    describe("hook returning abort", () => {
      it("should return 403 when hook returns abort", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook = vi.fn().mockResolvedValue({ abort: true, reason: "Access denied" });

        httpServer.onProtectedRequest(hook);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook).toHaveBeenCalled();
        expect(result.type).toBe("payment-error");
        if (result.type === "payment-error") {
          expect(result.response.status).toBe(403);
          expect(result.response.body).toEqual({ error: "Access denied" });
        }
      });
    });

    describe("multiple hooks", () => {
      it("should stop at first hook returning grantAccess", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook1 = vi.fn().mockResolvedValue({ grantAccess: true });
        const hook2 = vi.fn().mockResolvedValue({ abort: true, reason: "Should not reach" });

        httpServer.onProtectedRequest(hook1);
        httpServer.onProtectedRequest(hook2);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook1).toHaveBeenCalled();
        expect(hook2).not.toHaveBeenCalled();
        expect(result.type).toBe("no-payment-required");
      });

      it("should stop at first hook returning abort", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook1 = vi.fn().mockResolvedValue({ abort: true, reason: "Blocked" });
        const hook2 = vi.fn().mockResolvedValue({ grantAccess: true });

        httpServer.onProtectedRequest(hook1);
        httpServer.onProtectedRequest(hook2);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook1).toHaveBeenCalled();
        expect(hook2).not.toHaveBeenCalled();
        expect(result.type).toBe("payment-error");
        if (result.type === "payment-error") {
          expect(result.response.status).toBe(403);
        }
      });

      it("should continue through hooks returning void", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook1 = vi.fn().mockResolvedValue(undefined);
        const hook2 = vi.fn().mockResolvedValue(undefined);
        const hook3 = vi.fn().mockResolvedValue({ grantAccess: true });

        httpServer.onProtectedRequest(hook1);
        httpServer.onProtectedRequest(hook2);
        httpServer.onProtectedRequest(hook3);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook1).toHaveBeenCalled();
        expect(hook2).toHaveBeenCalled();
        expect(hook3).toHaveBeenCalled();
        expect(result.type).toBe("no-payment-required");
      });
    });

    describe("hook arguments", () => {
      it("should receive HTTPRequestContext", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        let receivedContext: HTTPRequestContext | undefined;

        const hook: ProtectedRequestHook = async context => {
          receivedContext = context;
        };

        httpServer.onProtectedRequest(hook);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        await httpServer.processHTTPRequest(context);

        expect(receivedContext).toBeDefined();
        expect(receivedContext?.path).toBe("/api/protected");
        expect(receivedContext?.method).toBe("GET");
        expect(receivedContext?.adapter).toBe(adapter);
      });

      it("should receive RouteConfig", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        let receivedRouteConfig: RouteConfig | undefined;

        const hook: ProtectedRequestHook = async (_context, routeConfig) => {
          receivedRouteConfig = routeConfig;
        };

        httpServer.onProtectedRequest(hook);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/protected",
          method: "GET",
        };

        await httpServer.processHTTPRequest(context);

        expect(receivedRouteConfig).toBeDefined();
        expect(receivedRouteConfig?.accepts).toBeDefined();
      });
    });

    describe("hooks on unprotected routes", () => {
      it("should not call hooks for routes without payment config", async () => {
        const httpServer = new x402HTTPResourceServer(ResourceServer, testRoutes);
        const hook = vi.fn().mockResolvedValue({ grantAccess: true });

        httpServer.onProtectedRequest(hook);

        const adapter = new MockHTTPAdapter();
        const context: HTTPRequestContext = {
          adapter,
          path: "/api/public", // Not in testRoutes
          method: "GET",
        };

        const result = await httpServer.processHTTPRequest(context);

        expect(hook).not.toHaveBeenCalled();
        expect(result.type).toBe("no-payment-required");
      });
    });
  });
});
