import { describe, it, expect, vi, beforeEach } from "vitest";
import { zeroAddress } from "viem";
import { verifyLifecycle } from "../../../src/auth-capture/facilitator/lifecycle";
import * as Errors from "../../../src/auth-capture/errors";
import { deriveBoundSalt } from "../../../src/auth-capture/nonce";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const PAY_TO = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const CAPTURE_AUTHORIZER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const FEE_RECIPIENT = "0x4444444444444444444444444444444444444444" as `0x${string}`;
const SALT_NONCE =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`;
const BOUND_SALT = deriveBoundSalt(RECEIVER_AUTHORIZER, zeroAddress, SALT_NONCE);

const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
const captureDeadline = futureSeconds + 86400;
const refundDeadline = captureDeadline + 86400;

const mockRequirements = {
  scheme: "auth-capture",
  network: "eip155:84532",
  amount: "1000000",
  asset: ASSET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {
    captureAuthorizer: CAPTURE_AUTHORIZER,
    captureDeadline,
    refundDeadline,
    feeRecipient: FEE_RECIPIENT,
    minFeeBps: 0,
    maxFeeBps: 100,
    name: "USDC",
    version: "2",
    receiverAuthorizer: RECEIVER_AUTHORIZER,
  },
};

function paymentInfo(): PaymentInfoStruct {
  return {
    operator: CAPTURE_AUTHORIZER,
    payer: PAYER,
    receiver: PAY_TO,
    token: ASSET,
    maxAmount: "1000000",
    preApprovalExpiry: futureSeconds,
    authorizationExpiry: captureDeadline,
    refundExpiry: refundDeadline,
    minFeeBps: 0,
    maxFeeBps: 100,
    feeReceiver: FEE_RECIPIENT,
    salt: BOUND_SALT,
  };
}

function createMockSigner(): FacilitatorEvmSigner {
  return {
    getAddresses: () => [CAPTURE_AUTHORIZER],
    readContract: vi.fn().mockResolvedValue("0x1626ba7e"),
    writeContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as FacilitatorEvmSigner;
}

describe("verifyLifecycle", () => {
  let signer: FacilitatorEvmSigner;

  beforeEach(() => {
    signer = createMockSigner();
  });

  it("rejects capture on authorization flow", async () => {
    const accepted = {
      ...mockRequirements,
      extra: { ...mockRequirements.extra, paymentFlow: "authorization" },
    };
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "capture",
        paymentInfo: paymentInfo(),
        saltNonce: SALT_NONCE,
        amount: "500000",
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        expectedCapturableAmount: "1000000",
        expectedRefundableAmount: "0",
        authorizerSignature: "0xabcd",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("rejects refund when delegated facilitator has no refund funding", async () => {
    const accepted = mockRequirements;
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "refund",
        paymentInfo: paymentInfo(),
        saltNonce: SALT_NONCE,
        amount: "100000",
        expectedCapturableAmount: "0",
        expectedRefundableAmount: "100000",
        authorizerSignature: "0xabcd",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrRefundFundingUnavailable);
  });

  it("rejects a missing signature when no delegated authorizer is configured", async () => {
    const accepted = mockRequirements;
    const info = paymentInfo();
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "void",
        paymentInfo: info,
        saltNonce: SALT_NONCE,
        authorizerSignature: "",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrAuthorizerSignature);
  });

  it("rejects malformed void payloads that carry voidAuthorizerSignature", async () => {
    const accepted = mockRequirements;
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "void",
        paymentInfo: paymentInfo(),
        saltNonce: SALT_NONCE,
        authorizerSignature: "0xabcd",
        voidAuthorizerSignature: "0xdead",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrVoidAuthorizerSignature);
  });

  it("rejects lifecycle payloads whose paymentInfo hash binding does not match saltNonce", async () => {
    const accepted = mockRequirements;
    const info = paymentInfo();
    const wrongSalt = "0x" + "99".repeat(32);
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "void",
        paymentInfo: { ...info, salt: wrongSalt },
        saltNonce: SALT_NONCE,
        authorizerSignature: "0xabcd",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrSaltBindingMismatch);
  });

  it("rejects capture payloads that include both feeBps and feeAmount", async () => {
    const accepted = mockRequirements;
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "capture",
        paymentInfo: paymentInfo(),
        saltNonce: SALT_NONCE,
        amount: "500000",
        feeBps: 0,
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        expectedCapturableAmount: "1000000",
        expectedRefundableAmount: "0",
        authorizerSignature: "0xabcd",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadFormat);
  });

  it("rejects capture payloads whose operator does not match extra.captureAuthorizer", async () => {
    const accepted = mockRequirements;
    const info = paymentInfo();
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "capture",
        paymentInfo: {
          ...info,
          operator: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        saltNonce: SALT_NONCE,
        amount: "500000",
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        expectedCapturableAmount: "1000000",
        expectedRefundableAmount: "0",
        authorizerSignature: "0xabcd",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrOperatorMismatch);
  });

  it("rejects capture payloads whose paymentInfo differs from the requirements", async () => {
    const accepted = mockRequirements;
    const result = await verifyLifecycle(
      [signer],
      undefined,
      { x402Version: 2, accepted, payload: {} },
      accepted,
      {
        type: "capture",
        paymentInfo: {
          ...paymentInfo(),
          receiver: "0xcccccccccccccccccccccccccccccccccccccccc",
        },
        saltNonce: SALT_NONCE,
        amount: "500000",
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        expectedCapturableAmount: "1000000",
        expectedRefundableAmount: "0",
        authorizerSignature: "0xabcd",
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPaymentInfoMismatch);
  });
});
