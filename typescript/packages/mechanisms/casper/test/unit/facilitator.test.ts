import casperSdk, { type Transaction } from "casper-js-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactCasperScheme as ClientExactCasperScheme } from "../../src/exact/client/scheme";
import { ExactCasperScheme } from "../../src/exact/facilitator/scheme";
import {
  ErrAmountMismatch,
  ErrAuthorizationUsed,
  ErrExpired,
  ErrInsufficientBalance,
  ErrInvalidAsset,
  ErrInvalidPayTo,
  ErrInvalidScheme,
  ErrInvalidSignature,
  ErrNetworkMismatch,
  ErrNonCanonicalSignature,
  ErrNotYetValid,
  ErrPayToMismatch,
  ErrPublicKeyMismatch,
  ErrSettleFailed,
  ErrSpeculativeExecutionFailed,
  ErrUnsupportedAsset,
} from "../../src/exact/facilitator/scheme";
import { toClientCasperSigner } from "../../src/signer";
import type { ExactCasperPayload, FacilitatorCasperSigner } from "../../src/types";

const { KeyAlgorithm, PrivateKey } = casperSdk;

const testAsset = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const testPayTo = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const testPackagePayTo = `01${"b".repeat(64)}`;
const testNetwork = "casper:casper-test";

function createMockSigner(
  overrides: Partial<FacilitatorCasperSigner> = {},
): FacilitatorCasperSigner {
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  return {
    getNetworkConfig: async () => ({
      chainName: "casper-test",
      rpcUrl: "http://localhost:11101/rpc",
    }),
    getAddresses: () => [privateKey.publicKey.accountHash().toHex()],
    getPublicKeyHex: () => privateKey.publicKey.toHex(),
    getBalance: vi.fn(async () => 10_000_000n),
    getAuthorizationState: vi.fn(async () => "unused"),
    assertTransferWithAuthorizationSupported: vi.fn(async () => {}),
    signTransaction: vi.fn(async () => {}),
    putTransaction: vi.fn(async () => "a".repeat(64)),
    waitForTransaction: vi.fn(async () => {}),
    ...overrides,
  };
}

function buildRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: testNetwork,
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

function buildPaymentPayload(payload: ExactCasperPayload): PaymentPayload {
  const requirements = buildRequirements();
  return {
    x402Version: 2,
    accepted: requirements,
    payload: payload as unknown as Record<string, unknown>,
  };
}

async function createValidPayload(
  requirements: PaymentRequirements = buildRequirements(),
  keyAlgorithm = KeyAlgorithm.ED25519,
): Promise<ExactCasperPayload> {
  const privateKey = PrivateKey.generate(keyAlgorithm);
  const clientSigner = toClientCasperSigner(privateKey);
  const clientScheme = new ClientExactCasperScheme(clientSigner);
  const result = await clientScheme.createPaymentPayload(2, requirements);
  return result.payload as ExactCasperPayload;
}

describe("ExactCasperScheme facilitator", () => {
  it("returns extra and signer addresses", () => {
    const signer = createMockSigner();
    const scheme = new ExactCasperScheme(signer);

    expect(scheme.getExtra(testNetwork)).toEqual({});
    expect(scheme.getSigners(testNetwork)).toEqual(signer.getAddresses(testNetwork));
  });

  it("validates a correct payload", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    const result = await scheme.verify(buildPaymentPayload(payload), buildRequirements());

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payload.authorization.from);
  });

  it("rejects structural mismatches", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements({ scheme: "upto" })),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidScheme,
    });
    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements({ network: "casper:other" })),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrNetworkMismatch,
    });
    await expect(
      scheme.verify(
        buildPaymentPayload(payload),
        buildRequirements({ payTo: "00".padEnd(66, "0") }),
      ),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrPayToMismatch });
    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements({ amount: "2000000" })),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrAmountMismatch });
    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements({ asset: "bad" })),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrInvalidAsset });
  });

  it("rejects invalid authorization fields", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    const invalidPayTo = structuredClone(payload);
    invalidPayTo.authorization.to = "bad";
    await expect(
      scheme.verify(buildPaymentPayload(invalidPayTo), buildRequirements({ payTo: "bad" })),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrInvalidPayTo });

    const expired = structuredClone(payload);
    expired.authorization.validAfter = String(Math.floor(Date.now() / 1000) - 100);
    expired.authorization.validBefore = String(Math.floor(Date.now() / 1000) - 10);
    await expect(
      scheme.verify(buildPaymentPayload(expired), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrExpired,
    });

    const future = structuredClone(payload);
    future.authorization.validAfter = String(Math.floor(Date.now() / 1000) + 100);
    future.authorization.validBefore = String(Math.floor(Date.now() / 1000) + 200);
    await expect(
      scheme.verify(buildPaymentPayload(future), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrNotYetValid,
    });
  });

  it("rejects payloads whose signature and public key use different algorithms", async () => {
    const scheme = new ExactCasperScheme(createMockSigner());

    for (const { signingAlgorithm, publicKeyAlgorithm } of [
      {
        signingAlgorithm: KeyAlgorithm.ED25519,
        publicKeyAlgorithm: KeyAlgorithm.SECP256K1,
      },
      {
        signingAlgorithm: KeyAlgorithm.SECP256K1,
        publicKeyAlgorithm: KeyAlgorithm.ED25519,
      },
    ]) {
      const payload = await createValidPayload(buildRequirements(), signingAlgorithm);
      const mismatchedPublicKey = structuredClone(payload);
      mismatchedPublicKey.publicKey = payload.publicKey.replace(
        new RegExp(`^0${signingAlgorithm.toString()}`),
        `0${publicKeyAlgorithm.toString()}`,
      );

      await expect(
        scheme.verify(buildPaymentPayload(mismatchedPublicKey), buildRequirements()),
      ).resolves.toMatchObject({ isValid: false, invalidReason: ErrInvalidSignature });
    }
  });

  it("rejects signature and public key failures", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    const wrongPublicKey = structuredClone(payload);
    wrongPublicKey.publicKey = PrivateKey.generate(KeyAlgorithm.ED25519).publicKey.toHex();
    await expect(
      scheme.verify(buildPaymentPayload(wrongPublicKey), buildRequirements()),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrPublicKeyMismatch });

    const invalidSignature = structuredClone(payload);
    invalidSignature.signature = "01" + "0".repeat(128);
    await expect(
      scheme.verify(buildPaymentPayload(invalidSignature), buildRequirements()),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrInvalidSignature });

    const highS = structuredClone(payload);
    highS.signature = "02" + "0".repeat(64) + "f".repeat(64);
    await expect(
      scheme.verify(buildPaymentPayload(highS), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrNonCanonicalSignature,
    });
  });

  it("rejects failed preflight checks", async () => {
    const payload = await createValidPayload();

    await expect(
      new ExactCasperScheme(createMockSigner({ getBalance: vi.fn(async () => 1n) })).verify(
        buildPaymentPayload(payload),
        buildRequirements(),
      ),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrInsufficientBalance });

    await expect(
      new ExactCasperScheme(
        createMockSigner({ getAuthorizationState: vi.fn(async () => "used") }),
      ).verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrAuthorizationUsed });

    await expect(
      new ExactCasperScheme(
        createMockSigner({
          assertTransferWithAuthorizationSupported: vi.fn(async () => {
            throw new Error("missing entry point");
          }),
        }),
      ).verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrUnsupportedAsset });
  });

  it("runs speculative execution when configured", async () => {
    const payload = await createValidPayload();
    const simulateTransferWithAuthorization = vi.fn(async () => {});
    const signer = createMockSigner({ simulateTransferWithAuthorization });
    const scheme = new ExactCasperScheme(signer);

    const result = await scheme.verify(buildPaymentPayload(payload), buildRequirements());

    expect(result).toMatchObject({ isValid: true, payer: payload.authorization.from });
    expect(simulateTransferWithAuthorization).toHaveBeenCalledTimes(1);
    const call = simulateTransferWithAuthorization.mock.calls[0]?.[0];
    expect(call).toMatchObject({ network: testNetwork, asset: testAsset });
    expect(call?.deploy).toBeDefined();
  });

  it("preserves the custom signer receiver during speculative execution", async () => {
    const payload = await createValidPayload();
    const signer = createMockSigner();
    let receiver: FacilitatorCasperSigner | undefined;
    signer.simulateTransferWithAuthorization = async function (this: FacilitatorCasperSigner) {
      receiver = this;
    };
    const scheme = new ExactCasperScheme(signer);

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({ isValid: true });

    expect(receiver).toBe(signer);
  });

  it("rejects speculative execution failures", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(
      createMockSigner({
        simulateTransferWithAuthorization: vi.fn(async () => {
          throw new Error("simulation reverted");
        }),
      }),
    );

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrSpeculativeExecutionFailed,
      invalidMessage: "simulation reverted",
      payer: payload.authorization.from,
    });
  });

  it("skips speculative execution when no simulation hook is configured", async () => {
    const payload = await createValidPayload();
    const signer = createMockSigner();
    const scheme = new ExactCasperScheme(signer);

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: true,
    });

    expect("simulateTransferWithAuthorization" in signer).toBe(false);
  });

  it("settles valid payloads and maps failures", async () => {
    const payload = await createValidPayload();
    const signer = createMockSigner();
    const scheme = new ExactCasperScheme(signer);

    const success = await scheme.settle(buildPaymentPayload(payload), buildRequirements());

    expect(success).toMatchObject({
      success: true,
      transaction: "a".repeat(64),
      network: testNetwork,
      payer: payload.authorization.from,
    });
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);

    const failed = await new ExactCasperScheme(
      createMockSigner({
        putTransaction: vi.fn(async () => {
          throw new Error("rpc error");
        }),
      }),
    ).settle(buildPaymentPayload(payload), buildRequirements());

    expect(failed).toMatchObject({
      success: false,
      errorReason: ErrSettleFailed,
      transaction: "",
    });
  });

  it("preserves package-hash recipients in settlement runtime args", async () => {
    const requirements = buildRequirements({ payTo: testPackagePayTo });
    const payload = await createValidPayload(requirements);
    const signer = createMockSigner();
    const scheme = new ExactCasperScheme(signer);

    await scheme.settle(buildPaymentPayload(payload), requirements);

    const transaction = vi.mocked(signer.signTransaction).mock.calls[0]?.[0] as
      | Transaction
      | undefined;
    expect(transaction?.args.getByName("from")?.key?.toString()).toBe(
      `account-hash-${payload.authorization.from.slice(2)}`,
    );
    expect(transaction?.args.getByName("to")?.key?.toString()).toBe(
      `hash-${testPackagePayTo.slice(2)}`,
    );
  });
});
