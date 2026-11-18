import { describe, expect, it } from "vitest";
import {
  computeTimeoutBlocks,
  decodeSignedDelegateB64,
  parseFtTransferArgs,
  settlementCacheKey,
} from "../../src/utils";
import { buildSignedDelegateB64, tamperSignature } from "./fixtures/near.fixture";

describe("near utils", () => {
  it("decodes a signed delegate action and exposes normalized fields", async () => {
    const { b64, publicKey } = await buildSignedDelegateB64({
      senderId: "alice.testnet",
      receiverId: "usdc.testnet",
      ftReceiver: "merchant.testnet",
      amount: "1000000",
      nonce: 7n,
      maxBlockHeight: 9999n,
    });

    const { delegate } = decodeSignedDelegateB64(b64);
    expect(delegate.senderId).toBe("alice.testnet");
    expect(delegate.receiverId).toBe("usdc.testnet");
    expect(delegate.publicKey).toBe(publicKey);
    expect(delegate.curve).toBe("ed25519");
    expect(delegate.nonce).toBe(7n);
    expect(delegate.maxBlockHeight).toBe(9999n);
    expect(delegate.actionCount).toBe(1);
    expect(delegate.functionCall?.methodName).toBe("ft_transfer");
    expect(delegate.functionCall?.deposit).toBe(1n);

    const args = parseFtTransferArgs(delegate.functionCall!.args);
    expect(args.receiver_id).toBe("merchant.testnet");
    expect(args.amount).toBe("1000000");
  });

  it("verifies a valid ed25519 signature", async () => {
    const { b64 } = await buildSignedDelegateB64({ curve: "ed25519" });
    expect(decodeSignedDelegateB64(b64).verifySignature()).toBe(true);
  });

  it("verifies a valid secp256k1 signature", async () => {
    const { b64 } = await buildSignedDelegateB64({ curve: "secp256k1" });
    const decoded = decodeSignedDelegateB64(b64);
    expect(decoded.delegate.curve).toBe("secp256k1");
    expect(decoded.verifySignature()).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const tampered = tamperSignature(b64);
    expect(decodeSignedDelegateB64(tampered).verifySignature()).toBe(false);
  });

  it("computes deterministic timeout blocks (1 block/sec)", () => {
    expect(computeTimeoutBlocks(60)).toBe(60n);
    expect(computeTimeoutBlocks(1)).toBe(1n);
    expect(computeTimeoutBlocks(0)).toBe(1n); // floored to at least one block
  });

  it("derives a stable cache key that differs per payload", async () => {
    const { b64: a } = await buildSignedDelegateB64({ nonce: 1n });
    const { b64: b } = await buildSignedDelegateB64({ nonce: 2n });
    expect(settlementCacheKey(a)).toBe(settlementCacheKey(a));
    expect(settlementCacheKey(a)).not.toBe(settlementCacheKey(b));
    expect(settlementCacheKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed ft_transfer args", () => {
    expect(() => parseFtTransferArgs(new TextEncoder().encode("{}"))).toThrow();
    expect(() =>
      parseFtTransferArgs(
        new TextEncoder().encode(JSON.stringify({ receiver_id: "a.near", amount: 5 })),
      ),
    ).toThrow();
  });
});
