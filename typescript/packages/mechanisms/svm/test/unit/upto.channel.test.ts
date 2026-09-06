import { address } from "@solana/kit";
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
  DEFAULT_CHANNEL_READ_BACKOFF_STEP_MS,
  DEFAULT_CHANNEL_READ_MAX_ATTEMPTS,
  delayAfterAttempt,
  fetchAndVerifyOpenChannel,
  getChannelDistributionHash,
  resolveChannelReadPolicy,
  type ExpectedOpenChannel,
} from "../../src/upto/facilitator/channel";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import type { UptoFacilitatorSigner } from "../../src/upto/facilitator/signer";

const CHANNEL_ID = USDC_MAINNET_ADDRESS;
const signer = {} as UptoFacilitatorSigner;
const NETWORK = SOLANA_DEVNET_CAIP2;
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

  // Pins the exact schedule, so a change back to `backoffStepMs * 2 ** (attempt-1)` fails here.
  it("backs off linearly across the default attempt budget", () => {
    const policy = resolveChannelReadPolicy();

    expect(policy.maxAttempts).toBe(DEFAULT_CHANNEL_READ_MAX_ATTEMPTS);
    expect(policy.backoffStepMs).toBe(DEFAULT_CHANNEL_READ_BACKOFF_STEP_MS);

    const delays: number[] = [];
    let total = 0;
    for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
      const delay = delayAfterAttempt(policy, attempt);
      delays.push(delay);
      total += delay;
    }

    expect(delays).toEqual([200, 400, 600, 800, 1000]);
    expect(total).toBe(3_000);
    expect(delays[delays.length - 1]).toBe(1_000);
  });

  // Config overrides must reach the retry loop rather than it using the defaults unconditionally.
  it("honours scheme config overrides", () => {
    const policy = resolveChannelReadPolicy({ maxAttempts: 8, backoffStepMs: 50 });

    expect(policy.maxAttempts).toBe(8);
    expect(policy.backoffStepMs).toBe(50);
    expect(delayAfterAttempt(policy, 8)).toBe(400);
  });

  it("retries a missing confirmed channel until it becomes visible", async () => {
    vi.useFakeTimers();
    channelAccountMocks.fetchMaybeChannel
      .mockResolvedValueOnce(missingAccount)
      .mockResolvedValueOnce(existingAccount);

    const result = fetchAndVerifyOpenChannel(signer, NETWORK, CHANNEL_ID, expected);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toMatchObject({ channelId: CHANNEL_ID });
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(2);
  });

  it("stops after six missing reads", async () => {
    vi.useFakeTimers();
    channelAccountMocks.fetchMaybeChannel.mockResolvedValue(missingAccount);

    const result = fetchAndVerifyOpenChannel(signer, NETWORK, CHANNEL_ID, expected);
    const assertion = expect(result).rejects.toThrow(`channel ${CHANNEL_ID} does not exist`);
    await vi.advanceTimersByTimeAsync(3_000);

    await assertion;
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(6);
  });

  // A channel that never becomes visible must be read exactly maxAttempts times.
  it("stops at the configured attempt count", async () => {
    vi.useFakeTimers();
    channelAccountMocks.fetchMaybeChannel.mockResolvedValue(missingAccount);

    const result = fetchAndVerifyOpenChannel(signer, NETWORK, CHANNEL_ID, expected, {
      maxAttempts: 3,
      backoffStepMs: 1,
    });
    const assertion = expect(result).rejects.toThrow(`channel ${CHANNEL_ID} does not exist`);
    await vi.advanceTimersByTimeAsync(10);

    await assertion;
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(3);
  });

  it("does not retry an existing channel with invalid state", async () => {
    channelAccountMocks.fetchMaybeChannel.mockResolvedValue({
      ...existingAccount,
      data: { ...channel, status: 1 },
    });

    await expect(fetchAndVerifyOpenChannel(signer, NETWORK, CHANNEL_ID, expected)).rejects.toThrow(
      `channel ${CHANNEL_ID} is not open`,
    );
    expect(channelAccountMocks.fetchMaybeChannel).toHaveBeenCalledTimes(1);
  });
});
