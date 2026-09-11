import { generateKeyPairSigner } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BatchChannelTracker } from "../../src/batch-settlement/client/channel";
import {
  BatchSvmScheme,
  type BatchClientChannelRecord,
  type BatchClientChannelStorage,
} from "../../src/batch-settlement/client/scheme";
import type { BatchChannelConfig } from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { signVoucher } from "../../src/payment-channels/voucher";
import { signBatchSettlementReceipt } from "../../src/batch-settlement/receipt";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../src/utils";

vi.mock("@solana-program/token-2022", async importOriginal => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchMint: vi.fn(),
}));

vi.mock("../../src/utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  createRpcClient: vi.fn(() => ({
    getProgramAccounts: vi.fn(() => ({ send: vi.fn().mockResolvedValue([]) })),
  })),
  resolveBlockhash: vi.fn(),
  resolveOpenSlot: vi.fn(),
}));

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const BLOCKHASH = USDC_MAINNET_ADDRESS;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
});

beforeEach(() => {
  vi.mocked(fetchMint).mockResolvedValue({ programAddress: TOKEN_PROGRAM_ADDRESS } as never);
  vi.mocked(resolveBlockhash).mockResolvedValue({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 10n,
  });
  vi.mocked(resolveOpenSlot).mockResolvedValue(123n);
  vi.mocked(createRpcClient).mockReturnValue({
    getProgramAccounts: vi.fn(() => ({ send: vi.fn().mockResolvedValue([]) })),
  } as never);
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
    network: NETWORK,
    payTo: RECEIVER,
    scheme: "batch-settlement",
    ...overrides,
  };
}

function memoryStorage() {
  const records = new Map<string, BatchClientChannelRecord>();
  const storage: BatchClientChannelStorage = {
    delete: vi.fn(async key => void records.delete(key)),
    get: vi.fn(async key => records.get(key)),
    set: vi.fn(async (key, record) => void records.set(key, record)),
  };
  return { records, storage };
}

type ClientInternals = {
  channels: Map<string, { tracker: BatchChannelTracker; deposit: bigint }>;
  pending: Map<string, unknown>;
  channelKey(requirements: PaymentRequirements, feePayer: string, withdrawDelay: number): string;
  resolveTerms(requirements: PaymentRequirements): Promise<unknown>;
  discoverChannel(requirements: PaymentRequirements, terms: unknown): Promise<unknown>;
  loadChannel(key: string): Promise<unknown>;
};

function internals(client: BatchSvmScheme): ClientInternals {
  return client as unknown as ClientInternals;
}

describe("batch client lifecycle", () => {
  it("commits the metered amount from a signed server-mode receipt", async () => {
    const operator = await generateKeyPairSigner();
    const { records, storage } = memoryStorage();
    const client = new BatchSvmScheme(payer, {
      channelStorage: storage,
      depositAmount: 3_000n,
      discoverChannels: false,
    });
    const serverRequirements = requirements({
      extra: {
        ...requirements().extra,
        operator: operator.address,
        voucherSigner: "server",
      },
    });
    const opened = await client.createPaymentPayload(2, serverRequirements);
    expect(opened.payload).toMatchObject({ type: "deposit" });
    expect("maxClaimableAmount" in opened.payload).toBe(false);
    const channelId = opened.payload.authorization!.channelId;
    const signature = await signVoucher(operator, {
      channelId,
      cumulativeAmount: 400n,
      expiresAt: 0n,
    });
    const voucher = { channelId, expiresAt: 0, maxClaimableAmount: "400", signature };
    const receipt = await signBatchSettlementReceipt(operator, {
      channelId,
      idempotencyKey: opened.payload.idempotencyKey!,
      authorizedAmount: 1_000n,
      chargedAmount: 400n,
      priorCumulativeAmount: 0n,
      cumulativeAmount: 400n,
      voucher,
    });

    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: serverRequirements, ...opened },
      requirements: serverRequirements,
      settleResponse: {
        extra: {
          chargedAmount: "400",
          channelState: { chargedCumulativeAmount: "400" },
          commitmentId: `${channelId}:400`,
          receipt,
          voucher,
        },
        success: true,
      },
    } as never);

    expect([...records.values()][0]).toMatchObject({
      chargedCumulativeAmount: "400",
      deposit: "3000",
    });

    const first = await client.createPaymentPayload(2, serverRequirements);
    const second = await client.createPaymentPayload(2, serverRequirements);
    expect(first.payload).toMatchObject({ type: "authorization" });
    expect(second.payload).toMatchObject({ type: "authorization" });
    if (first.payload.type !== "authorization" || second.payload.type !== "authorization") {
      throw new Error("expected server-mode authorization payloads");
    }
    expect(first.payload.idempotencyKey).not.toBe(second.payload.idempotencyKey);

    const response = async (
      payment: typeof first,
      prior: bigint,
      actual: bigint,
      cumulative: bigint,
    ) => {
      const voucherSignature = await signVoucher(operator, {
        channelId,
        cumulativeAmount: cumulative,
        expiresAt: 0n,
      });
      const completedVoucher = {
        channelId,
        expiresAt: 0,
        maxClaimableAmount: cumulative.toString(),
        signature: voucherSignature,
      };
      const completedReceipt = await signBatchSettlementReceipt(operator, {
        channelId,
        idempotencyKey: payment.payload.idempotencyKey!,
        authorizedAmount: 1_000n,
        chargedAmount: actual,
        priorCumulativeAmount: prior,
        cumulativeAmount: cumulative,
        voucher: completedVoucher,
      });
      return {
        extra: {
          chargedAmount: actual.toString(),
          channelState: { chargedCumulativeAmount: cumulative.toString() },
          commitmentId: `${channelId}:${cumulative}`,
          receipt: completedReceipt,
          voucher: completedVoucher,
        },
        success: true,
      };
    };

    // Request two completed second, then its response arrived after request
    // one's newer cumulative receipt. The client must not roll state back.
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: serverRequirements, ...first },
      requirements: serverRequirements,
      settleResponse: await response(first, 700n, 200n, 900n),
    } as never);
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: serverRequirements, ...second },
      requirements: serverRequirements,
      settleResponse: await response(second, 400n, 300n, 700n),
    } as never);
    expect([...records.values()][0]).toMatchObject({ chargedCumulativeAmount: "900" });
  });

  it("opens, replays, confirms, and advances a persisted channel", async () => {
    const { records, storage } = memoryStorage();
    const client = new BatchSvmScheme(payer, {
      channelStorage: storage,
      depositAmount: 3_000n,
      discoverChannels: false,
    });
    const opened = await client.createPaymentPayload(2, requirements());
    expect(opened.payload).toMatchObject({
      type: "deposit",
      deposit: { amount: "3000" },
      voucher: { maxClaimableAmount: "1000" },
    });

    await expect(client.createPaymentPayload(2, requirements())).resolves.toEqual(opened);
    await expect(client.createPaymentPayload(2, requirements({ amount: "2000" }))).rejects.toThrow(
      /pending allocation for a different amount/,
    );

    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: requirements(), ...opened },
      requirements: requirements(),
      settleResponse: {
        extra: {
          chargedAmount: "1000",
          channelState: { chargedCumulativeAmount: "1000" },
          commitmentId: `${opened.payload.voucher.channelId}:1000`,
        },
        success: true,
      },
    } as never);
    expect([...records.values()][0]).toMatchObject({
      chargedCumulativeAmount: "1000",
      deposit: "3000",
    });

    const next = await client.createPaymentPayload(2, requirements());
    expect(next.payload).toMatchObject({
      type: "voucher",
      voucher: { maxClaimableAmount: "2000" },
    });
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: requirements(), ...next },
      requirements: requirements(),
      settleResponse: {
        extra: {
          chargedAmount: "1000",
          commitmentId: `${next.payload.voucher.channelId}:2000`,
        },
        success: true,
      },
    } as never);
    expect([...records.values()][0]).toMatchObject({
      chargedCumulativeAmount: "2000",
      deposit: "3000",
    });

    const invalidResponse = await client.createPaymentPayload(2, requirements());
    await expect(
      client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: requirements(), ...invalidResponse },
        requirements: requirements(),
        settleResponse: { extra: { chargedAmount: "bad" }, success: true },
      } as never),
    ).rejects.toThrow(/charged more than/);
  });

  it("tops up an exhausted channel and commits only the signed deposit", async () => {
    const { records, storage } = memoryStorage();
    const client = new BatchSvmScheme(payer, {
      channelStorage: storage,
      depositAmount: 1_500n,
      discoverChannels: false,
    });
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    const key = api.channelKey(requirements(), feePayer.address, 900);
    const tracker = new BatchChannelTracker(RECEIVER, config, payer, 1_000n);
    api.channels.set(key, { deposit: 1_000n, tracker });

    const topUp = await client.createPaymentPayload(2, requirements());
    expect(topUp.payload).toMatchObject({
      type: "deposit",
      deposit: { amount: "1500" },
      voucher: { maxClaimableAmount: "2000" },
    });
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: requirements(), ...topUp },
      requirements: requirements(),
      settleResponse: {
        extra: {
          chargedAmount: "1000",
          channelState: { balance: "999999", chargedCumulativeAmount: "2000" },
          commitmentId: `${RECEIVER}:2000`,
        },
        success: true,
      },
    } as never);
    expect(records.get(key)).toMatchObject({ chargedCumulativeAmount: "2000", deposit: "2500" });
  });

  it("tops up by the exact shortfall when the configured increment is smaller", async () => {
    const client = new BatchSvmScheme(payer, {
      depositAmount: 500n,
      discoverChannels: false,
    });
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    const key = api.channelKey(requirements(), feePayer.address, 900);
    api.channels.set(key, {
      deposit: 1_000n,
      tracker: new BatchChannelTracker(RECEIVER, config, payer, 1_000n),
    });
    await expect(client.createPaymentPayload(2, requirements())).resolves.toMatchObject({
      payload: { deposit: { amount: "1000" }, type: "deposit" },
    });
  });

  it("uses five request charges as the default top-up target", async () => {
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    api.channels.set(api.channelKey(requirements(), feePayer.address, 900), {
      deposit: 1_000n,
      tracker: new BatchChannelTracker(RECEIVER, config, payer, 1_000n),
    });
    await expect(client.createPaymentPayload(2, requirements())).resolves.toMatchObject({
      payload: { deposit: { amount: "5000" }, type: "deposit" },
    });
  });

  it("honors a valid minDeposit hint within the local spend ceiling", async () => {
    const hinted = requirements({
      extra: { ...requirements().extra, minDeposit: "15000" },
    });
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    await expect(client.createPaymentPayload(2, hinted)).resolves.toMatchObject({
      payload: { deposit: { amount: "15000" }, type: "deposit" },
    });

    const capped = new BatchSvmScheme(payer, { discoverChannels: false });
    await expect(
      capped.createPaymentPayload(2, hinted, { maxAmountPerPayment: "2000" }),
    ).resolves.toMatchObject({
      payload: { deposit: { amount: "10000" }, type: "deposit" },
    });
  });

  it("falls back from malformed minDeposit and validates depositMultiplier", async () => {
    const malformed = requirements({
      extra: { ...requirements().extra, minDeposit: "500" },
    });
    const client = new BatchSvmScheme(payer, {
      depositPolicy: { depositMultiplier: 3 },
      discoverChannels: false,
    });
    await expect(client.createPaymentPayload(2, malformed)).resolves.toMatchObject({
      payload: { deposit: { amount: "3000" }, type: "deposit" },
    });
    expect(() => new BatchSvmScheme(payer, { depositPolicy: { depositMultiplier: 2 } })).toThrow(
      /integer >= 3/,
    );
  });

  it("rejects a required deposit above the spend-derived ceiling", async () => {
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    await expect(
      client.createPaymentPayload(2, requirements(), { maxAmountPerPayment: "100" }),
    ).rejects.toThrow(/Required deposit 1000 exceeds/);

    const malformedCap = new BatchSvmScheme(payer, { discoverChannels: false });
    await expect(
      malformedCap.createPaymentPayload(
        2,
        requirements({ extra: { ...requirements().extra, minDeposit: "not-an-amount" } }),
        { maxAmountPerPayment: "not-an-amount" },
      ),
    ).resolves.toMatchObject({
      payload: { deposit: { amount: "5000" }, type: "deposit" },
    });
  });

  it("treats empty and failed discovery scans as cache misses", async () => {
    const client = new BatchSvmScheme(payer);
    const api = internals(client);
    const terms = {
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    };
    await expect(api.discoverChannel(requirements(), terms)).resolves.toBeUndefined();
    vi.mocked(createRpcClient).mockReturnValue({
      getProgramAccounts: vi.fn(() => ({ send: vi.fn().mockRejectedValue(new Error("rpc")) })),
    } as never);
    await expect(api.discoverChannel(requirements(), terms)).resolves.toBeUndefined();
  });

  it("adopts a discovered channel before allocating a voucher", async () => {
    const { records, storage } = memoryStorage();
    const client = new BatchSvmScheme(payer, { channelStorage: storage });
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    api.discoverChannel = vi.fn().mockResolvedValue({
      deposit: 5_000n,
      tracker: new BatchChannelTracker(RECEIVER, config, payer, 1_000n),
    });
    await expect(client.createPaymentPayload(2, requirements())).resolves.toMatchObject({
      payload: { type: "voucher", voucher: { maxClaimableAmount: "2000" } },
    });
    expect([...records.values()][0]).toMatchObject({ chargedCumulativeAmount: "1000" });
  });

  it("preserves the spend-derived deposit ceiling after channel discovery", async () => {
    const client = new BatchSvmScheme(payer);
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    api.discoverChannel = vi.fn().mockResolvedValue({
      deposit: 0n,
      tracker: new BatchChannelTracker(RECEIVER, config, payer, 0n),
    });
    await expect(
      client.createPaymentPayload(2, requirements(), { maxAmountPerPayment: "100" }),
    ).rejects.toThrow(/Required deposit 1000 exceeds/);
  });

  it("restores confirmed state after a failed request", async () => {
    const { records, storage } = memoryStorage();
    const client = new BatchSvmScheme(payer, { channelStorage: storage });
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    const key = api.channelKey(requirements(), feePayer.address, 900);
    api.channels.set(key, {
      deposit: 5_000n,
      tracker: new BatchChannelTracker(RECEIVER, config, payer, 1_000n),
    });
    const payment = await client.createPaymentPayload(2, requirements());
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: requirements(), ...payment },
      requirements: requirements(),
      settleResponse: { success: false },
    } as never);
    expect(records.get(key)).toMatchObject({ chargedCumulativeAmount: "1000", deposit: "5000" });
  });

  it("rejects corrective responses without the required trustworthy state", async () => {
    const corrections = [
      { accepts: [requirements()], error: "other" },
      {
        accepts: [requirements()],
        error: "invalid_batch_settlement_svm_cumulative_amount_mismatch",
      },
      {
        accepts: [
          requirements({
            extra: {
              ...requirements().extra,
              channelState: {
                balance: "10000",
                channelId: RECEIVER,
                chargedCumulativeAmount: "1",
                totalClaimed: "2",
                withdrawRequestedAt: 0,
              },
            },
          }),
        ],
        error: "invalid_batch_settlement_svm_cumulative_amount_mismatch",
      },
    ];
    for (const paymentRequired of corrections) {
      const client = new BatchSvmScheme(payer, { discoverChannels: false });
      const payment = await client.createPaymentPayload(2, requirements());
      await expect(
        client.schemeHooks.onPaymentResponse!({
          paymentPayload: { accepted: requirements(), ...payment },
          paymentRequired: { ...paymentRequired, x402Version: 2 },
          requirements: requirements(),
          settleResponse: { success: false },
        } as never),
      ).resolves.toBeUndefined();
    }
  });

  it("hydrates confirmed and pending records and ignores unrelated responses", async () => {
    const { records, storage } = memoryStorage();
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    records.set("confirmed", {
      channelConfig: config,
      channelId: RECEIVER,
      chargedCumulativeAmount: "1000",
      deposit: "5000",
    });
    const client = new BatchSvmScheme(payer, { channelStorage: storage });
    await expect(internals(client).loadChannel("confirmed")).resolves.toMatchObject({
      deposit: 5_000n,
    });
    expect(await internals(client).loadChannel("confirmed")).toBeDefined();
    await expect(internals(client).loadChannel("missing")).resolves.toBeUndefined();
    await expect(
      client.schemeHooks.onPaymentResponse!({
        paymentPayload: {
          accepted: requirements(),
          payload: { type: "not-batch" },
          x402Version: 2,
        },
        requirements: requirements(),
      } as never),
    ).resolves.toBeUndefined();
    const voucher = await new BatchChannelTracker(RECEIVER, config, payer).previewVoucher(1_000n);
    await expect(
      client.schemeHooks.onPaymentResponse!({
        paymentPayload: {
          accepted: requirements(),
          payload: { channelConfig: config, type: "voucher", voucher },
          x402Version: 2,
        },
        requirements: requirements(),
        settleResponse: { success: false },
      } as never),
    ).resolves.toBeUndefined();
  });

  it("validates client terms and configuration boundaries", async () => {
    const client = new BatchSvmScheme(payer);
    const resolve = (value: PaymentRequirements) => internals(client).resolveTerms(value);
    await expect(resolve(requirements())).resolves.toMatchObject({
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    await expect(
      resolve(
        requirements({
          extra: {
            ...requirements().extra,
            memo: "invoice",
            receiverAuthorizer: payer.address,
          },
        }),
      ),
    ).resolves.toMatchObject({ memo: "invoice", receiverAuthorizer: payer.address });
    await expect(
      resolve(
        requirements({
          extra: {
            ...requirements().extra,
            operator: feePayer.address,
            voucherSigner: "server",
          },
        }),
      ),
    ).resolves.toMatchObject({ operator: feePayer.address, voucherSigner: "server" });
    const invalid = [
      requirements({ extra: undefined }),
      requirements({ extra: { ...requirements().extra, paymentFlow: "upfront" } }),
      requirements({ extra: { ...requirements().extra, feePayer: "" } }),
      requirements({ extra: { ...requirements().extra, withdrawDelay: 899 } }),
      requirements({ extra: { ...requirements().extra, tokenProgram: payer.address } }),
      requirements({ extra: { ...requirements().extra, receiverAuthorizer: 1 } }),
      requirements({ extra: { ...requirements().extra, memo: 1 } }),
      requirements({ extra: { ...requirements().extra, voucherSigner: "other" } }),
      requirements({ extra: { ...requirements().extra, voucherSigner: "server" } }),
      requirements({ extra: { ...requirements().extra, operator: feePayer.address } }),
    ];
    for (const value of invalid) await expect(resolve(value)).rejects.toThrow();

    vi.mocked(fetchMint).mockResolvedValueOnce({ programAddress: payer.address } as never);
    await expect(resolve(requirements())).rejects.toThrow(/does not own/);
    await expect(
      new BatchSvmScheme(payer, { salt: "bad" }).createPaymentPayload(2, requirements()),
    ).rejects.toThrow();
    await expect(
      new BatchSvmScheme(payer, {
        depositAmount: 999n,
        discoverChannels: false,
      }).createPaymentPayload(2, requirements()),
    ).rejects.toThrow(/must cover/);
    await expect(
      new BatchSvmScheme(payer).createPaymentPayload(2, requirements({ amount: "0" })),
    ).rejects.toThrow(/must be positive/);
    await expect(
      new BatchSvmScheme(payer, { discoverChannels: false }).createPaymentPayload(
        2,
        requirements(),
      ),
    ).resolves.toMatchObject({ payload: { deposit: { amount: "5000" }, type: "deposit" } });
  });

  it("builds a refund from a cached channel and rejects a missing one", async () => {
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    const api = internals(client);
    const config: BatchChannelConfig = {
      openSlot: 123,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: RECEIVER,
      salt: "0",
      token: MINT,
      withdrawDelay: 900,
    };
    const key = api.channelKey(requirements(), feePayer.address, 900);
    api.channels.set(key, {
      deposit: 5_000n,
      tracker: new BatchChannelTracker(RECEIVER, config, payer, 1_000n),
    });
    await expect(client.createRefundPayload(2, requirements())).resolves.toMatchObject({
      x402Version: 2,
      payload: { type: "refund" },
    });
    await expect(
      new BatchSvmScheme(payer, { discoverChannels: false }).createRefundPayload(2, requirements()),
    ).rejects.toThrow(/no batch-settlement channel/);
  });
});
