import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignerSepolia, SignerWallet } from "../../../types/shared/evm";
import { PaymentRequirements, UnsignedPaymentPayload } from "../../../types/verify";
import { createPaymentHeader, preparePaymentHeader, signPaymentHeader } from "./client";
import { signAuthorization } from "./sign";
import { encodePayment } from "./utils/paymentUtils";

vi.mock("./sign", async () => {
  const actual = await vi.importActual("./sign");
  return {
    ...actual,
    signAuthorization: vi.fn(),
  };
});

vi.mock("./utils/paymentUtils", () => ({
  encodePayment: vi.fn().mockReturnValue("encoded-payment-header"),
}));

describe("preparePaymentHeader", () => {
  const mockPaymentRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000000",
    resource: "https://example.com/resource",
    description: "Test resource",
    mimeType: "application/json",
    payTo: "0x1234567890123456789012345678901234567890",
    maxTimeoutSeconds: 300,
    asset: "0x1234567890123456789012345678901234567890",
  };

  const mockFromAddress = "0xabcdef1234567890123456789012345678901234";

  beforeEach(() => {
    vi.useFakeTimers();
    // Set a fixed time for consistent testing
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create a valid unsigned payment header", () => {
    const result = preparePaymentHeader(mockFromAddress, 1, mockPaymentRequirements);
    const currentTime = Math.floor(Date.now() / 1000);

    expect(result).toEqual({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: undefined,
        authorization: {
          from: mockFromAddress,
          to: mockPaymentRequirements.payTo,
          value: mockPaymentRequirements.maxAmountRequired,
          validAfter: (currentTime - 600).toString(),
          validBefore: (currentTime + mockPaymentRequirements.maxTimeoutSeconds).toString(),
          nonce: expect.any(String),
        },
      },
    });
  });

  it("should generate a unique nonce for each call", () => {
    const result1 = preparePaymentHeader(mockFromAddress, 1, mockPaymentRequirements);
    const result2 = preparePaymentHeader(mockFromAddress, 1, mockPaymentRequirements);

    expect(result1.payload.authorization.nonce.length).toBe(66);
    expect(result2.payload.authorization.nonce.length).toBe(66);
    expect(result1.payload.authorization.nonce).not.toBe(result2.payload.authorization.nonce);
  });

  it("should calculate validAfter as 60 seconds before current time", () => {
    const result = preparePaymentHeader(mockFromAddress, 1, mockPaymentRequirements);
    const currentTime = Math.floor(Date.now() / 1000);
    const validAfter = parseInt(result.payload.authorization.validAfter);

    expect(validAfter).toBe(currentTime - 600);
  });

  it("should calculate validBefore as current time plus maxTimeoutSeconds", () => {
    const result = preparePaymentHeader(mockFromAddress, 1, mockPaymentRequirements);
    const currentTime = Math.floor(Date.now() / 1000);
    const validBefore = parseInt(result.payload.authorization.validBefore);

    expect(validBefore).toBe(currentTime + mockPaymentRequirements.maxTimeoutSeconds);
  });

  it("should handle different x402 versions", () => {
    const result = preparePaymentHeader(mockFromAddress, 2, mockPaymentRequirements);
    expect(result.x402Version).toBe(2);
  });
});

describe("signPaymentHeader", () => {
  const mockPaymentRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000000",
    resource: "https://example.com/resource",
    description: "Test resource",
    mimeType: "application/json",
    payTo: "0x1234567890123456789012345678901234567890",
    maxTimeoutSeconds: 300,
    asset: "0x1234567890123456789012345678901234567890",
  };

  const mockUnsignedHeader: UnsignedPaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: undefined,
      authorization: {
        from: "0xabcdef1234567890123456789012345678901234",
        to: "0x1234567890123456789012345678901234567890",
        value: "1000000",
        validAfter: "1704067195",
        validBefore: "1704067495",
        nonce: "1234567890",
      },
    },
  };

  const mockSignature = "0x1234567890123456789012345678901234567890123456789012345678901234";

  const createTestClient = () => {
    return createSignerSepolia(
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signAuthorization).mockResolvedValue({ signature: mockSignature });
  });

  it("should sign the payment header and return a complete payload", async () => {
    const client = createTestClient();
    const result = await signPaymentHeader(client, mockPaymentRequirements, mockUnsignedHeader);

    expect(signAuthorization).toHaveBeenCalledWith(
      client,
      mockUnsignedHeader.payload.authorization,
      mockPaymentRequirements,
    );

    expect(result).toEqual({
      ...mockUnsignedHeader,
      payload: {
        ...mockUnsignedHeader.payload,
        signature: mockSignature,
      },
    });
  });

  it("should preserve all original fields in the signed payload", async () => {
    const client = createTestClient();
    const result = await signPaymentHeader(client, mockPaymentRequirements, mockUnsignedHeader);

    // Check that all original fields are preserved
    expect(result.x402Version).toBe(mockUnsignedHeader.x402Version);
    expect(result.scheme).toBe(mockUnsignedHeader.scheme);
    expect(result.network).toBe(mockUnsignedHeader.network);
    expect("authorization" in result.payload).toBe(true);
    if ("authorization" in result.payload) {
      expect(result.payload.authorization).toEqual(mockUnsignedHeader.payload.authorization);
    }
  });

  it("should throw an error if signing fails", async () => {
    const client = createTestClient();
    const error = new Error("Signing failed");
    vi.mocked(signAuthorization).mockRejectedValue(error);

    await expect(
      signPaymentHeader(client, mockPaymentRequirements, mockUnsignedHeader),
    ).rejects.toThrow("Signing failed");
  });
});

describe("createPaymentHeader", () => {
  const mockPaymentRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000000",
    resource: "https://example.com/resource",
    description: "Test resource",
    mimeType: "application/json",
    payTo: "0x1234567890123456789012345678901234567890",
    maxTimeoutSeconds: 300,
    asset: "0x1234567890123456789012345678901234567890",
  };

  const mockSignedPayment = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature:
        "0x1234567890123456789012345678901234567890123456789012345678901234" as `0x${string}`,
      authorization: {
        from: "0xabcdef1234567890123456789012345678901234" as `0x${string}`,
        to: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        value: "1000000",
        validAfter: "1704067195",
        validBefore: "1704067495",
        nonce: "1234567890",
      },
    },
  };

  const createTestClient = () => {
    const client = createSignerSepolia(
      "0x1234567890123456789012345678901234567890123456789012345678901234" as `0x${string}`,
    );
    return client as unknown as SignerWallet;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signAuthorization).mockResolvedValue({
      signature: mockSignedPayment.payload.signature,
    });
  });

  it("should create and encode a payment header", async () => {
    const client = createTestClient();
    const result = await createPaymentHeader(client, 1, mockPaymentRequirements);

    expect(result).toBe("encoded-payment-header");
    expect(vi.mocked(encodePayment)).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: expect.objectContaining({
          signature: mockSignedPayment.payload.signature,
          authorization: expect.objectContaining({
            from: client.account!.address,
            to: mockPaymentRequirements.payTo,
            value: mockPaymentRequirements.maxAmountRequired,
          }),
        }),
      }),
    );
  });

  it("should handle different x402 versions", async () => {
    const client = createTestClient();
    await createPaymentHeader(client, 2, mockPaymentRequirements);

    expect(vi.mocked(encodePayment)).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 2,
      }),
    );
  });

  it("should throw an error if signing fails", async () => {
    const client = createTestClient();
    const error = new Error("Signing failed");
    vi.mocked(signAuthorization).mockRejectedValue(error);

    await expect(createPaymentHeader(client, 1, mockPaymentRequirements)).rejects.toThrow(
      "Signing failed",
    );
  });

  it("should throw an error if encoding fails", async () => {
    const client = createTestClient();
    const error = new Error("Encoding failed");
    vi.mocked(encodePayment).mockImplementation(() => {
      throw error;
    });

    await expect(createPaymentHeader(client, 1, mockPaymentRequirements)).rejects.toThrow(
      "Encoding failed",
    );
  });
});
