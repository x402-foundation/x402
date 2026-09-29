import { beforeEach, describe, expect, it } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPAdapter,
  HTTPRequestContext,
} from "../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../src/server/x402ResourceServer";
import { decodePaymentRequiredHeader } from "../../src/http";
import { CashFacilitatorClient, CashSchemeNetworkServer } from "../mocks";
import { x402Facilitator } from "../../src/facilitator";
import { CashSchemeNetworkFacilitator } from "../mocks/cash";
import { Network, Price } from "../../src/types";

/**
 * Enhanced HTTP Adapter that simulates a real HTTP framework
 * with query params, body parsing, and custom headers
 */
class MockHTTPAdapter implements HTTPAdapter {
  private headers: Record<string, string>;
  private _queryParams: Record<string, string>;
  private _body: Record<string, unknown>;
  private _path: string;
  private _method: string;

  /**
   *
   * @param config
   * @param config.path
   * @param config.method
   * @param config.headers
   * @param config.queryParams
   * @param config.body
   */
  constructor(config: {
    path: string;
    method: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: Record<string, unknown>;
  }) {
    this._path = config.path;
    this._method = config.method;
    this.headers = config.headers || {};
    this._queryParams = config.queryParams || {};
    this._body = config.body || {};
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
    return this._method;
  }

  /**
   *
   */
  getPath(): string {
    return this._path;
  }

  /**
   *
   */
  getUrl(): string {
    const queryString =
      Object.keys(this._queryParams).length > 0
        ? "?" +
          Object.entries(this._queryParams)
            .map(([k, v]) => `${k}=${v}`)
            .join("&")
        : "";
    return `https://example.com${this._path}${queryString}`;
  }

  /**
   *
   */
  getAcceptHeader(): string {
    return this.headers["accept"] || "application/json";
  }

  /**
   *
   */
  getUserAgent(): string {
    return this.headers["user-agent"] || "TestClient/1.0";
  }

  // Implement optional HTTPAdapter methods
  /**
   *
   */
  getQueryParams(): Record<string, string | string[]> {
    return this._queryParams;
  }

  /**
   *
   * @param name
   */
  getQueryParam(name: string): string | string[] | undefined {
    return this._queryParams[name];
  }

  /**
   *
   */
  getBody(): unknown {
    return this._body;
  }
}

// Extend HTTPRequestContext with helper to access adapter methods
interface ExtendedHTTPRequestContext extends HTTPRequestContext {
  adapter: MockHTTPAdapter;
}

describe("Dynamic Pricing & PayTo Integration Tests", () => {
  let ResourceServer: x402ResourceServer;

  beforeEach(async () => {
    const facilitator = new x402Facilitator().register(
      "x402:cash",
      new CashSchemeNetworkFacilitator(),
    );

    const facilitatorClient = new CashFacilitatorClient(facilitator);
    ResourceServer = new x402ResourceServer(facilitatorClient);
    ResourceServer.register("x402:cash", new CashSchemeNetworkServer());
    await ResourceServer.initialize();
  });

  describe("Dynamic Pricing - Query Parameters", () => {
    it("should extract tier from query params and adjust price", async () => {
      const routes = {
        "GET /api/data": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "merchant@example.com",
            price: async (_context: HTTPRequestContext) => {
              // Extract tier from query params
              const tier = _context.adapter.getQueryParam?.("tier");

              // Tiered pricing based on query param
              if (tier === "premium") return "$0.01" as Price;
              if (tier === "business") return "$0.05" as Price;
              return "$0.10" as Price; // Default tier
            },
          },
          description: "Tiered API access",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Test 1: Premium tier
      const premiumAdapter = new MockHTTPAdapter({
        path: "/api/data",
        method: "GET",
        queryParams: { tier: "premium" },
      });

      const premiumContext: ExtendedHTTPRequestContext = {
        adapter: premiumAdapter,
        path: "/api/data",
        method: "GET",
      };

      const premiumResult = await httpServer.processHTTPRequest(premiumContext);

      expect(premiumResult.type).toBe("payment-error"); // No payment provided
      if (premiumResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          premiumResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.01"); // Premium price
      }

      // Test 2: Business tier
      const businessAdapter = new MockHTTPAdapter({
        path: "/api/data",
        method: "GET",
        queryParams: { tier: "business" },
      });

      const businessContext: ExtendedHTTPRequestContext = {
        adapter: businessAdapter,
        path: "/api/data",
        method: "GET",
      };

      const businessResult = await httpServer.processHTTPRequest(businessContext);

      if (businessResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          businessResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.05"); // Business price
      }

      // Test 3: Default tier (no query param)
      const defaultAdapter = new MockHTTPAdapter({
        path: "/api/data",
        method: "GET",
        queryParams: {},
      });

      const defaultContext: ExtendedHTTPRequestContext = {
        adapter: defaultAdapter,
        path: "/api/data",
        method: "GET",
      };

      const defaultResult = await httpServer.processHTTPRequest(defaultContext);

      if (defaultResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          defaultResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.10"); // Default price
      }
    });

    it("should use query params for pagination-based pricing", async () => {
      const routes = {
        "GET /api/items": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "merchant@example.com",
            price: async (_context: HTTPRequestContext) => {
              const limit = parseInt((context.adapter.getQueryParam?.("limit") as string) || "10");

              // Price scales with requested items
              const basePrice = 0.01;
              const pricePerItem = 0.001;
              const totalPrice = basePrice + limit * pricePerItem;

              return `$${totalPrice.toFixed(3)}` as Price;
            },
          },
          description: "Paginated data access",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Request 100 items
      const adapter = new MockHTTPAdapter({
        path: "/api/items",
        method: "GET",
        queryParams: { limit: "100" },
      });

      const context: ExtendedHTTPRequestContext = {
        adapter,
        path: "/api/items",
        method: "GET",
      };

      const result = await httpServer.processHTTPRequest(context);

      if (result.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );
        // 0.01 + (100 * 0.001) = 0.11
        expect(paymentRequired.accepts[0].amount).toBe("0.110");
      }
    });
  });

  describe("Dynamic Pricing - Request Body", () => {
    it("should extract data from request body for pricing", async () => {
      const routes = {
        "POST /api/compute": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "compute@example.com",
            price: async (_context: HTTPRequestContext) => {
              const body = _context.adapter.getBody?.() as Record<string, unknown> | undefined;

              const complexity = (body?.complexity as string) || "low";
              const duration = (body?.estimatedDuration as number) || 1;

              // Price based on computational complexity
              let baseRate = 0.1;
              if (complexity === "high") baseRate = 1.0;
              else if (complexity === "medium") baseRate = 0.5;

              const totalPrice = baseRate * duration;
              return `$${totalPrice.toFixed(2)}` as Price;
            },
          },
          description: "Compute service",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Test 1: High complexity, 5 minute job
      const highComplexityAdapter = new MockHTTPAdapter({
        path: "/api/compute",
        method: "POST",
        body: {
          complexity: "high",
          estimatedDuration: 5,
          task: "render_video",
        },
      });

      const highContext: ExtendedHTTPRequestContext = {
        adapter: highComplexityAdapter,
        path: "/api/compute",
        method: "POST",
      };

      const highResult = await httpServer.processHTTPRequest(highContext);

      if (highResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          highResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("5.00"); // 1.00 * 5
      }

      // Test 2: Low complexity, 2 minute job
      const lowComplexityAdapter = new MockHTTPAdapter({
        path: "/api/compute",
        method: "POST",
        body: {
          complexity: "low",
          estimatedDuration: 2,
        },
      });

      const lowContext: ExtendedHTTPRequestContext = {
        adapter: lowComplexityAdapter,
        path: "/api/compute",
        method: "POST",
      };

      const lowResult = await httpServer.processHTTPRequest(lowContext);

      if (lowResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          lowResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.20"); // 0.10 * 2
      }
    });

    it("should price based on request payload size", async () => {
      const routes = {
        "POST /api/process": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "processor@example.com",
            price: async (_context: HTTPRequestContext) => {
              const body = _context.adapter.getBody?.() as Record<string, unknown> | undefined;

              // Get data array size
              const dataArray = (body?.data as unknown[]) || [];
              const itemCount = dataArray.length;

              // $0.01 per item, minimum $0.05
              const price = Math.max(0.05, itemCount * 0.01);
              return `$${price.toFixed(2)}` as Price;
            },
          },
          description: "Batch processing",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter({
        path: "/api/process",
        method: "POST",
        body: {
          data: Array(50).fill({ item: "test" }), // 50 items
        },
      });

      const context: ExtendedHTTPRequestContext = {
        adapter,
        path: "/api/process",
        method: "POST",
      };

      const result = await httpServer.processHTTPRequest(context);

      if (result.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.50"); // 50 * 0.01
      }
    });
  });

  describe("Dynamic Pricing - Headers", () => {
    it("should extract API key from headers and apply tier-based pricing", async () => {
      // Simulate a user database
      const userDatabase: Record<string, { tier: string; rateLimit: number }> = {
        key_premium_123: { tier: "premium", rateLimit: 1000 },
        key_standard_456: { tier: "standard", rateLimit: 100 },
        key_free_789: { tier: "free", rateLimit: 10 },
      };

      const routes = {
        "GET /api/resource": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "api@example.com",
            price: async (_context: HTTPRequestContext) => {
              const apiKey = _context.adapter.getHeader("x-api-key");

              if (!apiKey) {
                return "$1.00" as Price; // No API key = highest price
              }

              const user = userDatabase[apiKey];
              if (!user) {
                return "$1.00" as Price; // Unknown key = highest price
              }

              // Tier-based pricing
              const tierPrices: Record<string, string> = {
                premium: "$0.01",
                standard: "$0.10",
                free: "$0.50",
              };

              return (tierPrices[user.tier] as Price) || ("$1.00" as Price);
            },
          },
          description: "API with tier-based access",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Test 1: Premium user
      const premiumAdapter = new MockHTTPAdapter({
        path: "/api/resource",
        method: "GET",
        headers: { "x-api-key": "key_premium_123" },
      });

      const premiumResult = await httpServer.processHTTPRequest({
        adapter: premiumAdapter,
        path: "/api/resource",
        method: "GET",
      });

      if (premiumResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          premiumResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.01");
      }

      // Test 2: Standard user
      const standardAdapter = new MockHTTPAdapter({
        path: "/api/resource",
        method: "GET",
        headers: { "x-api-key": "key_standard_456" },
      });

      const standardResult = await httpServer.processHTTPRequest({
        adapter: standardAdapter,
        path: "/api/resource",
        method: "GET",
      });

      if (standardResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          standardResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.10");
      }

      // Test 3: No API key
      const noKeyAdapter = new MockHTTPAdapter({
        path: "/api/resource",
        method: "GET",
        headers: {},
      });

      const noKeyResult = await httpServer.processHTTPRequest({
        adapter: noKeyAdapter,
        path: "/api/resource",
        method: "GET",
      });

      if (noKeyResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          noKeyResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("1.00"); // Highest price
      }
    });

    it("should use Content-Length header for size-based pricing", async () => {
      const routes = {
        "POST /api/upload": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "storage@example.com",
            price: async (_context: HTTPRequestContext) => {
              const contentLength = _context.adapter.getHeader("content-length");
              const sizeInBytes = parseInt(contentLength || "0");
              const sizeInMB = sizeInBytes / (1024 * 1024);

              // $0.10 per MB, minimum $0.05
              const price = Math.max(0.05, sizeInMB * 0.1);
              return `$${price.toFixed(2)}` as Price;
            },
          },
          description: "File storage",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Upload 10MB file
      const adapter = new MockHTTPAdapter({
        path: "/api/upload",
        method: "POST",
        headers: {
          "content-length": (10 * 1024 * 1024).toString(), // 10MB
          "content-type": "application/octet-stream",
        },
      });

      const context: ExtendedHTTPRequestContext = {
        adapter,
        path: "/api/upload",
        method: "POST",
      };

      const result = await httpServer.processHTTPRequest(context);

      if (result.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("1.00"); // 10 * 0.10
      }
    });

    it("should use custom headers for feature flags", async () => {
      const routes = {
        "GET /api/advanced": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "service@example.com",
            price: async (_context: HTTPRequestContext) => {
              const enableAI = _context.adapter.getHeader("x-enable-ai");
              const enableCache = _context.adapter.getHeader("x-enable-cache");

              let price = 0.1; // Base price

              if (enableAI === "true") price += 0.5; // AI features cost extra
              if (enableCache === "false") price += 0.2; // No cache = more compute

              return `$${price.toFixed(2)}` as Price;
            },
          },
          description: "Advanced API with optional features",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // With AI, with cache
      const aiCacheAdapter = new MockHTTPAdapter({
        path: "/api/advanced",
        method: "GET",
        headers: {
          "x-enable-ai": "true",
          "x-enable-cache": "true",
        },
      });

      const aiCacheResult = await httpServer.processHTTPRequest({
        adapter: aiCacheAdapter,
        path: "/api/advanced",
        method: "GET",
      });

      if (aiCacheResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          aiCacheResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.60"); // 0.10 + 0.50
      }

      // No AI, no cache
      const basicAdapter = new MockHTTPAdapter({
        path: "/api/advanced",
        method: "GET",
        headers: {
          "x-enable-ai": "false",
          "x-enable-cache": "false",
        },
      });

      const basicResult = await httpServer.processHTTPRequest({
        adapter: basicAdapter,
        path: "/api/advanced",
        method: "GET",
      });

      if (basicResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          basicResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.30"); // 0.10 + 0.20
      }
    });
  });

  describe("Dynamic PayTo - Headers", () => {
    it("should route payment to different addresses based on header", async () => {
      const routes = {
        "POST /api/process": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            price: "$0.50" as Price,
            payTo: async (context: HTTPRequestContext) => {
              const region = context.adapter.getHeader("x-region");

              // Route to different payment addresses by region
              const paymentAddresses: Record<string, string> = {
                us: "merchant-us@example.com",
                eu: "merchant-eu@example.com",
                asia: "merchant-asia@example.com",
              };

              return paymentAddresses[region || "us"] || "merchant-default@example.com";
            },
          },
          description: "Regional payment routing",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Test US region
      const usAdapter = new MockHTTPAdapter({
        path: "/api/process",
        method: "POST",
        headers: { "x-region": "us" },
      });

      const usResult = await httpServer.processHTTPRequest({
        adapter: usAdapter,
        path: "/api/process",
        method: "POST",
      });

      if (usResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          usResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].payTo).toBe("merchant-us@example.com");
      }

      // Test EU region
      const euAdapter = new MockHTTPAdapter({
        path: "/api/process",
        method: "POST",
        headers: { "x-region": "eu" },
      });

      const euResult = await httpServer.processHTTPRequest({
        adapter: euAdapter,
        path: "/api/process",
        method: "POST",
      });

      if (euResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          euResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].payTo).toBe("merchant-eu@example.com");
      }
    });

    it("should use Authorization header to determine payment recipient", async () => {
      const routes = {
        "GET /api/user-content": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            price: "$0.25" as Price,
            payTo: async (context: HTTPRequestContext) => {
              const authHeader = context.adapter.getHeader("authorization");

              if (!authHeader) {
                return "anonymous@example.com";
              }

              // Parse Bearer token (simplified)
              const token = authHeader.replace("Bearer ", "");

              // Simulate decoding user ID from token
              if (token.includes("creator")) {
                return "creator-123@example.com";
              }
              if (token.includes("consumer")) {
                return "platform@example.com";
              }

              return "default@example.com";
            },
          },
          description: "User-generated content access",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Creator content - pay creator directly
      const creatorAdapter = new MockHTTPAdapter({
        path: "/api/user-content",
        method: "GET",
        headers: { authorization: "Bearer creator_token_abc" },
      });

      const creatorResult = await httpServer.processHTTPRequest({
        adapter: creatorAdapter,
        path: "/api/user-content",
        method: "GET",
      });

      if (creatorResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          creatorResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].payTo).toBe("creator-123@example.com");
      }

      // Consumer - pay platform
      const consumerAdapter = new MockHTTPAdapter({
        path: "/api/user-content",
        method: "GET",
        headers: { authorization: "Bearer consumer_token_xyz" },
      });

      const consumerResult = await httpServer.processHTTPRequest({
        adapter: consumerAdapter,
        path: "/api/user-content",
        method: "GET",
      });

      if (consumerResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          consumerResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].payTo).toBe("platform@example.com");
      }
    });
  });

  describe("Dynamic PayTo - Request Body", () => {
    it("should route to different service providers based on request", async () => {
      const routes = {
        "POST /api/inference": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            price: "$1.00" as Price,
            payTo: async (context: HTTPRequestContext) => {
              const body = context.adapter.getBody?.() as Record<string, unknown> | undefined;

              const modelId = body?.modelId as string;

              // Route to different GPU providers based on model
              const modelProviders: Record<string, string> = {
                "gpt-4": "openai-provider@example.com",
                "claude-3": "anthropic-provider@example.com",
                "llama-3": "meta-provider@example.com",
              };

              return modelProviders[modelId] || "default-provider@example.com";
            },
          },
          description: "AI model inference routing",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // GPT-4 request
      const gptAdapter = new MockHTTPAdapter({
        path: "/api/inference",
        method: "POST",
        body: {
          modelId: "gpt-4",
          prompt: "Hello, world!",
        },
      });

      const gptResult = await httpServer.processHTTPRequest({
        adapter: gptAdapter,
        path: "/api/inference",
        method: "POST",
      });

      if (gptResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          gptResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].payTo).toBe("openai-provider@example.com");
      }

      // Claude request
      const claudeAdapter = new MockHTTPAdapter({
        path: "/api/inference",
        method: "POST",
        body: {
          modelId: "claude-3",
          prompt: "Hello, world!",
        },
      });

      const claudeResult = await httpServer.processHTTPRequest({
        adapter: claudeAdapter,
        path: "/api/inference",
        method: "POST",
      });

      if (claudeResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          claudeResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].payTo).toBe("anthropic-provider@example.com");
      }
    });
  });

  describe("Combined Dynamic Pricing & PayTo", () => {
    it("should use both query params and headers for complex routing", async () => {
      const routes = {
        "GET /api/premium-data": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: async (context: HTTPRequestContext) => {
              // Route based on data source (query param)
              const source = context.adapter.getQueryParam?.("source") as string | undefined;

              if (source === "blockchain") return "blockchain-provider@example.com";
              if (source === "market") return "market-data-provider@example.com";
              return "default-provider@example.com";
            },
            price: async (_context: HTTPRequestContext) => {
              // Price based on subscription level (header) and data range (query)
              const subscription = _context.adapter.getHeader("x-subscription");
              const range = (_context.adapter.getQueryParam?.("range") as string) || "1d";

              let basePrice = subscription === "pro" ? 0.1 : 0.5;

              // Price multiplier based on data range
              const rangeMultipliers: Record<string, number> = {
                "1d": 1,
                "7d": 3,
                "30d": 10,
                "1y": 50,
              };

              const multiplier = rangeMultipliers[range] || 1;
              const finalPrice = basePrice * multiplier;

              return `$${finalPrice.toFixed(2)}` as Price;
            },
          },
          description: "Premium data API with complex pricing",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Pro subscription, 30-day data, blockchain source
      const adapter = new MockHTTPAdapter({
        path: "/api/premium-data",
        method: "GET",
        headers: { "x-subscription": "pro" },
        queryParams: {
          source: "blockchain",
          range: "30d",
        },
      });

      const result = await httpServer.processHTTPRequest({
        adapter,
        path: "/api/premium-data",
        method: "GET",
      });

      if (result.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result.response.headers["PAYMENT-REQUIRED"],
        );

        // Verify dynamic payTo
        expect(paymentRequired.accepts[0].payTo).toBe("blockchain-provider@example.com");

        // Verify dynamic price: 0.10 * 10 = 1.00
        expect(paymentRequired.accepts[0].amount).toBe("1.00");
      }

      // Free subscription, 7-day data, market source
      const freeAdapter = new MockHTTPAdapter({
        path: "/api/premium-data",
        method: "GET",
        headers: { "x-subscription": "free" },
        queryParams: {
          source: "market",
          range: "7d",
        },
      });

      const freeResult = await httpServer.processHTTPRequest({
        adapter: freeAdapter,
        path: "/api/premium-data",
        method: "GET",
      });

      if (freeResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          freeResult.response.headers["PAYMENT-REQUIRED"],
        );

        // Verify dynamic payTo
        expect(paymentRequired.accepts[0].payTo).toBe("market-data-provider@example.com");

        // Verify dynamic price: 0.50 * 3 = 1.50
        expect(paymentRequired.accepts[0].amount).toBe("1.50");
      }
    });
  });

  describe("Real-world Middleware Scenarios", () => {
    it("should support rate-limiting based pricing", async () => {
      // Simulate rate limit tracking
      const requestCounts: Record<string, number> = {};

      const routes = {
        "GET /api/data": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "api@example.com",
            price: async (_context: HTTPRequestContext) => {
              const apiKey = _context.adapter.getHeader("x-api-key") || "anonymous";

              // Track requests
              requestCounts[apiKey] = (requestCounts[apiKey] || 0) + 1;

              const requestCount = requestCounts[apiKey];

              // First 100 requests: cheap
              if (requestCount <= 100) return "$0.01" as Price;
              // Next 900 requests: medium
              if (requestCount <= 1000) return "$0.05" as Price;
              // Over 1000: expensive (encourage upgrade)
              return "$0.50" as Price;
            },
          },
          description: "Rate-limited API",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter({
        path: "/api/data",
        method: "GET",
        headers: { "x-api-key": "test-key-123" },
      });

      // First request
      const result1 = await httpServer.processHTTPRequest({
        adapter,
        path: "/api/data",
        method: "GET",
      });

      if (result1.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result1.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.01");
      }

      // Simulate 100 more requests
      requestCounts["test-key-123"] = 101;

      const result101 = await httpServer.processHTTPRequest({
        adapter,
        path: "/api/data",
        method: "GET",
      });

      if (result101.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          result101.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.05");
      }
    });

    it("should support load-balancing across payment addresses", async () => {
      // Simulate load balancer state
      let currentServerIndex = 0;
      const servers = [
        { address: "server1@example.com", load: 0 },
        { address: "server2@example.com", load: 0 },
        { address: "server3@example.com", load: 0 },
      ];

      const routes = {
        "POST /api/task": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            price: "$0.10" as Price,
            payTo: async (_context: HTTPRequestContext) => {
              // Round-robin load balancing
              const server = servers[currentServerIndex];
              currentServerIndex = (currentServerIndex + 1) % servers.length;
              server.load++;

              return server.address;
            },
          },
          description: "Load-balanced task processing",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter({
        path: "/api/task",
        method: "POST",
      });

      // Make 3 requests
      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await httpServer.processHTTPRequest({
          adapter,
          path: "/api/task",
          method: "POST",
        });
        results.push(result);
      }

      // Should have routed to all 3 servers
      const payTos = results.map(r => {
        if (r.type === "payment-error") {
          const paymentRequired = decodePaymentRequiredHeader(
            r.response.headers["PAYMENT-REQUIRED"],
          );
          return paymentRequired.accepts[0].payTo;
        }
        return null;
      });

      expect(payTos).toEqual(["server1@example.com", "server2@example.com", "server3@example.com"]);

      expect(servers[0].load).toBe(1);
      expect(servers[1].load).toBe(1);
      expect(servers[2].load).toBe(1);
    });
  });

  describe("Time-based Dynamic Pricing", () => {
    it("should apply surge pricing during peak hours", async () => {
      const routes = {
        "GET /api/resource": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: "service@example.com",
            price: async (_context: HTTPRequestContext) => {
              // Check if client provides a timestamp header (for testing)
              const timestampHeader = _context.adapter.getHeader("x-test-time");
              const hour = timestampHeader
                ? new Date(parseInt(timestampHeader)).getHours()
                : new Date().getHours();

              // Peak hours (9 AM - 5 PM): surge pricing
              const isPeakHour = hour >= 9 && hour < 17;

              return isPeakHour ? ("$0.20" as Price) : ("$0.10" as Price);
            },
          },
          description: "Surge pricing API",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      // Peak hour - use local time noon (12 PM)
      const peakDate = new Date();
      peakDate.setHours(12, 0, 0, 0); // Set to noon local time

      const peakAdapter = new MockHTTPAdapter({
        path: "/api/resource",
        method: "GET",
        headers: {
          "x-test-time": peakDate.getTime().toString(),
        },
      });

      const peakResult = await httpServer.processHTTPRequest({
        adapter: peakAdapter,
        path: "/api/resource",
        method: "GET",
      });

      if (peakResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          peakResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.20"); // Surge price
      }

      // Off-peak hour - use local time 10 PM (22:00)
      const offPeakDate = new Date();
      offPeakDate.setHours(22, 0, 0, 0); // Set to 10 PM local time

      const offPeakAdapter = new MockHTTPAdapter({
        path: "/api/resource",
        method: "GET",
        headers: {
          "x-test-time": offPeakDate.getTime().toString(),
        },
      });

      const offPeakResult = await httpServer.processHTTPRequest({
        adapter: offPeakAdapter,
        path: "/api/resource",
        method: "GET",
      });

      if (offPeakResult.type === "payment-error") {
        const paymentRequired = decodePaymentRequiredHeader(
          offPeakResult.response.headers["PAYMENT-REQUIRED"],
        );
        expect(paymentRequired.accepts[0].amount).toBe("0.10"); // Normal price
      }
    });
  });

  describe("Access to Full Request Context", () => {
    it("should have access to all context properties in dynamic functions", async () => {
      let capturedContext: HTTPRequestContext | null = null;

      const routes = {
        "POST /api/test": {
          accepts: {
            scheme: "cash",
            network: "x402:cash" as Network,
            payTo: async (context: HTTPRequestContext) => {
              capturedContext = context;
              return "test@example.com";
            },
            price: "$1.00" as Price,
          },
          description: "Context capture test",
        },
      };

      const httpServer = new x402HTTPResourceServer(ResourceServer, routes);

      const adapter = new MockHTTPAdapter({
        path: "/api/test",
        method: "POST",
        headers: {
          "x-custom-header": "custom-value",
          authorization: "Bearer token123",
        },
        queryParams: {
          param1: "value1",
        },
        body: {
          data: "test",
        },
      });

      const context: ExtendedHTTPRequestContext = {
        adapter,
        path: "/api/test",
        method: "POST",
      };

      await httpServer.processHTTPRequest(context);

      // Verify context was captured
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.path).toBe("/api/test");
      expect(capturedContext?.method).toBe("POST");
      expect(capturedContext?.adapter).toBe(adapter);

      // Verify adapter methods are accessible
      expect(capturedContext?.adapter.getHeader("x-custom-header")).toBe("custom-value");
      expect(capturedContext?.adapter.getMethod()).toBe("POST");
      expect(capturedContext?.adapter.getPath()).toBe("/api/test");
    });
  });
});
