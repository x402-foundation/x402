import {
  AxiosError,
  AxiosHeaders,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evm, PaymentRequirements, ChainIdToNetwork, Signer, MultiNetworkSigner } from "x402/types";
import { withPaymentInterceptor } from "./index";

// Mock the createPaymentHeader function
vi.mock("x402/client", () => ({
  createPaymentHeader: vi.fn(),
  selectPaymentRequirements: vi.fn(),
}));

describe("withPaymentInterceptor()", () => {
  let mockAxiosClient: AxiosInstance;
  let mockWalletClient: typeof evm.SignerWallet;
  let interceptor: (error: AxiosError) => Promise<AxiosResponse>;

  const validPaymentRequirements: PaymentRequirements[] = [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000000", // 1 USDC in base units
      resource: "https://api.example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on base-sepolia
    },
  ];

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
    data?: { accepts: PaymentRequirements[]; x402Version: number },
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
        headers: {},
        config: config || createErrorConfig(),
      },
    );
  };

  beforeEach(async () => {
    // Reset mocks before each test
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

    // Mock wallet client
    mockWalletClient = {
      signMessage: vi.fn(),
    } as unknown as typeof evm.SignerWallet;

    // Mock payment requirements selector
    const { selectPaymentRequirements } = await import("x402/client");
    (selectPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements, _) => requirements[0],
    );

    // Set up the interceptor
    withPaymentInterceptor(mockAxiosClient, mockWalletClient);
    interceptor = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
  });

  it("should return the axios client instance", () => {
    const result = withPaymentInterceptor(mockAxiosClient, mockWalletClient);
    expect(result).toBe(mockAxiosClient);
  });

  it("should set up response interceptor", () => {
    expect(mockAxiosClient.interceptors.response.use).toHaveBeenCalled();
  });

  it("should not handle non-402 errors", async () => {
    const error = createAxiosError(404);
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should handle 402 errors and retry with payment header", async () => {
    const paymentHeader = "payment-header-value";
    const successResponse = { data: "success" } as AxiosResponse;

    const { createPaymentHeader, selectPaymentRequirements } = await import("x402/client");
    (createPaymentHeader as ReturnType<typeof vi.fn>).mockResolvedValue(paymentHeader);
    (selectPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements, _) => requirements[0],
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    const error = createAxiosError(402, createErrorConfig(), {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });

    const result = await interceptor(error);

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
    expect(mockAxiosClient.request).toHaveBeenCalledWith({
      ...error.config,
      headers: new AxiosHeaders({
        "X-PAYMENT": paymentHeader,
        "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
      }),
      __is402Retry: true,
    });
  });

  it("should not retry if already retried", async () => {
    const error = createAxiosError(402, createErrorConfig(true), {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });
    await expect(interceptor(error)).rejects.toBe(error);
  });

  it("should reject if missing request config", async () => {
    const error = createAxiosError(402, undefined, {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });
    await expect(interceptor(error)).rejects.toThrow("Missing axios request configuration");
  });

  it("should reject if payment header creation fails", async () => {
    const paymentError = new Error("Payment failed");
    const { createPaymentHeader } = await import("x402/client");
    (createPaymentHeader as ReturnType<typeof vi.fn>).mockRejectedValue(paymentError);

    const error = createAxiosError(402, createErrorConfig(), {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });
    await expect(interceptor(error)).rejects.toBe(paymentError);
  });

  it("passes ChainIdToNetwork-derived network for EVM signers", async () => {
    const paymentHeader = "payment-header-value";
    const successResponse = { data: "success" } as AxiosResponse;

    const { createPaymentHeader, selectPaymentRequirements } = await import("x402/client");
    (createPaymentHeader as ReturnType<typeof vi.fn>).mockResolvedValue(paymentHeader);
    (selectPaymentRequirements as ReturnType<typeof vi.fn>).mockImplementation(
      (requirements, _) => requirements[0],
    );
    (mockAxiosClient.request as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse);

    // Provide an EVM-like wallet object with a chain id and a transport key so it is detected as EVM signer
    const evmWallet = {
      chain: { id: 84532 },
      transport: {},
    } as unknown as typeof evm.SignerWallet;

    // Reinstall interceptor with this wallet
    withPaymentInterceptor(mockAxiosClient, evmWallet);
    const handler = (
      mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)![1];

    const error = createAxiosError(402, createErrorConfig(), {
      accepts: validPaymentRequirements,
      x402Version: 1,
    });

    await handler(error);

    expect(selectPaymentRequirements).toHaveBeenCalledWith(
      validPaymentRequirements,
      ChainIdToNetwork[84532],
      "exact",
    );
  });
});

describe("withPaymentInterceptor() - SVM and MultiNetwork", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes [solana, solana-devnet] for SVM-only signers", async () => {
    vi.doMock("x402/types", async () => {
      const actual = await vi.importActual("x402/types");
      return {
        ...actual,
        isEvmSignerWallet: vi.fn().mockReturnValue(false),
        isMultiNetworkSigner: vi.fn().mockReturnValue(false),
        isSvmSignerWallet: vi.fn().mockReturnValue(true),
      };
    });

    vi.doMock("x402/client", () => ({
      createPaymentHeader: vi.fn().mockResolvedValue("payment-header-value"),
      selectPaymentRequirements: vi.fn((reqs: PaymentRequirements[]) => reqs[0]),
    }));

    const { withPaymentInterceptor } = await import("./index");
    const { selectPaymentRequirements } = await import("x402/client");

    const mockAxiosClient: AxiosInstance = {
      interceptors: { response: { use: vi.fn() } },
      request: vi.fn().mockResolvedValue({ data: "success" } as AxiosResponse),
    } as unknown as AxiosInstance;

    // SVM-like signer (shape is irrelevant due to mocked guards)
    const svmWallet = {} as unknown as object;

    withPaymentInterceptor(mockAxiosClient, svmWallet as Signer);
    const handler = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>).mock
      .calls[0][1];

    // Local validPaymentRequirements for this suite
    const localValidPaymentRequirements: PaymentRequirements[] = [
      {
        scheme: "exact",
        network: "solana",
        maxAmountRequired: "1000000",
        resource: "https://api.example.com/resource",
        description: "Test payment",
        mimeType: "application/json",
        payTo: "11111111111111111111111111111111",
        maxTimeoutSeconds: 300,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    ];

    const error = new AxiosError(
      "Error",
      "ERROR",
      { headers: new AxiosHeaders() } as InternalAxiosRequestConfig,
      {},
      {
        status: 402,
        statusText: "Payment Required",
        data: { accepts: [{ ...localValidPaymentRequirements[0] }], x402Version: 1 },
        headers: {},
        config: { headers: new AxiosHeaders() } as InternalAxiosRequestConfig,
      },
    );

    await handler(error);

    expect(selectPaymentRequirements).toHaveBeenCalledWith(
      expect.any(Array),
      ["solana", "solana-devnet"],
      "exact",
    );
  });

  // TODO: this test should be updated once support is added for multi-network signers in selectPaymentRequirements
  it("passes undefined for MultiNetwork signers", async () => {
    vi.doMock("x402/types", async () => {
      const actual = await vi.importActual("x402/types");
      return {
        ...actual,
        isEvmSignerWallet: vi.fn().mockReturnValue(false),
        isSvmSignerWallet: vi.fn().mockReturnValue(false),
        isMultiNetworkSigner: vi.fn().mockReturnValue(true),
      };
    });

    vi.doMock("x402/client", () => ({
      createPaymentHeader: vi.fn().mockResolvedValue("payment-header-value"),
      selectPaymentRequirements: vi.fn((reqs: PaymentRequirements[]) => reqs[0]),
    }));

    const { withPaymentInterceptor } = await import("./index");
    const { selectPaymentRequirements } = await import("x402/client");

    const mockAxiosClient: AxiosInstance = {
      interceptors: { response: { use: vi.fn() } },
      request: vi.fn().mockResolvedValue({ data: "success" } as AxiosResponse),
    } as unknown as AxiosInstance;

    // MultiNetwork-like signer
    const multiWallet = { evm: {}, svm: {} } as MultiNetworkSigner;

    withPaymentInterceptor(mockAxiosClient, multiWallet);
    const handler = (mockAxiosClient.interceptors.response.use as ReturnType<typeof vi.fn>).mock
      .calls[0][1];

    // Local validPaymentRequirements for this suite
    const localValidPaymentRequirements: PaymentRequirements[] = [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "1000000",
        resource: "https://api.example.com/resource",
        description: "Test payment",
        mimeType: "application/json",
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
    ];

    const error = new AxiosError(
      "Error",
      "ERROR",
      { headers: new AxiosHeaders() } as InternalAxiosRequestConfig,
      {},
      {
        status: 402,
        statusText: "Payment Required",
        data: { accepts: [{ ...localValidPaymentRequirements[0] }], x402Version: 1 },
        headers: {},
        config: { headers: new AxiosHeaders() } as InternalAxiosRequestConfig,
      },
    );

    await handler(error);

    expect(selectPaymentRequirements).toHaveBeenCalledWith(expect.any(Array), undefined, "exact");
  });
});
