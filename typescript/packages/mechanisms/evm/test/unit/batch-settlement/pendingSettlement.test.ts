import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/facilitator/scheme";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import * as Errors from "../../../src/batch-settlement/errors";
import { ErrSettlementPending } from "../../../src/exact/facilitator/errors";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import type {
  ChannelConfig,
  AuthorizerSigner,
  BatchSettlementDepositPayload,
} from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
const NETWORK = "eip155:84532";
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const MOCK_TX_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function buildAuthorizerSigner(): AuthorizerSigner {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: ZERO_ADDR,
    receiver: RECEIVER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    token: ASSET,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      receiverAuthorizer: RECEIVER_AUTHORIZER,
      assetTransferMethod: "eip3009",
      withdrawDelay: 900,
    },
    ...overrides,
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    readContract: vi.fn().mockImplementation(args => {
      if (args.functionName === "isValidSignature") return Promise.resolve("0x1626ba7e");
      if (args.functionName === "receivers") return Promise.resolve([2500n, 0n]);
      return Promise.resolve(undefined);
    }),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn().mockResolvedValue("0x6080604052"),
    ...overrides,
  };
}

function envelopeDeposit(payload: BatchSettlementDepositPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

/**
 * Builds an ERC-3009 deposit payload keyed by `signature` for pending-settlement
 * store tests.
 *
 * @param channelId - The channel id from the accompanying voucher/channelConfig
 * @param signature - The ERC-3009 authorization signature, used as the store key
 * @returns A deposit payload envelope
 */
function buildDepositPayload(
  channelId: `0x${string}`,
  config: ChannelConfig,
  signature: string,
): BatchSettlementDepositPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    type: "deposit",
    channelConfig: config,
    voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
    deposit: {
      amount: "10000",
      authorization: {
        erc3009Authorization: {
          validAfter: String(now - 600),
          validBefore: String(now + 3600),
          salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
          signature,
        },
      },
    },
  };
}

// verifyDeposit's shared-state multicall: channels, balanceOf, pendingWithdrawals, refundNonce.
const VERIFY_MULTICALL_RESULT = [
  { status: "success", result: [0n, 0n] },
  { status: "success", result: 1_000_000n },
  { status: "success", result: [0n, 0n] },
  { status: "success", result: 0n },
];

// readChannelState's post-broadcast/post-reconcile multicall: channels, pendingWithdrawals, refundNonce.
const READ_CHANNEL_STATE_RESULT = [
  { status: "success", result: [10_000n, 0n] },
  { status: "success", result: [0n, 0n] },
  { status: "success", result: 0n },
];

describe("BatchSettlementEvmScheme deposit pending-settlement store integration", () => {
  const authorizer = buildAuthorizerSigner();
  let store: PendingSettlementStore;

  beforeEach(() => {
    mockedMulticall.mockReset();
    store = new InMemoryPendingSettlementStore();
  });

  it("cache-miss + broadcast success: leaves no pending entry", async () => {
    mockedMulticall
      .mockResolvedValueOnce(VERIFY_MULTICALL_RESULT)
      .mockResolvedValue(READ_CHANNEL_STATE_RESULT);
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      pendingSettlementStore: store,
    });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface1");

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(true);
    expect(signer.writeContract).toHaveBeenCalledTimes(1);
    expect(await store.get("0xfeedface1")).toBeUndefined();
  });

  it("cache-miss + failed receipt wait: returns settlement_pending and populates the store keyed by the authorization signature", async () => {
    mockedMulticall.mockResolvedValue(VERIFY_MULTICALL_RESULT);
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc: timeout")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      pendingSettlementStore: store,
    });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface2");

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    expect(await store.get("0xfeedface2")).toBe(MOCK_TX_HASH);
  });

  it("cache-hit: skips verify/broadcast entirely and reconciles against the cached tx", async () => {
    // Only the post-reconcile readChannelState multicall runs on the cache-hit path.
    mockedMulticall.mockResolvedValue(READ_CHANNEL_STATE_RESULT);
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      pendingSettlementStore: store,
    });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface3");
    await store.set("0xfeedface3", MOCK_TX_HASH);

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(signer.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: MOCK_TX_HASH }),
    );
    expect(await store.get("0xfeedface3")).toBeUndefined();
  });

  it("cache-hit: falls back to an optimistic channelState snapshot when the post-confirm read fails", async () => {
    // First multicall (pre-confirm optimistic read) succeeds; the second (post-confirm
    // read inside onSuccess) fails, so the response must fall back to the optimistic
    // snapshot rather than omitting extra.channelState.
    mockedMulticall
      .mockResolvedValueOnce(READ_CHANNEL_STATE_RESULT)
      .mockRejectedValueOnce(new Error("rpc read failed"));
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      pendingSettlementStore: store,
    });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface7");
    await store.set("0xfeedface7", MOCK_TX_HASH);

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    // READ_CHANNEL_STATE_RESULT reports balance 10_000n; optimistic = balance + deposit.amount (10_000).
    expect(result.extra).toEqual({
      channelState: {
        channelId,
        balance: "20000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
      },
    });
  });

  it("cache-hit: still-unconfirmed receipt wait returns settlement_pending again and preserves the store entry", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("still pending")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      pendingSettlementStore: store,
    });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface4");
    await store.set("0xfeedface4", MOCK_TX_HASH);

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(await store.get("0xfeedface4")).toBe(MOCK_TX_HASH);
  });

  it("terminal verify failure (insufficient balance) never touches the store", async () => {
    // verifySharedDepositState's balanceOf call reports less than the deposit amount.
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
      pendingSettlementStore: store,
    });
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface5");

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInsufficientBalance);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(await store.get("0xfeedface5")).toBeUndefined();
  });

  it("defaults to a fresh in-memory store when none is provided", async () => {
    mockedMulticall
      .mockResolvedValueOnce(VERIFY_MULTICALL_RESULT)
      .mockResolvedValue(READ_CHANNEL_STATE_RESULT);
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp = buildDepositPayload(channelId, config, "0xfeedface6");

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());

    expect(result.success).toBe(true);
  });
});
