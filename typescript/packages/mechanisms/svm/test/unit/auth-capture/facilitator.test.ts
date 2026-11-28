import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FacilitatorSvmSigner } from "../../src/signer";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { AuthCaptureSvmScheme } from "../../src/auth-capture";
import * as Errors from "../../src/auth-capture/facilitator/errors";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS } from "../../src/constants";

function baseRequirements(): PaymentRequirements {
  return {
    scheme: "auth-capture",
    network: SOLANA_DEVNET_CAIP2,
    amount: "1000000",
    asset: USDC_DEVNET_ADDRESS,
    payTo: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ",
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: "5E7kFbKPqW8t8qGzX2yN4mL6pR9sT3vW1aB7cD4eF6gH" as never,
      delegate: "5E7kFbKPqW8t8qGzX2yN4mL6pR9sT3vW1aB7cD4eF6gH" as never,
    },
  } as PaymentRequirements;
}

function baseSigner(): FacilitatorSvmSigner {
  return {
    getAddresses: () => [
      "5E7kFbKPqW8t8qGzX2yN4mL6pR9sT3vW1aB7cD4eF6gH" as never,
      "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
    ],
    signTransaction: vi.fn().mockResolvedValue("signed-tx"),
    sendTransaction: vi.fn().mockResolvedValue("signature-123"),
    confirmTransaction: vi.fn().mockResolvedValue({ slot: 12345n }),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe("AuthCaptureSvmScheme facilitator", () => {
  let facilitator: AuthCaptureSvmScheme;
  let signer: FacilitatorSvmSigner;

  beforeEach(() => {
    signer = baseSigner();
    facilitator = new AuthCaptureSvmScheme(signer);
  });

  it("should reject unsupported scheme", async () => {
    const payload = { accepted: { scheme: "exact", network: SOLANA_DEVNET_CAIP2 }, payload: {} } as never;
    const req = baseRequirements();
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrUnsupportedScheme);
  });

  it("should reject network mismatch", async () => {
    const payload = { accepted: { scheme: "auth-capture", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: {} } as never;
    const req = baseRequirements();
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
  });

  it("should reject missing delegate", async () => {
    const payload = { accepted: { scheme: "auth-capture", network: SOLANA_DEVNET_CAIP2 }, payload: {} } as never;
    const req = baseRequirements();
    delete req.extra.delegate;
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrMissingDelegate);
  });

  it("should reject missing feePayer", async () => {
    const payload = { accepted: { scheme: "auth-capture", network: SOLANA_DEVNET_CAIP2 }, payload: {} } as never;
    const req = baseRequirements();
    delete req.extra.feePayer;
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrMissingFeePayer);
  });

  it("should reject unmanaged feePayer", async () => {
    const payload = { accepted: { scheme: "auth-capture", network: SOLANA_DEVNET_CAIP2 }, payload: {} } as never;
    const req = baseRequirements();
    req.extra.feePayer = "unmanaged-address" as never;
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrFeePayerNotManaged);
  });

  it("should reject unmanaged delegate", async () => {
    const payload = { accepted: { scheme: "auth-capture", network: SOLANA_DEVNET_CAIP2 }, payload: {} } as never;
    const req = baseRequirements();
    req.extra.delegate = "unmanaged-address" as never;
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrDelegateNotManaged);
  });

  it("should reject delegate equal to feePayer", async () => {
    const payload = { accepted: { scheme: "auth-capture", network: SOLANA_DEVNET_CAIP2 }, payload: {} } as never;
    const req = baseRequirements();
    // Both are already the same in baseRequirements
    const result = await facilitator.verify(payload, req);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrFeePayerTransferringFunds);
  });

  it("should getExtra with feePayer and transactionVersions", () => {
    const extra = facilitator.getExtra(SOLANA_DEVNET_CAIP2);
    expect(extra).toBeDefined();
    expect(extra?.feePayer).toBeDefined();
    expect(Array.isArray(extra?.transactionVersions)).toBe(true);
  });

  it("should getSigners returning all addresses", () => {
    const signers = facilitator.getSigners(SOLANA_DEVNET_CAIP2);
    expect(signers).toHaveLength(2);
    expect(signers).toContain("5E7kFbKPqW8t8qGzX2yN4mL6pR9sT3vW1aB7cD4eF6gH" as never);
  });
});
