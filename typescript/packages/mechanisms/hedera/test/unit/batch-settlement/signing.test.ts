import { PrivateKey } from "@hiero-ledger/sdk";
import { hexToBytes, keccak256, recoverAddress, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  computeHederaAllowanceDepositDigest,
  HEDERA_ALLOWANCE_DEPOSIT_TYPEHASH,
  keyTypeOf,
  resolveSigningKeyFromKey,
  signDigestWithPrivateKey,
  verifyDigestSignature,
} from "../../../src/batch-settlement";

const DIGEST = keccak256(toBytes("x402 hedera batch-settlement digest"));

describe("signing", () => {
  it("detects key types", () => {
    expect(keyTypeOf(PrivateKey.generateED25519())).toBe("ED25519");
    expect(keyTypeOf(PrivateKey.generateECDSA())).toBe("ECDSA_SECP256K1");
  });

  it("signs a digest with ED25519 (64 bytes) and verifies it", async () => {
    const key = PrivateKey.generateED25519();
    const sig = await signDigestWithPrivateKey(key, DIGEST);
    expect(hexToBytes(sig).length).toBe(64);
    const resolved = resolveSigningKeyFromKey(key.publicKey);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.key.keyType).toBe("ED25519");
    await expect(
      verifyDigestSignature({ key: resolved.key, digest: DIGEST, signature: sig }),
    ).resolves.toBe(true);
    const other = keccak256(toBytes("other"));
    await expect(
      verifyDigestSignature({ key: resolved.key, digest: other, signature: sig }),
    ).resolves.toBe(false);
  });

  it("signs a digest with ECDSA (65 bytes r||s||v over the raw digest) and verifies it", async () => {
    const key = PrivateKey.generateECDSA();
    const sig = await signDigestWithPrivateKey(key, DIGEST);
    expect(hexToBytes(sig).length).toBe(65);
    const v = hexToBytes(sig)[64];
    expect([27, 28]).toContain(v);
    const resolved = resolveSigningKeyFromKey(key.publicKey);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.key.derivedEvmAddress?.toLowerCase()).toBe(
      `0x${key.publicKey.toEvmAddress().replace(/^0x/, "")}`.toLowerCase(),
    );
    // ecrecover over the raw digest recovers the account's EVM address (HAS semantics).
    const recovered = await recoverAddress({ hash: DIGEST, signature: sig });
    expect(recovered.toLowerCase()).toBe(resolved.key.derivedEvmAddress?.toLowerCase());
    await expect(
      verifyDigestSignature({ key: resolved.key, digest: DIGEST, signature: sig }),
    ).resolves.toBe(true);
  });

  it("rejects cross-type signatures", async () => {
    const ed = PrivateKey.generateED25519();
    const ec = PrivateKey.generateECDSA();
    const edSig = await signDigestWithPrivateKey(ed, DIGEST);
    const ecSig = await signDigestWithPrivateKey(ec, DIGEST);
    const edKey = resolveSigningKeyFromKey(ed.publicKey);
    const ecKey = resolveSigningKeyFromKey(ec.publicKey);
    if (!edKey.ok || !ecKey.ok) throw new Error("unexpected");
    await expect(
      verifyDigestSignature({ key: edKey.key, digest: DIGEST, signature: ecSig }),
    ).resolves.toBe(false);
    await expect(
      verifyDigestSignature({ key: ecKey.key, digest: DIGEST, signature: edSig }),
    ).resolves.toBe(false);
  });

  it("rejects malformed digests", async () => {
    await expect(
      signDigestWithPrivateKey(PrivateKey.generateED25519(), "0x1234"),
    ).rejects.toThrow();
  });
});

describe("deposit digest", () => {
  it("matches the Foundry vector (HederaAllowanceDepositCollector.t.sol)", () => {
    expect(HEDERA_ALLOWANCE_DEPOSIT_TYPEHASH).toBe(
      "0x07f61aa4f52ac5dc2175ba8dba6961ffd0d966d127c070f4d6f91f7fcafd95be",
    );
    const digest = computeHederaAllowanceDepositDigest({
      channelId: "0x0000000000000000000000000000000000000000000000000000000000001111",
      token: "0x0000000000000000000000000000000000068cDa",
      amount: "5000000",
      nonce: "42",
      deadline: "1800000000",
      collector: "0x00000000000000000000000000000000000aBCdE",
      chainId: 296,
    });
    expect(digest).toBe("0x75ffc9f0ef6aef449abcd1a4785e713ceec13c65b022ed35742c537db28e86c4");
  });
});
