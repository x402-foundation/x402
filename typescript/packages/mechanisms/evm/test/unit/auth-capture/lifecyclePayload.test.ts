import { describe, it, expect, vi } from "vitest";
import {
  AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
  CAPTURE_TYPES_V1_0,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
} from "../../../src/auth-capture/constants";
import { parseAuthCaptureExtra } from "../../../src/auth-capture/extra";
import {
  buildCaptureEnrichment,
  buildCapturePayload,
  buildChargeCompletionEnrichment,
  buildRefundPayload,
  buildVoidEnrichment,
  buildVoidPayload,
  buildCaptureFields,
} from "../../../src/auth-capture/lifecyclePayload";
import type { NormalizedAuthCaptureExtra } from "../../../src/auth-capture/extra";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

const FUTURE = Math.floor(Date.now() / 1000) + 86400;
const CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function normalizedExtra(overrides: Record<string, unknown> = {}): NormalizedAuthCaptureExtra {
  const parsed = parseAuthCaptureExtra({
    captureAuthorizer: "0x1234567890123456789012345678901234567890",
    captureDeadline: FUTURE,
    refundDeadline: FUTURE + 86400,
    feeRecipient: "0x4444444444444444444444444444444444444444",
    minFeeBps: 100,
    maxFeeBps: 200,
    name: "USDC",
    version: "2",
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    ...overrides,
  });
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return parsed.extra;
}

function mockSigner() {
  return {
    address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    signTypedData: vi.fn().mockResolvedValue("0xsig" as `0x${string}`),
  };
}

const paymentInfo: PaymentInfoStruct = {
  operator: "0x1234567890123456789012345678901234567890",
  payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  receiver: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  token: BASE_SEPOLIA_USDC,
  maxAmount: "1000000",
  preApprovalExpiry: FUTURE - 100,
  authorizationExpiry: FUTURE,
  refundExpiry: FUTURE + 86400,
  minFeeBps: 100,
  maxFeeBps: 200,
  feeReceiver: "0x4444444444444444444444444444444444444444",
  salt: "0x" + "44".repeat(32),
};

describe("buildCaptureFields", () => {
  it("rejects implicit void on full capture but signs void when capture is partial", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const hash = "0x" + "aa".repeat(32);

    const full = await buildCaptureFields({
      signer,
      chainId: CHAIN_ID,
      extra,
      paymentInfoHash: hash,
      amount: "1000000",
      capturable: "1000000",
      refundable: "0",
      voidOnPartialCapture: true,
    });
    expect(full.voidAuthorizerSignature).toBeUndefined();

    const partial = await buildCaptureFields({
      signer,
      chainId: CHAIN_ID,
      extra,
      paymentInfoHash: hash,
      amount: "400000",
      capturable: "1000000",
      refundable: "0",
      voidOnPartialCapture: true,
    });
    expect(partial.voidAuthorizerSignature).toBe("0xsig");
    expect(full.voidAuthorizerSignature).toBeUndefined();
  });

  it("uses v1.0 feeBps wire when deployment is pinned to v1.0", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra({ authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS });
    const fields = await buildCaptureFields({
      signer,
      chainId: CHAIN_ID,
      extra,
      paymentInfoHash: "0x" + "bb".repeat(32),
      amount: "1000000",
      capturable: "1000000",
      refundable: "0",
      feeBps: 50,
      feeReceiver: extra.feeRecipient,
    });
    expect(fields.feeBps).toBe(50);
    expect(fields.feeAmount).toBeUndefined();
    expect(signer.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({ types: CAPTURE_TYPES_V1_0, primaryType: "Capture" }),
    );
  });

  it("derives v1.1 feeAmount from feeBps when feeAmount is omitted", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const fields = await buildCaptureFields({
      signer,
      chainId: CHAIN_ID,
      extra,
      paymentInfoHash: "0x" + "ff".repeat(32),
      amount: "1000000",
      capturable: "1000000",
      refundable: "0",
      feeBps: 100,
      feeReceiver: extra.feeRecipient,
    });
    expect(fields.feeAmount).toBe("10000");
    expect(fields.feeBps).toBeUndefined();
  });

  it("honors explicit v1.1 feeAmount override", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const fields = await buildCaptureFields({
      signer,
      chainId: CHAIN_ID,
      extra,
      paymentInfoHash: "0x" + "cc".repeat(32),
      amount: "1000000",
      capturable: "1000000",
      refundable: "0",
      feeAmount: "12345",
      feeReceiver: extra.feeRecipient,
    });
    expect(fields.feeAmount).toBe("12345");
    expect(fields.feeBps).toBeUndefined();
  });
});

describe("lifecycle payload builders", () => {
  const requirements = {
    scheme: "auth-capture",
    network: "eip155:84532" as const,
    amount: "1000000",
    asset: BASE_SEPOLIA_USDC,
    payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    maxTimeoutSeconds: 300,
    extra: {
      captureAuthorizer: "0x1234567890123456789012345678901234567890",
      captureDeadline: FUTURE,
      refundDeadline: FUTURE + 86400,
      feeRecipient: "0x4444444444444444444444444444444444444444",
      minFeeBps: 100,
      maxFeeBps: 200,
      name: "USDC",
      version: "2",
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    },
  };

  const collect = {
    authorization: {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
      value: "1000000",
      validAfter: "0",
      validBefore: String(FUTURE),
      nonce: "0x" + "33".repeat(32),
    },
    signature: "0xabcd",
    salt: paymentInfo.salt,
    saltNonce: "0x" + "22".repeat(32),
  };

  it("builds void enrichment for cancel-phase settle", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const enrichment = await buildVoidEnrichment({
      paymentInfo,
      extra,
      signer,
      chainId: CHAIN_ID,
      paymentInfoHash: "0x" + "dd".repeat(32),
    });
    expect(enrichment).toEqual({
      type: "void",
      paymentInfo,
      authorizerSignature: "0xsig",
    });
  });

  it("includes saltNonce on deferred void and refund payloads", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const record = {
      paymentInfo,
      paymentInfoHash: "0x" + "ee".repeat(32),
      capturableAmount: "0",
      refundableAmount: "500000",
      saltNonce: "0x" + "22".repeat(32),
    };
    const voidPayload = await buildVoidPayload({ record, extra, signer, chainId: CHAIN_ID });
    expect(voidPayload.saltNonce).toBe(record.saltNonce);
    const refundPayload = await buildRefundPayload({
      record,
      extra,
      signer,
      chainId: CHAIN_ID,
      amount: "100000",
    });
    expect(refundPayload.type).toBe("refund");
    expect(refundPayload.amount).toBe("100000");
  });

  it("buildCapturePayload carries voidRemainder signatures through", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const payload = await buildCapturePayload({
      record: {
        paymentInfo,
        paymentInfoHash: "0x" + "ff".repeat(32),
        capturableAmount: "1000000",
        refundableAmount: "0",
        saltNonce: "0x" + "22".repeat(32),
      },
      extra,
      signer,
      chainId: CHAIN_ID,
      amount: "250000",
      voidRemainder: true,
    });
    expect(payload.voidAuthorizerSignature).toBe("0xsig");
    expect(payload.amount).toBe("250000");
  });

  describe("without a local signer (authorizer delegated to the facilitator)", () => {
    const extra = normalizedExtra();
    const record = {
      paymentInfo,
      paymentInfoHash: ("0x" + "ee".repeat(32)) as `0x${string}`,
      capturableAmount: "1000000",
      refundableAmount: "0",
      saltNonce: ("0x" + "22".repeat(32)) as `0x${string}`,
    };

    it("omits every signature and flags the void leg with voidRemainder", async () => {
      const payload = await buildCapturePayload({
        record,
        extra,
        chainId: CHAIN_ID,
        amount: "250000",
        voidRemainder: true,
      });
      expect(payload).toMatchObject({ type: "capture", amount: "250000", voidRemainder: true });
      expect(payload).not.toHaveProperty("authorizerSignature");
      expect(payload).not.toHaveProperty("voidAuthorizerSignature");
    });

    it("builds unsigned void, refund, void enrichment, and charge completion", async () => {
      const voidPayload = await buildVoidPayload({ record, extra, chainId: CHAIN_ID });
      expect(voidPayload).not.toHaveProperty("authorizerSignature");
      expect(voidPayload.saltNonce).toBe(record.saltNonce);

      const refundPayload = await buildRefundPayload({
        record,
        extra,
        chainId: CHAIN_ID,
        amount: "1",
      });
      expect(refundPayload).not.toHaveProperty("authorizerSignature");
      expect(refundPayload.expectedCapturableAmount).toBe("1000000");

      const voidEnrichment = await buildVoidEnrichment({
        paymentInfo,
        extra,
        chainId: CHAIN_ID,
        paymentInfoHash: record.paymentInfoHash,
      });
      expect(voidEnrichment).toEqual({ type: "void", paymentInfo });

      const completion = await buildChargeCompletionEnrichment({
        collect,
        requirements,
        extra,
        chainId: CHAIN_ID,
        amount: "1000000",
      });
      expect(completion).toEqual({
        amount: "1000000",
        feeAmount: "10000",
        feeReceiver: extra.feeRecipient,
      });
    });
  });

  it("buildCaptureEnrichment uses stored balances when present", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const enrichment = await buildCaptureEnrichment({
      collect,
      requirements: { ...requirements, amount: "500000" },
      extra,
      signer,
      chainId: CHAIN_ID,
      capturable: "750000",
      refundable: "100000",
      amount: "500000",
      paymentInfo,
    });
    expect(enrichment).toMatchObject({
      type: "capture",
      amount: "500000",
      expectedCapturableAmount: "750000",
      expectedRefundableAmount: "100000",
    });
    expect(enrichment).not.toHaveProperty("saltNonce");
  });

  it("buildChargeCompletionEnrichment uses feeAmount on v1.1", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra();
    const enrichment = await buildChargeCompletionEnrichment({
      collect,
      requirements,
      extra,
      signer,
      chainId: CHAIN_ID,
      amount: "1000000",
    });
    expect(enrichment).toMatchObject({
      amount: "1000000",
      feeAmount: "10000",
      authorizerSignature: "0xsig",
    });
    expect(enrichment).not.toHaveProperty("feeBps");
  });

  it("buildChargeCompletionEnrichment uses feeBps on v1.0 deployment", async () => {
    const signer = mockSigner();
    const extra = normalizedExtra({ authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS });
    const enrichment = await buildChargeCompletionEnrichment({
      collect,
      requirements: {
        ...requirements,
        extra: { ...requirements.extra, authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS },
      },
      extra,
      signer,
      chainId: CHAIN_ID,
      amount: "1000000",
    });
    expect(enrichment).toMatchObject({
      amount: "1000000",
      feeBps: 100,
      authorizerSignature: "0xsig",
    });
    expect(enrichment).not.toHaveProperty("feeAmount");
  });
});
