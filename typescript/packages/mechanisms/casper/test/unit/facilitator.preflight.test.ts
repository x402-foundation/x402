import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  RpcClient,
  newSpeculativeClient,
  rpcClient,
  speculativeExec,
  contractHash,
  tokenPackage,
  tokenContract,
  dictionaryU256,
  dictionaryBool,
} = vi.hoisted(() => {
  const rpcClient = {
    queryLatestGlobalState: vi.fn(),
    getDictionaryItemByIdentifier: vi.fn(),
  };
  const speculativeExec = vi.fn();
  const contractHash = "b".repeat(64);
  const tokenPackage = {
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
  };
  const tokenContract = {
    storedValue: {
      contract: {
        entryPoints: [{ name: "transfer_with_authorization" }],
      },
    },
  };
  return {
    RpcClient: vi.fn(() => rpcClient),
    newSpeculativeClient: vi.fn(() => ({ speculativeExec })),
    rpcClient,
    speculativeExec,
    contractHash,
    tokenPackage,
    tokenContract,
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
    SpeculativeClient: {
      newSpeculativeClient,
    },
  };
});

import { KeyAlgorithm, PrivateKey, type Transaction } from "casper-js-sdk";
import { ExactCasperScheme as ClientExactCasperScheme } from "../../src/exact/client/scheme";
import {
  ErrAuthorizationUsed,
  ErrInsufficientBalance,
  ErrNetworkMismatch,
  ErrSpeculativeExecutionFailed,
  ErrUnsupportedAsset,
  ExactCasperScheme,
} from "../../src/exact/facilitator/scheme";
import { toClientCasperSigner } from "../../src/signer";
import type { ExactCasperPayload, FacilitatorCasperSigner } from "../../src/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const testAsset = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const testPayTo = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
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
    getSpeculativeRpcUrl: () => undefined,
    getAddresses: () => [privateKey.publicKey.accountHash().toHex()],
    getPublicKeyHex: () => privateKey.publicKey.toHex(),
    signTransaction: vi.fn(async (_transaction: Transaction) => {}),
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
): Promise<ExactCasperPayload> {
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const clientSigner = toClientCasperSigner(privateKey);
  const clientScheme = new ClientExactCasperScheme(clientSigner);
  const result = await clientScheme.createPaymentPayload(2, requirements);
  return result.payload as ExactCasperPayload;
}

describe("ExactCasperScheme facilitator preflight", () => {
  beforeEach(() => {
    RpcClient.mockClear();
    newSpeculativeClient.mockClear();
    speculativeExec.mockReset();
    rpcClient.queryLatestGlobalState.mockReset();
    rpcClient.getDictionaryItemByIdentifier.mockReset();
    rpcClient.queryLatestGlobalState
      .mockResolvedValueOnce(tokenPackage)
      .mockResolvedValueOnce(tokenContract);
    rpcClient.getDictionaryItemByIdentifier
      .mockResolvedValueOnce(dictionaryU256("1000000"))
      .mockResolvedValueOnce(dictionaryBool(false));
  });

  it("runs SDK-owned targeted RPC preflight when no speculative URL is configured", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    const result = await scheme.verify(buildPaymentPayload(payload), buildRequirements());

    expect(result).toMatchObject({ isValid: true, payer: payload.authorization.from });
    expect(newSpeculativeClient).not.toHaveBeenCalled();
    expect(rpcClient.queryLatestGlobalState).toHaveBeenCalledWith(`hash-${testAsset}`, []);
    expect(rpcClient.queryLatestGlobalState).toHaveBeenCalledWith(`hash-${contractHash}`, []);
    expect(rpcClient.getDictionaryItemByIdentifier).toHaveBeenCalledTimes(2);
    expect(rpcClient.getDictionaryItemByIdentifier.mock.calls[0]?.[1]).toMatchObject({
      contractNamedKey: {
        key: `hash-${contractHash}`,
        dictionaryName: "balances",
      },
    });
    expect(rpcClient.getDictionaryItemByIdentifier.mock.calls[1]?.[1]).toMatchObject({
      contractNamedKey: {
        key: `hash-${contractHash}`,
        dictionaryName: "authorization_state",
      },
    });
  });

  it("maps signer network config failures to network mismatch", async () => {
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(
      createMockSigner({
        getNetworkConfig: async () => {
          throw new Error("unsupported network");
        },
      }),
    );

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrNetworkMismatch,
      invalidMessage: "unsupported network",
      payer: payload.authorization.from,
    });
  });

  it("runs speculative execution only when a speculative URL is configured", async () => {
    speculativeExec.mockResolvedValueOnce({ executionResult: {} });
    const payload = await createValidPayload();
    const signer = createMockSigner({
      getSpeculativeRpcUrl: () => "http://localhost:7778/rpc",
    });
    const scheme = new ExactCasperScheme(signer);

    const result = await scheme.verify(buildPaymentPayload(payload), buildRequirements());

    expect(result).toMatchObject({ isValid: true, payer: payload.authorization.from });
    expect(newSpeculativeClient).toHaveBeenCalledTimes(1);
    expect(speculativeExec).toHaveBeenCalledTimes(1);
    expect(rpcClient.queryLatestGlobalState).not.toHaveBeenCalled();
    expect(rpcClient.getDictionaryItemByIdentifier).not.toHaveBeenCalled();
  });

  it("maps speculative execution failures to invalid verification", async () => {
    speculativeExec.mockResolvedValueOnce({ executionResult: { errorMessage: "reverted" } });
    const payload = await createValidPayload();
    const signer = createMockSigner({
      getSpeculativeRpcUrl: () => "http://localhost:7778/rpc",
    });
    const scheme = new ExactCasperScheme(signer);

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrSpeculativeExecutionFailed,
      invalidMessage: "speculative execution failed: reverted",
      payer: payload.authorization.from,
    });
  });

  it("maps unrecognized speculative execution responses to invalid verification", async () => {
    speculativeExec.mockResolvedValueOnce({ rawJSON: { api_version: "1.5.0" } });
    const payload = await createValidPayload();
    const signer = createMockSigner({
      getSpeculativeRpcUrl: () => "http://localhost:7778/rpc",
    });
    const scheme = new ExactCasperScheme(signer);

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrSpeculativeExecutionFailed,
      invalidMessage:
        'speculative execution returned an unrecognized response: : {"api_version":"1.5.0"}',
      payer: payload.authorization.from,
    });
  });

  it("rejects insufficient CEP-18 balances from targeted RPC preflight", async () => {
    rpcClient.getDictionaryItemByIdentifier
      .mockReset()
      .mockResolvedValueOnce(dictionaryU256("999999"))
      .mockResolvedValueOnce(dictionaryBool(false));
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInsufficientBalance,
      payer: payload.authorization.from,
    });
  });

  it("maps token package lookup failures to unsupported asset", async () => {
    rpcClient.queryLatestGlobalState
      .mockReset()
      .mockRejectedValueOnce(new Error("rpc unavailable"));
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrUnsupportedAsset,
      invalidMessage: "rpc unavailable",
      payer: payload.authorization.from,
    });
  });

  it("maps malformed balance dictionary values to insufficient balance", async () => {
    rpcClient.getDictionaryItemByIdentifier
      .mockReset()
      .mockResolvedValueOnce(dictionaryU256("not-a-number"));
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrInsufficientBalance,
      invalidMessage: "invalid U256 dictionary value",
      payer: payload.authorization.from,
    });
  });

  it("rejects used CEP-3009 authorizations from targeted RPC preflight", async () => {
    rpcClient.getDictionaryItemByIdentifier
      .mockReset()
      .mockResolvedValueOnce(dictionaryU256("1000000"))
      .mockResolvedValueOnce(dictionaryBool(true));
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrAuthorizationUsed,
      payer: payload.authorization.from,
    });
  });

  it("allows missing authorization_state dictionary items", async () => {
    rpcClient.getDictionaryItemByIdentifier
      .mockReset()
      .mockResolvedValueOnce(dictionaryU256("1000000"))
      .mockRejectedValueOnce({ sourceErr: { data: "dictionary URef not found" } });
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: true,
      payer: payload.authorization.from,
    });
  });

  it("maps nonce dictionary read failures to authorization-used errors", async () => {
    rpcClient.getDictionaryItemByIdentifier
      .mockReset()
      .mockResolvedValueOnce(dictionaryU256("1000000"))
      .mockRejectedValueOnce(new Error("dictionary seed URef not found"));
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrAuthorizationUsed,
      invalidMessage: "dictionary seed URef not found",
      payer: payload.authorization.from,
    });
  });

  it("rejects token contracts without transfer_with_authorization", async () => {
    rpcClient.queryLatestGlobalState
      .mockReset()
      .mockResolvedValueOnce(tokenPackage)
      .mockResolvedValueOnce({
        storedValue: {
          contract: {
            entryPoints: [{ name: "transfer" }],
          },
        },
      });
    const payload = await createValidPayload();
    const scheme = new ExactCasperScheme(createMockSigner());

    await expect(
      scheme.verify(buildPaymentPayload(payload), buildRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ErrUnsupportedAsset,
      payer: payload.authorization.from,
    });
  });
});
