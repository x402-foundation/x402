import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  BatchSettlementChannelManager,
  type ClaimResult,
  type SettleResult,
  type RefundResult,
} from "../../../src/batch-settlement/server/channelManager";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/server/scheme";
import {
  InMemoryChannelStorage,
  type Channel,
  type ChannelLockStorage,
} from "../../../src/batch-settlement/server/storage";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import { EVM_NETWORK_CHAIN_ID_MAP } from "../../../src/constants";
import type { ChannelConfig, AuthorizerSigner } from "../../../src/batch-settlement/types";
import * as Errors from "../../../src/batch-settlement/errors";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  SupportedResponse,
} from "@x402/core/types";

const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const NETWORK = "eip155:84532";

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

function buildChannelConfig(saltSuffix = "00"): ChannelConfig {
  const salt = `0x${"00".repeat(31)}${saltSuffix.padStart(2, "0")}` as `0x${string}`;
  return {
    payer: PAYER,
    payerAuthorizer: ZERO,
    receiver: RECEIVER,
    receiverAuthorizer: ZERO,
    token: TOKEN,
    withdrawDelay: 900,
    salt,
  };
}

function buildSession(overrides: Partial<Channel> = {}): Channel {
  const config = overrides.channelConfig ?? buildChannelConfig();
  const channelId = overrides.channelId ?? computeChannelId(config);
  return {
    channelId,
    channelConfig: config,
    chargedCumulativeAmount: "1000",
    signedMaxClaimable: "1000",
    signature: "0xdeadbeef",
    balance: "10000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
    ...overrides,
  };
}

async function storeChannel(storage: InMemoryChannelStorage, channel: Channel): Promise<void> {
  await storage.updateChannel(channel.channelId, () => channel);
}

type FakeFacilitator = FacilitatorClient & {
  verify: MockedFunction<FacilitatorClient["verify"]>;
  settle: MockedFunction<FacilitatorClient["settle"]>;
  getSupported: MockedFunction<FacilitatorClient["getSupported"]>;
};

function buildFacilitator(
  settleImpl: (
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ) => Promise<SettleResponse> = async (_, reqs) => ({
    success: true,
    transaction: "0xtx",
    network: reqs.network,
  }),
): FakeFacilitator {
  return {
    verify: vi.fn<FacilitatorClient["verify"]>(
      async () =>
        ({
          isValid: true,
        }) as VerifyResponse,
    ),
    settle: vi.fn<FacilitatorClient["settle"]>(settleImpl),
    getSupported: vi.fn<FacilitatorClient["getSupported"]>(
      async () =>
        ({
          kinds: [],
        }) as unknown as SupportedResponse,
    ),
  };
}

function buildManager(opts?: {
  authorizerSigner?: AuthorizerSigner;
  facilitator?: FakeFacilitator;
  storage?: InMemoryChannelStorage;
}): {
  manager: BatchSettlementChannelManager;
  scheme: BatchSettlementEvmScheme;
  facilitator: FakeFacilitator;
  storage: InMemoryChannelStorage;
} {
  const storage = opts?.storage ?? new InMemoryChannelStorage();
  const scheme = new BatchSettlementEvmScheme(RECEIVER, {
    storage,
    receiverAuthorizerSigner: opts?.authorizerSigner,
  });
  const facilitator = opts?.facilitator ?? buildFacilitator();
  const manager = new BatchSettlementChannelManager({
    scheme,
    facilitator,
    receiver: RECEIVER,
    token: TOKEN,
    network: NETWORK,
  });
  return { manager, scheme, facilitator, storage };
}

async function buildNetworkFixture(stamped: boolean) {
  const setup = buildManager();
  const otherNetwork = `eip155:${EVM_NETWORK_CHAIN_ID_MAP.base}` as const;
  const local = buildSession({
    channelConfig: buildChannelConfig("01"),
    lastRequestTimestamp: Date.now() - 120_000,
    ...(stamped ? { network: NETWORK } : {}),
  });
  const otherConfig = buildChannelConfig("02");
  const other = buildSession({
    channelConfig: otherConfig,
    channelId: computeChannelIdForNetwork(otherConfig, otherNetwork),
    lastRequestTimestamp: Date.now() - 120_000,
    ...(stamped ? { network: otherNetwork } : {}),
  });
  await storeChannel(setup.storage, local);
  await storeChannel(setup.storage, other);
  const otherFacilitator = buildFacilitator();
  const otherManager = setup.scheme.createChannelManager(otherFacilitator, otherNetwork, TOKEN);
  return { ...setup, otherNetwork, local, other, otherFacilitator, otherManager };
}

describe.each([true, false])("network-scoped selection (stamped: %s)", stamped => {
  it("only passes local channels to the claim selector and filters its results", async () => {
    const { manager, storage, local, other } = await buildNetworkFixture(stamped);
    const selector = vi.fn(channels => [...channels, other]);

    const results = await manager.claim({ selectClaimChannels: selector });

    expect(selector).toHaveBeenCalledWith([local], expect.anything());
    expect(results).toMatchObject([{ vouchers: 1 }]);
    expect((await storage.get(other.channelId))?.totalClaimed).toBe("0");
  });

  it.each(["refund", "refundIdleChannels"] as const)("scopes %s to its network", async method => {
    const { manager, storage, local, other, facilitator } = await buildNetworkFixture(stamped);

    const results =
      method === "refund"
        ? await manager.refund()
        : await manager.refundIdleChannels({ idleSecs: 60 });

    expect(results).toEqual([{ channel: local.channelId, transaction: "0xtx" }]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(await storage.get(local.channelId)).toBeUndefined();
    expect(await storage.get(other.channelId)).toEqual(other);
  });

  it("scopes pending withdrawals to its network", async () => {
    const { manager, storage, local, other } = await buildNetworkFixture(stamped);
    for (const channel of [local, other]) {
      await storage.updateChannel(channel.channelId, current => ({
        ...current!,
        withdrawRequestedAt: 1,
      }));
    }

    expect(await manager.getWithdrawalPendingSessions()).toEqual([
      { ...local, withdrawRequestedAt: 1 },
    ]);
  });

  it("scopes both automatic refund selector input and output", async () => {
    vi.useFakeTimers();
    const { manager, storage, local, other, facilitator } = await buildNetworkFixture(stamped);
    const selector = vi.fn(channels => [...channels, other]);
    const onRefund = vi.fn();
    const onError = vi.fn();
    try {
      manager.start({ refundIntervalSecs: 1, selectRefundChannels: selector, onRefund, onError });
      await vi.advanceTimersByTimeAsync(1000);

      expect(selector).toHaveBeenCalledWith([local], expect.anything());
      expect(onRefund).toHaveBeenCalledExactlyOnceWith({
        channel: local.channelId,
        transaction: "0xtx",
      });
      expect(onError).not.toHaveBeenCalled();
      expect(facilitator.settle).toHaveBeenCalledTimes(1);
      expect(await storage.get(other.channelId)).toEqual(other);
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });
});

it("uses the persisted network before the channel-id binding", async () => {
  const { manager, otherManager, storage, local, otherNetwork } = await buildNetworkFixture(true);
  await storage.updateChannel(local.channelId, current => ({ ...current!, network: otherNetwork }));

  expect(await manager.getClaimableVouchers()).toEqual([]);
  expect(await otherManager.getClaimableVouchers()).toHaveLength(2);
});

it("falls back to channel-id binding when a persisted network is empty", async () => {
  const { manager, storage, local, other } = await buildNetworkFixture(false);
  for (const channel of [local, other]) {
    await storage.updateChannel(channel.channelId, current => ({
      ...current!,
      network: "" as Network,
    }));
  }

  expect(await manager.getClaimableVouchers()).toHaveLength(1);
  expect(await manager.refund()).toEqual([{ channel: local.channelId, transaction: "0xtx" }]);
  expect(await storage.get(other.channelId)).toBeDefined();
});

describe("independent claim batches", () => {
  let setup: ReturnType<typeof buildManager>;
  let channels: Channel[];
  const failure = new Error("claim rejected");
  const success: SettleResponse = { success: true, transaction: "0xtx", network: NETWORK };

  beforeEach(async () => {
    setup = buildManager();
    channels = ["01", "02"].map(salt =>
      buildSession({ channelConfig: buildChannelConfig(salt), network: NETWORK }),
    );
    for (const channel of channels) await storeChannel(setup.storage, channel);
  });

  it.each([0, 1])(
    "continues after batch %s fails and keeps successful claims pending",
    async failed => {
      const { manager, facilitator, storage } = setup;
      vi.useFakeTimers();
      if (failed === 1) facilitator.settle.mockResolvedValueOnce(success);
      facilitator.settle.mockRejectedValueOnce(failure);
      const shouldSettle = vi.fn(() => true);
      try {
        await expect(manager.claim({ maxClaimsPerBatch: 1 })).rejects.toMatchObject({
          name: "BatchClaimError",
          errors: [failure],
          results: [{ vouchers: 1, transaction: "0xtx" }],
        });
        expect(facilitator.settle).toHaveBeenCalledTimes(2);
        expect((await storage.get(channels[failed].channelId))?.totalClaimed).toBe("0");
        expect((await storage.get(channels[1 - failed].channelId))?.totalClaimed).toBe("1000");

        manager.start({ settleIntervalSecs: 1, shouldSettle });
        await vi.advanceTimersByTimeAsync(1000);
        expect(shouldSettle).toHaveBeenCalledWith(expect.objectContaining({ pendingSettle: true }));
        expect(facilitator.settle.mock.calls[2][0].payload.type).toBe("settle");

        expect(await manager.claim()).toMatchObject([{ vouchers: 1 }]);
        expect((await storage.get(channels[failed].channelId))?.totalClaimed).toBe("1000");
      } finally {
        await manager.stop();
        vi.useRealTimers();
      }
    },
  );

  it("preserves all batch errors without marking failed claims as settled", async () => {
    const { manager, facilitator, storage } = setup;
    const second = new Error("second rejected");
    facilitator.settle.mockRejectedValueOnce(failure).mockRejectedValueOnce(second);

    await expect(manager.claim({ maxClaimsPerBatch: 1 })).rejects.toMatchObject({
      errors: [failure, second],
      results: [],
    });
    for (const channel of channels) {
      expect((await storage.get(channel.channelId))?.totalClaimed).toBe("0");
    }
    const selector = vi.fn(() => []);
    await manager.claim({ selectClaimChannels: selector });
    expect(selector).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pendingSettle: false, lastClaimTime: 0 }),
    );
  });

  it("settles successful batches while exposing the partial claim failure", async () => {
    const { manager, facilitator } = setup;
    facilitator.settle.mockRejectedValueOnce(failure);

    await expect(manager.claimAndSettle({ maxClaimsPerBatch: 1 })).rejects.toMatchObject({
      errors: [failure],
      results: [{ vouchers: 1, transaction: "0xtx" }],
      settle: { transaction: "0xtx" },
    });
    expect(facilitator.settle.mock.calls.map(([payload]) => payload.payload.type)).toEqual([
      "claim",
      "claim",
      "settle",
    ]);
  });

  it("reports both claim and settlement failures", async () => {
    const { manager, facilitator } = setup;
    const settleFailure = new Error("settle rejected");
    facilitator.settle
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(success)
      .mockRejectedValueOnce(settleFailure);

    await expect(manager.claimAndSettle({ maxClaimsPerBatch: 1 })).rejects.toMatchObject({
      errors: [failure, settleFailure],
      results: [{ vouchers: 1, transaction: "0xtx" }],
    });
  });

  it("reports automatic claim successes as well as batch failures", async () => {
    const { manager, facilitator } = setup;
    vi.useFakeTimers();
    const onClaim = vi.fn();
    const onError = vi.fn();
    facilitator.settle.mockRejectedValueOnce(failure);
    try {
      manager.start({ claimIntervalSecs: 1, maxClaimsPerBatch: 1, onClaim, onError });
      await vi.advanceTimersByTimeAsync(1000);

      expect(onClaim).toHaveBeenCalledExactlyOnceWith({ vouchers: 1, transaction: "0xtx" });
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ errors: [failure] }),
      );
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });
});

describe("BatchSettlementChannelManager — claim()", () => {
  it("returns no results when there are no claimable vouchers", async () => {
    const { manager, facilitator } = buildManager();
    const results = await manager.claim();
    expect(results).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("submits a single claim batch when claimable vouchers exist", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000", totalClaimed: "0" });
    await storeChannel(storage, session);

    const results = await manager.claim();
    expect(results).toHaveLength(1);
    expect(results[0].vouchers).toBe(1);
    expect(results[0].transaction).toBe("0xtx");

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const [paymentPayload] = facilitator.settle.mock.calls[0];
    const payload = paymentPayload.payload as Record<string, unknown>;
    expect(payload.type).toBe("claim");
    expect(payload.claims).toHaveLength(1);
  });

  it.each([true, false])("scopes claims to the manager's network (stamped: %s)", async stamped => {
    const { manager, storage, facilitator, local, other, otherManager, otherFacilitator } =
      await buildNetworkFixture(stamped);

    for (const [claimManager, channel] of [
      [manager, local],
      [otherManager, other],
    ] as const) {
      expect(await claimManager.getClaimableVouchers()).toEqual([
        {
          voucher: {
            channel: channel.channelConfig,
            maxClaimableAmount: channel.signedMaxClaimable,
          },
          signature: channel.signature,
          totalClaimed: channel.chargedCumulativeAmount,
        },
      ]);
    }

    const results = await manager.claim();

    expect(results).toHaveLength(1);
    expect(results[0].vouchers).toBe(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect((await storage.get(local.channelId))?.totalClaimed).toBe(local.chargedCumulativeAmount);
    expect((await storage.get(other.channelId))?.totalClaimed).toBe("0");

    await otherManager.claim();

    expect(otherFacilitator.settle).toHaveBeenCalledTimes(1);
    expect((await storage.get(other.channelId))?.totalClaimed).toBe(other.chargedCumulativeAmount);
  });

  it("splits claims across multiple batches respecting maxClaimsPerBatch", async () => {
    const { manager, storage, facilitator } = buildManager();
    for (let i = 0; i < 5; i++) {
      const config = buildChannelConfig(i.toString(16));
      await storeChannel(
        storage,
        buildSession({
          channelConfig: config,
          channelId: computeChannelId(config),
          chargedCumulativeAmount: String(1000 * (i + 1)),
          totalClaimed: "0",
        }),
      );
    }

    const results = await manager.claim({ maxClaimsPerBatch: 2 });
    expect(results).toHaveLength(3);
    expect(results.map(r => r.vouchers)).toEqual([2, 2, 1]);
    expect(facilitator.settle).toHaveBeenCalledTimes(3);
  });

  it("defaults to 100 vouchers per claim batch", { timeout: 15_000 }, async () => {
    const { manager, storage, facilitator } = buildManager();
    for (let i = 0; i < 101; i++) {
      const config = buildChannelConfig(i.toString(16));
      await storeChannel(
        storage,
        buildSession({
          channelConfig: config,
          channelId: computeChannelId(config),
          chargedCumulativeAmount: String(1000 * (i + 1)),
          totalClaimed: "0",
        }),
      );
    }

    const results = await manager.claim();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.vouchers)).toEqual([100, 1]);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it("skips sessions that are not idle long enough when idleSecs is set", async () => {
    const { manager, storage, facilitator } = buildManager();
    const fresh = buildSession({
      chargedCumulativeAmount: "5000",
      lastRequestTimestamp: Date.now(),
    });
    await storeChannel(storage, fresh);

    const results = await manager.claim({ idleSecs: 60 });
    expect(results).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("claims only channels selected by the claim selector", async () => {
    const { manager, storage, facilitator } = buildManager();
    const selectedConfig = buildChannelConfig("01");
    const skippedConfig = buildChannelConfig("02");
    const selected = buildSession({
      channelConfig: selectedConfig,
      channelId: computeChannelId(selectedConfig),
      chargedCumulativeAmount: "5000",
    });
    const skipped = buildSession({
      channelConfig: skippedConfig,
      channelId: computeChannelId(skippedConfig),
      chargedCumulativeAmount: "7000",
    });
    await storeChannel(storage, selected);
    await storeChannel(storage, skipped);

    const results = await manager.claim({
      selectClaimChannels: channels =>
        channels.filter(channel => channel.channelId === selected.channelId),
    });

    expect(results).toHaveLength(1);
    expect(results[0].vouchers).toBe(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect((await storage.get(selected.channelId))?.totalClaimed).toBe("5000");
    expect((await storage.get(skipped.channelId))?.totalClaimed).toBe("0");
  });

  it("updates session.totalClaimed after a successful claim", async () => {
    const { manager, storage } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000", totalClaimed: "0" });
    await storeChannel(storage, session);

    await manager.claim();

    const updated = await storage.get(session.channelId);
    expect(updated?.totalClaimed).toBe("5000");
  });

  it("includes a claim authorizer signature when an authorizer signer is configured", async () => {
    const authorizer = buildAuthorizerSigner();
    const config = buildChannelConfig();
    const channelId = computeChannelId({ ...config, receiverAuthorizer: authorizer.address });
    const { manager, storage, facilitator } = buildManager({ authorizerSigner: authorizer });
    await storeChannel(
      storage,
      buildSession({
        channelId,
        channelConfig: { ...config, receiverAuthorizer: authorizer.address },
        chargedCumulativeAmount: "5000",
      }),
    );

    await manager.claim();

    const [paymentPayload] = facilitator.settle.mock.calls[0];
    const payload = paymentPayload.payload as Record<string, unknown>;
    expect(payload.claimAuthorizerSignature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("propagates a facilitator failure as a thrown error and leaves session intact", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "boom",
      errorMessage: "Claim reverted",
      transaction: "",
      network: NETWORK,
    }));
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    await expect(manager.claim()).rejects.toThrow(/Claim failed/);

    const stored = await storage.get(session.channelId);
    expect(stored?.totalClaimed).toBe("0");
  });
});

describe("BatchSettlementChannelManager — settle()", () => {
  it('calls the facilitator with a type="settle" payload', async () => {
    const { manager, facilitator } = buildManager();
    const result = await manager.settle();

    expect(result.transaction).toBe("0xtx");
    const [paymentPayload, reqs] = facilitator.settle.mock.calls[0];
    expect((paymentPayload.payload as Record<string, unknown>).type).toBe("settle");
    expect((paymentPayload.payload as Record<string, unknown>).receiver).toBe(RECEIVER);
    expect((paymentPayload.payload as Record<string, unknown>).token).toBe(TOKEN);
    expect(reqs.network).toBe(NETWORK);
  });

  it("throws when the facilitator reports a failure", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "boom",
      errorMessage: "settle reverted",
      transaction: "",
      network: NETWORK,
    }));
    const { manager } = buildManager({ facilitator });
    await expect(manager.settle()).rejects.toThrow(/Settle failed/);
  });

  it("treats ErrNothingToSettle as a no-op instead of throwing", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: Errors.ErrNothingToSettle,
      errorMessage: "nothing to settle for receiver and token",
      transaction: "",
      network: NETWORK,
    }));
    const { manager } = buildManager({ facilitator });
    await expect(manager.settle()).resolves.toEqual({ transaction: "" });
  });
});

describe("BatchSettlementChannelManager — claimAndSettle()", () => {
  it("returns only the empty claims when no claimable vouchers exist", async () => {
    const { manager, facilitator } = buildManager();
    const result = await manager.claimAndSettle();
    expect(result.claims).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("runs both claim and settle when there are claimable vouchers", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const result = await manager.claimAndSettle();
    expect(result.claims).toHaveLength(1);
    expect(result.settle?.transaction).toBe("0xtx");
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it("does not settle when the claim selector returns no claim work", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const result = await manager.claimAndSettle({
      selectClaimChannels: () => [],
    });

    expect(result.claims).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect((await storage.get(session.channelId))?.totalClaimed).toBe("0");
  });
});

describe("BatchSettlementChannelManager — refund()", () => {
  it("still refunds when the lock store throws", async () => {
    const storage = new InMemoryChannelStorage();
    const lockStorage: ChannelLockStorage = {
      acquire: async () => true,
      release: async () => undefined,
      isHeld: async () => {
        throw new Error("lock down");
      },
    };
    const scheme = new BatchSettlementEvmScheme(RECEIVER, { storage, lockStorage });
    const facilitator = buildFacilitator();
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    const result = await manager.refund();
    expect(result).toEqual([{ channel: session.channelId, transaction: "0xtx" }]);
  });

  it("rejects refund when isHeld throws a TypeError", async () => {
    const storage = new InMemoryChannelStorage();
    const lockStorage: ChannelLockStorage = {
      acquire: async () => true,
      release: async () => undefined,
      isHeld: async () => {
        throw new TypeError("corrupt hold");
      },
    };
    const scheme = new BatchSettlementEvmScheme(RECEIVER, { storage, lockStorage });
    const facilitator = buildFacilitator();
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    await expect(manager.refund()).rejects.toThrow(TypeError);
  });

  it("returns no channels when storage is empty", async () => {
    const { manager, facilitator } = buildManager();
    const result = await manager.refund();
    expect(result).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("refunds remaining escrow", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    const result = await manager.refund();

    expect(result).toEqual([{ channel: session.channelId, transaction: "0xtx" }]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const [paymentPayload] = facilitator.settle.mock.calls[0];
    const payload = paymentPayload.payload as Record<string, unknown>;
    expect(payload.type).toBe("refund");
    expect(payload.amount).toBe("9000");
    expect(payload.chargedCumulativeAmount).toBeUndefined();
  });

  it("includes outstanding voucher claims and deletes session on success", async () => {
    const { manager, storage } = buildManager();
    const session = buildSession({
      chargedCumulativeAmount: "3000",
      totalClaimed: "1000",
      balance: "10000",
    });
    await storeChannel(storage, session);

    await manager.refund();

    const stored = await storage.get(session.channelId);
    expect(stored).toBeUndefined();
  });

  it("refunds multiple channels with one facilitator transaction per channel", async () => {
    const { manager, storage, facilitator } = buildManager();
    for (let i = 0; i < 2; i++) {
      const config = buildChannelConfig(i.toString(16));
      await storeChannel(
        storage,
        buildSession({
          channelConfig: config,
          channelId: computeChannelId(config),
          chargedCumulativeAmount: "1000",
          balance: "10000",
        }),
      );
    }

    const result = await manager.refund();

    expect(result).toHaveLength(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
    for (const { channel } of result) {
      expect(await storage.get(channel)).toBeUndefined();
    }
  });

  it("refundIdleChannels skips channels whose escrow balance is already zero", async () => {
    const { manager, storage } = buildManager();
    await storeChannel(
      storage,
      buildSession({
        balance: "0",
        chargedCumulativeAmount: "0",
        totalClaimed: "0",
        lastRequestTimestamp: Date.now() - 120_000,
      }),
    );

    const results = await manager.refundIdleChannels({ idleSecs: 60 });
    expect(results).toEqual([]);
  });

  it("refundIdleChannels only refunds channels idle long enough", async () => {
    const { manager, storage } = buildManager();
    const idleConfig = buildChannelConfig("01");
    const freshConfig = buildChannelConfig("02");
    const idle = buildSession({
      channelConfig: idleConfig,
      channelId: computeChannelId(idleConfig),
      lastRequestTimestamp: Date.now() - 120_000,
    });
    const fresh = buildSession({
      channelConfig: freshConfig,
      channelId: computeChannelId(freshConfig),
      lastRequestTimestamp: Date.now(),
    });
    await storeChannel(storage, idle);
    await storeChannel(storage, fresh);

    const result = await manager.refundIdleChannels({ idleSecs: 60 });

    expect(result).toEqual([{ channel: idle.channelId, transaction: "0xtx" }]);
    expect(await storage.get(idle.channelId)).toBeUndefined();
    expect(await storage.get(fresh.channelId)).toBeDefined();
  });

  it("throws when facilitator reports failure", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "boom",
      errorMessage: "refund reverted",
      transaction: "",
      network: NETWORK,
    }));
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    await expect(manager.refund()).rejects.toThrow(/Refund failed/);

    const stored = await storage.get(session.channelId);
    expect(stored).toBeDefined();
  });
});

describe("BatchSettlementChannelManager — start()/stop() loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules configured auto job timers and clears them on stop", async () => {
    const { manager } = buildManager();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 2, refundIntervalSecs: 3 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(3);

    await manager.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
  });

  it("is a no-op to call start twice (single timer)", () => {
    const { manager } = buildManager();
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    manager.start({ claimIntervalSecs: 1 });
    manager.start({ settleIntervalSecs: 1 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("flushes pending claims and settles on stop({ flush: true })", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    manager.start();
    await manager.stop({ flush: true });

    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it("flushes pending claims and settles without refunding on stop({ flush: true })", async () => {
    const { manager, storage } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    const onRefund = vi.fn<(r: RefundResult) => void>();
    manager.start({ onRefund });
    await manager.stop({ flush: true });

    expect(onRefund).not.toHaveBeenCalled();
    expect(await storage.get(session.channelId)).toBeDefined();
  });

  it("uses the configured claim selector during stop({ flush: true })", async () => {
    const { manager, storage, facilitator } = buildManager();
    const selectedConfig = buildChannelConfig("01");
    const skippedConfig = buildChannelConfig("02");
    const selected = buildSession({
      channelConfig: selectedConfig,
      channelId: computeChannelId(selectedConfig),
      chargedCumulativeAmount: "5000",
    });
    const skipped = buildSession({
      channelConfig: skippedConfig,
      channelId: computeChannelId(skippedConfig),
      chargedCumulativeAmount: "7000",
    });
    await storeChannel(storage, selected);
    await storeChannel(storage, skipped);

    manager.start({
      selectClaimChannels: channels =>
        channels.filter(channel => channel.channelId === selected.channelId),
    });
    await manager.stop({ flush: true });

    expect(facilitator.settle).toHaveBeenCalledTimes(2);
    expect((await storage.get(selected.channelId))?.totalClaimed).toBe("5000");
    expect((await storage.get(skipped.channelId))?.totalClaimed).toBe("0");
  });

  it("forwards flush errors from claimAndSettle", async () => {
    const facilitator = buildFacilitator(async payload => {
      const action = (payload.payload as Record<string, unknown>).type;
      if (action === "claim") {
        return {
          success: false,
          errorReason: "boom",
          errorMessage: "claim reverted",
          transaction: "",
          network: NETWORK,
        };
      }
      return { success: true, transaction: "0xtx", network: NETWORK };
    });
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    manager.start();

    await expect(manager.stop({ flush: true })).rejects.toThrow(/Claim failed/);
  });
});

describe("BatchSettlementChannelManager — auto-loop tick policies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs aligned claim and settle timers in priority order", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const onClaim = vi.fn<(r: ClaimResult) => void>();
    const onSettle = vi.fn<(r: SettleResult) => void>();
    manager.start({
      claimIntervalSecs: 1,
      settleIntervalSecs: 1,
      onClaim,
      onSettle,
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(onClaim).toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalled();
    const settleTypes = facilitator.settle.mock.calls.map(
      ([p]) => (p.payload as Record<string, unknown>).type,
    );
    expect(settleTypes).toEqual(["claim", "settle"]);
  });

  it("coalesces repeated same-type timer events while a job is running", async () => {
    vi.useRealTimers();
    const flushMicrotasks = async () => {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
    };
    let onClaimInterval: () => void = () => {};
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((handler: TimerHandler) => {
        onClaimInterval = typeof handler === "function" ? (handler as () => void) : () => {};
        return 999 as unknown as ReturnType<typeof setInterval>;
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const { manager } = buildManager();
    let releaseFirstSelection: (() => void) | undefined;
    const firstSelection = new Promise<void>(resolve => {
      releaseFirstSelection = resolve;
    });
    const selectClaimChannels = vi.fn(async (channels: Channel[]) => {
      if (selectClaimChannels.mock.calls.length === 1) {
        await firstSelection;
      }
      return channels;
    });

    try {
      manager.start({
        claimIntervalSecs: 1,
        selectClaimChannels,
      });

      onClaimInterval();
      await flushMicrotasks();
      expect(selectClaimChannels).toHaveBeenCalledTimes(1);

      onClaimInterval();
      onClaimInterval();

      releaseFirstSelection?.();
      await flushMicrotasks();

      await manager.stop();
      expect(selectClaimChannels).toHaveBeenCalledTimes(2);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    }
  });

  it("settles pending claims without reading the full channel list", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);
    await manager.claim();
    facilitator.settle.mockClear();

    const listSpy = vi.spyOn(storage, "list");
    const onSettle = vi.fn<(r: SettleResult) => void>();
    manager.start({
      settleIntervalSecs: 1,
      onSettle,
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(onSettle).toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    const settleTypes = facilitator.settle.mock.calls.map(
      ([p]) => (p.payload as Record<string, unknown>).type,
    );
    expect(settleTypes).toEqual(["settle"]);
  });

  it("claims only channels selected by the auto claim selector", async () => {
    const { manager, storage } = buildManager();
    const selectedConfig = buildChannelConfig("01");
    const skippedConfig = buildChannelConfig("02");
    const selected = buildSession({
      channelConfig: selectedConfig,
      channelId: computeChannelId(selectedConfig),
      chargedCumulativeAmount: "5000",
    });
    const skipped = buildSession({
      channelConfig: skippedConfig,
      channelId: computeChannelId(skippedConfig),
      chargedCumulativeAmount: "7000",
    });
    await storeChannel(storage, selected);
    await storeChannel(storage, skipped);

    manager.start({
      claimIntervalSecs: 1,
      selectClaimChannels: channels =>
        channels.filter(channel => channel.channelId === selected.channelId),
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect((await storage.get(selected.channelId))?.totalClaimed).toBe("5000");
    expect((await storage.get(skipped.channelId))?.totalClaimed).toBe("0");
  });

  it("does not refund or read channels without a refund selector", async () => {
    const { manager, storage, facilitator } = buildManager();
    const listSpy = vi.spyOn(storage, "list");
    const onRefund = vi.fn<(r: RefundResult) => void>();

    manager.start({ refundIntervalSecs: 1, onRefund });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(listSpy).not.toHaveBeenCalled();
    expect(onRefund).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("refunds only channels selected by the refund selector", async () => {
    const { manager, storage } = buildManager();
    const selectedConfig = buildChannelConfig("01");
    const skippedConfig = buildChannelConfig("02");
    const selected = buildSession({
      channelConfig: selectedConfig,
      channelId: computeChannelId(selectedConfig),
      balance: "10000",
    });
    const skipped = buildSession({
      channelConfig: skippedConfig,
      channelId: computeChannelId(skippedConfig),
      balance: "10000",
    });
    await storeChannel(storage, selected);
    await storeChannel(storage, skipped);

    const onRefund = vi.fn<(r: RefundResult) => void>();
    manager.start({
      refundIntervalSecs: 1,
      selectRefundChannels: channels =>
        channels.filter(channel => channel.channelId === selected.channelId),
      onRefund,
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(onRefund).toHaveBeenCalledWith({ channel: selected.channelId, transaction: "0xtx" });
    expect(await storage.get(selected.channelId)).toBeUndefined();
    expect(await storage.get(skipped.channelId)).toBeDefined();
  });

  it("invokes onError when an auto job throws", async () => {
    const facilitator = buildFacilitator(async () => {
      throw new Error("network down");
    });
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const onError = vi.fn<(e: unknown) => void>();
    manager.start({ claimIntervalSecs: 1, onError });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(onError).toHaveBeenCalled();
  });
});

describe("BatchSettlementChannelManager — facilitator-managed mode", () => {
  function buildManagedManager(opts?: { facilitator?: FakeFacilitator }): {
    manager: BatchSettlementChannelManager;
    facilitator: FakeFacilitator;
    storage: InMemoryChannelStorage;
  } {
    const storage = new InMemoryChannelStorage();
    const scheme = new BatchSettlementEvmScheme(RECEIVER, {
      voucherStoreMode: "facilitator",
      storage,
    });
    const facilitator = opts?.facilitator ?? buildFacilitator();
    const manager = new BatchSettlementChannelManager({
      scheme,
      facilitator,
      receiver: RECEIVER,
      token: TOKEN,
      network: NETWORK,
    });
    return { manager, facilitator, storage };
  }

  it("allows claim from the replica", async () => {
    const { manager, storage, facilitator } = buildManagedManager();
    const session = buildSession({ chargedCumulativeAmount: "5000", totalClaimed: "0" });
    await storeChannel(storage, session);

    const results = await manager.claim();
    expect(results).toHaveLength(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const [paymentPayload] = facilitator.settle.mock.calls[0];
    expect((paymentPayload.payload as Record<string, unknown>).type).toBe("claim");
  });

  it("throws on refund()", async () => {
    const { manager } = buildManagedManager();
    await expect(manager.refund()).rejects.toThrow(
      "cooperative refunds are client-initiated in facilitator-managed mode",
    );
  });

  it("throws on refundIdleChannels()", async () => {
    const { manager } = buildManagedManager();
    await expect(manager.refundIdleChannels({ idleSecs: 60 })).rejects.toThrow(
      "cooperative refunds are client-initiated in facilitator-managed mode",
    );
  });

  it("does not start a refund interval timer", async () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const { manager } = buildManagedManager();

      manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 2, refundIntervalSecs: 3 });
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      await manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
