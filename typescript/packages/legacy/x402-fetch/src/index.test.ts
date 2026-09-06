import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapFetchWithPayment } from "./index";
import { evm, PaymentRequirements } from "x402/types";

vi.mock("x402/client", () => ({
  createPaymentHeader: vi.fn(),
  selectPaymentRequirements: vi.fn(),
}));

type RequestInitWithRetry = RequestInit & { __is402Retry?: boolean };

describe("fetchWithPayment()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockWalletClient: typeof evm.SignerWallet;
  let wrappedFetch: ReturnType<typeof wrapFetchWithPayment>;
  const validPaymentRequirements: PaymentRequirements[] = [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "100000", // 0.1 USDC in base units
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on base-sepolia
    },
  ];

  const createResponse = (status: number, data?: unknown): Response => {
    const response = new Response(JSON.stringify(data), {
      status,
      statusText: status === 402 ? "Payment Required" : "Not Found",
      headers: new Headers(),
    });
    return response;
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    mockFetch = vi.fn();

    mockWalletClient = {
      signMessage: vi.fn(),
    } as unknown as typeof evm.SignerWallet;

    // Mock payment requirements selector
    const { selectPaymentRequirements } = await import("x402/client");
    (selectPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements, _) => requirements[0],
    );

    wrappedFetch = wrapFetchWithPayment(mockFetch, mockWalletClient);
  });

  it("should return the original response for non-402 status codes", async () => {
    const successResponse = createResponse(200, { data: "success" });
    mockFetch.mockResolvedValue(successResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledWith("https://api.example.com", undefined);
  });

  it("should handle 402 errors and retry with payment header", async () => {
    const paymentHeader = "payment-header-value";
    const successResponse = createResponse(200, { data: "success" });

    const { createPaymentHeader, selectPaymentRequirements } = await import("x402/client");
    (createPaymentHeader as ReturnType<typeof vi.fn>).mockResolvedValue(paymentHeader);
    (selectPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements, _) => requirements[0],
    );
    mockFetch
      .mockResolvedValueOnce(
        createResponse(402, { accepts: validPaymentRequirements, x402Version: 1 }),
      )
      .mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    } as RequestInitWithRetry);

    expect(result).toBe(successResponse);
    expect(selectPaymentRequirements).toHaveBeenCalledWith(
      validPaymentRequirements,
      undefined,
      "exact",
    );
    expect(createPaymentHeader).toHaveBeenCalledWith(
      mockWalletClient,
      1,
      validPaymentRequirements[0],
      undefined,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith("https://api.example.com", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": paymentHeader,
        "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
      },
      __is402Retry: true,
    } as RequestInitWithRetry);
  });

  it("should not retry if already retried", async () => {
    const errorResponse = createResponse(402, {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });
    mockFetch.mockResolvedValue(errorResponse);

    await expect(
      wrappedFetch("https://api.example.com", {
        __is402Retry: true,
      } as RequestInitWithRetry),
    ).rejects.toThrow("Payment already attempted");
  });

  it("should allow optional fetch request config", async () => {
    const errorResponse = createResponse(402, {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });
    mockFetch.mockResolvedValue(errorResponse);

    await expect(wrappedFetch("https://api.example.com")).resolves.toBeDefined();
  });

  it("should reject if payment amount exceeds maximum", async () => {
    const errorResponse = createResponse(402, {
      accepts: [
        {
          ...validPaymentRequirements[0],
          maxAmountRequired: "200000", // 0.2 USDC, which exceeds our default max of 0.1 USDC
        },
      ],
      x402Version: 1,
    });
    mockFetch.mockResolvedValue(errorResponse);

    await expect(
      wrappedFetch("https://api.example.com", {
        method: "GET",
      } as RequestInitWithRetry),
    ).rejects.toThrow("Payment amount exceeds maximum allowed");
  });

  it("should reject if payment header creation fails", async () => {
    const paymentError = new Error("Payment failed");
    const { createPaymentHeader } = await import("x402/client");
    (createPaymentHeader as ReturnType<typeof vi.fn>).mockRejectedValue(paymentError);
    mockFetch.mockResolvedValue(
      createResponse(402, { accepts: validPaymentRequirements, x402Version: 1 }),
    );

    await expect(
      wrappedFetch("https://api.example.com", {
        method: "GET",
      } as RequestInitWithRetry),
    ).rejects.toBe(paymentError);
  });
});
