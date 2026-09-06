import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exact } from "x402/schemes";
import { findMatchingRoute, findMatchingPaymentRequirements } from "x402/shared";
import { getPaywallHtml } from "x402/paywall";
import {
  FacilitatorConfig,
  Network,
  PaymentMiddlewareConfig,
  PaymentPayload,
  PaymentRequirements,
  RouteConfig,
} from "x402/types";
import type { Address as SolanaAddress } from "@solana/kit";
import { useFacilitator } from "x402/verify";
import { paymentMiddleware } from "./index";

// Mock dependencies
vi.mock("x402/verify", () => ({
  useFacilitator: vi.fn(),
}));

vi.mock("x402/paywall", () => ({
  getPaywallHtml: vi.fn(),
}));

vi.mock("x402/shared", async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getNetworkId: vi.fn().mockReturnValue(84532),
    toJsonSafe: vi.fn(x => x),
    computeRoutePatterns: vi.fn().mockImplementation(routes => {
      const normalizedRoutes = Object.fromEntries(
        Object.entries(routes).map(([pattern, value]) => [
          pattern,
          typeof value === "string" || typeof value === "number"
            ? ({ price: value, network: "base-sepolia" } as RouteConfig)
            : (value as RouteConfig),
        ]),
      );

      return Object.entries(normalizedRoutes).map(([pattern, routeConfig]) => {
        const [verb, path] = pattern.includes(" ") ? pattern.split(/\s+/) : ["*", pattern];
        if (!path) {
          throw new Error(`Invalid route pattern: ${pattern}`);
        }
        return {
          verb: verb.toUpperCase(),
          pattern: new RegExp(
            `^${path
              .replace(/\*/g, ".*?")
              .replace(/\[([^\]]+)\]/g, "[^/]+")
              .replace(/\//g, "\\/")}$`,
          ),
          config: routeConfig,
        };
      });
    }),
    findMatchingRoute: vi
      .fn()
      .mockImplementation(
        (
          routePatterns: Array<{ pattern: RegExp; verb: string; config: RouteConfig }>,
          path: string,
          _method: string,
        ) => {
          if (!routePatterns) return undefined;
          return routePatterns.find(({ pattern, verb }) => {
            const matchesPath = pattern.test(path);
            const matchesVerb = verb === "*" || verb === _method.toUpperCase();
            return matchesPath && matchesVerb;
          });
        },
      ),
    findMatchingPaymentRequirements: vi
      .fn()
      .mockImplementation((requirements: PaymentRequirements[], payment: PaymentPayload) => {
        return requirements.find(
          req => req.scheme == payment.scheme && req.network == payment.network,
        );
      }),
  };
});

vi.mock("x402/shared/evm", () => ({
  getUsdcAddressForChain: vi.fn().mockReturnValue("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
}));

vi.mock("x402/schemes", () => ({
  exact: {
    evm: {
      decodePayment: vi.fn(),
    },
  },
}));

describe("paymentMiddleware()", () => {
  let mockRequest: NextRequest;
  let middleware: ReturnType<typeof paymentMiddleware>;
  let mockVerify: ReturnType<typeof useFacilitator>["verify"];
  let mockSettle: ReturnType<typeof useFacilitator>["settle"];
  let mockDecodePayment: ReturnType<typeof vi.fn>;

  const middlewareConfig: PaymentMiddlewareConfig = {
    description: "Test payment",
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    outputSchema: { type: "object" },
    inputSchema: { queryParams: { type: "string" } },
    resource: "https://api.example.com/resource",
  };
  const outputSchema = {
    input: {
      method: "GET",
      type: "http",
      discoverable: true,
      ...middlewareConfig.inputSchema,
    },
    output: middlewareConfig.outputSchema,
  };

  const facilitatorConfig: FacilitatorConfig = {
    url: "https://facilitator.example.com",
    createAuthHeaders: async () => ({
      verify: { Authorization: "Bearer token" },
      settle: { Authorization: "Bearer token" },
      supported: { Authorization: "Bearer token" },
    }),
  };

  const payTo = "0x1234567890123456789012345678901234567890";

  beforeEach(() => {
    vi.resetAllMocks();

    // Setup request mock
    mockRequest = {
      nextUrl: {
        pathname: "/protected/test",
        protocol: "https:",
        host: "example.com",
      },
      headers: new Headers(),
      method: "GET",
    } as unknown as NextRequest;

    // Setup facilitator mocks
    mockVerify = vi.fn() as ReturnType<typeof useFacilitator>["verify"];
    mockSettle = vi.fn() as ReturnType<typeof useFacilitator>["settle"];
    (useFacilitator as ReturnType<typeof vi.fn>).mockReturnValue({
      verify: mockVerify,
      settle: mockSettle,
    });

    // Setup paywall HTML mock
    (getPaywallHtml as ReturnType<typeof vi.fn>).mockReturnValue("<html>Paywall</html>");

    // Setup decode payment mock
    mockDecodePayment = vi.fn();
    (exact.evm.decodePayment as ReturnType<typeof vi.fn>).mockImplementation(mockDecodePayment);

    // Setup route pattern matching mock
    (findMatchingRoute as ReturnType<typeof vi.fn>).mockImplementation(
      (routePatterns, path, method) => {
        if (path === "/protected/test" && method === "GET") {
          return {
            pattern: /^\/protected\/test$/,
            verb: "GET",
            config: {
              price: "$0.001",
              network: "base-sepolia",
              config: middlewareConfig,
            },
          };
        }
        return undefined;
      },
    );

    (findMatchingPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements: PaymentRequirements[], payment: PaymentPayload) => {
        return requirements.find(
          req => req.scheme == payment.scheme && req.network == payment.network,
        );
      },
    );

    // Create middleware with test routes
    middleware = paymentMiddleware(
      payTo,
      {
        "/protected/*": {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
        },
      },
      facilitatorConfig,
    );
  });

  it("should return next() when no route matches", async () => {
    const request = {
      ...mockRequest,
      nextUrl: {
        ...mockRequest.nextUrl,
        pathname: "/unprotected/test",
      },
    } as NextRequest;
    const response = await middleware(request);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
  });

  it("should match routes with HTTP verbs", async () => {
    middleware = paymentMiddleware(
      payTo,
      {
        "GET /protected/*": {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
        },
      },
      facilitatorConfig,
    );

    // Test GET request to protected route
    const getRequest = {
      ...mockRequest,
      method: "GET",
    } as NextRequest;
    getRequest.nextUrl.pathname = "/protected/test";
    let response = await middleware(getRequest);
    expect(response.status).toBe(402);

    // Test POST request to protected route (should not match)
    const postRequest = {
      ...mockRequest,
      method: "POST",
    } as NextRequest;
    postRequest.nextUrl.pathname = "/protected/test";
    response = await middleware(postRequest);
    expect(response.status).toBe(200);
  });

  it("should match routes without verbs using any HTTP method", async () => {
    middleware = paymentMiddleware(
      payTo,
      {
        "/protected/*": {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
        },
      },
      facilitatorConfig,
    );

    // Setup route pattern matching mock
    (findMatchingRoute as ReturnType<typeof vi.fn>).mockImplementation((routePatterns, path) => {
      if (path === "/protected/test") {
        return {
          pattern: /^\/protected\/test$/,
          verb: "*",
          config: {
            price: 1.0,
            network: "base-sepolia",
            config: middlewareConfig,
          },
        };
      }
      return undefined;
    });

    // Test GET request
    const getRequest = {
      ...mockRequest,
      method: "GET",
    } as NextRequest;
    getRequest.nextUrl.pathname = "/protected/test";
    let response = await middleware(getRequest);
    expect(response.status).toBe(402);

    // Test POST request (should also match)
    const postRequest = {
      ...mockRequest,
      method: "POST",
    } as NextRequest;
    postRequest.nextUrl.pathname = "/protected/test";
    response = await middleware(postRequest);
    expect(response.status).toBe(402);
  });

  it("should throw error for invalid route patterns", async () => {
    const middleware = paymentMiddleware(
      payTo,
      {
        "GET ": {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
        },
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers(),
    } as NextRequest;

    const response = await middleware(request);
    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/resource",
          description: "Test payment",
          mimeType: "application/json",
          payTo: "0x1234567890123456789012345678901234567890",
          maxTimeoutSeconds: 300,
          outputSchema,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
    });
  });

  it("should return 402 with payment requirements when no payment header is present", async () => {
    const request = {
      ...mockRequest,
      headers: new Headers({
        Accept: "application/json",
      }),
    } as NextRequest;
    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = (await response.json()) as {
      accepts: Array<{ maxAmountRequired: string }>;
    };
    expect(json.accepts[0]).toEqual({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      outputSchema,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {
        name: "USDC",
        version: "2",
      },
    });
  });

  it("should return HTML paywall for browser requests", async () => {
    const request = {
      ...mockRequest,
      headers: new Headers({
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0",
      }),
    } as NextRequest;
    const response = await middleware(request);

    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    const html = await response.text();
    expect(html).toBe("<html>Paywall</html>");
  });

  it("should verify payment and proceed if valid", async () => {
    const validPayment = "valid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": validPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    (mockVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ isValid: true });
    (mockSettle as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      transaction: "0x123",
      network: "base-sepolia",
    });

    const response = await middleware(request);

    expect(mockDecodePayment).toHaveBeenCalledWith(validPayment);
    expect(mockVerify).toHaveBeenCalledWith(decodedPayment, {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      outputSchema,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {
        name: "USDC",
        version: "2",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-PAYMENT-RESPONSE")).toBeDefined();
  });

  it("should return 402 if payment verification fails", async () => {
    const invalidPayment = "invalid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": invalidPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    (mockVerify as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: false,
      invalidReason: "insufficient_funds",
    });

    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "insufficient_funds",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/resource",
          description: "Test payment",
          mimeType: "application/json",
          payTo: "0x1234567890123456789012345678901234567890",
          maxTimeoutSeconds: 300,
          outputSchema,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
    });
  });

  it("should return 402 if payment verification throws an error", async () => {
    const invalidPayment = "invalid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": invalidPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    // Mock findMatchingPaymentRequirements to return a match for this test
    (findMatchingPaymentRequirements as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      outputSchema,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {
        name: "USDC",
        version: "2",
      },
    });

    (mockVerify as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(
        "This facilitator only supports: base-sepolia, solana-devnet. Network 'base' is not supported.",
      ),
    );

    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error:
        "This facilitator only supports: base-sepolia, solana-devnet. Network 'base' is not supported.",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/resource",
          description: "Test payment",
          mimeType: "application/json",
          payTo: "0x1234567890123456789012345678901234567890",
          maxTimeoutSeconds: 300,
          outputSchema,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
    });
  });

  it("should handle settlement after response", async () => {
    const validPayment = "valid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": validPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    (mockVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ isValid: true });
    (mockSettle as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      transaction: "0x123",
      network: "base-sepolia",
    });

    const response = await middleware(request);

    expect(mockSettle).toHaveBeenCalledWith(decodedPayment, {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      outputSchema,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {
        name: "USDC",
        version: "2",
      },
    });
    expect(response.headers.get("X-PAYMENT-RESPONSE")).toBeDefined();
  });

  it("should handle settlement failure", async () => {
    const validPayment = "valid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": validPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    (mockVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ isValid: true });
    (mockSettle as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Settlement failed"));

    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "Settlement failed",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/resource",
          description: "Test payment",
          mimeType: "application/json",
          payTo: "0x1234567890123456789012345678901234567890",
          maxTimeoutSeconds: 300,
          outputSchema,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
    });
  });

  it("should handle unsuccessful settlement (success = false)", async () => {
    const validPayment = "valid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": validPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    (mockVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ isValid: true });
    (mockSettle as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: "0x123",
      network: "base-sepolia",
      payer: "0x123",
    });

    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "invalid_transaction_state",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/resource",
          description: "Test payment",
          mimeType: "application/json",
          payTo: "0x1234567890123456789012345678901234567890",
          maxTimeoutSeconds: 300,
          outputSchema,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
    });
  });

  it("should handle invalid payment amount configuration", async () => {
    middleware = paymentMiddleware(
      payTo,
      {
        "/protected/*": {
          price: "invalid",
          network: "base-sepolia",
          config: middlewareConfig,
        },
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers(),
    } as NextRequest;

    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/resource",
          description: "Test payment",
          mimeType: "application/json",
          payTo: "0x1234567890123456789012345678901234567890",
          maxTimeoutSeconds: 300,
          outputSchema,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
    });
  });

  it("should handle custom token amounts", async () => {
    middleware = paymentMiddleware(
      payTo,
      {
        "/protected/*": {
          price: {
            amount: "1000000000000000000",
            asset: {
              address: "0xCustomAssetAddress",
              decimals: 18,
              eip712: {
                name: "Custom Token",
                version: "1.0",
              },
            },
          },
          network: "base-sepolia",
          config: middlewareConfig,
        },
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({
        Accept: "application/json",
      }),
    } as NextRequest;

    const response = await middleware(request);

    expect(response.status).toBe(402);
    const json = (await response.json()) as {
      accepts: Array<{ maxAmountRequired: string }>;
    };
    expect(json.accepts[0]).toEqual({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      outputSchema,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {
        name: "USDC",
        version: "2",
      },
    });
  });

  it("should not settle payment if protected route returns status >= 400", async () => {
    const validPayment = "valid-payment-header";
    const request = {
      ...mockRequest,
      headers: new Headers({
        "X-PAYMENT": validPayment,
      }),
    } as NextRequest;

    const decodedPayment = {
      scheme: "exact",
      network: "base-sepolia",
      x402Version: 1,
    };
    mockDecodePayment.mockReturnValue(decodedPayment);

    (mockVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ isValid: true });
    (mockSettle as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      transaction: "0x123",
      network: "base-sepolia",
    });

    // Mock NextResponse.next to return a 500 response
    const mockNext = vi.spyOn(NextResponse, "next").mockImplementation(() => {
      return new NextResponse("Internal server error", { status: 500 });
    });

    const response = await middleware(request);
    console.log(response);

    expect(response.status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();

    // Restore original NextResponse.next
    mockNext.mockRestore();
  });

  it("should return 402 with feePayer for solana-devnet when no payment header is present", async () => {
    const solanaRoutesConfig = {
      "/protected/*": {
        price: "$0.001",
        network: "solana-devnet",
        config: middlewareConfig,
      },
    } as const;

    const solanaPayTo = "CKy5kSzS3K2V4RcedtEa7hC43aYk5tq6z6A4vZnE1fVz";
    const feePayer = "FeePayerAddress12345";

    const mockSupported = vi.fn().mockResolvedValue({
      kinds: [{ scheme: "exact", network: "solana-devnet", extra: { feePayer } }],
    });

    (useFacilitator as ReturnType<typeof vi.fn>).mockReturnValue({
      verify: mockVerify,
      settle: mockSettle,
      supported: mockSupported,
    });

    (findMatchingRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      pattern: /^\/protected\/test$/,
      verb: "GET",
      config: {
        price: "$0.001",
        network: "solana-devnet",
        config: middlewareConfig,
      },
    });

    const middlewareSol = paymentMiddleware(
      solanaPayTo as SolanaAddress,
      solanaRoutesConfig,
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({ Accept: "application/json" }),
    } as NextRequest;

    const response = await middlewareSol(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual(
      expect.objectContaining({
        x402Version: 1,
        accepts: expect.arrayContaining([
          expect.objectContaining({
            network: "solana-devnet",
            payTo: solanaPayTo,
            extra: expect.objectContaining({ feePayer }),
          }),
        ]),
      }),
    );
  });

  it("should return 402 with feePayer for solana when no payment header is present", async () => {
    const solanaRoutesConfig = {
      "/protected/*": {
        price: "$0.001",
        network: "solana",
        config: middlewareConfig,
      },
    } as const;

    const solanaPayTo = "CKy5kSzS3K2V4RcedtEa7hC43aYk5tq6z6A4vZnE1fVz";
    const feePayer = "FeePayerAddressMainnet";

    const mockSupported = vi.fn().mockResolvedValue({
      kinds: [{ scheme: "exact", network: "solana", extra: { feePayer } }],
    });

    (useFacilitator as ReturnType<typeof vi.fn>).mockReturnValue({
      verify: mockVerify,
      settle: mockSettle,
      supported: mockSupported,
    });

    (findMatchingRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      pattern: /^\/protected\/test$/,
      verb: "GET",
      config: {
        price: "$0.001",
        network: "solana",
        config: middlewareConfig,
      },
    });

    const middlewareSol = paymentMiddleware(
      solanaPayTo as SolanaAddress,
      solanaRoutesConfig,
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({ Accept: "application/json" }),
    } as NextRequest;

    const response = await middlewareSol(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual(
      expect.objectContaining({
        x402Version: 1,
        accepts: expect.arrayContaining([
          expect.objectContaining({
            network: "solana",
            payTo: solanaPayTo,
            extra: expect.objectContaining({ feePayer }),
          }),
        ]),
      }),
    );
  });

  it("should throw error for unsupported network", async () => {
    const unsupportedRoutesConfig = {
      "/protected/*": {
        price: "$0.001",
        network: "unsupported-network" as Network,
        config: middlewareConfig,
      },
    } as const;

    (findMatchingRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      pattern: /^\/protected\/test$/,
      verb: "GET",
      config: {
        price: "$0.001",
        network: "unsupported-network" as Network,
        config: middlewareConfig,
      },
    });

    const middlewareUnsupported = paymentMiddleware(
      payTo,
      unsupportedRoutesConfig,
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({ Accept: "application/json" }),
    } as NextRequest;

    await expect(middlewareUnsupported(request)).rejects.toThrow(
      "Unsupported network: unsupported-network",
    );
  });

  describe("session token integration", () => {
    it("should pass sessionTokenEndpoint to paywall HTML when configured", async () => {
      const paywallConfig = {
        cdpClientKey: "test-client-key",
        appName: "Test App",
        appLogo: "/test-logo.png",
        sessionTokenEndpoint: "/api/x402/session-token",
      };

      const middlewareWithPaywall = paymentMiddleware(
        payTo,
        {
          "/protected/*": {
            price: 1.0,
            network: "base-sepolia",
            config: middlewareConfig,
          },
        },
        facilitatorConfig,
        paywallConfig,
      );

      const request = {
        ...mockRequest,
        headers: new Headers({
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0",
        }),
      } as NextRequest;

      await middlewareWithPaywall(request);

      expect(getPaywallHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpClientKey: "test-client-key",
          appName: "Test App",
          appLogo: "/test-logo.png",
          sessionTokenEndpoint: "/api/x402/session-token",
        }),
      );
    });

    it("should not pass sessionTokenEndpoint when not configured", async () => {
      const paywallConfig = {
        cdpClientKey: "test-client-key",
        appName: "Test App",
      };

      const middlewareWithPaywall = paymentMiddleware(
        payTo,
        {
          "/protected/*": {
            price: 1.0,
            network: "base-sepolia",
            config: middlewareConfig,
          },
        },
        facilitatorConfig,
        paywallConfig,
      );

      const request = {
        ...mockRequest,
        headers: new Headers({
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0",
        }),
      } as NextRequest;

      await middlewareWithPaywall(request);

      expect(getPaywallHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpClientKey: "test-client-key",
          appName: "Test App",
          sessionTokenEndpoint: undefined,
        }),
      );
    });

    it("should pass sessionTokenEndpoint even when other paywall config is minimal", async () => {
      const paywallConfig = {
        sessionTokenEndpoint: "/custom/session-token",
      };

      const middlewareWithPaywall = paymentMiddleware(
        payTo,
        {
          "/protected/*": {
            price: 1.0,
            network: "base-sepolia",
            config: middlewareConfig,
          },
        },
        facilitatorConfig,
        paywallConfig,
      );

      const request = {
        ...mockRequest,
        headers: new Headers({
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0",
        }),
      } as NextRequest;

      await middlewareWithPaywall(request);

      expect(getPaywallHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTokenEndpoint: "/custom/session-token",
          cdpClientKey: undefined,
          appName: undefined,
          appLogo: undefined,
        }),
      );
    });

    it("should work without any paywall config", async () => {
      const middlewareWithoutPaywall = paymentMiddleware(
        payTo,
        {
          "/protected/*": {
            price: 1.0,
            network: "base-sepolia",
            config: middlewareConfig,
          },
        },
        facilitatorConfig,
      );

      const request = {
        ...mockRequest,
        headers: new Headers({
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0",
        }),
      } as NextRequest;

      await middlewareWithoutPaywall(request);

      expect(getPaywallHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTokenEndpoint: undefined,
          cdpClientKey: undefined,
          appName: undefined,
          appLogo: undefined,
        }),
      );
    });
  });
});
