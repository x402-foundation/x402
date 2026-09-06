import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaidResponseValidationError,
  wrapFetchWithPayment,
  wrapFetchWithPaymentFromConfig,
  type ValidatePaidResponseContext,
} from "./index";
import type { x402Client, x402HTTPClient, x402ClientConfig } from "@x402/core/client";
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

const createResponse = (
  status: number,
  data?: unknown,
  headers?: Record<string, string>,
): Response => {
  return new Response(data ? JSON.stringify(data) : null, {
    status,
    statusText: status === 402 ? "Payment Required" : "OK",
    headers: new Headers(headers),
  });
};

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

describe("wrapFetchWithPayment()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockClient: x402Client;
  let wrappedFetch: ReturnType<typeof wrapFetchWithPayment>;

  beforeEach(async () => {
    vi.resetAllMocks();
    mockFetch = vi.fn();
    mockClient = await createDefaultMockClient();
    wrappedFetch = wrapFetchWithPayment(mockFetch, mockClient);
  });

  it("should return the original response for non-402 status codes", async () => {
    const successResponse = createResponse(200, { data: "success" });
    mockFetch.mockResolvedValue(successResponse);

    const result = await wrappedFetch("https://api.example.com", { method: "GET" });

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const request = mockFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("https://api.example.com/");
    expect(request.method).toBe("GET");
  });

  it("should handle 402 errors and retry with payment header", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createResponse(200, { data: "success" });

    mockFetch
      .mockResolvedValueOnce(
        createResponse(402, validPaymentRequired, { "PAYMENT-REQUIRED": "encoded-header" }),
      )
      .mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(validPaymentRequired);
    expect(MockX402HTTPClient.prototype.encodePaymentSignatureHeader).toHaveBeenCalledWith(
      validPaymentPayload,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the retry request is a Request object with correct headers
    const retryCall = mockFetch.mock.calls[1];
    const retryRequest = retryCall[0] as Request;
    expect(retryRequest.headers.get("Content-Type")).toBe("application/json");
    expect(retryRequest.headers.get("PAYMENT-SIGNATURE")).toBe("encoded-payment-header");
    expect(retryRequest.headers.get("Access-Control-Expose-Headers")).toBe(
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
  });

  it("should not retry if already retried (PAYMENT-SIGNATURE header present)", async () => {
    mockFetch.mockResolvedValue(createResponse(402, validPaymentRequired));

    await expect(
      wrappedFetch("https://api.example.com", {
        method: "GET",
        headers: { "PAYMENT-SIGNATURE": "already-present" },
      }),
    ).rejects.toThrow("Payment already attempted");
  });

  it("should not retry if already retried (X-PAYMENT header present)", async () => {
    mockFetch.mockResolvedValue(createResponse(402, validPaymentRequired));

    await expect(
      wrappedFetch("https://api.example.com", {
        method: "GET",
        headers: { "X-PAYMENT": "already-present" },
      }),
    ).rejects.toThrow("Payment already attempted");
  });

  it("should allow optional fetch request config", async () => {
    const successResponse = createResponse(200, { data: "success" });

    mockFetch.mockResolvedValueOnce(createResponse(402, validPaymentRequired));
    mockFetch.mockResolvedValueOnce(successResponse);

    await expect(wrappedFetch("https://api.example.com")).resolves.toBe(successResponse);
  });

  it("should reject with descriptive error if payment requirements parsing fails", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error("Invalid payment header format");
    });

    mockFetch.mockResolvedValue(createResponse(402, undefined));

    await expect(wrappedFetch("https://api.example.com", { method: "GET" })).rejects.toThrow(
      "Failed to parse payment requirements: Invalid payment header format",
    );
  });

  it("should reject with descriptive error if payment payload creation fails", async () => {
    const paymentError = new Error("Insufficient funds");
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockRejectedValue(paymentError);

    mockFetch.mockResolvedValue(createResponse(402, validPaymentRequired));

    await expect(wrappedFetch("https://api.example.com", { method: "GET" })).rejects.toThrow(
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

    mockFetch.mockResolvedValue(createResponse(402, undefined));

    await expect(wrappedFetch("https://api.example.com", { method: "GET" })).rejects.toThrow(
      "Failed to parse payment requirements: Unknown error",
    );
  });

  it("should reject with generic error message for unknown payment creation errors", async () => {
    (mockClient.createPaymentPayload as ReturnType<typeof vi.fn>).mockRejectedValue("String error");

    mockFetch.mockResolvedValue(createResponse(402, validPaymentRequired));

    await expect(wrappedFetch("https://api.example.com", { method: "GET" })).rejects.toThrow(
      "Failed to create payment payload: Unknown error",
    );
  });

  it("should handle v1 payment responses from body", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createResponse(200, { data: "success" });

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

    mockFetch.mockResolvedValueOnce(createResponse(402, v1PaymentRequired));
    mockFetch.mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com", { method: "GET" });

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.encodePaymentSignatureHeader).toHaveBeenCalledWith(
      v1PaymentPayload,
    );

    // Verify v1 payment header was set correctly
    const retryCall = mockFetch.mock.calls[1];
    const retryRequest = retryCall[0] as Request;
    expect(retryRequest.headers.get("X-PAYMENT")).toBe("v1-payment-header");
  });

  it("should propagate retry errors", async () => {
    const retryError = new Error("Network error on retry");

    mockFetch.mockResolvedValueOnce(createResponse(402, validPaymentRequired));
    mockFetch.mockRejectedValueOnce(retryError);

    await expect(wrappedFetch("https://api.example.com", { method: "GET" })).rejects.toBe(
      retryError,
    );
  });

  it("should set Access-Control-Expose-Headers on retry request", async () => {
    const successResponse = createResponse(200, { data: "success" });

    mockFetch.mockResolvedValueOnce(createResponse(402, validPaymentRequired));
    mockFetch.mockResolvedValueOnce(successResponse);

    await wrappedFetch("https://api.example.com", { method: "GET" });

    const retryCall = mockFetch.mock.calls[1];
    const retryRequest = retryCall[0] as Request;
    expect(retryRequest.headers.get("Access-Control-Expose-Headers")).toBe(
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );
  });

  it("should preserve Headers object during retry", async () => {
    const successResponse = createResponse(200, { data: "success" });

    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    // Use a Headers object instead of a plain object
    const originalHeaders = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Custom-Header": "custom-value",
    });

    await wrappedFetch("https://api.example.com", {
      method: "POST",
      headers: originalHeaders,
    });

    // Verify the retry request includes all original headers plus payment headers
    const retryCall = mockFetch.mock.calls[1];
    const retryRequest = retryCall[0] as Request;

    // Check payment headers were added
    expect(retryRequest.headers.get("PAYMENT-SIGNATURE")).toBe("encoded-payment-header");
    expect(retryRequest.headers.get("Access-Control-Expose-Headers")).toBe(
      "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
    );

    // Check original headers were preserved (this would fail before the fix)
    expect(retryRequest.headers.get("Content-Type")).toBe("application/json");
    expect(retryRequest.headers.get("Accept")).toBe("application/json, text/event-stream");
    expect(retryRequest.headers.get("Custom-Header")).toBe("custom-value");
  });

  it("should handle empty response body gracefully", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createResponse(200, { data: "success" });

    // Response with headers only, no body
    const headerOnlyResponse = new Response("", {
      status: 402,
      headers: new Headers({ "PAYMENT-REQUIRED": "encoded-header" }),
    });

    mockFetch.mockResolvedValueOnce(headerOnlyResponse);
    mockFetch.mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com", { method: "GET" });

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).toHaveBeenCalled();
  });

  it("should handle invalid JSON in response body gracefully", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const successResponse = createResponse(200, { data: "success" });

    // Response with invalid JSON body
    const invalidJsonResponse = new Response("not valid json", {
      status: 402,
      headers: new Headers({ "PAYMENT-REQUIRED": "encoded-header" }),
    });

    mockFetch.mockResolvedValueOnce(invalidJsonResponse);
    mockFetch.mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com", { method: "GET" });

    expect(result).toBe(successResponse);
    expect(MockX402HTTPClient.prototype.getPaymentRequiredResponse).toHaveBeenCalled();
  });

  it("should accept x402HTTPClient directly", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");

    const httpClient = new MockX402HTTPClient(mockClient) as unknown as x402HTTPClient;
    const wrappedWithHttpClient = wrapFetchWithPayment(mockFetch, httpClient);

    const successResponse = createResponse(200, { data: "success" });
    mockFetch.mockResolvedValue(successResponse);

    const result = await wrappedWithHttpClient("https://api.example.com", { method: "GET" });

    expect(result).toBe(successResponse);
  });

  it("should preserve request body on retry (fixes body consumption bug)", async () => {
    const successResponse = createResponse(200, { data: "success" });

    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    const bodyContent = JSON.stringify({ test: "data" });

    await wrappedFetch("https://api.example.com", {
      method: "POST",
      body: bodyContent,
      headers: { "Content-Type": "application/json" },
    });

    // Verify the retry request has the body preserved
    const retryCall = mockFetch.mock.calls[1];
    const retryRequest = retryCall[0] as Request;
    expect(retryRequest.method).toBe("POST");
    const retryBody = await retryRequest.text();
    expect(retryBody).toBe(bodyContent);
  });

  it("should preserve a Request body during payment recovery", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ recovered: true });

    const bodyContent = JSON.stringify({ test: "recovery" });
    const observedBodies: string[] = [];
    const successResponse = createResponse(200, { data: "success" });

    mockFetch.mockImplementation(async (request: Request) => {
      observedBodies.push(await request.text());
      if (observedBodies.length < 3) {
        return createResponse(402, validPaymentRequired);
      }
      return successResponse;
    });

    const input = new Request("https://api.example.com", {
      method: "POST",
      body: bodyContent,
      headers: { "Content-Type": "application/json" },
    });

    const result = await wrappedFetch(input);

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(observedBodies).toEqual([bodyContent, bodyContent, bodyContent]);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);

    const recoveryRequest = mockFetch.mock.calls[2][0] as Request;
    expect(recoveryRequest.headers.get("PAYMENT-SIGNATURE")).toBe("encoded-payment-header");
  });

  it("should preserve headers from Request object input", async () => {
    const successResponse = createResponse(200, { data: "success" });

    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    // Pass a Request object with custom headers (not init)
    const request = new Request("https://api.example.com", {
      method: "GET",
      headers: { "Custom-Header": "custom-value", Authorization: "Bearer token" },
    });

    await wrappedFetch(request);

    // Verify the retry request has all headers preserved
    const retryCall = mockFetch.mock.calls[1];
    const retryRequest = retryCall[0] as Request;
    expect(retryRequest.headers.get("Custom-Header")).toBe("custom-value");
    expect(retryRequest.headers.get("Authorization")).toBe("Bearer token");
    expect(retryRequest.headers.get("PAYMENT-SIGNATURE")).toBe("encoded-payment-header");
  });
});

describe("wrapFetchWithPaymentFromConfig()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();

    mockFetch = vi.fn();

    const { x402Client: MockX402Client, x402HTTPClient: MockX402HTTPClient } = await import(
      "@x402/core/client"
    );
    (MockX402Client.fromConfig as ReturnType<typeof vi.fn>).mockReturnValue(new MockX402Client());

    (
      MockX402HTTPClient.prototype.getPaymentRequiredResponse as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      x402Version: 2,
      resource: { url: "test", description: "test", mimeType: "text/plain" },
      accepts: [],
    });
    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (
      MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ recovered: false });
  });

  it("should create client from config and wrap fetch", async () => {
    const { x402Client: MockX402Client } = await import("@x402/core/client");

    const config: x402ClientConfig = {
      schemes: [],
    };

    const wrappedFetch = wrapFetchWithPaymentFromConfig(mockFetch, config);

    expect(MockX402Client.fromConfig).toHaveBeenCalledWith(config);
    expect(typeof wrappedFetch).toBe("function");
  });

  it("should return wrapped fetch function", async () => {
    const config: x402ClientConfig = {
      schemes: [],
    };

    const wrappedFetch = wrapFetchWithPaymentFromConfig(mockFetch, config);
    const successResponse = new Response(JSON.stringify({ data: "success" }), { status: 200 });
    mockFetch.mockResolvedValue(successResponse);

    const result = await wrappedFetch("https://api.example.com", { method: "GET" });

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe("wrapFetchWithPayment() paid-response validation", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockClient: x402Client;

  const wrapWithValidator = (
    validator?: (response: Response, context: ValidatePaidResponseContext) => void | Promise<void>,
  ) => wrapFetchWithPayment(mockFetch, mockClient, { validatePaidResponse: validator });

  const expectDetachedValidationCall = (
    validator: ReturnType<typeof vi.fn>,
    response: Response,
    recovered: boolean,
  ): void => {
    expect(validator).toHaveBeenCalledTimes(1);
    const [view, context] = validator.mock.calls[0] as [Response, ValidatePaidResponseContext];
    expect(view).not.toBe(response);
    expect(view.status).toBe(response.status);
    expect(context.recovered).toBe(recovered);
    expect(context.paymentRequired).toEqual(validPaymentRequired);
  };

  const setupRecoveryFlow = async (finalResponse: Response): Promise<void> => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ recovered: true })
      .mockResolvedValueOnce({ recovered: false });
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(
        createResponse(402, validPaymentRequired, { "PAYMENT-REQUIRED": "corrective" }),
      )
      .mockResolvedValueOnce(finalResponse);
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    mockFetch = vi.fn();
    mockClient = await createDefaultMockClient();
  });

  it("should not invoke a validator on a free initial 200", async () => {
    const validator = vi.fn();
    const wrappedFetch = wrapWithValidator(validator);
    const successResponse = createResponse(200, { ok: true });
    mockFetch.mockResolvedValue(successResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(successResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("should not invoke a validator on pre-payment hook success", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const wrappedFetch = wrapWithValidator(validator);
    const hookResponse = createResponse(200, { hooked: true });

    (
      MockX402HTTPClient.prototype.handlePaymentRequired as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ "X-HOOK": "handled" });
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(hookResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(hookResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should keep current behavior when the validator option is absent", async () => {
    const wrappedFetch = wrapFetchWithPayment(mockFetch, mockClient, {});
    const successResponse = createResponse(
      200,
      { report: { weather: "sunny" } },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(successResponse);
    expect(result.bodyUsed).toBe(false);
    await expect(result.json()).resolves.toEqual({ report: { weather: "sunny" } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should return the original paid response with an unread body when the validator succeeds", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn().mockImplementation(async (view: Response) => {
      await expect(view.json()).resolves.toEqual({ report: { weather: "sunny" } });
    });
    const wrappedFetch = wrapWithValidator(validator);
    const successResponse = createResponse(
      200,
      { report: { weather: "sunny" } },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(successResponse);
    expect(result.bodyUsed).toBe(false);
    await expect(result.json()).resolves.toEqual({ report: { weather: "sunny" } });
    expectDetachedValidationCall(validator, successResponse, false);
    expect(
      (MockX402HTTPClient.prototype.processPaymentResult as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(validator.mock.invocationCallOrder[0]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should not validate a terminal post-payment 402", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const wrappedFetch = wrapWithValidator(validator);
    const terminalResponse = createResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "terminal-payment-required",
    });
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(terminalResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(terminalResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(MockX402HTTPClient.prototype.processPaymentResult).toHaveBeenCalledTimes(1);
  });

  it("should preserve settlement evidence and not repay when the validator fails", async () => {
    const validator = vi.fn().mockImplementation(() => {
      throw new Error("missing report.weather");
    });
    const wrappedFetch = wrapWithValidator(validator);
    const successResponse = createResponse(
      200,
      { report: {} },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    const error = await wrappedFetch("https://api.example.com").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "missing report.weather",
      response: successResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
      paymentResponseHeader: "settled-header",
    });
    expect((error as PaidResponseValidationError).cause).toBeInstanceOf(Error);
    expect((error as PaidResponseValidationError).response.bodyUsed).toBe(false);
    await expect((error as PaidResponseValidationError).response.json()).resolves.toEqual({
      report: {},
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should validate and preserve absent PAYMENT-RESPONSE evidence when validation fails", async () => {
    const validator = vi.fn().mockImplementation(() => {
      throw new Error("invalid body");
    });
    const wrappedFetch = wrapWithValidator(validator);
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(createResponse(200, { report: {} }));

    const error = await wrappedFetch("https://api.example.com").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "invalid body",
      recovered: false,
    });
    expect((error as PaidResponseValidationError).paymentResponseHeader).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should return a recovered paid body when the validator succeeds", async () => {
    const { x402HTTPClient: MockX402HTTPClient } = await import("@x402/core/client");
    const validator = vi.fn();
    const wrappedFetch = wrapWithValidator(validator);
    const recoveredResponse = createResponse(
      200,
      { report: { weather: "cloudy" } },
      { "PAYMENT-RESPONSE": "recovered-settled" },
    );
    await setupRecoveryFlow(recoveredResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(recoveredResponse);
    expectDetachedValidationCall(validator, recoveredResponse, true);
    const processPaymentResult = MockX402HTTPClient.prototype.processPaymentResult as ReturnType<
      typeof vi.fn
    >;
    expect(processPaymentResult).toHaveBeenCalledTimes(2);
    expect(processPaymentResult.mock.invocationCallOrder[1]).toBeLessThan(
      validator.mock.invocationCallOrder[0],
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });

  it("should validate a recovery paid success exactly once and not repay on failure", async () => {
    // Rejects asynchronously with a non-Error to cover the awaited path and the message fallback.
    const validator = vi.fn().mockRejectedValue("invalid recovered body");
    const wrappedFetch = wrapWithValidator(validator);
    const recoveredResponse = createResponse(
      200,
      { report: {} },
      { "X-PAYMENT-RESPONSE": "recovered-settled" },
    );
    await setupRecoveryFlow(recoveredResponse);

    const error = await wrappedFetch("https://api.example.com").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      message: "Paid response validation failed",
      response: recoveredResponse,
      paymentRequired: validPaymentRequired,
      recovered: true,
      paymentResponseHeader: "recovered-settled",
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });

  it("should not validate a terminal 402 after one bounded recovery", async () => {
    const validator = vi.fn();
    const wrappedFetch = wrapWithValidator(validator);
    const terminalResponse = createResponse(402, validPaymentRequired, {
      "PAYMENT-REQUIRED": "terminal-payment-required",
    });
    await setupRecoveryFlow(terminalResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(terminalResponse);
    expect(validator).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });

  it("should fail closed when the paid response cannot be cloned", async () => {
    const validator = vi.fn();
    const wrappedFetch = wrapWithValidator(validator);
    const consumedResponse = createResponse(
      200,
      { report: { weather: "sunny" } },
      { "PAYMENT-RESPONSE": "settled-header" },
    );
    await consumedResponse.text();
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(consumedResponse);

    const error = await wrappedFetch("https://api.example.com").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidResponseValidationError);
    expect(error).toMatchObject({
      name: "PaidResponseValidationError",
      message: "Paid response cannot be detached for validation",
      response: consumedResponse,
      paymentRequired: validPaymentRequired,
      recovered: false,
      paymentResponseHeader: "settled-header",
    });
    expect((error as PaidResponseValidationError).cause).toBeInstanceOf(Error);
    expect(validator).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("should pass validatePaidResponse through wrapFetchWithPaymentFromConfig", async () => {
    const { x402Client: MockX402Client } = await import("@x402/core/client");
    const validator = vi.fn();
    (MockX402Client.fromConfig as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);
    const wrappedFetch = wrapFetchWithPaymentFromConfig(
      mockFetch,
      { schemes: [] },
      { validatePaidResponse: validator },
    );
    const successResponse = createResponse(
      200,
      { ok: true },
      { "PAYMENT-RESPONSE": "from-config-settled" },
    );
    mockFetch
      .mockResolvedValueOnce(createResponse(402, validPaymentRequired))
      .mockResolvedValueOnce(successResponse);

    const result = await wrappedFetch("https://api.example.com");

    expect(result).toBe(successResponse);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });
});
