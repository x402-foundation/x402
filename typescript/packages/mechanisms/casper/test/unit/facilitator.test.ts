import { beforeEach, describe, expect, it, vi } from "vitest";

const { RpcClient, rpcClient, tokenPackage, tokenContract, dictionaryU256, dictionaryBool } =
  vi.hoisted(() => {
    const asset = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
    const contractHash = "b".repeat(64);
    const rpcClient = {
      queryLatestGlobalState: vi.fn(async (key: string) =>
        key === `hash-${asset}`
          ? {
              storedValue: {
                contractPackage: {
                  disabledVersions: [],
                  versions: [
                    {
                      contractVersion: 1,
                      protocolVersionMajor: 1,
                      contractHash: {
                        hash: {
                          toHex: () => contractHash,
                        },
                      },
                    },
                  ],
                },
              },
            }
          : {
              storedValue: {
                contract: {
                  entryPoints: [{ name: "transfer_with_authorization" }],
                },
              },
            },
      ),
      getDictionaryItemByIdentifier: vi.fn(
        async (
          _stateRootHash: string | null,
          identifier: { contractNamedKey?: { dictionaryName?: string } },
        ) => {
          const dictionaryName = identifier.contractNamedKey?.dictionaryName;
          return dictionaryName === "balances"
            ? {
                storedValue: {
                  clValue: {
                    ui256: { toString: () => "1000000" },
                  },
                },
              }
            : {
                storedValue: {
                  clValue: {
                    bool: { getValue: () => false },
                  },
                },
              };
        },
      ),
    };
    return {
      RpcClient: vi.fn(() => rpcClient),
      rpcClient,
      tokenPackage: {
        storedValue: {
          contractPackage: {
            disabledVersions: [],
            versions: [
              {
                contractVersion: 1,
                protocolVersionMajor: 1,
                contractHash: {
                  hash: {
                    toHex: () => contractHash,
                  },
                },
              },
            ],
          },
        },
      },
      tokenContract: {
        storedValue: {
          contract: {
            entryPoints: [{ name: "transfer_with_authorization" }],
          },
        },
      },
      dictionaryU256: (value: string) => ({
        storedValue: {
          clValue: {
            ui256: { toString: () => value },
          },
        },
      }),
      dictionaryBool: (value: boolean) => ({
        storedValue: {
          clValue: {
            bool: { getValue: () => value },
          },
        },
      }),
    };
  });

vi.mock("casper-js-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("casper-js-sdk")>();
  return {
    ...actual,
    RpcClient,
  };
});

import { KeyAlgorithm, PrivateKey, type Transaction } from "casper-js-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactCasperScheme as ClientExactCasperScheme } from "../../src/exact/client/scheme";
import { ExactCasperScheme } from "../../src/exact/facilitator/scheme";
import {
  ErrAmountMismatch,
  ErrExpired,
  ErrInvalidAsset,
  ErrInvalidPayer,
  ErrInvalidPayTo,
  ErrInvalidScheme,
  ErrInvalidSignature,
  ErrMissingTokenName,
  ErrMissingTokenVersion,
  ErrNetworkMismatch,
  ErrNonCanonicalSignature,
  ErrNotYetValid,
  ErrPayToMismatch,
  ErrPublicKeyMismatch,
  ErrSettleFailed,
} from "../../src/exact/facilitator/scheme";
import { toClientCasperSigner } from "../../src/signer";
import type { ExactCasperPayload, FacilitatorCasperSigner } from "../../src/types";

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
    getSpeculativeRpcUrl: () => undefined,
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
  beforeEach(() => {
    RpcClient.mockClear();
    rpcClient.queryLatestGlobalState.mockReset();
    rpcClient.queryLatestGlobalState.mockImplementation(async (key: string) =>
      key === `hash-${testAsset}` ? tokenPackage : tokenContract,
    );
    rpcClient.getDictionaryItemByIdentifier.mockReset();
    rpcClient.getDictionaryItemByIdentifier.mockImplementation(
      async (
        _stateRootHash: string | null,
        identifier: { contractNamedKey?: { dictionaryName?: string } },
      ) =>
        identifier.contractNamedKey?.dictionaryName === "balances"
          ? dictionaryU256("1000000")
          : dictionaryBool(false),
    );
  });

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

  it("rejects malformed payload shapes", async () => {
    const scheme = new ExactCasperScheme(createMockSigner());
    const payment = buildPaymentPayload(await createValidPayload());
    payment.payload = { signature: "01" };

    await expect(scheme.verify(payment, buildRequirements())).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidScheme,
      invalidMessage: "malformed payload",
    });
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

  it("rejects invalid payer, amount, nonce, validity, and token metadata", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    const invalidPayer = structuredClone(payload);
    invalidPayer.authorization.from = `01${"a".repeat(64)}`;
    await expect(
      scheme.verify(buildPaymentPayload(invalidPayer), buildRequirements()),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrInvalidPayer });

    const zeroAmount = structuredClone(payload);
    zeroAmount.authorization.value = "0";
    await expect(
      scheme.verify(buildPaymentPayload(zeroAmount), buildRequirements({ amount: "0" })),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrAmountMismatch,
      invalidMessage: "amount must be non-zero decimal string",
    });

    const invalidNonce = structuredClone(payload);
    invalidNonce.authorization.nonce = "not-a-nonce";
    await expect(
      scheme.verify(buildPaymentPayload(invalidNonce), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
      invalidMessage: "nonce must be 32 bytes",
    });

    const invalidDates = structuredClone(payload);
    invalidDates.authorization.validAfter = "1.5";
    await expect(
      scheme.verify(buildPaymentPayload(invalidDates), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidScheme,
      invalidMessage: "invalid validAfter/validBefore",
    });

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements({ extra: { version: "1" } })),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrMissingTokenName });

    await expect(
      scheme.verify(
        buildPaymentPayload(payload),
        buildRequirements({ extra: { name: "TestToken" } }),
      ),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrMissingTokenVersion });
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
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
      invalidMessage: "invalid signature",
    });

    const algoMismatch = structuredClone(payload);
    algoMismatch.signature = "02" + payload.signature.slice(2);
    await expect(
      scheme.verify(buildPaymentPayload(algoMismatch), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
      invalidMessage: "public key and signature algorithm tags do not match",
    });

    const secp256k1Payload = await createValidPayload(buildRequirements(), KeyAlgorithm.SECP256K1);
    const highS = structuredClone(secp256k1Payload);
    highS.signature = "02" + "0".repeat(64) + "f".repeat(64);
    await expect(
      scheme.verify(buildPaymentPayload(highS), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrNonCanonicalSignature,
    });
  });

  it("rejects malformed signatures and public keys", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    const shortSignature = structuredClone(payload);
    shortSignature.signature = "01" + "0".repeat(126);
    await expect(
      scheme.verify(buildPaymentPayload(shortSignature), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
      invalidMessage: "signature must be 65 bytes",
    });

    const nonHexSignature = structuredClone(payload);
    nonHexSignature.signature = "01zz";
    await expect(
      scheme.verify(buildPaymentPayload(nonHexSignature), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
      invalidMessage: "hex string contains non-hex characters",
    });

    const invalidPublicKey = structuredClone(payload);
    invalidPublicKey.publicKey = "01ff";
    await expect(
      scheme.verify(buildPaymentPayload(invalidPublicKey), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
    });

    const badNetwork = structuredClone(payload);
    await expect(
      scheme.verify(buildPaymentPayload(badNetwork), buildRequirements({ network: "bad-network" })),
    ).resolves.toMatchObject({ isValid: false, invalidReason: ErrNetworkMismatch });
  });

  it("rejects tampered signatures that do not verify", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());
    const tampered = structuredClone(payload);
    tampered.signature = `${payload.signature.slice(0, -2)}${
      payload.signature.endsWith("00") ? "01" : "00"
    }`;

    await expect(
      scheme.verify(buildPaymentPayload(tampered), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignature,
    });
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

  it("returns verify failures directly during settlement", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.settle(buildPaymentPayload(payload), buildRequirements({ amount: "2000000" })),
    ).resolves.toMatchObject({
      success: false,
      errorReason: ErrAmountMismatch,
      transaction: "",
      network: testNetwork,
    });
  });

  it("maps non-error settlement failures", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(
      createMockSigner({
        putTransaction: vi.fn(async () => {
          throw "offline";
        }),
      }),
    );

    await expect(
      scheme.settle(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      success: false,
      errorReason: ErrSettleFailed,
      errorMessage: "offline",
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
