/**
 * Unit tests for the pure helpers + verify branch matrix in payment.ts.
 *
 * Runner: node --test via tsx loader (no test-framework dependency).
 *   npm test          # via the added script
 *   or: npx tsx --test tests/payment.test.ts
 *
 * These tests are hermetic — no RPC calls, no timers, no filesystem.
 * The verifyEIP3009 tests inject a stubbed PublicClient whose readContract
 * returns pre-seeded values (authorizationState, balanceOf) so we can
 * exercise each error path deterministically.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Address } from "viem";
import { __test } from "../src/payment.js";

const { toBig, normalizeAuth, resolveToken, verifyEIP3009, USDG } = __test;

// ── Fixtures ──────────────────────────────────────────────────────────
// Deterministic payer wallet. This key is for tests only; it is not funded
// and never touches a real chain.
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const payer = privateKeyToAccount(PAYER_KEY);
const PAYEE: Address = "0x000000000000000000000000000000000000dEaD";
const NONCE = keccak256(toHex("test-nonce-1"));

function makeAuth(overrides: Partial<Record<string, any>> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    from: payer.address,
    to: PAYEE,
    value: "500000",
    validAfter: String(now - 60),
    validBefore: String(now + 300),
    nonce: NONCE,
    ...overrides,
  };
}

// Build a valid EIP-712 signed payload for the "happy path" tests.
async function signedPayload(overrides: Partial<Record<string, any>> = {}) {
  const auth = makeAuth(overrides);
  const domain = {
    name: "USDG",
    version: "2",
    chainId: 46630,
    verifyingContract: USDG,
  } as const;
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  } as const;
  const signature = await payer.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  return { scheme: "exact", payload: { authorization: auth, signature } };
}

// Stubbed PublicClient. Enough of the shape for verifyEIP3009 to run.
type Stub = {
  nonceUsed?: boolean;
  balance?: bigint;
};
function stubClient(cfg: Stub = {}) {
  const s = { nonceUsed: false, balance: 10_000_000n, ...cfg };
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "authorizationState") return s.nonceUsed;
      if (functionName === "balanceOf") return s.balance;
      throw new Error(`unstubbed readContract: ${functionName}`);
    },
  } as any; // typed loosely — verifyEIP3009 only uses readContract
}

// ── toBig ──────────────────────────────────────────────────────────────
describe("toBig", () => {
  it("passes bigints through unchanged", () => {
    assert.equal(toBig(42n), 42n);
  });

  it("converts finite numbers", () => {
    assert.equal(toBig(500_000), 500_000n);
  });

  it("parses decimal strings (v2 spec)", () => {
    assert.equal(toBig("500000"), 500_000n);
  });

  it("parses hex strings (legacy)", () => {
    assert.equal(toBig("0x7A120"), 500_000n);
    assert.equal(toBig("0X7A120"), 500_000n);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(toBig("  123  "), 123n);
  });

  it("handles a very large 256-bit value", () => {
    const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    assert.equal(toBig(big), 2n ** 256n - 1n);
  });

  it("throws on non-numeric garbage", () => {
    assert.throws(() => toBig("not-a-number"));
  });
});

// ── resolveToken ──────────────────────────────────────────────────────
describe("resolveToken", () => {
  it("returns the configured USDG when asset is 'USDG'", () => {
    assert.equal(resolveToken({ asset: "USDG" }).toLowerCase(), USDG.toLowerCase());
  });

  it("returns the configured USDG when asset/token is missing", () => {
    assert.equal(resolveToken({}).toLowerCase(), USDG.toLowerCase());
  });

  it("checksums an arbitrary address", () => {
    // All-lowercase input should come back checksummed.
    const lower = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const out = resolveToken({ asset: lower });
    assert.equal(out.toLowerCase(), lower);
    assert.notEqual(out, lower); // it re-cased for the checksum
  });

  it("prefers `asset` (v2) over `token` (legacy) when both present", () => {
    const other = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const out = resolveToken({ asset: other, token: "USDG" });
    assert.equal(out.toLowerCase(), other);
  });
});

// ── normalizeAuth ─────────────────────────────────────────────────────
describe("normalizeAuth", () => {
  it("accepts the v2 nested shape (payload.authorization + payload.signature)", () => {
    const sig = "0x" + "aa".repeat(65);
    const out = normalizeAuth({ payload: { authorization: makeAuth(), signature: sig } });
    assert.ok(out);
    assert.equal(out!.value, 500_000n);
    assert.equal(out!.signature, sig);
  });

  it("accepts a flat legacy payload", () => {
    const sig = "0x" + "bb".repeat(65);
    const out = normalizeAuth({ ...makeAuth(), signature: sig });
    assert.ok(out);
    assert.equal(out!.from.toLowerCase(), payer.address.toLowerCase());
  });

  it("returns null when signature is missing", () => {
    assert.equal(normalizeAuth({ payload: { authorization: makeAuth() } }), null);
  });

  it("returns null when authorization.from is missing", () => {
    const bad = makeAuth();
    delete (bad as any).from;
    assert.equal(normalizeAuth({ payload: { authorization: bad, signature: "0x" + "cc".repeat(65) } }), null);
  });

  it("returns null when nonce is missing", () => {
    const bad = makeAuth();
    delete (bad as any).nonce;
    assert.equal(normalizeAuth({ payload: { authorization: bad, signature: "0x" + "dd".repeat(65) } }), null);
  });

  it("preserves the raw nonce bytes32 as-is", () => {
    const sig = "0x" + "ee".repeat(65);
    const out = normalizeAuth({ payload: { authorization: makeAuth(), signature: sig } });
    assert.equal(out!.nonce, NONCE);
  });
});

// ── verifyEIP3009: branch matrix ──────────────────────────────────────
describe("verifyEIP3009", () => {
  const baseReqs = {
    scheme: "exact",
    network: "eip155:46630",
    amount: "500000",
    payTo: PAYEE,
    asset: USDG,
    extra: { name: "USDG", version: "2" },
  };

  it("rejects a malformed payload", async () => {
    const client = stubClient();
    const out = await verifyEIP3009(client, {}, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "malformed_payload");
  });

  it("rejects a nonce that has already been used", async () => {
    const client = stubClient({ nonceUsed: true });
    const p = await signedPayload();
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "nonce_already_used");
  });

  it("rejects when payer balance is below value", async () => {
    const client = stubClient({ balance: 1n });
    const p = await signedPayload();
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "insufficient_funds");
  });

  it("rejects when authorized value doesn't match requirements.amount", async () => {
    const client = stubClient();
    const p = await signedPayload({ value: "400000" });
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "amount_mismatch");
  });

  it("rejects when auth.to differs from requirements.payTo (redirection attack)", async () => {
    const client = stubClient();
    const attacker = "0x1234567890123456789012345678901234567890" as Address;
    const p = await signedPayload({ to: attacker });
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "recipient_mismatch");
  });

  it("rejects an authorization whose validAfter is in the future", async () => {
    const client = stubClient();
    const p = await signedPayload({ validAfter: String(Math.floor(Date.now() / 1000) + 3600) });
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "authorization_not_yet_valid");
  });

  it("rejects an expired authorization", async () => {
    const client = stubClient();
    const p = await signedPayload({ validBefore: String(Math.floor(Date.now() / 1000) - 60) });
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.equal(out.invalidReason, "authorization_expired");
  });

  it("rejects a signature that doesn't recover the `from` address", async () => {
    const client = stubClient();
    const p = await signedPayload();
    // Flip one byte in r to invalidate.
    const sig = p.payload.signature;
    const mutated = sig.slice(0, 4) + (sig[4] === "0" ? "1" : "0") + sig.slice(5);
    p.payload.signature = mutated as `0x${string}`;
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, false);
    assert.ok(
      out.invalidReason === "signature_mismatch" || out.invalidReason === "signature_verification_failed",
      `unexpected reason: ${out.invalidReason}`,
    );
  });

  it("accepts a fully valid v2 payload", async () => {
    const client = stubClient();
    const p = await signedPayload();
    const out = await verifyEIP3009(client, p, baseReqs);
    assert.equal(out.isValid, true, `unexpected reject: ${out.invalidReason}`);
    assert.equal(out.payer?.toLowerCase(), payer.address.toLowerCase());
  });
});
