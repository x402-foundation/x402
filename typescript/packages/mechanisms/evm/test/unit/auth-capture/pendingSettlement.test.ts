import { describe, it, expect, beforeEach, vi } from "vitest";
import { hexToBigInt, zeroAddress } from "viem";
import { AuthCaptureEvmScheme } from "../../../src/auth-capture/facilitator/scheme";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import {
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../../../src/auth-capture/constants";
import {
  computePayerAgnosticPaymentInfoHash,
  deriveBoundSalt,
} from "../../../src/auth-capture/nonce";
import * as Errors from "../../../src/auth-capture/errors";

const MOCK_TX_HASH = ("0x" + "a1".repeat(32)) as `0x${string}`;
const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const PAY_TO = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const CAPTURE_AUTHORIZER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const FEE_RECIPIENT = "0x4444444444444444444444444444444444444444" as `0x${string}`;
const SALT = "0x0000000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;
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
  },
};

function buildEip3009Payload(signature = "0xabcd" as `0x${string}`) {
  const paymentInfo = {
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
    salt: SALT,
  };
  const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
  return {
    x402Version: 2,
    accepted: mockRequirements,
    resource: { url: "", description: "", mimeType: "" },
    payload: {
      authorization: {
        from: PAYER,
        to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
        value: "1000000",
        validAfter: "0",
        validBefore: String(futureSeconds),
        nonce,
      },
      signature,
      salt: SALT,
    },
  };
}

function buildPermit2Payload(signature = "0xpermit2sig" as `0x${string}`) {
  const paymentInfo = {
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
    salt: SALT,
  };
  const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
  const accepted = {
    ...mockRequirements,
    extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
  };
  return {
    x402Version: 2,
    accepted,
    resource: { url: "", description: "", mimeType: "" },
    payload: {
      permit2Authorization: {
        from: PAYER,
        permitted: { token: ASSET, amount: "1000000" },
        spender: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
        nonce: hexToBigInt(nonce).toString(),
        deadline: String(futureSeconds),
      },
      signature,
      salt: SALT,
    },
  };
}

function buildCapturePayload(authorizerSignature = "0xabcd" as `0x${string}`) {
  const accepted = {
    ...mockRequirements,
    extra: { ...mockRequirements.extra, receiverAuthorizer: RECEIVER_AUTHORIZER },
  };
  return {
    x402Version: 2,
    accepted,
    resource: { url: "", description: "", mimeType: "" },
    payload: {
      type: "capture" as const,
      paymentInfo: {
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
      },
      saltNonce: SALT_NONCE,
      amount: "500000",
      feeAmount: "0",
      feeReceiver: FEE_RECIPIENT,
      expectedCapturableAmount: "1000000",
      expectedRefundableAmount: "0",
      authorizerSignature,
    },
  };
}

function buildVoidPayload(authorizerSignature = "0xvoidsig" as `0x${string}`) {
  const accepted = {
    ...mockRequirements,
    extra: { ...mockRequirements.extra, receiverAuthorizer: RECEIVER_AUTHORIZER },
  };
  return {
    x402Version: 2,
    accepted,
    resource: { url: "", description: "", mimeType: "" },
    payload: {
      type: "void" as const,
      paymentInfo: {
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
      },
      saltNonce: SALT_NONCE,
      authorizerSignature,
    },
  };
}

describe("AuthCaptureEvmScheme pending-settlement store integration", () => {
  let mockFacilitatorSigner: FacilitatorEvmSigner;
  let store: PendingSettlementStore;

  beforeEach(() => {
    mockFacilitatorSigner = {
      getAddresses: vi.fn().mockReturnValue([CAPTURE_AUTHORIZER]),
      readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
        if (args?.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
        if (args?.functionName === "paymentState") {
          return {
            hasCollectedPayment: true,
            capturableAmount: BigInt("1000000"),
            refundableAmount: 0n,
          };
        }
        return BigInt("1000000000");
      }),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
      sendTransaction: vi.fn().mockResolvedValue(MOCK_TX_HASH),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: null }),
      getCode: vi.fn().mockImplementation(async ({ address }: { address: `0x${string}` }) => {
        const lower = address.toLowerCase();
        if (lower === PAYER.toLowerCase() || lower === RECEIVER_AUTHORIZER.toLowerCase()) {
          return "0x6080604052";
        }
        return "0x";
      }),
    };
    store = new InMemoryPendingSettlementStore();
  });

  describe("collect — EIP-3009", () => {
    it("cache-miss success leaves no pending entry", async () => {
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(true);
      expect(await store.get(signature)).toBeUndefined();
    });

    it("cache-miss + receipt wait fails returns settlement_pending and populates the store", async () => {
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("rpc: timeout waiting for receipt"));
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("cache-hit skips verify/broadcast and reconciles against the cached tx", async () => {
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;
      await store.set(signature, MOCK_TX_HASH);

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(mockFacilitatorSigner.waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ hash: MOCK_TX_HASH }),
      );
      expect(await store.get(signature)).toBeUndefined();
    });

    it("cache-hit + extra re-parse fails keeps the hash and returns settlement_pending", async () => {
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;
      await store.set(signature, MOCK_TX_HASH);
      const brokenRequirements = {
        ...payload.accepted,
        extra: { ...payload.accepted.extra, captureAuthorizer: "not-an-address" },
      };

      const result = await facilitator.settle(payload, brokenRequirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("cache-hit + submitter unresolved keeps the hash and returns settlement_pending", async () => {
      mockFacilitatorSigner.getAddresses = vi
        .fn()
        .mockReturnValue(["0x9999999999999999999999999999999999999999"]);
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;
      await store.set(signature, MOCK_TX_HASH);

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(mockFacilitatorSigner.waitForTransactionReceipt).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("cache-hit still unconfirmed returns settlement_pending again without re-broadcasting", async () => {
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("still pending"));
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;
      await store.set(signature, MOCK_TX_HASH);

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("verify-only failure is terminal and never touches the store", async () => {
      mockFacilitatorSigner.readContract = vi
        .fn()
        .mockImplementation(async (args: { functionName: string }) => {
          if (args?.functionName === "isValidSignature") return "0x00000000";
          if (args?.functionName === "paymentState") {
            return {
              hasCollectedPayment: true,
              capturableAmount: BigInt("1000000"),
              refundableAmount: 0n,
            };
          }
          return BigInt("1000000000");
        });
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrInvalidAuthCaptureSignature);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBeUndefined();
    });

    it("invalid broadcast hash is terminal and never populates the store", async () => {
      mockFacilitatorSigner.writeContract = vi.fn().mockResolvedValue("0xnothash");
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildEip3009Payload();
      const signature = payload.payload.signature;

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrTransactionReverted);
      expect(await store.get(signature)).toBeUndefined();
    });
  });

  describe("collect — Permit2", () => {
    it("cache-miss + receipt wait fails returns settlement_pending keyed by signature", async () => {
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("rpc timeout"));
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload();
      const signature = payload.payload.signature;

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("cache-hit reconciles without re-broadcasting", async () => {
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload();
      const signature = payload.payload.signature;
      await store.set(signature, MOCK_TX_HASH);

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(true);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBeUndefined();
    });
  });

  describe("lifecycle", () => {
    it("capture cache-miss + receipt wait fails returns settlement_pending keyed by authorizerSignature", async () => {
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("rpc timeout"));
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildCapturePayload();
      const key = payload.payload.authorizerSignature;

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(await store.get(key)).toBe(MOCK_TX_HASH);
    });

    it("capture cache-hit reconciles without re-broadcasting", async () => {
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildCapturePayload();
      const key = payload.payload.authorizerSignature;
      await store.set(key, MOCK_TX_HASH);

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(key)).toBeUndefined();
    });

    it("capture cache-hit + extra re-parse fails keeps the hash and returns settlement_pending", async () => {
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildCapturePayload();
      const key = payload.payload.authorizerSignature;
      await store.set(key, MOCK_TX_HASH);
      const brokenRequirements = {
        ...payload.accepted,
        extra: { ...payload.accepted.extra, captureAuthorizer: "not-an-address" },
      };

      const result = await facilitator.settle(payload, brokenRequirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(key)).toBe(MOCK_TX_HASH);
    });

    it("void cache-hit still unconfirmed returns settlement_pending again", async () => {
      mockFacilitatorSigner.readContract = vi
        .fn()
        .mockImplementation(async (args: { functionName: string }) => {
          if (args?.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
          if (args?.functionName === "paymentState") {
            return {
              hasCollectedPayment: true,
              capturableAmount: BigInt("500000"),
              refundableAmount: 0n,
            };
          }
          return BigInt("1000000000");
        });
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("still pending"));
      const facilitator = new AuthCaptureEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildVoidPayload();
      const key = payload.payload.authorizerSignature;
      await store.set(key, MOCK_TX_HASH);

      const result = await facilitator.settle(payload, payload.accepted);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(key)).toBe(MOCK_TX_HASH);
    });
  });

  describe("ErrSettlementPending wire contract", () => {
    it("equals the settlement_pending wire literal", () => {
      expect(Errors.ErrSettlementPending).toBe("settlement_pending");
    });
  });
});
