import { address, generateKeyPairSigner, type Signature } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildDepositPayload,
  buildRefundPayload,
  signBatchVoucher,
} from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import {
  BatchSvmScheme,
  calculateDistributionAmount,
  MAX_CHANNELS_PER_SETTLE_TX,
} from "../../src/batch-settlement/facilitator/scheme";
import type {
  BatchChannelConfig,
  BatchClaimPayload,
  BatchSettlePayload,
} from "../../src/batch-settlement/types";
import {
  SOLANA_DEVNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import type { Channel } from "../../src/payment-channels/generated/accounts/channel";
import { ChannelStatus } from "../../src/payment-channels/onchain";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { ChannelBroadcastConfirmationError } from "../../src/payment-channels/facilitator";
import { TransactionOnchainFailureError } from "../../src/utils";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const SIGNATURE = USDC_DEVNET_ADDRESS as Signature;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let channelConfig: BatchChannelConfig;
let actualChannelId: string;
let actualDeposit: Awaited<ReturnType<typeof buildDepositPayload>>["payload"];

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  channelId = USDC_MAINNET_ADDRESS;
  channelConfig = {
    openSlot: 1,
    payer: payer.address,
    payerAuthorizer: payer.address,
    receiver: RECEIVER,
    salt: "0",
    token: MINT,
    withdrawDelay: 900,
  };
  const built = await buildDepositPayload({
    blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
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
  actualChannelId = built.channelId;
  actualDeposit = built.payload;
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

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    authorizedSigner: address(payer.address),
    bump: 1,
    closureStartedAt: 0n,
    deposit: 10_000n,
    discriminator: 1,
    distributionHash: getChannelDistributionHash([{ bps: 10_000, recipient: RECEIVER }]),
    gracePeriod: 900,
    mint: address(MINT),
    openSlot: 1n,
    payee: address(feePayer.address),
    payer: address(payer.address),
    payerWithdrawnAt: 0n,
    rentPayer: address(feePayer.address),
    salt: 0n,
    settlement: { payoutWatermark: 0n, settled: 0n },
    status: ChannelStatus.Open,
    version: 1,
    ...overrides,
  };
}

function signer(overrides: Record<string, unknown> = {}) {
  return {
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
    getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ADDRESS }),
    getAddresses: vi.fn(() => [feePayer.address]),
    getSigner: vi.fn(() => feePayer),
    sendTransaction: vi.fn().mockResolvedValue(SIGNATURE),
    signTransaction: vi.fn().mockResolvedValue("signed"),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

type FacilitatorInternals = {
  resolveTerms(
    config: BatchChannelConfig,
    requirements: PaymentRequirements,
  ): Promise<{
    feePayer: string;
    feePayerSigner: typeof feePayer;
    tokenProgram: string;
    withdrawDelay: number;
  }>;
  deriveChannelId: ReturnType<typeof vi.fn>;
  fetchChannel: ReturnType<typeof vi.fn>;
  trackChannel: ReturnType<typeof vi.fn>;
  submitRedemption: ReturnType<typeof vi.fn>;
  distributeInstruction: ReturnType<typeof vi.fn>;
  broadcastDurably(
    key: string,
    network: typeof NETWORK,
    payerAddress: string,
    broadcast: (onBroadcast: (signature: string) => Promise<void>) => Promise<string>,
  ): Promise<unknown>;
  validateDeposit: ReturnType<typeof vi.fn>;
  validateRefund: ReturnType<typeof vi.fn>;
  validateVoucherOnly: ReturnType<typeof vi.fn>;
  settleDeposit(
    payment: PaymentPayload,
    payload: unknown,
    requirements: PaymentRequirements,
  ): Promise<unknown>;
  settleRefund(
    payment: PaymentPayload,
    payload: unknown,
    requirements: PaymentRequirements,
  ): Promise<unknown>;
  settleVoucher(
    payment: PaymentPayload,
    payload: unknown,
    requirements: PaymentRequirements,
  ): Promise<unknown>;
  reconcileBroadcast(
    key: string,
    signature: string,
    network: typeof NETWORK,
    payer: string,
  ): Promise<unknown>;
  assertExpiry(expiresAt: number): void;
  assertClaimChannel: ReturnType<typeof vi.fn>;
  assertSettlementAccounts(
    requirements: PaymentRequirements,
    payer: string,
    tokenProgram: string,
  ): Promise<void>;
  readChannel: ReturnType<typeof vi.fn>;
  settlementCache: {
    delete: ReturnType<typeof vi.fn>;
    isDuplicate: ReturnType<typeof vi.fn>;
  };
};

function internals(scheme: BatchSvmScheme): FacilitatorInternals {
  return scheme as unknown as FacilitatorInternals;
}

describe("batch facilitator lifecycle", () => {
  it("requires a usable managed signer", () => {
    expect(() => new BatchSvmScheme({ getAddresses: () => [feePayer.address] } as never)).toThrow(
      /requires getSigner/,
    );
    expect(
      () => new BatchSvmScheme({ getAddresses: () => [], getSigner: vi.fn() } as never),
    ).toThrow(/at least one fee payer/);
  });

  it.each([
    ["payer", 0],
    ["recipient", 1],
    ["payment-channel treasury", 2],
  ])("identifies a missing %s settlement ATA", async (label, missingIndex) => {
    let readIndex = 0;
    const getAccountInfo = vi.fn().mockImplementation(async () => {
      const exists = readIndex !== missingIndex;
      readIndex += 1;
      return exists ? { owner: TOKEN_PROGRAM_ADDRESS } : null;
    });
    const api = internals(new BatchSvmScheme(signer({ getAccountInfo }) as never));

    await expect(
      api.assertSettlementAccounts(requirements(), payer.address, TOKEN_PROGRAM_ADDRESS),
    ).rejects.toThrow(`missing ${label} ATA`);
    expect(getAccountInfo).toHaveBeenCalledTimes(missingIndex + 1);
  });

  it("identifies a settlement ATA owned by the wrong token program", async () => {
    const api = internals(
      new BatchSvmScheme(
        signer({
          getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_2022_PROGRAM_ADDRESS }),
        }) as never,
      ),
    );

    await expect(
      api.assertSettlementAccounts(requirements(), payer.address, TOKEN_PROGRAM_ADDRESS),
    ).rejects.toThrow(`payer ATA is not owned by ${TOKEN_PROGRAM_ADDRESS}`);
  });

  it("requires account reads for settlement-path preflight", async () => {
    const api = internals(new BatchSvmScheme(signer({ getAccountInfo: undefined }) as never));

    await expect(
      api.assertSettlementAccounts(requirements(), payer.address, TOKEN_PROGRAM_ADDRESS),
    ).rejects.toThrow("requires getAccountInfo");
  });

  it("rejects a deposit during verify when its settlement path is unavailable", async () => {
    const getAccountInfo = vi
      .fn()
      .mockResolvedValueOnce({ owner: TOKEN_PROGRAM_ADDRESS })
      .mockResolvedValueOnce(null);
    const scheme = new BatchSvmScheme(signer({ getAccountInfo }) as never);
    const paymentRequirements = requirements();

    await expect(
      scheme.verify(
        {
          accepted: paymentRequirements,
          payload: actualDeposit,
          x402Version: 2,
        },
        paymentRequirements,
      ),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: BatchError.SETTLEMENT_SIMULATION,
    });
  });

  it("resolves valid channel terms and rejects malformed requirements", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    await expect(
      internals(scheme).resolveTerms(channelConfig, requirements()),
    ).resolves.toMatchObject({
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });

    await expect(
      internals(scheme).resolveTerms(channelConfig, requirements({ extra: undefined })),
    ).rejects.toThrow(BatchError.PAYMENT_FLOW);
    await expect(
      internals(scheme).resolveTerms(channelConfig, {
        ...requirements(),
        extra: { ...requirements().extra, feePayer: undefined },
      }),
    ).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);
    await expect(
      internals(scheme).resolveTerms(channelConfig, {
        ...requirements(),
        extra: { ...requirements().extra, withdrawDelay: 10 },
      }),
    ).rejects.toThrow(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE);
    await expect(
      internals(scheme).resolveTerms({ ...channelConfig, receiver: payer.address }, requirements()),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      internals(scheme).resolveTerms(channelConfig, {
        ...requirements(),
        extra: { ...requirements().extra, tokenProgram: payer.address },
      }),
    ).rejects.toThrow(BatchError.TOKEN_PROGRAM);
  });

  it("covers every facilitator term and channel-binding boundary", async () => {
    const resolve = (scheme: BatchSvmScheme, config = channelConfig, req = requirements()) =>
      internals(scheme).resolveTerms(config, req);
    const validSigner = signer();
    const valid = new BatchSvmScheme(validSigner as never);
    const token2022 = new BatchSvmScheme(
      signer({
        getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_2022_PROGRAM_ADDRESS }),
      }) as never,
    );
    const receiverAuthorizer = payer.address;
    await expect(
      resolve(
        token2022,
        { ...channelConfig, receiverAuthorizer },
        {
          ...requirements(),
          extra: {
            ...requirements().extra,
            memo: "invoice",
            receiverAuthorizer,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          },
        },
      ),
    ).resolves.toMatchObject({ memo: "invoice", receiverAuthorizer });

    const cases: Array<[BatchChannelConfig, PaymentRequirements]> = [
      [
        channelConfig,
        { ...requirements(), extra: { ...requirements().extra, paymentFlow: "upfront" } },
      ],
      [{ ...channelConfig, payer: feePayer.address }, requirements()],
      [{ ...channelConfig, payerAuthorizer: feePayer.address }, requirements()],
      [
        channelConfig,
        { ...requirements(), extra: { ...requirements().extra, withdrawDelay: 900.5 } },
      ],
      [
        channelConfig,
        { ...requirements(), extra: { ...requirements().extra, withdrawDelay: 2_592_001 } },
      ],
      [channelConfig, { ...requirements(), maxTimeoutSeconds: 901 }],
      [{ ...channelConfig, withdrawDelay: 901 }, requirements()],
      [{ ...channelConfig, receiverAuthorizer }, requirements()],
      [
        channelConfig,
        { ...requirements(), extra: { ...requirements().extra, receiverAuthorizer } },
      ],
      [
        { ...channelConfig, receiverAuthorizer },
        {
          ...requirements(),
          extra: { ...requirements().extra, receiverAuthorizer: feePayer.address },
        },
      ],
      [channelConfig, { ...requirements(), extra: { ...requirements().extra, memo: 3 } }],
    ];
    for (const [config, req] of cases) await expect(resolve(valid, config, req)).rejects.toThrow();

    const noAccountRead = new BatchSvmScheme(signer({ getAccountInfo: undefined }) as never);
    await expect(resolve(noAccountRead)).rejects.toThrow(/requires getAccountInfo/);
    const missingMint = new BatchSvmScheme(
      signer({ getAccountInfo: vi.fn().mockResolvedValue(undefined) }) as never,
    );
    await expect(resolve(missingMint)).rejects.toThrow(BatchError.TOKEN_PROGRAM);

    const terms = {
      feePayer: feePayer.address,
      feePayerSigner: feePayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    };
    const assert = (value: Channel, config = channelConfig, allowed = [ChannelStatus.Open]) =>
      internals(new BatchSvmScheme(signer() as never)).assertClaimChannel(
        value,
        config,
        terms,
        requirements(),
        allowed,
      );
    const mutations: Channel[] = [
      channel({ discriminator: 0 }),
      channel({ status: ChannelStatus.Closing }),
      channel({ payer: address(feePayer.address) }),
      channel({ payee: address(payer.address) }),
      channel({ rentPayer: address(payer.address) }),
      channel({ authorizedSigner: address(feePayer.address) }),
      channel({ mint: address(RECEIVER) }),
      channel({ gracePeriod: 901 }),
      channel({ salt: 1n }),
      channel({ openSlot: 2n }),
      channel({ distributionHash: new Uint8Array() }),
      channel({ distributionHash: new Uint8Array(32).fill(1) }),
    ];
    for (const value of mutations) expect(() => assert(value)).toThrow(BatchError.CHANNEL_STATE);
    expect(() => assert(channel())).not.toThrow();
  });

  it("verifies scheme and network envelopes before channel reads", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const voucher = await signBatchVoucher(payer, {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: 1_000n,
    });
    const payment = {
      accepted: requirements(),
      payload: { channelConfig, type: "voucher", voucher },
      x402Version: 2,
    } as PaymentPayload;
    await expect(
      scheme.verify(payment, { ...requirements(), scheme: "exact" }),
    ).resolves.toMatchObject({ isValid: false, invalidReason: "unsupported_scheme" });
    await expect(
      scheme.verify(payment, { ...requirements(), network: "solana:other" }),
    ).resolves.toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("routes verify variants and classifies validation failures", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const api = internals(scheme);
    const voucher = await signBatchVoucher(payer, {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: 1_000n,
    });
    const deposit = {
      channelConfig,
      deposit: { amount: "10000", transaction: "setup" },
      type: "deposit" as const,
      voucher,
    };
    api.validateDeposit = vi.fn().mockResolvedValue({ channelId });
    await expect(
      scheme.verify({ accepted: requirements(), payload: deposit, x402Version: 2 }, requirements()),
    ).resolves.toMatchObject({ isValid: true, extra: { channelId } });

    api.resolveTerms = vi.fn().mockResolvedValue({ feePayer: feePayer.address });
    api.deriveChannelId = vi.fn().mockResolvedValue(channelId);
    api.validateVoucherOnly = vi.fn().mockResolvedValue(channel());
    await expect(
      scheme.verify(
        {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher", voucher },
          x402Version: 2,
        },
        requirements(),
      ),
    ).resolves.toMatchObject({ isValid: true, extra: { channelState: { channelId } } });

    api.deriveChannelId = vi.fn().mockResolvedValue(payer.address);
    await expect(
      scheme.verify(
        {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher", voucher },
          x402Version: 2,
        },
        requirements(),
      ),
    ).resolves.toMatchObject({ isValid: false, invalidReason: BatchError.CHANNEL_ID_MISMATCH });

    api.validateDeposit = vi.fn().mockRejectedValue(new Error(BatchError.VOUCHER_SIGNATURE));
    await expect(
      scheme.verify({ accepted: requirements(), payload: deposit, x402Version: 2 }, requirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: BatchError.VOUCHER_SIGNATURE,
      invalidMessage: BatchError.VOUCHER_SIGNATURE,
    });
    api.validateDeposit = vi.fn().mockRejectedValue("plain validation failure");
    await expect(
      scheme.verify({ accepted: requirements(), payload: deposit, x402Version: 2 }, requirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "transaction_failed",
      invalidMessage: "plain validation failure",
    });
    await expect(
      scheme.verify(
        { accepted: requirements(), payload: { nope: true }, x402Version: 2 } as never,
        requirements(),
      ),
    ).resolves.toMatchObject({ isValid: false, invalidReason: BatchError.PAYLOAD_TYPE });
  });

  it("validates real open, voucher, and refund transactions", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const api = internals(scheme);
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    await expect(
      scheme.verify(
        { accepted: requirements(), payload: actualDeposit, x402Version: 2 },
        requirements(),
      ),
    ).resolves.toMatchObject({ isValid: true, extra: { channelId: actualChannelId } });

    const voucherPayment = {
      channelConfig: actualDeposit.channelConfig,
      type: "voucher" as const,
      voucher: actualDeposit.voucher,
    };
    api.assertClaimChannel = vi.fn();
    api.fetchChannel = vi.fn().mockResolvedValue(
      channel({
        authorizedSigner: address(payer.address),
        openSlot: 123n,
      }),
    );
    const verifiedVoucher = await scheme.verify(
      { accepted: requirements(), payload: voucherPayment, x402Version: 2 },
      requirements(),
    );
    expect(verifiedVoucher).toMatchObject({ isValid: true });
    api.fetchChannel = vi
      .fn()
      .mockResolvedValue(
        channel({ authorizedSigner: address(payer.address), deposit: 999n, openSlot: 123n }),
      );
    await expect(
      scheme.verify(
        { accepted: requirements(), payload: voucherPayment, x402Version: 2 },
        requirements(),
      ),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: BatchError.CUMULATIVE_EXCEEDS_DEPOSIT,
    });

    const refund = await buildRefundPayload({
      blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
      channelConfig: actualDeposit.channelConfig,
      channelId: actualChannelId,
      feePayer: feePayer.address,
      payer,
    });
    api.fetchChannel = vi
      .fn()
      .mockResolvedValue(channel({ authorizedSigner: address(payer.address), openSlot: 123n }));
    await expect(
      scheme.verify({ accepted: requirements(), payload: refund, x402Version: 2 }, requirements()),
    ).resolves.toMatchObject({ isValid: true });
  });

  it("routes facilitator settlement variants and converts thrown errors", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const api = internals(scheme) as FacilitatorInternals &
      Record<string, ReturnType<typeof vi.fn>>;
    const cases = [
      ["deposit", "settleDeposit"],
      ["voucher", "settleVoucher"],
      ["refund", "settleRefund"],
      ["claim", "settleClaims"],
      ["settle", "settleDistributions"],
    ] as const;
    for (const [type, method] of cases) {
      api[method] = vi.fn().mockResolvedValue({ success: true, transaction: type });
      const payload =
        type === "claim"
          ? {
              claims: [
                {
                  signature: "x",
                  voucher: {
                    channelConfig,
                    channelId,
                    expiresAt: 0,
                    maxClaimableAmount: "1",
                  },
                },
              ],
              type,
            }
          : type === "settle"
            ? { channels: [{ channelConfig, channelId }], type }
            : type === "refund"
              ? { channelConfig, transaction: "x", type }
              : type === "deposit"
                ? {
                    channelConfig,
                    deposit: { amount: "1", transaction: "x" },
                    type,
                    voucher: { channelId, expiresAt: 0, maxClaimableAmount: "1", signature: "x" },
                  }
                : {
                    channelConfig,
                    type,
                    voucher: { channelId, expiresAt: 0, maxClaimableAmount: "1", signature: "x" },
                  };
      await expect(
        scheme.settle(
          { accepted: requirements(), payload, x402Version: 2 } as never,
          requirements(),
        ),
      ).resolves.toMatchObject({ success: true, transaction: type });
    }

    api.settleVoucher = vi.fn().mockRejectedValue("rpc down");
    await expect(
      scheme.settle(
        {
          accepted: requirements(),
          payload: {
            channelConfig,
            type: "voucher",
            voucher: { channelId, expiresAt: 0, maxClaimableAmount: "1", signature: "x" },
          },
          x402Version: 2,
        } as never,
        requirements(),
      ),
    ).resolves.toMatchObject({ success: false, errorReason: "transaction_failed" });
    api.settleVoucher = vi.fn().mockRejectedValue(new Error(BatchError.VOUCHER_SIGNATURE));
    await expect(
      scheme.settle(
        {
          accepted: requirements(),
          payload: {
            channelConfig,
            type: "voucher",
            voucher: { channelId, expiresAt: 0, maxClaimableAmount: "1", signature: "x" },
          },
          x402Version: 2,
        } as never,
        requirements(),
      ),
    ).resolves.toMatchObject({
      success: false,
      errorReason: BatchError.VOUCHER_SIGNATURE,
      errorMessage: BatchError.VOUCHER_SIGNATURE,
    });
    api.settleVoucher = vi.fn().mockRejectedValue(new Error("duplicate_settlement: channel busy"));
    await expect(
      scheme.settle(
        {
          accepted: requirements(),
          payload: {
            channelConfig,
            type: "voucher",
            voucher: { channelId, expiresAt: 0, maxClaimableAmount: "1", signature: "x" },
          },
          x402Version: 2,
        } as never,
        requirements(),
      ),
    ).resolves.toMatchObject({ success: false, errorReason: "duplicate_settlement" });
    await expect(
      scheme.settle(
        { accepted: requirements(), payload: { type: "bad" }, x402Version: 2 } as never,
        requirements(),
      ),
    ).resolves.toMatchObject({ success: false, errorReason: BatchError.PAYLOAD_TYPE });
  });

  it("settles top-ups, idempotent opens, vouchers, and refunds", async () => {
    const facilitatorSigner = signer();
    const scheme = new BatchSvmScheme(facilitatorSigner as never);
    const api = internals(scheme);
    const voucher = await signBatchVoucher(payer, {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: 1_000n,
    });
    const deposit = {
      channelConfig,
      deposit: { amount: "1000", transaction: "setup" },
      type: "deposit" as const,
      voucher,
    };
    const terms = {
      feePayer: feePayer.address,
      feePayerSigner: feePayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    };
    api.validateDeposit = vi.fn().mockResolvedValue({
      channelId,
      deposit: 1_000n,
      expectedDeposit: 11_000n,
      isTopUp: true,
      payload: deposit,
      terms,
    });
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    api.trackChannel = vi.fn().mockResolvedValue(undefined);
    api.broadcastDurably = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
    api.fetchChannel = vi.fn().mockResolvedValue(channel({ deposit: 11_000n }));
    api.assertClaimChannel = vi.fn();
    await expect(
      api.settleDeposit(
        { accepted: requirements(), payload: deposit, x402Version: 2 },
        deposit,
        requirements(),
      ),
    ).resolves.toMatchObject({ success: true, amount: "11000", transaction: SIGNATURE });
    expect(facilitatorSigner.simulateTransaction).toHaveBeenCalledWith("setup", NETWORK);

    api.validateDeposit = vi.fn().mockResolvedValue({
      channelId,
      deposit: 1_000n,
      expectedDeposit: 10_000n,
      isTopUp: false,
      payload: deposit,
      terms,
    });
    api.readChannel = vi.fn().mockResolvedValue(channel());
    api.fetchChannel = vi.fn().mockResolvedValue(channel());
    await expect(
      api.settleDeposit(
        { accepted: requirements(), payload: deposit, x402Version: 2 },
        deposit,
        requirements(),
      ),
    ).resolves.toMatchObject({ success: true, transaction: "" });

    await expect(
      api.settleVoucher(
        {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher", voucher },
          x402Version: 2,
        },
        { channelConfig, type: "voucher", voucher },
        requirements(),
      ),
    ).resolves.toMatchObject({ success: false, errorReason: BatchError.PAYLOAD_TYPE });

    const refund = { channelConfig, transaction: "close", type: "refund" as const };
    api.validateRefund = vi.fn().mockResolvedValue({
      channel: channel({ closureStartedAt: 20n, status: ChannelStatus.Closing }),
      channelId,
      terms,
    });
    await expect(
      api.settleRefund(
        { accepted: requirements(), payload: refund, x402Version: 2 } as never,
        refund,
        requirements(),
      ),
    ).resolves.toMatchObject({
      success: true,
      transaction: "",
      extra: { channelState: { withdrawRequestedAt: 20 } },
    });

    api.validateRefund = vi.fn().mockResolvedValue({ channel: channel(), channelId, terms });
    api.broadcastDurably = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
    api.fetchChannel = vi
      .fn()
      .mockResolvedValue(channel({ closureStartedAt: 20n, status: ChannelStatus.Closing }));
    await expect(
      api.settleRefund(
        { accepted: requirements(), payload: refund, x402Version: 2 } as never,
        refund,
        requirements(),
      ),
    ).resolves.toMatchObject({ success: true, transaction: SIGNATURE });
  });

  it("serializes opens by channel and releases the lock before broadcast failures", async () => {
    const facilitatorSigner = signer();
    const scheme = new BatchSvmScheme(facilitatorSigner as never);
    const api = internals(scheme);
    const terms = {
      feePayer: feePayer.address,
      feePayerSigner: feePayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    };
    const deposit = {
      channelConfig,
      deposit: { amount: "1000", transaction: "open-a" },
      type: "deposit" as const,
      voucher: await signBatchVoucher(payer, {
        channelId,
        expiresAt: 0,
        maxClaimableAmount: 1_000n,
      }),
    };
    api.validateDeposit = vi.fn().mockResolvedValue({
      channelId,
      deposit: 1_000n,
      expectedDeposit: 1_000n,
      isTopUp: false,
      payload: deposit,
      terms,
    });
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    const isDuplicate = vi.fn().mockReturnValue(true);
    api.settlementCache = { delete: vi.fn(), isDuplicate };

    for (const transaction of ["open-a", "open-b"]) {
      await expect(
        api.settleDeposit(
          { accepted: requirements(), payload: deposit, x402Version: 2 },
          { ...deposit, deposit: { amount: "1000", transaction } },
          requirements(),
        ),
      ).resolves.toMatchObject({ errorReason: "duplicate_settlement", success: false });
    }
    expect(isDuplicate.mock.calls.map(([key]) => key)).toEqual([
      `batch:deposit:${NETWORK}:${channelId}`,
      `batch:deposit:${NETWORK}:${channelId}`,
    ]);

    const simulation = new BatchSvmScheme(
      signer({
        simulateTransaction: vi.fn().mockRejectedValue(new Error("bad simulation")),
      }) as never,
    );
    const simulationApi = internals(simulation);
    simulationApi.validateDeposit = vi.fn().mockResolvedValue({
      channelId,
      deposit: 1_000n,
      expectedDeposit: 11_000n,
      isTopUp: true,
      payload: deposit,
      terms,
    });
    simulationApi.readChannel = vi.fn().mockResolvedValue(undefined);
    const simulationDelete = vi.fn();
    simulationApi.settlementCache = {
      delete: simulationDelete,
      isDuplicate: vi.fn().mockReturnValue(false),
    };
    await expect(
      simulationApi.settleDeposit(
        { accepted: requirements(), payload: deposit, x402Version: 2 },
        deposit,
        requirements(),
      ),
    ).rejects.toThrow(BatchError.SETTLEMENT_SIMULATION);
    expect(simulationDelete).toHaveBeenCalledWith(`batch:topup:${NETWORK}:open-a`);

    const classifiedSimulation = new BatchSvmScheme(
      signer({
        simulateTransaction: vi
          .fn()
          .mockRejectedValue(
            new Error(`${BatchError.SETTLEMENT_SIMULATION}: missing treasury ATA`),
          ),
      }) as never,
    );
    const classifiedApi = internals(classifiedSimulation);
    classifiedApi.validateDeposit = simulationApi.validateDeposit;
    classifiedApi.readChannel = vi.fn().mockResolvedValue(undefined);
    classifiedApi.settlementCache = {
      delete: vi.fn(),
      isDuplicate: vi.fn().mockReturnValue(false),
    };
    await expect(
      classifiedApi.settleDeposit(
        { accepted: requirements(), payload: deposit, x402Version: 2 },
        deposit,
        requirements(),
      ),
    ).rejects.toThrow(`${BatchError.SETTLEMENT_SIMULATION}: missing treasury ATA`);

    const indexing = new BatchSvmScheme(signer() as never);
    const indexingApi = internals(indexing);
    indexingApi.validateDeposit = simulationApi.validateDeposit;
    indexingApi.readChannel = vi.fn().mockResolvedValue(undefined);
    indexingApi.trackChannel = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const indexingDelete = vi.fn();
    indexingApi.settlementCache = {
      delete: indexingDelete,
      isDuplicate: vi.fn().mockReturnValue(false),
    };
    await expect(
      indexingApi.settleDeposit(
        { accepted: requirements(), payload: deposit, x402Version: 2 },
        deposit,
        requirements(),
      ),
    ).rejects.toThrow("storage unavailable");
    expect(indexingDelete).toHaveBeenCalledWith(`batch:topup:${NETWORK}:open-a`);
  });

  it("prepares and confirms a voucher claim batch", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const privateApi = internals(scheme);
    privateApi.resolveTerms = vi.fn().mockResolvedValue({
      feePayer: feePayer.address,
      feePayerSigner: feePayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    privateApi.deriveChannelId = vi.fn().mockResolvedValue(channelId);
    privateApi.fetchChannel = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 0n, settled: 1_000n } }));
    privateApi.trackChannel = vi.fn().mockResolvedValue(undefined);
    privateApi.submitRedemption = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });

    const signed = await signBatchVoucher(payer, {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: 1_000n,
    });
    const payload: BatchClaimPayload = {
      type: "claim",
      claims: [
        {
          signature: signed.signature,
          voucher: {
            channelConfig,
            channelId,
            expiresAt: 0,
            maxClaimableAmount: "1000",
          },
        },
      ],
    };
    await expect(
      scheme.settleClaims(
        { accepted: requirements(), payload, x402Version: 2 } as never,
        payload,
        requirements(),
      ),
    ).resolves.toMatchObject({
      success: true,
      transaction: SIGNATURE,
      extra: { accepts: [{ channelId, totalClaimed: "1000" }] },
    });
    expect(privateApi.trackChannel).toHaveBeenCalledOnce();
    expect(privateApi.submitRedemption).toHaveBeenCalledOnce();
  });

  it("rejects invalid claim batches at each lifecycle boundary", async () => {
    const signed = await signBatchVoucher(payer, {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: 1_000n,
    });
    const claim = (overrides: Record<string, unknown> = {}): BatchClaimPayload => ({
      type: "claim",
      claims: [
        {
          signature: signed.signature,
          voucher: {
            channelConfig,
            channelId,
            expiresAt: 0,
            maxClaimableAmount: "1000",
            ...overrides,
          },
        },
      ],
    });
    const configured = () => {
      const scheme = new BatchSvmScheme(signer() as never);
      const api = internals(scheme);
      api.resolveTerms = vi.fn().mockResolvedValue({
        feePayer: feePayer.address,
        feePayerSigner: feePayer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      });
      api.deriveChannelId = vi.fn().mockResolvedValue(channelId);
      api.fetchChannel = vi.fn().mockResolvedValue(channel());
      api.trackChannel = vi.fn().mockResolvedValue(undefined);
      api.submitRedemption = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
      return { api, scheme };
    };
    const settle = (scheme: BatchSvmScheme, payload: BatchClaimPayload) =>
      scheme.settleClaims(
        { accepted: requirements(), payload, x402Version: 2 } as never,
        payload,
        requirements(),
      );

    const mismatch = configured();
    mismatch.api.deriveChannelId = vi.fn().mockResolvedValue(payer.address);
    await expect(settle(mismatch.scheme, claim())).rejects.toThrow(BatchError.CHANNEL_ID_MISMATCH);

    for (const value of ["0", "10001"]) {
      const bounds = configured();
      await expect(settle(bounds.scheme, claim({ maxClaimableAmount: value }))).rejects.toThrow(
        BatchError.CUMULATIVE_AMOUNT_MISMATCH,
      );
    }
    const signature = configured();
    await expect(settle(signature.scheme, claim({ maxClaimableAmount: "1001" }))).rejects.toThrow(
      BatchError.VOUCHER_SIGNATURE,
    );

    const rejected = configured();
    rejected.api.submitRedemption = vi.fn().mockResolvedValue({
      ok: false,
      response: { errorReason: "settlement_pending", success: false },
    });
    await expect(settle(rejected.scheme, claim())).resolves.toMatchObject({
      errorReason: "settlement_pending",
      success: false,
    });

    const unconfirmed = configured();
    unconfirmed.api.fetchChannel = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 0n, settled: 999n } }));
    await expect(settle(unconfirmed.scheme, claim())).rejects.toThrow(BatchError.CHANNEL_STATE);

    const split = configured();
    split.api.assertClaimChannel = vi.fn();
    split.api.resolveTerms = vi
      .fn()
      .mockResolvedValueOnce({
        feePayer: feePayer.address,
        feePayerSigner: feePayer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      })
      .mockResolvedValueOnce({
        feePayer: payer.address,
        feePayerSigner: payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      });
    const two = claim();
    two.claims.push({ ...two.claims[0] });
    await expect(settle(split.scheme, two)).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);
  });

  it("prepares and confirms a distribution batch", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const privateApi = internals(scheme);
    privateApi.resolveTerms = vi.fn().mockResolvedValue({
      feePayer: feePayer.address,
      feePayerSigner: feePayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    privateApi.deriveChannelId = vi.fn().mockResolvedValue(channelId);
    privateApi.fetchChannel = vi
      .fn()
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 200n, settled: 1_000n } }))
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 1_000n, settled: 1_000n } }));
    privateApi.distributeInstruction = vi.fn().mockResolvedValue({
      accounts: [],
      data: new Uint8Array([7]),
      programAddress: address(USDC_MAINNET_ADDRESS),
    });
    privateApi.submitRedemption = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
    const payload: BatchSettlePayload = {
      type: "settle",
      channels: [{ channelConfig, channelId }],
    };
    await expect(
      scheme.settleDistributions(
        { accepted: requirements(), payload, x402Version: 2 } as never,
        payload,
        requirements(),
      ),
    ).resolves.toMatchObject({ amount: "800", success: true, transaction: SIGNATURE });
  });

  it("rejects invalid distribution batches at each lifecycle boundary", async () => {
    const payload: BatchSettlePayload = {
      type: "settle",
      channels: [{ channelConfig, channelId }],
    };
    const configured = () => {
      const scheme = new BatchSvmScheme(signer() as never);
      const api = internals(scheme);
      api.resolveTerms = vi.fn().mockResolvedValue({
        feePayer: feePayer.address,
        feePayerSigner: feePayer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      });
      api.deriveChannelId = vi.fn().mockResolvedValue(channelId);
      api.fetchChannel = vi
        .fn()
        .mockResolvedValue(channel({ settlement: { payoutWatermark: 0n, settled: 1_000n } }));
      api.distributeInstruction = vi.fn().mockResolvedValue({
        accounts: [],
        data: new Uint8Array([7]),
        programAddress: address(RECEIVER),
      });
      api.submitRedemption = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
      return { api, scheme };
    };
    const settle = (scheme: BatchSvmScheme, value = payload) =>
      scheme.settleDistributions(
        { accepted: requirements(), payload: value, x402Version: 2 } as never,
        value,
        requirements(),
      );
    const mismatch = configured();
    mismatch.api.deriveChannelId = vi.fn().mockResolvedValue(payer.address);
    await expect(settle(mismatch.scheme)).rejects.toThrow(BatchError.CHANNEL_ID_MISMATCH);

    const rejected = configured();
    rejected.api.submitRedemption = vi.fn().mockResolvedValue({
      ok: false,
      response: { errorReason: "settlement_pending", success: false },
    });
    await expect(settle(rejected.scheme)).resolves.toMatchObject({ success: false });

    const unconfirmed = configured();
    unconfirmed.api.fetchChannel = vi
      .fn()
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 0n, settled: 1_000n } }))
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 999n, settled: 1_000n } }));
    await expect(settle(unconfirmed.scheme)).rejects.toThrow(/watermark did not advance/);

    const split = configured();
    split.api.assertClaimChannel = vi.fn();
    split.api.resolveTerms = vi
      .fn()
      .mockResolvedValueOnce({
        feePayer: feePayer.address,
        feePayerSigner: feePayer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      })
      .mockResolvedValueOnce({
        feePayer: payer.address,
        feePayerSigner: payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      });
    await expect(
      settle(split.scheme, { ...payload, channels: [...payload.channels, ...payload.channels] }),
    ).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);
  });

  it("rejects empty and oversized redemption batches", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const emptyClaims: BatchClaimPayload = { claims: [], type: "claim" };
    await expect(
      scheme.settleClaims(
        { accepted: requirements(), payload: emptyClaims, x402Version: 2 } as never,
        emptyClaims,
        requirements(),
      ),
    ).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);

    const oversized: BatchSettlePayload = {
      type: "settle",
      channels: Array.from({ length: MAX_CHANNELS_PER_SETTLE_TX + 1 }, () => ({
        channelConfig,
        channelId,
      })),
    };
    await expect(
      scheme.settleDistributions(
        { accepted: requirements(), payload: oversized, x402Version: 2 } as never,
        oversized,
        requirements(),
      ),
    ).rejects.toThrow(/too many channels/);
  });

  it("persists, reconciles, and forgets durable broadcast signatures", async () => {
    const facilitatorSigner = signer();
    const scheme = new BatchSvmScheme(facilitatorSigner as never);
    const privateApi = internals(scheme);
    const first = await privateApi.broadcastDurably(
      "key",
      NETWORK,
      payer.address,
      async onBroadcast => {
        await onBroadcast(SIGNATURE);
        return SIGNATURE;
      },
    );
    expect(first).toEqual({ ok: true, signature: SIGNATURE });

    const pendingStore = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(SIGNATURE),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const recovering = new BatchSvmScheme(facilitatorSigner as never, {
      pendingSettlementStore: pendingStore,
    });
    await expect(
      internals(recovering).broadcastDurably("key", NETWORK, payer.address, vi.fn()),
    ).resolves.toEqual({ ok: true, signature: SIGNATURE });
    expect(facilitatorSigner.confirmTransaction).toHaveBeenCalledWith(SIGNATURE, NETWORK);
    expect(pendingStore.delete).toHaveBeenCalledWith("key");
  });

  it("distinguishes pre-broadcast, pending, and onchain-terminal failures", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const api = internals(scheme);
    await expect(
      api.broadcastDurably("ordinary", NETWORK, payer.address, async () => {
        throw new Error("send failed");
      }),
    ).rejects.toThrow("send failed");
    await expect(
      api.broadcastDurably("pending", NETWORK, payer.address, async () => {
        throw new ChannelBroadcastConfirmationError(SIGNATURE, new Error("timeout"));
      }),
    ).resolves.toMatchObject({
      ok: false,
      response: { errorReason: "settlement_pending", transaction: SIGNATURE },
    });

    const terminalStore = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(SIGNATURE),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const terminal = new BatchSvmScheme(
      signer({
        confirmTransaction: vi.fn().mockRejectedValue(new TransactionOnchainFailureError("failed")),
      }) as never,
      { pendingSettlementStore: terminalStore },
    );
    await expect(
      internals(terminal).broadcastDurably("terminal", NETWORK, payer.address, vi.fn()),
    ).resolves.toMatchObject({
      ok: false,
      response: { errorReason: "transaction_failed", transaction: SIGNATURE },
    });
    expect(terminalStore.delete).toHaveBeenCalled();

    const retryStore = {
      delete: vi.fn().mockRejectedValue(new Error("delete failed")),
      get: vi.fn().mockResolvedValue(SIGNATURE),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const retry = new BatchSvmScheme(
      signer({ confirmTransaction: vi.fn().mockRejectedValue(new Error("timeout")) }) as never,
      { pendingSettlementStore: retryStore },
    );
    await expect(
      internals(retry).broadcastDurably("retry", NETWORK, payer.address, vi.fn()),
    ).resolves.toMatchObject({ ok: false, response: { errorReason: "settlement_pending" } });
  });

  it("rejects invalid expiry, fee payer, deposit, and distribution arithmetic", () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const api = internals(scheme) as FacilitatorInternals & {
      resolveFeePayer(value: string): unknown;
      assertDepositChannel(value: Channel, validated: unknown, req: PaymentRequirements): void;
    };
    expect(() => api.assertExpiry(1)).toThrow(BatchError.VOUCHER_EXPIRY);
    expect(() => api.resolveFeePayer(payer.address)).toThrow(BatchError.FEE_PAYER_MISMATCH);
    expect(() =>
      api.assertDepositChannel(
        channel({ deposit: 1n }),
        {
          expectedDeposit: 2n,
          payload: { channelConfig },
          terms: {
            feePayer: feePayer.address,
            feePayerSigner: feePayer,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
            withdrawDelay: 900,
          },
        },
        requirements(),
      ),
    ).toThrow(/confirmed deposit mismatch/);
    expect(() => calculateDistributionAmount([{ payoutWatermark: 2n, settled: 1n }])).toThrow(
      /payout watermark exceeds/,
    );
  });
});
