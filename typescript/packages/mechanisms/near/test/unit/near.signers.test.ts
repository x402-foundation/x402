import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { baseEncode } from "@near-js/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEAR_TESTNET_CAIP2 } from "../../src/constants";
import { createClientNearSigner } from "../../src/signers/clientNearSigner";
import {
  createFacilitatorNearSigner,
  interpretOutcome,
  interpretSettlementOutcome,
} from "../../src/signers/facilitatorNearSigner";
import * as providerModule from "../../src/signers/provider";
import { decodeSignedDelegateB64 } from "../../src/utils";
import { FIXTURE, buildSignedDelegateB64, makeRequirements } from "./fixtures/near.fixture";

const TEST_BLOCK_HASH = baseEncode(new Uint8Array(32).fill(9));

const mockProvider = {
  viewAccessKey: vi.fn(),
  block: vi.fn(),
  viewAccount: vi.fn(),
  callFunction: vi.fn(),
  sendTransactionUntil: vi.fn(),
};

describe("createProviderFactory", () => {
  it("throws for unsupported networks", () => {
    const getProvider = providerModule.createProviderFactory();
    expect(() => getProvider("eip155:8453")).toThrow(/Unsupported NEAR network/);
  });

  it("returns a cached provider per network", () => {
    const getProvider = providerModule.createProviderFactory();
    const first = getProvider(NEAR_TESTNET_CAIP2);
    const second = getProvider(NEAR_TESTNET_CAIP2);
    expect(first).toBe(second);
  });

  it("honors per-network RPC URL overrides", () => {
    const getProvider = providerModule.createProviderFactory({
      [NEAR_TESTNET_CAIP2]: "https://custom-rpc.example.com",
    });
    expect(getProvider(NEAR_TESTNET_CAIP2)).toBeDefined();
  });
});

describe("near reference facilitator signer outcome classification", () => {
  it("requires a successful receipt executed by the token contract", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        { outcome: { executor_id: "alice.testnet", status: { SuccessValue: "" } } },
        { outcome: { executor_id: "usdc.testnet", status: { SuccessValue: "" } } },
      ],
    };

    expect(interpretSettlementOutcome(outcome, "usdc.testnet")).toEqual({
      kind: "success",
      value: "",
    });
  });

  it("returns success value from the token contract receipt", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          outcome: {
            executor_id: "usdc.testnet",
            status: { SuccessValue: "dGVzdA==" },
          },
        },
      ],
    };

    expect(interpretSettlementOutcome(outcome, "usdc.testnet")).toEqual({
      kind: "success",
      value: "dGVzdA==",
    });
  });

  it("reports failure when any final receipt failed", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          outcome: {
            executor_id: "usdc.testnet",
            status: { Failure: { ActionError: "NotEnoughBalance" } },
          },
        },
      ],
    };

    const result = interpretSettlementOutcome(outcome, "usdc.testnet");
    expect(result.kind).toBe("failure");
    expect(result.error).toContain("NotEnoughBalance");
  });

  it("reports failure when an intermediate receipt failed", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          outcome: {
            executor_id: "relayer.testnet",
            status: { Failure: { ActionError: "GasExceeded" } },
          },
        },
        { outcome: { executor_id: "usdc.testnet", status: { SuccessValue: "" } } },
      ],
    };

    const result = interpretSettlementOutcome(outcome, "usdc.testnet");
    expect(result.kind).toBe("failure");
    expect(result.error).toContain("GasExceeded");
  });

  it("does not treat outer transaction success as inner transfer success", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        { outcome: { executor_id: "relayer.testnet", status: { SuccessValue: "" } } },
      ],
    };

    expect(interpretSettlementOutcome(outcome, "usdc.testnet")).toEqual({
      kind: "failure",
      error: "inner_ft_transfer_receipt_not_successful",
    });
  });

  it("reports outer transaction failure before inspecting receipts", () => {
    const outcome = {
      status: { Failure: { ActionError: "DelegateActionInvalidNonce" } },
      receipts_outcome: [
        { outcome: { executor_id: "usdc.testnet", status: { SuccessValue: "" } } },
      ],
    };

    const result = interpretSettlementOutcome(outcome, "usdc.testnet");
    expect(result.kind).toBe("failure");
    expect(result.error).toContain("DelegateActionInvalidNonce");
  });

  it("exposes interpretOutcome as a backwards-compatible alias", () => {
    const outcome = {
      status: { SuccessValue: "" },
      receipts_outcome: [
        { outcome: { executor_id: "usdc.testnet", status: { SuccessValue: "abc" } } },
      ],
    };

    expect(interpretOutcome(outcome, "usdc.testnet")).toEqual(
      interpretSettlementOutcome(outcome, "usdc.testnet"),
    );
  });
});

describe("createClientNearSigner", () => {
  beforeEach(() => {
    vi.spyOn(providerModule, "createProviderFactory").mockReturnValue(() => mockProvider as never);
    mockProvider.viewAccessKey.mockResolvedValue({ nonce: 4, permission: "FullAccess" });
    mockProvider.block.mockResolvedValue({ header: { height: 1000 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("builds and signs a delegate action from chain state", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const clientSigner = createClientNearSigner({
      accountId: FIXTURE.senderId,
      secretKey: keyPair.toString() as KeyPairString,
    });

    const b64 = await clientSigner.createSignedDelegateAction({
      x402Version: 2,
      paymentRequirements: makeRequirements(),
    });

    const decoded = decodeSignedDelegateB64(b64);
    expect(decoded.verifySignature()).toBe(true);
    expect(decoded.delegate.senderId).toBe(FIXTURE.senderId);
    expect(decoded.delegate.receiverId).toBe(FIXTURE.asset);
    expect(decoded.delegate.nonce).toBe(5n);
    expect(decoded.delegate.maxBlockHeight).toBe(1060n);
    expect(decoded.delegate.functionCall?.methodName).toBe("ft_transfer");
  });
});

describe("createFacilitatorNearSigner", () => {
  const relayerKey = KeyPair.fromRandom("ed25519");
  const relayerId = "relayer.testnet";

  beforeEach(() => {
    vi.spyOn(providerModule, "createProviderFactory").mockReturnValue(() => mockProvider as never);
    mockProvider.block.mockResolvedValue({ header: { height: 1000, hash: TEST_BLOCK_HASH } });
    mockProvider.viewAccessKey.mockResolvedValue({ nonce: 0, permission: "FullAccess" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("lists configured relayer account ids", () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });
    expect(signer.getRelayerIds()).toEqual([relayerId]);
  });

  it("reads the current block height at final finality", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });
    await expect(signer.getCurrentBlockHeight(NEAR_TESTNET_CAIP2)).resolves.toBe(1000n);
  });

  it("returns account code hash or null when the account is missing", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });

    mockProvider.viewAccount.mockResolvedValueOnce({ code_hash: "abc123" });
    await expect(
      signer.viewAccount({ network: NEAR_TESTNET_CAIP2, accountId: "alice.testnet" }),
    ).resolves.toEqual({ codeHash: "abc123" });

    mockProvider.viewAccount.mockRejectedValueOnce(new Error("UNKNOWN_ACCOUNT: alice.testnet"));
    await expect(
      signer.viewAccount({ network: NEAR_TESTNET_CAIP2, accountId: "missing.testnet" }),
    ).resolves.toBeNull();

    mockProvider.viewAccount.mockRejectedValueOnce(new Error("rpc_transport_failure"));
    await expect(
      signer.viewAccount({ network: NEAR_TESTNET_CAIP2, accountId: "alice.testnet" }),
    ).rejects.toThrow("rpc_transport_failure");
  });

  it("returns access key nonce and permission or null when the key is missing", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });
    const publicKey = relayerKey.getPublicKey().toString();

    mockProvider.viewAccessKey.mockResolvedValueOnce({
      nonce: 12,
      permission: {
        functionCall: { allowance: "1", receiver_id: "token.testnet", method_names: [] },
      },
    });
    await expect(
      signer.viewAccessKey({
        network: NEAR_TESTNET_CAIP2,
        accountId: relayerId,
        publicKey,
      }),
    ).resolves.toEqual({ nonce: 12n, permissionKind: "FunctionCall" });

    mockProvider.viewAccessKey.mockRejectedValueOnce(new Error("UNKNOWN_ACCESS_KEY"));
    await expect(
      signer.viewAccessKey({
        network: NEAR_TESTNET_CAIP2,
        accountId: relayerId,
        publicKey,
      }),
    ).resolves.toBeNull();

    mockProvider.viewAccessKey.mockRejectedValueOnce(new Error("rpc_timeout"));
    await expect(
      signer.viewAccessKey({
        network: NEAR_TESTNET_CAIP2,
        accountId: relayerId,
        publicKey,
      }),
    ).rejects.toThrow("rpc_timeout");
  });

  it("reads ft_balance_of and rejects malformed responses", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });

    mockProvider.callFunction.mockResolvedValueOnce("5000000");
    await expect(
      signer.ftBalanceOf({
        network: NEAR_TESTNET_CAIP2,
        token: FIXTURE.asset,
        accountId: FIXTURE.senderId,
      }),
    ).resolves.toBe(5_000_000n);

    mockProvider.callFunction.mockResolvedValueOnce("not-numeric");
    await expect(
      signer.ftBalanceOf({
        network: NEAR_TESTNET_CAIP2,
        token: FIXTURE.asset,
        accountId: FIXTURE.senderId,
      }),
    ).rejects.toThrow("invalid_ft_balance_of_result");
  });

  it("reports storage registration support and method availability", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });

    mockProvider.callFunction.mockResolvedValueOnce({ total: "125" });
    await expect(
      signer.storageBalanceOf({
        network: NEAR_TESTNET_CAIP2,
        token: FIXTURE.asset,
        accountId: FIXTURE.senderId,
      }),
    ).resolves.toEqual({ supported: true, registered: true });

    mockProvider.callFunction.mockResolvedValueOnce(null);
    await expect(
      signer.storageBalanceOf({
        network: NEAR_TESTNET_CAIP2,
        token: FIXTURE.asset,
        accountId: FIXTURE.senderId,
      }),
    ).resolves.toEqual({ supported: true, registered: false });

    mockProvider.callFunction.mockRejectedValueOnce(new Error("MethodNotFound"));
    await expect(
      signer.storageBalanceOf({
        network: NEAR_TESTNET_CAIP2,
        token: FIXTURE.asset,
        accountId: FIXTURE.senderId,
      }),
    ).resolves.toEqual({ supported: false });

    mockProvider.callFunction.mockRejectedValueOnce(new Error("rpc_failure"));
    await expect(
      signer.storageBalanceOf({
        network: NEAR_TESTNET_CAIP2,
        token: FIXTURE.asset,
        accountId: FIXTURE.senderId,
      }),
    ).rejects.toThrow("rpc_failure");
  });

  it("submits a signed delegate action through the relayer", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });
    const { b64 } = await buildSignedDelegateB64();

    mockProvider.sendTransactionUntil.mockResolvedValueOnce({
      transaction_outcome: { id: "TX123" },
      status: { SuccessValue: "" },
      receipts_outcome: [{ outcome: { executor_id: FIXTURE.asset, status: { SuccessValue: "" } } }],
    });

    const outcome = await signer.submitSignedDelegateAction({
      network: FIXTURE.network,
      relayerId,
      signedDelegateAction: b64,
    });

    expect(outcome.transaction).toBe("TX123");
    expect(outcome.innerReceipt).toEqual({ kind: "success", value: "" });
    expect(mockProvider.sendTransactionUntil).toHaveBeenCalledTimes(1);
    expect(mockProvider.sendTransactionUntil.mock.calls[0][1]).toBe("FINAL");
  });

  it("rejects submission for an unknown relayer id", async () => {
    const signer = createFacilitatorNearSigner({
      relayers: [{ accountId: relayerId, secretKey: relayerKey.toString() as KeyPairString }],
    });
    const { b64 } = await buildSignedDelegateB64();

    await expect(
      signer.submitSignedDelegateAction({
        network: FIXTURE.network,
        relayerId: "unknown.testnet",
        signedDelegateAction: b64,
      }),
    ).rejects.toThrow("unknown_relayer:unknown.testnet");
  });
});
