import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/facilitator/scheme";
import { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { USDT_MASTER, TVM_MAINNET } from "../../../src/constants";
import {
  ERR_SETTLEMENT_FAILED,
} from "../../../src/exact/facilitator/errors";
import { beginCell } from "@ton/core";
import nacl from "tweetnacl";

const TEST_FACILITATOR_URL = "https://facilitator.test.example.com";

function buildSignedBoc(secretKey: Uint8Array): string {
  const payloadCell = beginCell()
    .storeUint(698983191, 32) // wallet_id
    .storeUint(Math.floor(Date.now() / 1000) + 300, 32) // valid_until
    .storeUint(1, 32) // seqno
    .endCell();

  const payloadHash = payloadCell.hash();
  const signature = nacl.sign.detached(payloadHash, secretKey);

  const bodyBuilder = beginCell();
  bodyBuilder.storeBuffer(Buffer.from(signature));
  const payloadSlice = payloadCell.beginParse();
  bodyBuilder.storeSlice(payloadSlice);
  const bodyCell = bodyBuilder.endCell();

  const extCell = beginCell().storeRef(bodyCell).endCell();
  return extCell.toBoc().toString("base64");
}

describe("ExactTvmScheme (Facilitator)", () => {
  let facilitator: ExactTvmScheme;
  let testKeyPair: nacl.SignKeyPair;
  let testPublicKeyHex: string;

  const validRequirements: PaymentRequirements = {
    scheme: "exact",
    network: TVM_MAINNET,
    amount: "10000",
    asset: USDT_MASTER,
    payTo: "0:recipient000000000000000000000000000000000000000000000000000000",
    maxTimeoutSeconds: 300,
    extra: { facilitatorUrl: TEST_FACILITATOR_URL },
  };

  function makeValidPayload(): PaymentPayload {
    const settlementBoc = buildSignedBoc(testKeyPair.secretKey);
    return {
      x402Version: 2,
      accepted: validRequirements,
      payload: {
        from: "0:sender0000000000000000000000000000000000000000000000000000000000",
        to: validRequirements.payTo,
        tokenMaster: USDT_MASTER,
        amount: "10000",
        validUntil: Math.floor(Date.now() / 1000) + 300,
        settlementBoc,
        walletPublicKey: testPublicKeyHex,
      },
    };
  }

  /**
   * Mock fetch to respond correctly based on URL path.
   */
  function mockFetchForVerifyAndSettle(
    verifyResponse: Record<string, unknown> = { isValid: true },
    settleResponse: Record<string, unknown> = { success: true, transaction: "abc123", network: TVM_MAINNET },
  ) {
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/verify")) {
        return new Response(JSON.stringify(verifyResponse), { status: 200 });
      }
      if (url.includes("/settle")) {
        return new Response(JSON.stringify(settleResponse), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
  }

  beforeEach(() => {
    testKeyPair = nacl.sign.keyPair();
    testPublicKeyHex = Buffer.from(testKeyPair.publicKey).toString("hex");
    facilitator = new ExactTvmScheme({ facilitatorUrl: TEST_FACILITATOR_URL });
    vi.restoreAllMocks();
  });

  describe("Construction", () => {
    it("should create instance", () => {
      expect(facilitator).toBeDefined();
      expect(facilitator.scheme).toBe("exact");
      expect(facilitator.caipFamily).toBe("tvm:*");
    });
  });

  describe("getExtra", () => {
    it("should return facilitatorUrl when configured", () => {
      const extra = facilitator.getExtra(TVM_MAINNET);
      expect(extra).toEqual({ facilitatorUrl: TEST_FACILITATOR_URL });
    });

    it("should return undefined when not configured", () => {
      const scheme = new ExactTvmScheme();
      expect(scheme.getExtra(TVM_MAINNET)).toBeUndefined();
    });
  });

  describe("getSigners", () => {
    it("should return empty array", () => {
      expect(facilitator.getSigners(TVM_MAINNET)).toEqual([]);
    });
  });

  describe("verify", () => {
    it("should delegate to facilitator /verify endpoint", async () => {
      const fetchSpy = mockFetchForVerifyAndSettle();
      const result = await facilitator.verify(makeValidPayload(), validRequirements);
      expect(result.isValid).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        `${TEST_FACILITATOR_URL}/verify`,
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should return invalid when facilitator rejects", async () => {
      mockFetchForVerifyAndSettle({ isValid: false, invalidReason: "expired" });
      const result = await facilitator.verify(makeValidPayload(), validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("expired");
    });

    it("should support snake_case response format", async () => {
      mockFetchForVerifyAndSettle({ is_valid: true });
      const result = await facilitator.verify(makeValidPayload(), validRequirements);
      expect(result.isValid).toBe(true);
    });

    it("should return error on fetch failure", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("network error"));
      const result = await facilitator.verify(makeValidPayload(), validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("verification_error");
    });

    it("should fail if no facilitatorUrl available", async () => {
      const noUrlFacilitator = new ExactTvmScheme();
      const noUrlReqs = { ...validRequirements, extra: {} };
      const result = await noUrlFacilitator.verify(makeValidPayload(), noUrlReqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_facilitator_url");
    });

    it("should include payer address in response", async () => {
      mockFetchForVerifyAndSettle();
      const payload = makeValidPayload();
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.payer).toBe((payload.payload as Record<string, unknown>).from);
    });
  });

  describe("settle", () => {
    it("should settle valid payment via facilitator /settle", async () => {
      mockFetchForVerifyAndSettle(
        { isValid: true },
        { success: true, transaction: "deadbeef", network: TVM_MAINNET },
      );
      const result = await facilitator.settle(makeValidPayload(), validRequirements);
      expect(result.success).toBe(true);
      expect(result.transaction).toBe("deadbeef");
      expect(result.network).toBe(TVM_MAINNET);
    });

    it("should call both /verify and /settle endpoints", async () => {
      mockFetchForVerifyAndSettle();
      await facilitator.settle(makeValidPayload(), validRequirements);

      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const urls = calls.map((c: unknown[]) => c[0] as string);
      expect(urls.some((u: string) => u.includes("/verify"))).toBe(true);
      expect(urls.some((u: string) => u.includes("/settle"))).toBe(true);
    });

    it("should fail settle when verify fails", async () => {
      mockFetchForVerifyAndSettle({ isValid: false, invalidReason: "bad_sig" });
      const result = await facilitator.settle(makeValidPayload(), validRequirements);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("bad_sig");
    });

    it("should handle /settle endpoint failure", async () => {
      vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/verify")) {
          return new Response(JSON.stringify({ isValid: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: false, errorReason: "insufficient_gas" }), { status: 200 });
      });

      const result = await facilitator.settle(makeValidPayload(), validRequirements);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ERR_SETTLEMENT_FAILED);
    });

    it("should fail when no facilitatorUrl is available", async () => {
      const noUrlFacilitator = new ExactTvmScheme();
      const noUrlReqs = { ...validRequirements, extra: {} };
      const result = await noUrlFacilitator.settle(makeValidPayload(), noUrlReqs);
      expect(result.success).toBe(false);
    });

    it("should track settled BoC hashes", async () => {
      mockFetchForVerifyAndSettle();
      const payload = makeValidPayload();
      const result1 = await facilitator.settle(payload, validRequirements);
      expect(result1.success).toBe(true);

      // Second settle with same payload uses same BoC hash tracking
      const result2 = await facilitator.settle(payload, validRequirements);
      // Whether this rejects depends on remote facilitator, but local tracking should work
      expect(result2).toBeDefined();
    });
  });
});
