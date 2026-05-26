import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exact } from "x402/schemes";
import { findMatchingPaymentRequirements } from "x402/shared";
import { getPaywallHtml } from "x402/paywall";
import {
  FacilitatorConfig,
  Network,
  PaymentMiddlewareConfig,
  PaymentPayload,
  PaymentRequirements,
} from "x402/types";
import type { Address as SolanaAddress } from "@solana/kit";
import { useFacilitator } from "x402/verify";
import { withX402 } from "./index";

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

describe("withX402()", () => {
  let mockRequest: NextRequest;
  let mockHandler: ReturnType<typeof vi.fn>;
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
        pathname: "/api/weather",
        protocol: "https:",
        host: "example.com",
      },
      headers: new Headers(),
      method: "GET",
    } as unknown as NextRequest;

    // Setup handler mock
    mockHandler = vi.fn().mockResolvedValue(
      NextResponse.json({
        report: { weather: "sunny", temperature: 70 },
      }),
    );

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

    (findMatchingPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements: PaymentRequirements[], payment: PaymentPayload) => {
        return requirements.find(
          req => req.scheme == payment.scheme && req.network == payment.network,
        );
      },
    );
  });

  it("should return 402 with payment requirements when no payment header is present", async () => {
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({
        Accept: "application/json",
      }),
    } as NextRequest;

    const response = await wrappedHandler(request);

    expect(mockHandler).not.toHaveBeenCalled();
    expect(response.status).toBe(402);
    const json = (await response.json()) as {
      accepts: Array<{ maxAmountRequired: string }>;
    };
    expect(json.accepts[0]).toEqual({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000000",
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
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
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

    const response = await wrappedHandler(request);

    expect(mockHandler).not.toHaveBeenCalled();
    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    const html = await response.text();
    expect(html).toBe("<html>Paywall</html>");
  });

  it("should verify payment and call handler if valid", async () => {
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith(request);
    expect(mockDecodePayment).toHaveBeenCalledWith(validPayment);
    expect(mockVerify).toHaveBeenCalledWith(decodedPayment, {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000000",
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
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(mockHandler).not.toHaveBeenCalled();
    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "insufficient_funds",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000000",
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

  it("should handle settlement after successful response", async () => {
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(mockSettle).toHaveBeenCalledWith(decodedPayment, {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000000",
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
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "Settlement failed",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000000",
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
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith(request);
    expect(response.status).toBe(402);
    const json = await response.json();
    expect(json).toEqual({
      x402Version: 1,
      error: "invalid_transaction_state",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000000",
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
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: "invalid",
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers(),
    } as NextRequest;

    await expect(wrappedHandler(request)).rejects.toThrow(/Invalid price/);
  });

  it("should handle custom token amounts", async () => {
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: {
          amount: "1000000000000000000",
          asset: {
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
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
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({
        Accept: "application/json",
      }),
    } as NextRequest;

    const response = await wrappedHandler(request);

    expect(response.status).toBe(402);
    const json = (await response.json()) as {
      accepts: Array<{ maxAmountRequired: string; asset: string }>;
    };
    expect(json.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000000000000000000",
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      extra: {
        name: "Custom Token",
        version: "1.0",
      },
    });
  });

  it("should not settle payment if handler returns status >= 400", async () => {
    mockHandler.mockResolvedValue(
      NextResponse.json({ error: "Internal server error" }, { status: 500 }),
    );

    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith(request);
    expect(response.status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("should not settle payment if handler returns 400 status", async () => {
    mockHandler.mockResolvedValue(NextResponse.json({ error: "Bad request" }, { status: 400 }));

    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: 1.0,
        network: "base-sepolia",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

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

    const response = await wrappedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith(request);
    expect(response.status).toBe(400);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("should return 402 with feePayer for solana-devnet when no payment header is present", async () => {
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

    const wrappedHandler = withX402(
      mockHandler,
      solanaPayTo as SolanaAddress,
      {
        price: "$0.001",
        network: "solana-devnet",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({ Accept: "application/json" }),
    } as NextRequest;

    const response = await wrappedHandler(request);

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

    const wrappedHandler = withX402(
      mockHandler,
      solanaPayTo as SolanaAddress,
      {
        price: "$0.001",
        network: "solana",
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({ Accept: "application/json" }),
    } as NextRequest;

    const response = await wrappedHandler(request);

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
    const wrappedHandler = withX402(
      mockHandler,
      payTo,
      {
        price: "$0.001",
        network: "unsupported-network" as Network,
        config: middlewareConfig,
      },
      facilitatorConfig,
    );

    const request = {
      ...mockRequest,
      headers: new Headers({ Accept: "application/json" }),
    } as NextRequest;

    await expect(wrappedHandler(request)).rejects.toThrow(
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

      const wrappedHandler = withX402(
        mockHandler,
        payTo,
        {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
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

      await wrappedHandler(request);

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

      const wrappedHandler = withX402(
        mockHandler,
        payTo,
        {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
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

      await wrappedHandler(request);

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

      const wrappedHandler = withX402(
        mockHandler,
        payTo,
        {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
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

      await wrappedHandler(request);

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
      const wrappedHandler = withX402(
        mockHandler,
        payTo,
        {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
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

      await wrappedHandler(request);

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

  describe("POST method", () => {
    it("should handle POST requests correctly", async () => {
      mockRequest = {
        nextUrl: {
          pathname: "/api/weather",
          protocol: "https:",
          host: "example.com",
        },
        headers: new Headers(),
        method: "POST",
      } as unknown as NextRequest;

      const wrappedHandler = withX402(
        mockHandler,
        payTo,
        {
          price: 1.0,
          network: "base-sepolia",
          config: middlewareConfig,
        },
        facilitatorConfig,
      );

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

      const response = await wrappedHandler(request);

      expect(mockHandler).toHaveBeenCalledWith(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-PAYMENT-RESPONSE")).toBeDefined();
    });
  });

  describe("custom error messages", () => {
    it("should use custom error messages when provided", async () => {
      const customConfig: PaymentMiddlewareConfig = {
        ...middlewareConfig,
        errorMessages: {
          paymentRequired: "Custom payment required message",
          invalidPayment: "Custom invalid payment message",
          verificationFailed: "Custom verification failed message",
          settlementFailed: "Custom settlement failed message",
        },
      };

      const wrappedHandler = withX402(
        mockHandler,
        payTo,
        {
          price: 1.0,
          network: "base-sepolia",
          config: customConfig,
        },
        facilitatorConfig,
      );

      const request = {
        ...mockRequest,
        headers: new Headers({
          Accept: "application/json",
        }),
      } as NextRequest;

      const response = await wrappedHandler(request);

      expect(response.status).toBe(402);
      const json = (await response.json()) as { error: string };
      expect(json.error).toBe("Custom payment required message");
    });
  });
});
