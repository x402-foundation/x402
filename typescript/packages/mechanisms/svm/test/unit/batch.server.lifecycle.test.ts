import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDepositPayload, buildRefundPayload } from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchSvmScheme } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore, type ChannelState } from "../../src/batch-settlement/server/storage";
import {
  isBatchFacilitatorPayload,
  isBatchPayload,
  type BatchChannelConfig,
  type BatchPayload,
} from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let channelConfig: BatchChannelConfig;
let depositPayload: Extract<BatchPayload, { type: "deposit" }>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  const built = await buildDepositPayload({
    blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
    depositAmount: 10_000n,
    feePayer: feePayer.address,
    firstCharge: 1_000n,
    mint: MINT,
    openSlot: 123n,
    payer,
    receiver: RECEIVER,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  });
  channelId = built.channelId;
  channelConfig = built.payload.channelConfig;
  depositPayload = built.payload;
});

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    extra: {
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: RECEIVER,
    scheme: "batch-settlement",
    ...overrides,
  };
}

function state(overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    channelConfig,
    channelId,
    chargedCumulativeAmount: 0n,
    deposit: 10_000n,
    feePayer: feePayer.address,
    mint: MINT,
    onchainSyncedAt: Date.now(),
    openSlot: 123n,
    payer: payer.address,
    payerAuthorizer: payer.address,
    payoutWatermark: 0n,
    receiver: RECEIVER,
    salt: 0n,
    settled: 0n,
    signedMaxClaimable: 0n,
    status: "open",
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
    ...overrides,
  };
}

type ServerInternals = {
  validatePayload(raw: BatchPayload, requirements: PaymentRequirements): Promise<string>;
  applySnapshot(
    channelId: string,
    snapshot: {
      channelId?: string;
      balance?: bigint;
      totalClaimed: bigint;
      withdrawRequestedAt: number;
    },
  ): boolean;
  persistSnapshot(
    channelId: string,
    raw: BatchPayload,
    requirements: PaymentRequirements,
    snapshot: {
      channelId?: string;
      balance?: bigint;
      totalClaimed: bigint;
      withdrawRequestedAt: number;
    },
  ): Promise<void>;
  recoveredState(
    raw: BatchPayload,
    requirements: PaymentRequirements,
    channelId: string,
    snapshot: { balance?: bigint; totalClaimed: bigint; withdrawRequestedAt: number },
  ): ChannelState;
  provisionalState(
    raw: BatchPayload,
    requirements: PaymentRequirements,
    channelId: string,
  ): ChannelState;
  assertStoredConfig(value: ChannelState, config: BatchChannelConfig): void;
};

function internals(server: BatchSvmScheme): ServerInternals {
  return server as unknown as ServerInternals;
}

describe("batch server lifecycle boundaries", () => {
  it("rejects unknown payload discriminators and malformed claim entries", () => {
    expect(isBatchPayload({ channelConfig, type: "unknown" })).toBe(false);
    expect(isBatchFacilitatorPayload({ claims: [null], type: "claim" })).toBe(false);
    expect(
      isBatchFacilitatorPayload({ claims: [{ signature: 1, voucher: {} }], type: "claim" }),
    ).toBe(false);
  });

  it("validates every immutable payload binding", async () => {
    const api = internals(new BatchSvmScheme());
    await expect(api.validatePayload(depositPayload, requirements())).resolves.toBe(channelId);
    const invalid: Array<[BatchPayload, PaymentRequirements, string]> = [
      [depositPayload, requirements({ extra: undefined }), BatchError.PAYMENT_FLOW],
      [
        depositPayload,
        requirements({ extra: { ...requirements().extra, paymentFlow: "upfront" } }),
        BatchError.PAYMENT_FLOW,
      ],
      [
        depositPayload,
        requirements({ extra: { ...requirements().extra, feePayer: undefined } }),
        BatchError.FEE_PAYER_MISMATCH,
      ],
      [
        { ...depositPayload, channelConfig: { ...channelConfig, payer: feePayer.address } },
        requirements(),
        BatchError.FEE_PAYER_MISMATCH,
      ],
      [
        {
          ...depositPayload,
          channelConfig: { ...channelConfig, payerAuthorizer: feePayer.address },
        },
        requirements(),
        BatchError.FEE_PAYER_MISMATCH,
      ],
      [
        { ...depositPayload, channelConfig: { ...channelConfig, receiver: payer.address } },
        requirements(),
        BatchError.CHANNEL_STATE,
      ],
      [
        { ...depositPayload, channelConfig: { ...channelConfig, token: RECEIVER } },
        requirements(),
        BatchError.CHANNEL_STATE,
      ],
      [
        { ...depositPayload, channelConfig: { ...channelConfig, withdrawDelay: 901 } },
        requirements(),
        BatchError.WITHDRAW_DELAY_MISMATCH,
      ],
      [
        {
          ...depositPayload,
          channelConfig: { ...channelConfig, receiverAuthorizer: payer.address },
        },
        requirements(),
        BatchError.RECEIVER_AUTHORIZER_MISMATCH,
      ],
      [
        depositPayload,
        requirements({ extra: { ...requirements().extra, receiverAuthorizer: payer.address } }),
        BatchError.RECEIVER_AUTHORIZER_MISMATCH,
      ],
      [
        depositPayload,
        requirements({ extra: { ...requirements().extra, tokenProgram: payer.address } }),
        BatchError.TOKEN_PROGRAM,
      ],
      [
        { ...depositPayload, voucher: { ...depositPayload.voucher, channelId: payer.address } },
        requirements(),
        BatchError.CHANNEL_ID_MISMATCH,
      ],
      [
        { ...depositPayload, voucher: { ...depositPayload.voucher, expiresAt: 1 } },
        requirements(),
        BatchError.VOUCHER_EXPIRY,
      ],
      [
        {
          ...depositPayload,
          voucher: { ...depositPayload.voucher, maxClaimableAmount: "1001" },
        },
        requirements(),
        BatchError.VOUCHER_SIGNATURE,
      ],
    ];
    for (const [payload, req, reason] of invalid) {
      await expect(api.validatePayload(payload, req)).rejects.toThrow(reason);
    }
  });

  it("accepts and rejects verified snapshot boundaries", () => {
    const api = internals(new BatchSvmScheme());
    expect(
      api.applySnapshot(channelId, {
        channelId,
        balance: 10_000n,
        totalClaimed: 1_000n,
        withdrawRequestedAt: 0,
      }),
    ).toBe(true);
    expect(
      api.applySnapshot(channelId, {
        channelId: payer.address,
        totalClaimed: 0n,
        withdrawRequestedAt: 0,
      }),
    ).toBe(false);
    expect(api.applySnapshot(channelId, { totalClaimed: 0n, withdrawRequestedAt: 1 })).toBe(false);
    expect(
      api.applySnapshot(channelId, {
        balance: 1n,
        totalClaimed: 2n,
        withdrawRequestedAt: 0,
      }),
    ).toBe(false);
    expect(api.applySnapshot(channelId, { totalClaimed: 2n, withdrawRequestedAt: 0 })).toBe(true);
  });

  it("creates provisional/recovered records and merges snapshots monotonically", async () => {
    const store = new MemoryChannelStore();
    const server = new BatchSvmScheme({ store });
    const api = internals(server);
    expect(
      api.recoveredState(depositPayload, requirements(), channelId, {
        totalClaimed: 2_000n,
        withdrawRequestedAt: 0,
      }),
    ).toMatchObject({ deposit: 0n, settled: 2_000n, signedMaxClaimable: 2_000n });
    expect(api.provisionalState(depositPayload, requirements(), channelId)).toMatchObject({
      deposit: 10_000n,
      settled: 0n,
    });
    expect(() =>
      api.provisionalState(
        { channelConfig, transaction: "close", type: "refund" },
        requirements(),
        channelId,
      ),
    ).toThrow(BatchError.CHANNEL_STATE);

    await store.put(state({ chargedCumulativeAmount: 3_000n, deposit: 10_000n, settled: 2_000n }));
    await api.persistSnapshot(channelId, depositPayload, requirements(), {
      balance: 12_000n,
      totalClaimed: 4_000n,
      withdrawRequestedAt: 20,
    });
    expect(await store.get(channelId)).toMatchObject({
      chargedCumulativeAmount: 4_000n,
      closeRequestedAt: 20,
      deposit: 12_000n,
      settled: 4_000n,
      signedMaxClaimable: 4_000n,
      status: "closing",
    });
    await api.persistSnapshot(channelId, depositPayload, requirements(), {
      balance: 1n,
      totalClaimed: 1n,
      withdrawRequestedAt: 0,
    });
    expect(await store.get(channelId)).toMatchObject({ deposit: 12_000n, settled: 4_000n });
  });

  it("rejects a stored channel with different immutable configuration", () => {
    const api = internals(new BatchSvmScheme());
    expect(() => api.assertStoredConfig(state(), channelConfig)).not.toThrow();
    expect(() => api.assertStoredConfig(state(), { ...channelConfig, salt: "1" })).toThrow(
      BatchError.CHANNEL_STATE,
    );
  });

  it("covers hook no-op and missing-reservation paths", async () => {
    const server = new BatchSvmScheme();
    const payment = {
      accepted: requirements(),
      payload: depositPayload,
      x402Version: 2,
    } as PaymentPayload;
    await expect(
      server.schemeHooks.onBeforeVerify!({
        declaredExtensions: {},
        paymentPayload: { ...payment, payload: { type: "other" } } as never,
        requirements: requirements(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      server.schemeHooks.onAfterVerify!({
        declaredExtensions: {},
        paymentPayload: payment,
        requirements: requirements(),
        result: { isValid: false, payer: payer.address },
      }),
    ).resolves.toBeUndefined();
    await expect(
      server.schemeHooks.onBeforeSettle!({
        declaredExtensions: {},
        paymentPayload: payment,
        phase: "before-handler",
        requirements: requirements(),
      }),
    ).resolves.toMatchObject({ abort: true, reason: "duplicate_settlement" });
    await expect(
      server.schemeHooks.onAfterSettle!({
        declaredExtensions: {},
        paymentPayload: payment,
        phase: "after-handler",
        requirements: requirements(),
        result: { network: SOLANA_DEVNET_CAIP2, success: false, transaction: "" },
      }),
    ).resolves.toBeUndefined();
  });

  it("only enriches a validated cumulative mismatch with stored proof", async () => {
    const store = new MemoryChannelStore();
    const server = new BatchSvmScheme({ store });
    const payment = {
      accepted: requirements(),
      payload: depositPayload,
      x402Version: 2,
    } as PaymentPayload;
    const enrich = (overrides: Record<string, unknown> = {}) =>
      server.enrichPaymentRequiredResponse({
        error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
        paymentPayload: payment,
        requirements: [requirements()],
        x402Version: 2,
        ...overrides,
      } as never);
    await expect(enrich({ error: "other" })).resolves.toBeUndefined();
    await expect(enrich({ paymentPayload: undefined })).resolves.toBeUndefined();
    await expect(
      enrich({ paymentPayload: { ...payment, payload: { nope: true } } }),
    ).resolves.toBeUndefined();
    await expect(enrich()).resolves.toBeUndefined();

    await store.put(state());
    await expect(
      enrich({ requirements: [{ ...requirements(), scheme: "exact" }] }),
    ).resolves.toBeUndefined();
    const enriched = await enrich();
    expect(enriched?.[0].extra).toMatchObject({
      channelState: { chargedCumulativeAmount: "0", channelId },
    });
    expect(enriched?.[0].extra).not.toHaveProperty("voucherState");

    await store.put(
      state({
        highestVoucherExpiresAt: 0,
        highestVoucherSignature: depositPayload.voucher.signature,
        signedMaxClaimable: 1_000n,
      }),
    );
    await expect(enrich()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extra: expect.objectContaining({
            voucherState: expect.objectContaining({ signedMaxClaimable: "1000" }),
          }),
        }),
      ]),
    );
    await store.put(
      state({
        closeRequestedAt: 20,
        highestVoucherExpiresAt: undefined,
        highestVoucherSignature: depositPayload.voucher.signature,
        signedMaxClaimable: 1_000n,
      }),
    );
    await expect(enrich()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extra: expect.objectContaining({
            channelState: expect.objectContaining({ withdrawRequestedAt: 20 }),
            voucherState: expect.objectContaining({ expiresAt: 0 }),
          }),
        }),
      ]),
    );
  });

  it("handles unknown channels and rejects unusable facilitator snapshots", async () => {
    const store = new MemoryChannelStore();
    const server = new BatchSvmScheme({ store });
    const voucherPayload: BatchPayload = {
      channelConfig,
      type: "voucher",
      voucher: depositPayload.voucher,
    };
    const payment = {
      accepted: requirements(),
      payload: voucherPayload,
      x402Version: 2,
    } as PaymentPayload;
    const verifyContext = {
      declaredExtensions: {},
      paymentPayload: payment,
      requirements: requirements(),
    };
    await expect(server.schemeHooks.onBeforeVerify!(verifyContext)).resolves.toBeUndefined();
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...verifyContext,
        result: {
          extra: {
            channelState: {
              balance: "1",
              channelId,
              totalClaimed: "2",
              withdrawRequestedAt: 0,
            },
          },
          isValid: true,
          payer: payer.address,
        },
      }),
    ).resolves.toMatchObject({ abort: true, reason: BatchError.CHANNEL_STATE });

    const second = new BatchSvmScheme({ store: new MemoryChannelStore() });
    const payment2 = { ...payment, payload: { ...voucherPayload } } as PaymentPayload;
    const context2 = { ...verifyContext, paymentPayload: payment2 };
    await second.schemeHooks.onBeforeVerify!(context2);
    await expect(
      second.schemeHooks.onAfterVerify!({
        ...context2,
        result: {
          extra: {
            channelState: {
              balance: "10000",
              channelId,
              totalClaimed: "500",
              withdrawRequestedAt: 0,
            },
          },
          isValid: true,
          payer: payer.address,
        },
      }),
    ).resolves.toMatchObject({ abort: true, reason: BatchError.CUMULATIVE_AMOUNT_MISMATCH });
  });

  it("rejects an exact replay before the resource handler", async () => {
    const replayState = state({
      chargedCumulativeAmount: 1_000n,
      highestVoucherSignature: depositPayload.voucher.signature,
      signedMaxClaimable: 1_000n,
    });
    const makePayment = (): PaymentPayload => ({
      accepted: requirements(),
      payload: {
        channelConfig,
        type: "voucher",
        voucher: depositPayload.voucher,
      },
      x402Version: 2,
    });
    const store = new MemoryChannelStore();
    await store.put(replayState);
    const server = new BatchSvmScheme({ store });
    const payment = makePayment();
    await expect(
      server.schemeHooks.onBeforeVerify!({
        declaredExtensions: {},
        paymentPayload: payment,
        requirements: requirements(),
      }),
    ).resolves.toMatchObject({ abort: true, reason: "duplicate_settlement" });
  });

  it("uses local voucher verification only while the onchain snapshot is fresh", async () => {
    const freshStore = new MemoryChannelStore();
    await freshStore.put(state());
    const payment: PaymentPayload = {
      accepted: requirements(),
      payload: { channelConfig, type: "voucher", voucher: depositPayload.voucher },
      x402Version: 2,
    };
    const freshContext = {
      declaredExtensions: {},
      paymentPayload: payment,
      requirements: requirements(),
    };
    await expect(
      new BatchSvmScheme({ onchainStateTtlMs: 1_000, store: freshStore }).schemeHooks
        .onBeforeVerify!(freshContext),
    ).resolves.toMatchObject({ skip: true });

    const staleStore = new MemoryChannelStore();
    await staleStore.put(state({ onchainSyncedAt: 0 }));
    const staleServer = new BatchSvmScheme({ onchainStateTtlMs: 1_000, store: staleStore });
    const stalePayment = { ...payment, payload: { ...payment.payload } } as PaymentPayload;
    const staleContext = { ...freshContext, paymentPayload: stalePayment };
    await expect(staleServer.schemeHooks.onBeforeVerify!(staleContext)).resolves.toBeUndefined();
    await expect(
      staleServer.schemeHooks.onAfterVerify!({
        ...staleContext,
        result: { isValid: true, payer: payer.address },
      }),
    ).resolves.toMatchObject({ abort: true, reason: BatchError.CHANNEL_STATE });
    const beforeRefresh = Date.now();
    await expect(
      staleServer.schemeHooks.onAfterVerify!({
        ...staleContext,
        result: {
          extra: {
            channelState: {
              balance: "10000",
              channelId,
              totalClaimed: "0",
              withdrawRequestedAt: 0,
            },
          },
          isValid: true,
          payer: payer.address,
        },
      }),
    ).resolves.toBeUndefined();
    expect((await staleStore.get(channelId))?.onchainSyncedAt).toBeGreaterThanOrEqual(
      beforeRefresh,
    );
  });

  it("rejects busy, closing, and mismatched stored channel reservations", async () => {
    const cases = [
      state({
        reservations: {
          busy: { ceiling: 1n, expiresAt: Date.now() + 10_000, kind: "client" },
        },
      }),
      state({ status: "closing" }),
      state({ channelConfig: { ...channelConfig, salt: "1" } }),
    ];
    for (const stored of cases) {
      const store = new MemoryChannelStore();
      await store.put(stored);
      const server = new BatchSvmScheme({ store });
      const payment: PaymentPayload = {
        accepted: requirements(),
        payload: depositPayload,
        x402Version: 2,
      };
      const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
      const before = await server.schemeHooks.onBeforeVerify!(ctx);
      if (stored.channelConfig.salt !== channelConfig.salt) {
        expect(before).toMatchObject({ abort: true, reason: BatchError.CHANNEL_STATE });
        continue;
      }
      expect(before).toBeUndefined();
      await expect(
        server.schemeHooks.onAfterVerify!({
          ...ctx,
          result: { isValid: true, payer: payer.address },
        }),
      ).resolves.toMatchObject({ abort: true });
    }
  });

  it("covers price parser and requirement configuration branches", async () => {
    const server = new BatchSvmScheme({ receiverAuthorizer: payer.address });
    await expect(
      server.parsePrice({ amount: "1", asset: MINT }, SOLANA_DEVNET_CAIP2),
    ).resolves.toEqual({
      amount: "1",
      asset: MINT,
      extra: {},
    });
    await expect(
      server.parsePrice({ amount: "1", asset: "" }, SOLANA_DEVNET_CAIP2),
    ).rejects.toThrow(/Asset address/);
    await expect(server.parsePrice(1, SOLANA_DEVNET_CAIP2)).resolves.toMatchObject({
      amount: "1000000",
    });
    await expect(server.parsePrice("1 USD", SOLANA_DEVNET_CAIP2)).resolves.toMatchObject({
      asset: MINT,
    });
    await expect(server.parsePrice("not money", SOLANA_DEVNET_CAIP2)).rejects.toThrow(
      /Invalid money format/,
    );
    const custom = new BatchSvmScheme()
      .registerMoneyParser(async () => null)
      .registerMoneyParser(async () => ({ amount: "7", asset: MINT }));
    await expect(custom.parsePrice("2", SOLANA_DEVNET_CAIP2)).resolves.toEqual({
      amount: "7",
      asset: MINT,
    });
    await expect(
      server.enhancePaymentRequirements(
        requirements(),
        { network: SOLANA_DEVNET_CAIP2, scheme: "batch-settlement", x402Version: 2 },
        [],
      ),
    ).resolves.toMatchObject({ extra: { receiverAuthorizer: payer.address, withdrawDelay: 900 } });
    expect(() =>
      new BatchSvmScheme({ withdrawDelay: 2_592_001 }).enhancePaymentRequirements(
        requirements(),
        { network: SOLANA_DEVNET_CAIP2, scheme: "batch-settlement", x402Version: 2 },
        [],
      ),
    ).toThrow(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE);
  });

  it("normalizes malformed verify snapshots without trusting their fields", async () => {
    const snapshots = [
      undefined,
      null,
      { totalClaimed: "bad", withdrawRequestedAt: 0 },
      { balance: "bad", totalClaimed: "0", withdrawRequestedAt: 1.5 },
      { totalClaimed: "0", withdrawRequestedAt: "bad" },
    ];
    for (const channelState of snapshots) {
      const store = new MemoryChannelStore();
      const server = new BatchSvmScheme({ store });
      const payment: PaymentPayload = {
        accepted: requirements(),
        payload: depositPayload,
        x402Version: 2,
      };
      const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
      await server.schemeHooks.onBeforeVerify!(ctx);
      const result = await server.schemeHooks.onAfterVerify!({
        ...ctx,
        result: {
          extra: channelState === undefined ? undefined : { channelState },
          isValid: true,
          payer: payer.address,
        },
      });
      const snapshotWithoutBalance =
        typeof channelState === "object" &&
        channelState !== null &&
        typeof channelState.totalClaimed === "string" &&
        /^\d+$/.test(channelState.totalClaimed) &&
        !(typeof channelState.balance === "string" && /^\d+$/.test(channelState.balance));
      if (snapshotWithoutBalance) {
        expect(result).toMatchObject({
          abort: true,
          reason: BatchError.CUMULATIVE_EXCEEDS_DEPOSIT,
        });
      } else {
        expect(result).toBeUndefined();
      }
      expect(await store.get(channelId)).toBeDefined();
    }
  });

  it("normalizes settlement snapshots and never lowers a confirmed deposit", async () => {
    const responses = [
      undefined,
      null,
      { balance: "bad", totalClaimed: 1, withdrawRequestedAt: "bad" },
      { balance: "1", totalClaimed: "0", withdrawRequestedAt: 0 },
      { balance: "12000", totalClaimed: "0", withdrawRequestedAt: 0 },
    ];
    for (const channelState of responses) {
      const store = new MemoryChannelStore();
      const server = new BatchSvmScheme({ store });
      const payment: PaymentPayload = {
        accepted: requirements(),
        payload: depositPayload,
        x402Version: 2,
      };
      const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
      const before = await server.schemeHooks.onBeforeVerify!(ctx);
      expect(before).toBeUndefined();
      await server.schemeHooks.onAfterVerify!({
        ...ctx,
        result: { isValid: true, payer: payer.address },
      });
      await server.schemeHooks.onAfterSettle!({
        ...ctx,
        phase: "after-handler",
        result: {
          extra: channelState === undefined ? undefined : { channelState },
          network: SOLANA_DEVNET_CAIP2,
          success: true,
          transaction: "signature",
        },
      });
      const stored = await store.get(channelId);
      expect(stored?.deposit).toBe(
        channelState && channelState.balance === "12000" ? 12_000n : 10_000n,
      );
    }
  });

  it("commits voucher reservations before settlement and detects replacement", async () => {
    const store = new MemoryChannelStore();
    await store.put(state());
    const server = new BatchSvmScheme({ store });
    const payment: PaymentPayload = {
      accepted: requirements(),
      payload: {
        channelConfig,
        type: "voucher",
        voucher: depositPayload.voucher,
      },
      x402Version: 2,
    };
    const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
    await server.schemeHooks.onBeforeVerify!(ctx);
    await server.schemeHooks.onAfterVerify!({
      ...ctx,
      result: { isValid: true, payer: payer.address },
    });
    await expect(
      server.schemeHooks.onBeforeSettle!({ ...ctx, phase: "before-handler" }),
    ).resolves.toMatchObject({
      skip: true,
      result: { extra: { commitmentId: `${channelId}:1000` }, success: true },
    });
    expect(await store.get(channelId)).toMatchObject({ chargedCumulativeAmount: 1_000n });

    const changedStore = new MemoryChannelStore();
    await changedStore.put(state());
    const changed = new BatchSvmScheme({ store: changedStore });
    const payment2 = { ...payment, payload: { ...payment.payload } } as PaymentPayload;
    const ctx2 = { ...ctx, paymentPayload: payment2 };
    await changed.schemeHooks.onBeforeVerify!(ctx2);
    await changed.schemeHooks.onAfterVerify!({
      ...ctx2,
      result: { isValid: true, payer: payer.address },
    });
    await changedStore.update(channelId, current => ({
      ...current!,
      reservations: {
        replacement: { ceiling: 1n, expiresAt: Date.now() + 10_000, kind: "client" },
      },
    }));
    await expect(
      changed.schemeHooks.onBeforeSettle!({ ...ctx2, phase: "before-handler" }),
    ).resolves.toMatchObject({ abort: true, reason: "duplicate_settlement" });
  });

  it("covers corrective validation and hook state edge cases", async () => {
    const server = new BatchSvmScheme();
    const invalidPayment: PaymentPayload = {
      accepted: requirements(),
      payload: {
        ...depositPayload,
        voucher: { ...depositPayload.voucher, maxClaimableAmount: "1001" },
      },
      x402Version: 2,
    };
    await expect(
      server.enrichPaymentRequiredResponse({
        error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
        paymentPayload: invalidPayment,
        requirements: [requirements()],
        x402Version: 2,
      } as never),
    ).resolves.toBeUndefined();

    const thrown = new BatchSvmScheme();
    internals(thrown).validatePayload = async () => Promise.reject("validation failed");
    await expect(
      thrown.schemeHooks.onBeforeVerify!({
        declaredExtensions: {},
        paymentPayload: { accepted: requirements(), payload: depositPayload, x402Version: 2 },
        requirements: requirements(),
      }),
    ).resolves.toMatchObject({
      abort: true,
      message: "validation failed",
      reason: "transaction_failed",
    });

    const noRequest = new BatchSvmScheme();
    const payment: PaymentPayload = {
      accepted: requirements(),
      payload: depositPayload,
      x402Version: 2,
    };
    await expect(
      noRequest.schemeHooks.onAfterVerify!({
        declaredExtensions: {},
        paymentPayload: payment,
        requirements: requirements(),
        result: { isValid: true, payer: payer.address },
      }),
    ).resolves.toMatchObject({ abort: true, reason: BatchError.CHANNEL_STATE });
    await expect(
      noRequest.schemeHooks.onAfterSettle!({
        declaredExtensions: {},
        paymentPayload: payment,
        phase: "after-handler",
        requirements: requirements(),
        result: { network: SOLANA_DEVNET_CAIP2, success: true, transaction: "sig" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      noRequest.schemeHooks.onSettleFailure!({
        declaredExtensions: {},
        error: new Error("handler"),
        paymentPayload: payment,
        phase: "after-handler",
        requirements: requirements(),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("reserves refunds but never runs them through pre-handler settlement", async () => {
    const store = new MemoryChannelStore();
    await store.put(state({ highestVoucherSignature: depositPayload.voucher.signature }));
    const server = new BatchSvmScheme({ store });
    const refund = await buildRefundPayload({
      blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
      channelConfig,
      channelId,
      feePayer: feePayer.address,
      payer,
    });
    const payment: PaymentPayload = {
      accepted: requirements(),
      payload: refund,
      x402Version: 2,
    };
    const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
    await expect(server.schemeHooks.onBeforeVerify!(ctx)).resolves.toBeUndefined();
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...ctx,
        result: { isValid: true, payer: payer.address },
      }),
    ).resolves.toMatchObject({
      skipHandler: true,
      response: { body: { channelId, message: "Refund initiated" } },
    });
    await expect(
      server.schemeHooks.onBeforeSettle!({ ...ctx, phase: "before-handler" }),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown voucher when no verified snapshot creates state", async () => {
    const server = new BatchSvmScheme();
    const payment: PaymentPayload = {
      accepted: requirements(),
      payload: { channelConfig, type: "voucher", voucher: depositPayload.voucher },
      x402Version: 2,
    };
    const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
    await server.schemeHooks.onBeforeVerify!(ctx);
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...ctx,
        result: { isValid: true, payer: payer.address },
      }),
    ).resolves.toMatchObject({ abort: true, reason: BatchError.CHANNEL_STATE });
  });
});
