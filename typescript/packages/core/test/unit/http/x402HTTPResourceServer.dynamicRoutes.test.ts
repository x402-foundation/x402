import { describe, it, expect, beforeEach } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPRequestContext,
  HTTPAdapter,
  RouteConfig,
} from "../../../src/http/x402HTTPResourceServer";
import { decodePaymentRequiredHeader } from "../../../src/http";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
} from "../../mocks";
import { Network, Price } from "../../../src/types";

// Mock HTTP Adapter
/**
 *
 */
class MockHTTPAdapter implements HTTPAdapter {
  private headers: Record<string, string> = {};
  private path: string;
  private method: string;

  /**
   *
   * @param path
   * @param method
   * @param headers
   */
  constructor(path = "/api/test", method = "GET", headers: Record<string, string> = {}) {
    this.path = path;
    this.method = method;
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
    return this.method;
  }

  /**
   *
   */
  getPath(): string {
    return this.path;
  }

  /**
   *
   */
  getUrl(): string {
    return `https://example.com${this.path}`;
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
}

/**
 * Build a request context for the given path and method.
 *
 * @param path - Request path
 * @param method - HTTP method
 * @returns HTTP request context backed by a mock adapter
 */
function buildContext(path: string, method = "GET"): HTTPRequestContext {
  const adapter = new MockHTTPAdapter(path, method);
  return { adapter, path, method };
}

const EVM_NETWORK = "eip155:8453" as Network;
const SVM_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network;

/**
 * Build a minimal route config for tests.
 *
 * @param description - Optional route description
 * @param network - Network for the payment option (defaults to the EVM test network)
 * @returns Route configuration
 */
function buildRouteConfig(description?: string, network: Network = EVM_NETWORK): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      payTo: "0xabc",
      price: "$0.001" as Price,
      network,
    },
    description,
  };
}

describe("x402HTTPResourceServer dynamic routes", () => {
  let ResourceServer: x402ResourceServer;
  let httpServer: x402HTTPResourceServer;

  beforeEach(async () => {
    const mockFacilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [
          { x402Version: 2, scheme: "exact", network: EVM_NETWORK },
          { x402Version: 2, scheme: "exact", network: SVM_NETWORK },
        ],
      }),
      buildVerifyResponse({ isValid: true }),
    );

    ResourceServer = new x402ResourceServer(mockFacilitator);

    const mockEvmScheme = new MockSchemeNetworkServer("exact", {
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: {},
    });
    const mockSvmScheme = new MockSchemeNetworkServer("exact", {
      amount: "1000000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      extra: {},
    });

    ResourceServer.register(EVM_NETWORK, mockEvmScheme);
    ResourceServer.register(SVM_NETWORK, mockSvmScheme);
    await ResourceServer.initialize();

    httpServer = new x402HTTPResourceServer(ResourceServer, {
      "GET /static": buildRouteConfig("static route"),
    });
  });

  describe("registerRoute", () => {
    it("should protect a route registered after construction", () => {
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(false);

      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(true);
    });

    it("should match only the registered HTTP verb", () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc", "POST"))).toBe(false);
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc", "GET"))).toBe(true);
    });

    it("should match all verbs when no verb is given", () => {
      httpServer.registerRoute("/pay/j_abc", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc", "GET"))).toBe(true);
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc", "POST"))).toBe(true);
    });

    it("should support parameterized patterns", () => {
      httpServer.registerRoute("GET /pay/:id", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(true);
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc/nested"))).toBe(false);
    });

    it("should support wildcard patterns", () => {
      httpServer.registerRoute("GET /resource/*", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/resource/a/b/c"))).toBe(true);
    });

    it("should return 402 for an unpaid request to a dynamically registered route", async () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig("dynamic resource"));

      const result = await httpServer.processHTTPRequest(buildContext("/pay/j_abc"));

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        expect(result.response.status).toBe(402);
        expect(result.response.headers["PAYMENT-REQUIRED"]).toBeDefined();
      }
    });

    it("should protect routes registered for other networks", async () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig("svm resource", SVM_NETWORK));

      const result = await httpServer.processHTTPRequest(buildContext("/pay/j_abc"));

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        expect(result.response.status).toBe(402);
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts).toHaveLength(1);
        expect(paymentRequired.accepts[0].network).toBe(SVM_NETWORK);
      }
    });

    it("should support multiple networks in a single dynamic route", async () => {
      httpServer.registerRoute("GET /pay/j_abc", {
        accepts: [
          { scheme: "exact", payTo: "0xabc", price: "$0.001" as Price, network: EVM_NETWORK },
          { scheme: "exact", payTo: "svmAddr", price: "$0.001" as Price, network: SVM_NETWORK },
        ],
      });

      const result = await httpServer.processHTTPRequest(buildContext("/pay/j_abc"));

      expect(result.type).toBe("payment-error");
      if (result.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );
        const networks = paymentRequired.accepts.map(a => a.network);
        expect(networks).toContain(EVM_NETWORK);
        expect(networks).toContain(SVM_NETWORK);
      }
    });

    it("should not affect statically configured routes", () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/static"))).toBe(true);
    });

    it("should be a no-op when the same pattern and verb are already registered", () => {
      const firstConfig = buildRouteConfig("first");
      const secondConfig = buildRouteConfig("second");

      httpServer.registerRoute("GET /pay/j_abc", firstConfig);
      httpServer.registerRoute("GET /pay/j_abc", secondConfig);

      // A single unregister removes the route entirely — no duplicate entry exists
      httpServer.unregisterRoute("GET /pay/j_abc");
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(false);
    });

    it("should reflect dynamically registered routes in the routes getter", () => {
      const config = buildRouteConfig();
      httpServer.registerRoute("GET /pay/j_abc", config);

      expect((httpServer.routes as Record<string, RouteConfig>)["GET /pay/j_abc"]).toBe(config);
    });

    it("should return the server instance for chaining", () => {
      const result = httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      expect(result).toBe(httpServer);
    });
  });

  describe("unregisterRoute", () => {
    it("should stop protecting a previously registered route", async () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(true);

      httpServer.unregisterRoute("GET /pay/j_abc");

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(false);
      const result = await httpServer.processHTTPRequest(buildContext("/pay/j_abc"));
      expect(result.type).toBe("no-payment-required");
    });

    it("should remove constructor-configured routes as well", () => {
      expect(httpServer.requiresPayment(buildContext("/static"))).toBe(true);

      httpServer.unregisterRoute("GET /static");

      expect(httpServer.requiresPayment(buildContext("/static"))).toBe(false);
    });

    it("should be a no-op for unknown patterns", () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      expect(() => httpServer.unregisterRoute("GET /unknown")).not.toThrow();
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(true);
    });

    it("should only remove the route matching both pattern and verb", () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());
      httpServer.registerRoute("POST /pay/j_abc", buildRouteConfig());

      httpServer.unregisterRoute("GET /pay/j_abc");

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc", "GET"))).toBe(false);
      expect(httpServer.requiresPayment(buildContext("/pay/j_abc", "POST"))).toBe(true);
    });

    it("should remove the route from the routes getter", () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      httpServer.unregisterRoute("GET /pay/j_abc");

      expect((httpServer.routes as Record<string, RouteConfig>)["GET /pay/j_abc"]).toBeUndefined();
    });

    it("should return the server instance for chaining", () => {
      const result = httpServer.unregisterRoute("GET /unknown");

      expect(result).toBe(httpServer);
    });
  });

  describe("register/unregister lifecycle", () => {
    it("should support the marketplace flow: quote → protect → pay → release", async () => {
      const jobId = "j_123";
      const pattern = `GET /pay/${jobId}`;

      // 1. Job created — protect its payment URL
      httpServer.registerRoute(pattern, buildRouteConfig(`Job ${jobId}`));
      const unpaid = await httpServer.processHTTPRequest(buildContext(`/pay/${jobId}`));
      expect(unpaid.type).toBe("payment-error");

      // 2. Payment confirmed — release the route (replay protection)
      httpServer.unregisterRoute(pattern);
      const afterPayment = await httpServer.processHTTPRequest(buildContext(`/pay/${jobId}`));
      expect(afterPayment.type).toBe("no-payment-required");
    });

    it("should allow re-registering after unregistering", () => {
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());
      httpServer.unregisterRoute("GET /pay/j_abc");
      httpServer.registerRoute("GET /pay/j_abc", buildRouteConfig());

      expect(httpServer.requiresPayment(buildContext("/pay/j_abc"))).toBe(true);
    });
  });
});
