import { address, generateKeyPairSigner, type Signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import type { Channel } from "../../src/payment-channels/generated/accounts/channel";
import type { ChannelSplit } from "../../src/payment-channels/open";

const channelAccountMocks = vi.hoisted(() => ({
  fetchMaybeChannel: vi.fn(),
}));

vi.mock("../../src/payment-channels/generated/accounts/channel", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../src/payment-channels/generated/accounts/channel")>();
  return {
    ...actual,
    fetchMaybeChannel: channelAccountMocks.fetchMaybeChannel,
  };
});

import {
  broadcastOpen,
  channelExists,
  ChannelBroadcastConfirmationError,
  ChannelSimulationError,
  confirmSignature,
  DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT,
  fetchAndVerifyOpenChannel,
  getChannelDistributionHash,
  reclaimComputeUnitLimit,
  resolveChannelReadPolicy,
  SettlementConfirmationTimeoutError,
  submitChannelTransactionWithSigner,
  submitSettle,
  verifyOpenChannelAccount,
  type ChannelRpc,
  type ExpectedOpenChannel,
} from "../../src/payment-channels/facilitator";
import { MEMO_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";

const CHANNEL_ID = USDC_MAINNET_ADDRESS;
const rpc = {} as ChannelRpc;
const PAYEE = USDC_DEVNET_ADDRESS;
const PAYER = USDC_MAINNET_ADDRESS;
const AUTHORIZED_SIGNER = USDC_DEVNET_ADDRESS;
const MINT = USDC_MAINNET_ADDRESS;
const SPLITS: readonly ChannelSplit[] = [{ recipient: PAYEE, bps: 10_000 }];

const expected: ExpectedOpenChannel = {
  authorizedSigner: AUTHORIZED_SIGNER,
  deposit: 1_000_000n,
  gracePeriod: 900,
  mint: MINT,
  payee: PAYEE,
  payer: PAYER,
  rentPayer: PAYEE,
  splits: SPLITS,
};

const channel: Channel = {
  discriminator: 1,
  version: 1,
  bump: 1,
  status: 0,
  salt: 1n,
  deposit: expected.deposit,
  settlement: { settled: 0n, payoutWatermark: 0n },
  closureStartedAt: 0n,
  payerWithdrawnAt: 0n,
  gracePeriod: expected.gracePeriod,
  distributionHash: getChannelDistributionHash(SPLITS),
  payer: address(PAYER),
  payee: address(PAYEE),
  authorizedSigner: address(AUTHORIZED_SIGNER),
  mint: address(MINT),
  rentPayer: address(PAYEE),
  openSlot: 1n,
};

const missingAccount = { exists: false, address: address(CHANNEL_ID) };
const existingAccount = {
  exists: true,
  address: address(CHANNEL_ID),
  data: channel,
  executable: false,
  lamports: 2_000_000n,
  programAddress: address(PAYEE),
  space: 0n,
};

describe("upto SVM channel reads", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries a missing confirmed channel until it becomes visible", async () => {
    vi.useFakeTimers();
    channelAccountMocks.fetchMaybeChannel
      .mockResolvedValueOnce(missingAccount)
      .mockResolvedValueOnce(existingAccount);

    const result = fetchAndVerifyOpenChannel(rpc, CHANNEL_ID, expected);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toMatchObject({ channelId: CHANNEL_ID });
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(2);
  });

  it("stops after six missing reads", async () => {
    vi.useFakeTimers();
    channelAccountMocks.fetchMaybeChannel.mockResolvedValue(missingAccount);

    const result = fetchAndVerifyOpenChannel(rpc, CHANNEL_ID, expected);
    const assertion = expect(result).rejects.toThrow(`channel ${CHANNEL_ID} does not exist`);
    await vi.advanceTimersByTimeAsync(3_000);

    await assertion;
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(6);
  });

  it("does not retry an existing channel with invalid state", async () => {
    channelAccountMocks.fetchMaybeChannel.mockResolvedValue({
      ...existingAccount,
      data: { ...channel, status: 1 },
    });

    await expect(fetchAndVerifyOpenChannel(rpc, CHANNEL_ID, expected)).rejects.toThrow(
      `channel ${CHANNEL_ID} is not open`,
    );
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(1);
  });

  it("validates policy overrides and channel identity fields", () => {
    expect(resolveChannelReadPolicy({ maxAttempts: 3, backoffStepMs: 7 })).toEqual({
      maxAttempts: 3,
      backoffStepMs: 7,
    });
    expect(() =>
      verifyOpenChannelAccount(CHANNEL_ID, { ...channel, discriminator: 9 }, expected),
    ).toThrow(/invalid account discriminator/);
    expect(() =>
      verifyOpenChannelAccount(CHANNEL_ID, { ...channel, payee: address(PAYER) }, expected),
    ).toThrow(/channel payee/);
    expect(() =>
      verifyOpenChannelAccount(CHANNEL_ID, { ...channel, mint: address(PAYEE) }, expected),
    ).toThrow(/channel mint/);
    expect(() =>
      verifyOpenChannelAccount(CHANNEL_ID, { ...channel, deposit: 2n }, expected),
    ).toThrow(/channel deposit/);
  });

  it("checks channel account presence through the RPC", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce({ value: {} });
    const accountRpc = { getAccountInfo: vi.fn(() => ({ send })) } as never;
    await expect(channelExists(accountRpc, CHANNEL_ID)).resolves.toBe(false);
    await expect(channelExists(accountRpc, CHANNEL_ID)).resolves.toBe(true);
  });
});

describe("payment-channel transaction submission", () => {
  const signature = USDC_DEVNET_ADDRESS as Signature;
  const instruction = {
    accounts: [],
    data: new TextEncoder().encode("settle"),
    programAddress: address(MEMO_PROGRAM_ADDRESS),
  };

  it("broadcasts an open and reports its signature before confirmation", async () => {
    const events: string[] = [];
    const facilitator = {
      signTransaction: vi.fn().mockResolvedValue("signed"),
      sendTransaction: vi.fn().mockResolvedValue(signature),
      confirmTransaction: vi.fn().mockImplementation(async () => events.push("confirmed")),
    };
    await expect(
      broadcastOpen(facilitator, address(PAYEE), SOLANA_DEVNET_CAIP2, "open", async value => {
        events.push(`broadcast:${value}`);
      }),
    ).resolves.toBe(signature);
    expect(events).toEqual([`broadcast:${signature}`, "confirmed"]);
  });

  it("carries an unconfirmed open signature", async () => {
    const facilitator = {
      signTransaction: vi.fn().mockResolvedValue("signed"),
      sendTransaction: vi.fn().mockResolvedValue(signature),
      confirmTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    await expect(
      broadcastOpen(facilitator, address(PAYEE), SOLANA_DEVNET_CAIP2, "open"),
    ).rejects.toMatchObject({ name: "ChannelBroadcastConfirmationError", signature });
    expect(new ChannelBroadcastConfirmationError(signature, "timeout").cause).toBe("timeout");
  });

  it("submits, simulates, and confirms through a facilitator signer", async () => {
    const feePayer = await generateKeyPairSigner();
    const signer = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: USDC_MAINNET_ADDRESS,
        lastValidBlockHeight: 1n,
      }),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn().mockResolvedValue(signature),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const onBroadcast = vi.fn().mockResolvedValue(undefined);
    await expect(
      submitChannelTransactionWithSigner(feePayer, signer, SOLANA_DEVNET_CAIP2, [instruction], {
        computeUnitLimit: DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT,
        onBroadcast,
      }),
    ).resolves.toBe(signature);
    expect(signer.simulateTransaction).toHaveBeenCalledOnce();
    expect(onBroadcast).toHaveBeenCalledWith(signature);
    expect(signer.confirmTransaction).toHaveBeenCalledWith(signature, SOLANA_DEVNET_CAIP2);
  });

  it("rejects missing blockhash support and simulation failures", async () => {
    const feePayer = await generateKeyPairSigner();
    const withoutBlockhash = {
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    };
    await expect(
      submitChannelTransactionWithSigner(feePayer, withoutBlockhash, SOLANA_DEVNET_CAIP2, [
        instruction,
      ]),
    ).rejects.toThrow(/requires getLatestBlockhash/);

    const signer = {
      ...withoutBlockhash,
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: USDC_MAINNET_ADDRESS,
        lastValidBlockHeight: 1n,
      }),
      simulateTransaction: vi.fn().mockRejectedValue(new Error("bad simulation")),
    };
    await expect(
      submitChannelTransactionWithSigner(feePayer, signer, SOLANA_DEVNET_CAIP2, [instruction]),
    ).rejects.toBeInstanceOf(ChannelSimulationError);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("turns unknown confirmation failures into a durable timeout", async () => {
    const feePayer = await generateKeyPairSigner();
    const signer = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: USDC_MAINNET_ADDRESS,
        lastValidBlockHeight: 1n,
      }),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn().mockResolvedValue(signature),
      confirmTransaction: vi.fn().mockRejectedValue(new Error("rpc timeout")),
    };
    await expect(
      submitChannelTransactionWithSigner(feePayer, signer, SOLANA_DEVNET_CAIP2, [instruction]),
    ).rejects.toMatchObject({ name: "SettlementConfirmationTimeoutError", signature });
  });

  it("submits through RPC and polls confirmed status", async () => {
    const feePayer = await generateKeyPairSigner();
    const rpc = {
      getLatestBlockhash: vi.fn(() => ({
        send: vi.fn().mockResolvedValue({
          value: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
        }),
      })),
      sendTransaction: vi.fn(() => ({ send: vi.fn().mockResolvedValue(signature) })),
      getSignatureStatuses: vi.fn(() => ({
        send: vi.fn().mockResolvedValue({
          value: [{ confirmationStatus: "confirmed", err: null }],
        }),
      })),
    } as never;
    await expect(submitSettle(feePayer, rpc, [instruction])).resolves.toBe(signature);
  });

  it("reports onchain errors and confirmation timeouts", async () => {
    const failedRpc = {
      getSignatureStatuses: vi.fn(() => ({
        send: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: 7n }] }),
      })),
    } as never;
    await expect(confirmSignature(failedRpc, signature, 0)).rejects.toThrow(/failed onchain/);

    const pendingRpc = {
      getSignatureStatuses: vi.fn(() => ({
        send: vi.fn().mockResolvedValue({ value: [null] }),
      })),
    } as never;
    await expect(confirmSignature(pendingRpc, signature, 0)).rejects.toBeInstanceOf(
      SettlementConfirmationTimeoutError,
    );
  });

  it("sizes reclaim batches within the transaction ceiling", () => {
    expect(reclaimComputeUnitLimit(1)).toBe(30_000);
    expect(reclaimComputeUnitLimit(8)).toBe(65_000);
    expect(reclaimComputeUnitLimit(1_000_000)).toBe(1_400_000);
  });
});
