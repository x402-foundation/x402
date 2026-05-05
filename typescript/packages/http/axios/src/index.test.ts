import {
  AxiosError,
  AxiosHeaders,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wrapAxiosWithPayment, wrapAxiosWithPaymentFromConfig } from "./index";
import type { x402Client, x402ClientConfig } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

// Mock the @x402/core/client module
vi.mock("@x402/core/client", () => {
  const MockX402HTTPClient = vi.fn();
  MockX402HTTPClient.prototype.getPaymentRequiredResponse = vi.fn();
  MockX402HTTPClient.prototype.encodePaymentSignatureHeader = vi.fn();
  MockX402HTTPClient.prototype.handlePaymentRequired = vi.fn();
  MockX402HTTPClient.prototype.processPaymentResult = vi.fn();

  const MockX402Client = vi.fn() as ReturnType<typeof vi.fn> & {
    fromConfig: ReturnType<typeof vi.fn>;
  };
  MockX402Client.prototype.createPaymentPayload = vi.fn();
  MockX402Client.fromConfig = vi.fn();

  return {
    x402HTTPClient: MockX402HTTPClient,
    x402Client: MockX402Client,
  };
});

describe("wrapAxiosWithPayment()", () => {
  let mockAxiosClient: AxiosInstance;
  let mockClient: x402Client;
  let interceptor: (error: AxiosError) => Promise<AxiosResponse>;

  const validPaymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        extra: {},
      } as PaymentRequirements,
    ],
  };

  const validPaymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: validPaymentRequired.resource,
    accepted: validPaymentRequired.accepts[0],
    payload: { signature: "0xmocksignature" },
  };

  const createErrorConfig = (isRetry = false): InternalAxiosRequestConfig =>
    ({
      headers: new AxiosHeaders(),
      url: "https://api.example.com",
      method: "GET",
      ...(isRetry ? { __is402Retry: true } : {}),
    }) as InternalAxiosRequestConfig;

  const createAxiosError = (
    status: number,
    config?: InternalAxiosRequestConfig,
    data?: PaymentRequired,
    headers?: Record<string, string>,
  ): AxiosError => {
    return new AxiosError(
      "Error",
      "ERROR",
      config,
      {},
      {
        status,
        statusText: status === 402 ? "Payment Required" : "Not Found",
        data,
        headers: headers || {},
        config: config || createErrorConfig(),
      },
    );
  };

  const createAxiosResponse = (
    status: number,
    data?: unknown,
    headers?: Record<string, string>,
  ): AxiosResponse =>
    ({
      status,
      statusText: status === 402 ? "Payment Required" : "OK",
      data,
      headers: headers || {},
      config: createErrorConfig(),
    }) as AxiosResponse;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Mock axios client
    mockAxiosClient = {
      interceptors: {
        response: {
          use: vi.fn(),
        },
      },
      request: vi.fn(),
    } as unknown as AxiosInstance;

    // Create mock client
    const { x402Client: MockX402Client, x402HTTPClient: MockX402HTTPClient } = await import(
      "@x402/core/client"
    );

    mockClient = new MockX402Client() as unknown as x402Client;

    // Setup default mock implementations
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      validPaymentPayload,
    );

    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockReturnValue(validPaymentRequired);
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      "PAYMENT-SIGNATURE": "encoded-payment-header",
    });
    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ recovered: false });

    // Set up the interceptor
    wrapAxiosWithPayment(mockAxiosClient, mockClient);
    interceptor = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
  });

  it("should return the axios client instance", () => {
    const result = wrapAxiosWithPayment(mockAxiosClient, mockClient);
    expect(result).toBe(mockAxiosClient);
  });

  it("should set up response interceptor", () => {
    expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalled();
  });

  it("should pass through successful responses", async () => {
    const successHandler = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    const response = { data: "success" } as AxiosResponse;
    expect(successHandler(response)).toBe(response);
  });

  it("should not handle non-402 errors", async () => {
    const error = createAxiosError(404);
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should not handle errors without response", async () => {
    const error = new AxiosError("Network Error", "ECONNREFUSED");
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should handle 402 errors and retry with payment header", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = { data: "success" } as AxiosResponse;

    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired, {
      "PAYMENT-REQUIRED": "encoded-payment-required",
    });

    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(validPaymentRequired);
    expect(MockX402HTTPClient.prototype.encodePaymentSignatureHeader).toHaveBeenCalledWith(
      validPaymentPayload,
    );
    expect(mockAxiosClient.request).toHaveBeenCalled();

    // Verify the retry config has payment headers and retry flag
    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.__is402Retry).toBe(true);
  });

  it("should not retry if already retried", async () => {
    const error = createAxiosError(402, createErrorConfig(true), validPaymentRequired);
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should reject if missing request config", async () => {
    const error = createAxiosError(402, undefined, validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow("Missing axios request configuration");
  });

  it("should reject if missing headers in config", async () => {
    const configWithoutHeaders = {
      url: "https://api.example.com",
      method: "GET",
    } as InternalAxiosRequestConfig;

    const error = createAxiosError(402, configWithoutHeaders, validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow("Missing axios request configuration");
  });

  it("should reject with descriptive error if payment requirements parsing fails", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error("Invalid payment header format");
    });

    const error = createAxiosError(402, createErrorConfig(), undefined);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to parse payment requirements: Invalid payment header format",
    );
  });

  it("should reject with descriptive error if payment payload creation fails", async () => {
    const paymentError = new Error("Insufficient funds");
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockRejectedValue(paymentError);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to create payment payload: Insufficient funds",
    );
  });

  it("should reject with generic error message for unknown parsing errors", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw "String error"; // Non-Error thrown
    });

    const error = createAxiosError(402, createErrorConfig(), undefined);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to parse payment requirements: Unknown error",
    );
  });

  it("should reject with generic error message for unknown payment creation errors", async () => {
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockRejectedValue("String error");

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    await expect(interceptor(error)).rejects.toThrow(
      "Failed to create payment payload: Unknown error",
    );
  });

  it("should handle v1 payment responses from body", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = { data: "success" } as AxiosResponse;

    const v1PaymentRequired: PaymentRequired = {
      ...validPaymentRequired,
      x402Version: 1,
    };

    const v1PaymentPayload: PaymentPayload = {
      ...validPaymentPayload,
      x402Version: 1,
    };

    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockReturnValue(v1PaymentRequired);
    (
      MockX402HTTPClient.prototype.encodePaymentSignatureHeader as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      "X-PAYMENT": "v1-payment-header",
    });
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      v1PaymentPayload,
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), v1PaymentRequired);

    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.encodePaymentSignatureHeader).toHaveBeenCalledWith(
      v1PaymentPayload,
    );
  });

  it("should propagate retry errors", async () => {
    const retryError = new Error("Retry failed");
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockRejectedValue(retryError);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);

    await expect(interceptor(error)).rejects.toBe(retryError);
  });

  it("should set Access-Control-Expose-Headers on retry request", async () => {
    const successResponse = { data: "success" } as AxiosResponse;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);

    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers.get("Access-Control-Expose-Headers")).toBe(
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
  });

  it("should recover from a corrective 402 paid retry with one fresh payload retry", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "corrective-payment-required",
    });
    const successResponse = createAxiosResponse(
      200,
      { data: "success" },
      {
        "PAYMENT-RESPONSE": "settled",
      },
    );
    const freshPaymentPayload: PaymentPayload = {
      ...validPaymentPayload,
      payload: { signature: "0xfreshsignature" },
    };

    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(validPaymentPayload)
      .mockResolvedValueOnce(freshPaymentPayload);
    (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ recovered: true })
      .mockResolvedValueOnce({ recovered: false });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(correctiveResponse)
      .mockResolvedValueOnce(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(2);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenNthCalledWith(
      1,
      validPaymentPayload,
      expect.any(Function),
      402,
    );
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenNthCalledWith(
      2,
      freshPaymentPayload,
      expect.any(Function),
      200,
    );
  });

  it("should return a corrective 402 paid retry when recovery does not run", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "corrective-payment-required",
    });

    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(correctiveResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(correctiveResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledWith(
      validPaymentPayload,
      expect.any(Function),
      402,
    );
  });

  it("should preserve caller validateStatus for non-402 retry statuses", async () => {
    const successResponse = createAxiosResponse(200, { data: "success" });
    const config = createErrorConfig();
    config.validateStatus = status => status === 409;
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, config, validPaymentRequired);
    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.validateStatus(402)).toBe(true);
    expect(retryConfig.validateStatus(409)).toBe(true);
    expect(retryConfig.validateStatus(200)).toBe(false);
    expect(retryConfig.validateStatus(500)).toBe(false);
  });

  it("should fall through to paid retry when hook retry returns 402", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const hookResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "hook-payment-required",
    });
    const successResponse = createAxiosResponse(200, { data: "success" });

    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ "X-HOOK": "handled" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(hookResponse)
      .mockResolvedValueOnce(successResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(successResponse);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    const hookConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const paidConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(hookConfig.validateStatus(402)).toBe(true);
    expect(hookConfig.headers.get("X-HOOK")).toBe("handled");
    expect(paidConfig.headers.get("PAYMENT-SIGNATURE")).toBe("encoded-payment-header");
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(validPaymentRequired);
  });
});

describe("wrapAxiosWithPaymentFromConfig()", () => {
  let mockAxiosClient: AxiosInstance;

  beforeEach(async () => {
    vi.resetAllMocks();

    mockAxiosClient = {
      interceptors: {
        response: {
          use: vi.fn(),
        },
      },
      request: vi.fn(),
    } as unknown as AxiosInstance;

    const { x402Client: MockX402Client } = await import("@x402/core/client");
    (MockX402Client.fromConfig as ReturnType<typeof vi.fn>).mockReturnValue(new MockX402Client());
  });

  it("should create client from config and wrap axios", async () => {
    const { x402Client: MockX402Client } = await import("@x402/core/client");

    const config: x402ClientConfig = {
      schemes: [],
    };

    const result = wrapAxiosWithPaymentFromConfig(mockAxiosClient, config);

    expect(MockX402Client.fromConfig).toHaveBeenCalledWith(config);
    expect(result).toBe(mockAxiosClient);
    expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalled();
  });

  it("should return the axios client instance", () => {
    const config: x402ClientConfig = {
      schemes: [],
    };

    const result = wrapAxiosWithPaymentFromConfig(mockAxiosClient, config);
    expect(result).toBe(mockAxiosClient);
  });
});
