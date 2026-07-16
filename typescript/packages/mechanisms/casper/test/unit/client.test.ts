import casperSdk from "casper-js-sdk";
import { describe, expect, it } from "vitest";
import { ExactCasperScheme } from "../../src/exact/client/scheme";
import { toClientCasperSigner } from "../../src/signer";
import type { ExactCasperPayload } from "../../src/types";

const { KeyAlgorithm, PrivateKey } = casperSdk;

const testAsset = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const testPayTo = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";

function createTestSigner() {
  return toClientCasperSigner(PrivateKey.generate(KeyAlgorithm.ED25519));
}

function buildRequirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "casper:casper-test",
    asset: testAsset,
    amount: "1000000",
    payTo: testPayTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "TestToken",
      version: "1",
    },
    ...overrides,
  };
}

describe("ExactCasperScheme client", () => {
  it("creates a signed exact Casper payload", async () => {
    const scheme = new ExactCasperScheme(createTestSigner());
    const result = await scheme.createPaymentPayload(2, buildRequirements());
    const payload = result.payload as ExactCasperPayload;

    expect(result.x402Version).toBe(2);
    expect(payload.signature).toMatch(/^[0-9a-fA-F]{130}$/);
    expect(payload.publicKey).toMatch(/^01[0-9a-fA-F]{64}$/);
    expect(payload.authorization).toMatchObject({
      from: expect.stringMatching(/^00[0-9a-fA-F]{64}$/),
      to: testPayTo,
      value: "1000000",
      nonce: expect.stringMatching(/^[0-9a-fA-F]{64}$/),
    });
  });

  it("sets validity timestamps around maxTimeoutSeconds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const scheme = new ExactCasperScheme(createTestSigner());
    const result = await scheme.createPaymentPayload(2, buildRequirements());
    const payload = result.payload as ExactCasperPayload;

    expect(Number(payload.authorization.validAfter)).toBeGreaterThanOrEqual(now - 605);
    expect(Number(payload.authorization.validAfter)).toBeLessThanOrEqual(now - 595);
    expect(Number(payload.authorization.validBefore)).toBeGreaterThanOrEqual(now + 295);
    expect(Number(payload.authorization.validBefore)).toBeLessThanOrEqual(now + 305);
  });

  it("rejects invalid requirements", async () => {
    const scheme = new ExactCasperScheme(createTestSigner());

    await expect(
      scheme.createPaymentPayload(2, buildRequirements({ scheme: "upto" })),
    ).rejects.toThrow("invalid_exact_casper_client_invalid_scheme");
    await expect(
      scheme.createPaymentPayload(2, buildRequirements({ asset: "bad" })),
    ).rejects.toThrow("invalid_exact_casper_client_invalid_asset");
    await expect(
      scheme.createPaymentPayload(2, buildRequirements({ payTo: "bad" })),
    ).rejects.toThrow("invalid_exact_casper_client_invalid_pay_to");
    await expect(
      scheme.createPaymentPayload(2, buildRequirements({ extra: { version: "1" } })),
    ).rejects.toThrow("invalid_exact_casper_client_missing_token_name");
    await expect(
      scheme.createPaymentPayload(2, buildRequirements({ extra: { name: "TestToken" } })),
    ).rejects.toThrow("invalid_exact_casper_client_missing_token_version");
  });

  it("creates a unique nonce for each payload", async () => {
    const scheme = new ExactCasperScheme(createTestSigner());
    const first = (await scheme.createPaymentPayload(2, buildRequirements()))
      .payload as ExactCasperPayload;
    const second = (await scheme.createPaymentPayload(2, buildRequirements()))
      .payload as ExactCasperPayload;

    expect(first.authorization.nonce).not.toBe(second.authorization.nonce);
  });

  it("preserves signature algorithm byte", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    const scheme = new ExactCasperScheme(toClientCasperSigner(privateKey));
    const result = await scheme.createPaymentPayload(2, buildRequirements());
    const payload = result.payload as ExactCasperPayload;

    expect(payload.publicKey.slice(0, 2)).toBe("02");
    expect(payload.signature.slice(0, 2)).toBe("02");
  });
});
