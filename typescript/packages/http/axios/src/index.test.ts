import {
  AxiosError,
  AxiosHeaders,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaidResponseValidationError,
  wrapAxiosWithPayment,
  wrapAxiosWithPaymentFromConfig,
  type PaidResponseValidationView,
  type ValidatePaidResponse,
  type ValidatePaidResponseContext,
} from "./index";
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
  headers?: AxiosResponse["headers"],
): AxiosResponse =>
  ({
    status,
    statusText: status === 402 ? "Payment Required" : "OK",
    data,
    headers: headers || {},
    config: createErrorConfig(),
  }) as AxiosResponse;

const createMockAxiosInstance = (): AxiosInstance =>
  ({
    interceptors: {
      response: {
        use: vi.fn(),
      },
    },
    request: vi.fn(),
  }) as unknown as AxiosInstance;

/**
 * Installs default x402 client/HTTP-client mocks and returns a mock x402Client.
 *
 * @returns Mock x402 client with default paid-flow implementations
 */
const createDefaultMockClient = async (): Promise<x402Client> => {
  const { x402Client: MockX402Client, x402HTTPClient: MockX402HTTPClient } = await import(
    "@x402/core/client"
  );

  const mockClient = new MockX402Client() as unknown as x402Client;
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
  (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>).mockResolvedValue(
    { recovered: false },
  );

  return mockClient;
};

const getErrorInterceptor = (
  axiosInstance: AxiosInstance,
): ((error: AxiosError) => Promise<AxiosResponse>) =>
  (axiosInstance.interceptors.response.use as ReturnType<typeof vi.fn>).mock.calls[0][1];

const getSuccessHandler = (axiosInstance: AxiosInstance): ((response: AxiosResponse) => unknown) =>
  (axiosInstance.interceptors.response.use as ReturnType<typeof vi.fn>).mock.calls[0][0];

/**
 * Asserts the validator received a detached copy, not the live Axios response.
 *
 * @param validator - Mock validator
 * @param response - Original paid Axios response
 * @param recovered - Whether the paid attempt used the recovery path
 */
const expectDetachedValidationView = (
  validator: ReturnType<typeof vi.fn>,
  response: AxiosResponse,
  recovered: boolean,
): void => {
  expect(validator).toHaveBeenCalledTimes(1);
  const [view, context] = validator.mock.calls[0] as [
    PaidResponseValidationView,
    ValidatePaidResponseContext,
  ];
  expect(view).not.toBe(response);
  expect(view.status).toBe(response.status);
  expect(view.statusText).toBe(response.statusText);
  expect(view.data).toEqual(response.data);
  if (response.data !== null && typeof response.data === "object") {
    expect(view.data).not.toBe(response.data);
  }
  expect(view.headers).not.toBe(response.headers);
  expect(context.recovered).toBe(recovered);
  expect(context.paymentRequired).toEqual(validPaymentRequired);
  expect(context.paymentRequired).not.toBe(validPaymentRequired);
};

describe("wrapAxiosWithPayment()", () => {
  let mockAxiosClient: AxiosInstance;
  let mockClient: x402Client;
  let interceptor: (error: AxiosError) => Promise<AxiosResponse>;

  beforeEach(async () => {
    vi.resetAllMocks();
    mockAxiosClient = createMockAxiosInstance();
    mockClient = await createDefaultMockClient();
    wrapAxiosWithPayment(mockAxiosClient, mockClient);
    interceptor = getErrorInterceptor(mockAxiosClient);
  });

  it("should return the axios client instance", () => {
    const result = wrapAxiosWithPayment(mockAxiosClient, mockClient);
    expect(result).toBe(mockAxiosClient);
  });

  it("should set up response interceptor", () => {
    expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalled();
  });

  it("should pass through successful responses", async () => {
    const response = { data: "success" } as AxiosResponse;
    expect(getSuccessHandler(mockAxiosClient)(response)).toBe(response);
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
    expect(retryConfig.headers["Access-Control-Expose-Headers"]).toBe(
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
  });

  it("should clone retry headers into a serializable record", async () => {
    /**
     * Minimal axios-like headers object with a Map-backed set and JSON serialization.
     */
    class CallerAxiosHeaders {
      private readonly values = new Map<string, string>();

      /**
       * Stores a header name/value pair.
       *
       * @param key - Header name
       * @param value - Header value
       */
      set(key: string, value: string): void {
        this.values.set(key, value);
      }

      /**
       * Returns headers as a plain object for JSON-style cloning.
       *
       * @returns Header entries as a string record
       */
      toJSON(): Record<string, string> {
        return Object.fromEntries(this.values);
      }
    }

    const successResponse = { data: "success" } as AxiosResponse;
    const config = createErrorConfig();
    const callerHeaders = new CallerAxiosHeaders();
    callerHeaders.set("Accept", "application/json");
    config.headers = callerHeaders as unknown as InternalAxiosRequestConfig["headers"];
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, config, validPaymentRequired);
    await interceptor(error);

    const retryConfig = (mockAxiosClient.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(retryConfig.headers).not.toBeInstanceOf(CallerAxiosHeaders);
    expect(retryConfig.headers).not.toBe(callerHeaders);
    expect(retryConfig.headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        "PAYMENT-SIGNATURE": "encoded-payment-header",
      }),
    );
    expect(Object.values(retryConfig.headers).some(value => typeof value === "function")).toBe(
      false,
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
    expect(hookConfig.headers["X-HOOK"]).toBe("handled");
    expect(paidConfig.headers["PAYMENT-SIGNATURE"]).toBe("encoded-payment-header");
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(validPaymentRequired);
  });
});

describe("wrapAxiosWithPaymentFromConfig()", () => {
  let mockAxiosClient: AxiosInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    mockAxiosClient = createMockAxiosInstance();

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

describe("wrapAxiosWithPayment() paid-response validation", () => {
  let mockAxiosClient: AxiosInstance;
  let mockClient: x402Client;

  /**
   * Wraps a mock Axios instance and returns the 402 error interceptor.
   *
   * @param validatePaidResponse - Optional caller-owned paid-response validator
   * @returns Error interceptor installed by wrapAxiosWithPayment
   */
  const wrapAndGetInterceptor = (
    validatePaidResponse?: ValidatePaidResponse,
  ): ((error: AxiosError) => Promise<AxiosResponse>) => {
    wrapAxiosWithPayment(mockAxiosClient, mockClient, {
      validatePaidResponse,
    });
    return getErrorInterceptor(mockAxiosClient);
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    mockAxiosClient = createMockAxiosInstance();
    mockClient = await createDefaultMockClient();
  });

  it("should not invoke a validator on a free initial 200", async () => {
    const validator = vi.fn();
    wrapAxiosWithPayment(mockAxiosClient, mockClient, {
      validatePaidResponse: validator,
    });
    const response = createAxiosResponse(200, { ok: true });

    expect(getSuccessHandler(mockAxiosClient)(response)).toBe(response);
    expect(validator).not.toHaveBeenCalled();
    expect(mockAxiosClient.request).not.toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("should not invoke a validator on pre-payment hook success", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const hookResponse = createAxiosResponse(200, { hooked: true });

    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ "X-HOOK": "handled" });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(hookResponse);

    const error = createAxiosError(402, createErrorConfig(), validPaymentRequired);
    const result = await interceptor(error);

    expect(result).toBe(hookResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
  });

  it("should keep current behavior when the validator option is absent", async () => {
    const interceptor = wrapAndGetInterceptor();
    const successResponse = createAxiosResponse(
      200,
      { report: { weather: "sunny" } },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(successResponse);
    expect(result.data).toEqual({ report: { weather: "sunny" } });
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should return the original paid response when the validator succeeds on a detached view", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn().mockResolvedValue(undefined);
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(
      200,
      { report: { weather: "sunny" } },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(successResponse);
    expectDetachedValidationView(validator, successResponse, false);
    expect(
      (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(validator.mock.invocationCallOrder[0]);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should not validate a terminal post-payment 402", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const terminalResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "terminal-payment-required",
    });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(terminalResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(terminalResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(1);
  });

  it("should preserve settlement evidence and not repay when the validator fails", async () => {
    const validator = vi.fn().mockImplementation(() => {
      throw new Error("missing report.weather");
    });
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(
      200,
      { report: {} },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const rejection = interceptor(createAxiosError(402, createErrorConfig(), validPaymentRequired));

    await expect(rejection).rejects.toBeInstanceOf(PaidResponseValidationError);
    const error = await rejection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "missing report.weather",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
      paymentResponseHeader: "settled-header",
    });
    expect((error as PaidResponseValidationError).cause).toBeInstanceOf(Error);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should bind a caller-thrown typed validation error to the actual paid response", async () => {
    const successResponse = createAxiosResponse(
      200,
      { report: {} },
      { "payment-response": "actual-settled" },
    );
    const foreignResponse = createAxiosResponse(
      200,
      { foreign: true },
      { "payment-response": "foreign-settled" },
    );
    const foreignPaymentRequired: PaymentRequired = {
      ...validPaymentRequired,
      resource: {
        ...validPaymentRequired.resource,
        url: "https://foreign.example/resource",
      },
    };
    const callerError = new PaidResponseValidationError(
      "caller typed failure",
      foreignResponse,
      foreignPaymentRequired,
      true,
    );
    const interceptor = wrapAndGetInterceptor(() => {
      throw new PaidResponseValidationError(
        callerError.message,
        callerError.response,
        callerError.paymentRequired,
        callerError.recovered,
      );
    });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const rebound = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);
    expect(rebound).toMatchObject({
      name: "PaidResponseValidationError",
      message: "caller typed failure",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
      paymentResponseHeader: "actual-settled",
    });
    expect((rebound as PaidResponseValidationError).cause).toBeInstanceOf(
      PaidResponseValidationError,
    );
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should validate a recovery paid success exactly once and not repay on failure", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn().mockImplementation(() => {
      throw new Error("invalid recovered body");
    });
    const interceptor = wrapAndGetInterceptor(validator);
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "corrective-payment-required",
    });
    const recoveredResponse = createAxiosResponse(
      200,
      { report: { weather: "cloudy" } },
      { "PAYMENT-RESPONSE": "recovered-settled" },
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
      .mockResolvedValueOnce(recoveredResponse);

    const rejection = interceptor(createAxiosError(402, createErrorConfig(), validPaymentRequired));
    const error = await rejection.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      response: recoveredResponse,
      recovered: true,
      paymentResponseHeader: "recovered-settled",
      paymentRequired: validPaymentRequired,
    });
    expectDetachedValidationView(validator, recoveredResponse, true);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(2);
  });

  it("should return a recovered paid body when the validator succeeds", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired);
    const recoveredResponse = createAxiosResponse(
      200,
      { report: { weather: "sunny" } },
      { "PAYMENT-RESPONSE": "recovered-settled" },
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
      .mockResolvedValueOnce(recoveredResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(recoveredResponse);
    expectDetachedValidationView(validator, recoveredResponse, true);
    const processPaymentResult = MockX402HTTPClient.prototype.processPaymentResult as ReturnType<
      typeof vi.fn
    >;
    expect(processPaymentResult.mock.invocationCallOrder[0]).toBeLessThan(
      processPaymentResult.mock.invocationCallOrder[1],
    );
    expect(processPaymentResult.mock.invocationCallOrder[1]).toBeLessThan(
      validator.mock.invocationCallOrder[0],
    );
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });

  it("should not validate a terminal 402 after one bounded recovery", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const correctiveResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "corrective-payment-required",
    });
    const terminalResponse = createAxiosResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "terminal-payment-required",
    });
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
      .mockResolvedValueOnce(terminalResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(terminalResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(2);
  });

  it("should pass validatePaidResponse through wrapAxiosWithPaymentFromConfig", async () => {
    const { x402Client: MockX402Client, x402HTTPClient: MockX402HTTPClient } = await import(
      "@x402/core/client"
    );
    const validator = vi.fn();
    const configClient = new MockX402Client() as unknown as x402Client;
    (MockX402Client.fromConfig as ReturnType<typeof vi.fn>).mockReturnValue(configClient);
    (configClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      validPaymentPayload,
    );
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ recovered: false });

    const successResponse = createAxiosResponse(
      200,
      { ok: true },
      { "PAYMENT-RESPONSE": "from-config-settled" },
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    wrapAxiosWithPaymentFromConfig(
      mockAxiosClient,
      { schemes: [] },
      { validatePaidResponse: validator },
    );
    const interceptor = getErrorInterceptor(mockAxiosClient);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(successResponse);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(configClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
  });

  it("should keep the original body when a hostile validator mutates the detached view", async () => {
    const data = { report: { weather: "sunny" } };
    const headers = { "PAYMENT-RESPONSE": "settled-header" };
    const successResponse = createAxiosResponse(200, data, headers);
    const validator = vi.fn().mockImplementation((view: PaidResponseValidationView) => {
      (view.data as { report: { weather: string } }).report.weather = "pwned";
      view.headers["PAYMENT-RESPONSE"] = "forged";
    });
    const interceptor = wrapAndGetInterceptor(validator);
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(successResponse);
    expect(result.data).toEqual({ report: { weather: "sunny" } });
    expect(result.headers["PAYMENT-RESPONSE"]).toBe("settled-header");
  });

  it("should preserve original evidence when validation mutates data, headers, and paymentRequired", async () => {
    const headers = new AxiosHeaders();
    headers.set("PAYMENT-RESPONSE", "settled-header");
    const data = { report: { weather: "sunny" } };
    const successResponse = createAxiosResponse(200, data, headers);
    const validator = vi
      .fn()
      .mockImplementation(
        (view: PaidResponseValidationView, context: ValidatePaidResponseContext) => {
          (view.data as { report: { weather: string } }).report.weather = "pwned";
          delete view.headers["PAYMENT-RESPONSE"];
          delete view.headers["payment-response"];
          view.headers["PAYMENT-RESPONSE"] = "forged";
          context.paymentRequired.resource.url = "https://evil.example/resource";
          context.paymentRequired.accepts.splice(0);
          throw new Error("hostile rejection");
        },
      );
    const interceptor = wrapAndGetInterceptor(validator);
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      message: "hostile rejection",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
      paymentResponseHeader: "settled-header",
    });
    expect((error as PaidResponseValidationError).response.data).toEqual({
      report: { weather: "sunny" },
    });
    expect(headers.get("PAYMENT-RESPONSE")).toBe("settled-header");
    expect(validPaymentRequired.resource.url).toBe("https://api.example.com/resource");
    expect(validPaymentRequired.accepts).toHaveLength(1);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should validate a post-payment success when PAYMENT-RESPONSE is absent", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(200, { report: { weather: "sunny" } });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const result = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    );

    expect(result).toBe(successResponse);
    expectDetachedValidationView(validator, successResponse, false);
    expect(
      (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(validator.mock.invocationCallOrder[0]);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should preserve absent PAYMENT-RESPONSE evidence when validation fails", async () => {
    const validator = vi.fn().mockImplementation(() => {
      throw new Error("invalid body");
    });
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(200, { report: {} });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "invalid body",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
    });
    expect((error as PaidResponseValidationError).paymentResponseHeader).toBeUndefined();
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should preserve pre-validator header absence when hostile validation mutates the original response", async () => {
    const successResponse = createAxiosResponse(200, { report: {} });
    const validator = vi.fn().mockImplementation(() => {
      successResponse.headers["PAYMENT-RESPONSE"] = "forged-after-snapshot";
      throw new Error("invalid body");
    });
    const interceptor = wrapAndGetInterceptor(validator);
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "invalid body",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
    });
    expect((error as PaidResponseValidationError).paymentResponseHeader).toBeUndefined();
    expect((error as PaidResponseValidationError).response.headers["PAYMENT-RESPONSE"]).toBe(
      "forged-after-snapshot",
    );
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should fail closed on a stream-like body without consuming it", async () => {
    let consumed = false;
    const streamBody = {
      /**
       * Marks the stream as consumed when piped.
       *
       * @param dest - Pipe destination
       * @returns The destination
       */
      pipe(dest: unknown) {
        consumed = true;
        return dest;
      },
      /**
       * Marks the stream as consumed when read.
       *
       * @returns No buffered chunk
       */
      read() {
        consumed = true;
        return null;
      },
      /**
       * Registers a listener without consuming.
       *
       * @returns This stream-like object
       */
      on() {
        return this;
      },
    };
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(200, streamBody, {
      "PAYMENT-RESPONSE": "settled-header",
    });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      message: "Paid response cannot be detached for validation",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
      paymentResponseHeader: "settled-header",
    });
    expect((error as PaidResponseValidationError).response.data).toBe(streamBody);
    expect(consumed).toBe(false);
    expect(validator).not.toHaveBeenCalled();
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should fail closed on a web-stream-like body without calling getReader", async () => {
    let consumed = false;
    const streamBody = {
      /**
       * Would consume the body if the SDK called it while detaching.
       *
       * @returns A reader stub
       */
      getReader() {
        consumed = true;
        return {
          /**
           * Marks the stream as consumed.
           *
           * @returns An empty read result
           */
          read() {
            consumed = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(200, streamBody, {
      "PAYMENT-RESPONSE": "settled-header",
    });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "Paid response cannot be detached for validation",
      response: successResponse,
      paymentResponseHeader: "settled-header",
    });
    expect(consumed).toBe(false);
    expect(validator).not.toHaveBeenCalled();
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should fail closed on a non-cloneable body without invoking the validator", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const body = {
      report: { weather: "sunny" },
      fn: () => "secret",
    };
    const validator = vi.fn();
    const interceptor = wrapAndGetInterceptor(validator);
    const successResponse = createAxiosResponse(200, body, {
      "PAYMENT-RESPONSE": "settled-header",
    });
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = await interceptor(
      createAxiosError(402, createErrorConfig(), validPaymentRequired),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      message: "Paid response cannot be detached for validation",
      response: successResponse,
      paymentResponseHeader: "settled-header",
    });
    expect((error as PaidResponseValidationError).response.data).toBe(body);
    expect(validator).not.toHaveBeenCalled();
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(1);
    expect(mockAxiosClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });
});
