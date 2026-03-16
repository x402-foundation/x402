import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/facilitator/scheme";
import { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { USDT_MASTER, TVM_MAINNET } from "../../../src/constants";
import {
  ERR_PAYMENT_EXPIRED,
  ERR_WRONG_RECIPIENT,
  ERR_WRONG_TOKEN,
  ERR_AMOUNT_MISMATCH,
  ERR_REPLAY,
  ERR_MISSING_SETTLEMENT_DATA,
  ERR_INVALID_SIGNATURE,
  ERR_SETTLEMENT_FAILED,
} from "../../../src/exact/facilitator/errors";
import { beginCell, Cell } from "@ton/core";
import nacl from "tweetnacl";

const TEST_FACILITATOR_URL = "https://facilitator.test.example.com";

/**
 * Build a properly signed settlement BoC for testing.
 *
 * Mimics W5R1 external message layout:
 *   root cell -> ref[0] = body cell
 *   body cell = [512-bit Ed25519 signature][payload bits + refs]
 *
 * The signature is Ed25519(hash(payloadCell), secretKey).
 */
function buildSignedBoc(secretKey: Uint8Array): string {
  // Build a payload cell (simulates W5R1 transfer body: wallet_id + valid_until + seqno)
  const payloadCell = beginCell()
    .storeUint(698983191, 32) // wallet_id
    .storeUint(Math.floor(Date.now() / 1000) + 300, 32) // valid_until
    .storeUint(1, 32) // seqno
    .endCell();

  // Sign the payload cell hash
  const payloadHash = payloadCell.hash();
  const signature = nacl.sign.detached(payloadHash, secretKey);

  // Build body cell: signature + payload data (inline)
  const bodyBuilder = beginCell();
  bodyBuilder.storeBuffer(Buffer.from(signature)); // 512 bits
  // Copy payload bits and refs into body
  const payloadSlice = payloadCell.beginParse();
  bodyBuilder.storeSlice(payloadSlice);
  const bodyCell = bodyBuilder.endCell();

  // Build external message with body as ref (standard serialization)
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
        nonce: crypto.randomUUID(),
        settlementBoc,
        walletPublicKey: testPublicKeyHex,
      },
    };
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
    it("should accept valid payload", async () => {
      const result = await facilitator.verify(makeValidPayload(), validRequirements);
      expect(result.isValid).toBe(true);
    });

    it("should reject expired payment", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).validUntil = Math.floor(Date.now() / 1000) - 100;
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_PAYMENT_EXPIRED);
    });

    it("should reject wrong recipient", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).to = "0:wrongrecipient";
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_WRONG_RECIPIENT);
    });

    it("should reject wrong token", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).tokenMaster = "0:wrongtoken";
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_WRONG_TOKEN);
    });

    it("should reject insufficient amount", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).amount = "5000"; // less than required 10000
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_AMOUNT_MISMATCH);
    });

    it("should accept exact amount", async () => {
      const result = await facilitator.verify(makeValidPayload(), validRequirements);
      expect(result.isValid).toBe(true);
    });

    it("should accept higher amount", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).amount = "20000"; // more than required
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(true);
    });

    it("should reject missing settlement BOC", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).settlementBoc = "";
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_MISSING_SETTLEMENT_DATA);
    });

    it("should reject missing wallet public key", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).walletPublicKey = "";
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_MISSING_SETTLEMENT_DATA);
    });

    it("should reject invalid signature (wrong key)", async () => {
      const payload = makeValidPayload();
      // Use a different keypair's public key
      const otherKeyPair = nacl.sign.keyPair();
      (payload.payload as any).walletPublicKey = Buffer.from(otherKeyPair.publicKey).toString("hex");
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_INVALID_SIGNATURE);
    });

    it("should reject replay (same nonce after settle)", async () => {
      // Mock fetch for settle
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const payload = makeValidPayload();
      // First settle should succeed
      const settleResult = await facilitator.settle(payload, validRequirements);
      expect(settleResult.success).toBe(true);

      // Second verify should fail (replay)
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ERR_REPLAY);
    });

    it("should include payer address in response", async () => {
      const payload = makeValidPayload();
      const result = await facilitator.verify(payload, validRequirements);
      expect(result.payer).toBe((payload.payload as any).from);
    });
  });

  describe("settle", () => {
    it("should settle valid payment via facilitator /settle", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = await facilitator.settle(makeValidPayload(), validRequirements);
      expect(result.success).toBe(true);
      expect(result.network).toBe(TVM_MAINNET);
      expect(result.transaction).toContain("settle-");
    });

    it("should call facilitator /settle endpoint", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const payload = makeValidPayload();
      await facilitator.settle(payload, validRequirements);

      expect(fetchSpy).toHaveBeenCalledWith(
        `${TEST_FACILITATOR_URL}/settle`,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("should reject invalid payload on settle", async () => {
      const payload = makeValidPayload();
      (payload.payload as any).to = "0:wrongrecipient";
      const result = await facilitator.settle(payload, validRequirements);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ERR_WRONG_RECIPIENT);
    });

    it("should handle /settle failure", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );

      const result = await facilitator.settle(makeValidPayload(), validRequirements);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("Settlement failed");
    });

    it("should fail when no facilitatorUrl is available", async () => {
      const noUrlFacilitator = new ExactTvmScheme();
      const noUrlRequirements = { ...validRequirements, extra: {} };
      const result = await noUrlFacilitator.settle(makeValidPayload(), noUrlRequirements);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ERR_SETTLEMENT_FAILED);
      expect(result.errorMessage).toContain("Missing facilitatorUrl");
    });

    it("should prevent replay on settle", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const payload = makeValidPayload();
      const result1 = await facilitator.settle(payload, validRequirements);
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(payload, validRequirements);
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe(ERR_REPLAY);
    });
  });
});
