import { address, generateKeyPairSigner, type Signature } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { signCloseAuthorization } from "../../src/batch-settlement/closeAuthorization";
import { BatchError } from "../../src/batch-settlement/errors";
import { InMemoryBatchReceiverAuthorizerStore } from "../../src/batch-settlement/facilitator/receiverAuthorizerStore";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import { encodeReceiverBindingMemo } from "../../src/batch-settlement/receiverBinding";
import {
  isBatchFacilitatorPayload,
  type BatchChannelConfig,
  type BatchSealPayload,
} from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import type { Channel } from "../../src/payment-channels/generated/accounts/channel";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { ChannelStatus } from "../../src/payment-channels/onchain";
import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { signVoucher } from "../../src/payment-channels/voucher";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const SIGNATURE = USDC_DEVNET_ADDRESS as Signature;
const NOW = 1_800_000_000;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let authorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let channelConfig: BatchChannelConfig;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  authorizer = await generateKeyPairSigner();
  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner: payer.address,
    bindingMemo: encodeReceiverBindingMemo(authorizer.address),
    blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 0n },
    deposit: 10_000n,
    feePayer: feePayer.address,
    gracePeriod: 900,
    mint: MINT,
    openSlot: 1n,
    payee: feePayer.address,
    payer,
    recipients: [{ bps: 10_000, recipient: RECEIVER }],
    salt: 0n,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  channelId = open.channelId;
  channelConfig = {
    openSlot: 1,
    payer: payer.address,
    payerAuthorizer: payer.address,
    receiver: RECEIVER,
    receiverAuthorizer: authorizer.address,
    salt: "0",
    token: MINT,
    withdrawDelay: 900,
  };
});

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    extra: {
      feePayer: feePayer.address,
      receiverAuthorizer: authorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    authorizedSigner: address(payer.address),
    bump: 1,
    closureStartedAt: BigInt(NOW - 60),
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
    settlement: { payoutWatermark: 500n, settled: 1_000n },
    status: ChannelStatus.Closing,
    version: 1,
    ...overrides,
  };
}

function signer() {
  return {
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
    getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ADDRESS }),
    getAddresses: vi.fn(() => [feePayer.address]),
    getSigner: vi.fn(() => feePayer),
    sendTransaction: vi.fn().mockResolvedValue(SIGNATURE),
    signTransaction: vi.fn().mockResolvedValue("signed"),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

type Internals = {
  resolveTerms: ReturnType<typeof vi.fn>;
  deriveChannelId: ReturnType<typeof vi.fn>;
  fetchChannel: ReturnType<typeof vi.fn>;
  readChannel: ReturnType<typeof vi.fn>;
  distributeInstruction: ReturnType<typeof vi.fn>;
  submitRedemption: ReturnType<typeof vi.fn>;
  trackChannel: ReturnType<typeof vi.fn>;
  sealDependencies(): { nowSeconds(): number };
};

async function sealPayload(cumulative: bigint, overrides: Partial<BatchSealPayload> = {}) {
  const signature = await signVoucher(payer, {
    channelId,
    cumulativeAmount: cumulative,
    expiresAt: 0n,
  });
  const closeAuthorization = await signCloseAuthorization(authorizer, {
    channelId,
    feePayer: feePayer.address,
    maxClaimableAmount: cumulative,
    network: NETWORK,
    validBefore: NOW + 120,
    voucherExpiresAt: 0n,
  });
  const payload: BatchSealPayload = {
    channelConfig,
    channelId,
    closeAuthorization,
    type: "seal",
    voucher: { channelId, expiresAt: 0, maxClaimableAmount: cumulative.toString(), signature },
    ...overrides,
  };
  return payload;
}

/**
 * Facilitator whose chain reads are stubbed and whose clock is pinned.
 *
 * @param options - Binding seed and live channel
 * @param options.live - The channel account the facilitator reads
 * @param options.bound - Whether the receiver authorizer was bound at deposit
 * @returns The scheme, its stubbed internals, and its binding store
 */
async function facilitator(
  options: {
    live?: Channel;
    bound?: boolean;
  } = {},
) {
  const store = new InMemoryBatchReceiverAuthorizerStore();
  if (options.bound ?? true) {
    await store.bind({ channelId, network: NETWORK, receiverAuthorizer: authorizer.address });
  }
  const scheme = new BatchSvmScheme(signer() as never, {
    receiverAuthorizerStore: store,
  });
  const api = scheme as unknown as Internals;
  api.resolveTerms = vi.fn().mockResolvedValue({
    feePayer: feePayer.address,
    feePayerSigner: feePayer,
    receiverAuthorizer: authorizer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    voucherSigner: "client",
    withdrawDelay: 900,
  });
  api.deriveChannelId = vi.fn().mockResolvedValue(channelId);
  api.fetchChannel = vi.fn().mockResolvedValue(options.live ?? channel());
  api.readChannel = vi.fn().mockResolvedValue(undefined);
  api.distributeInstruction = vi.fn().mockResolvedValue({
    accounts: [],
    data: new Uint8Array([9]),
    programAddress: address(RECEIVER),
  });
  api.submitRedemption = vi.fn().mockResolvedValue({
    ok: true,
    replayed: false,
    signature: SIGNATURE,
  });
  api.trackChannel = vi.fn().mockResolvedValue(undefined);
  const original = api.sealDependencies.bind(scheme);
  api.sealDependencies = () => ({ ...original(), nowSeconds: () => NOW });
  return { api, scheme, store };
}

const settle = (scheme: BatchSvmScheme, payload: BatchSealPayload) =>
  scheme.settle({ accepted: requirements(), payload, x402Version: 2 } as never, requirements());

describe("batch-settlement seal", () => {
  it("accepts only a well-formed seal payload", async () => {
    const payload = await sealPayload(3_000n);
    expect(isBatchFacilitatorPayload(payload)).toBe(true);
    expect(isBatchFacilitatorPayload({ ...payload, closeAuthorization: undefined })).toBe(true);
    expect(isBatchFacilitatorPayload({ ...payload, voucher: undefined })).toBe(false);
    expect(
      isBatchFacilitatorPayload({
        ...payload,
        closeAuthorization: { signature: "x", validBefore: 0 },
      }),
    ).toBe(false);
  });

  it("applies the final voucher with settle_and_seal and a sealed distribute in one transaction", async () => {
    const { api, scheme } = await facilitator();
    const response = await settle(scheme, await sealPayload(3_000n));
    expect(response).toMatchObject({
      // 3000 settled less the 500 already paid out reaches the receiver now.
      amount: "2500",
      extra: {
        channelState: {
          balance: "10000",
          channelId,
          totalClaimed: "3000",
          withdrawRequestedAt: 0,
        },
      },
      payer: payer.address,
      success: true,
      transaction: SIGNATURE,
    });
    const [feePayerArg, network, instructions, key] = api.submitRedemption.mock.calls[0]!;
    expect(feePayerArg).toBe(feePayer.address);
    expect(network).toBe(NETWORK);
    // Ed25519 precompile, settle_and_seal, distribute.
    expect(instructions).toHaveLength(3);
    expect(key).toBe(`batch:seal:${NETWORK}:${channelId}:3000`);
    expect(api.trackChannel).toHaveBeenCalledOnce();

    // The same close replays from the recorded result without a second broadcast.
    await expect(settle(scheme, await sealPayload(3_000n))).resolves.toMatchObject({
      amount: "2500",
      success: true,
    });
    expect(api.submitRedemption).toHaveBeenCalledOnce();
  });

  it("seals at the current watermark without a precompile when the voucher equals settled", async () => {
    const { api, scheme } = await facilitator();
    const response = await settle(scheme, await sealPayload(1_000n));
    expect(response).toMatchObject({ amount: "500", success: true });
    expect(api.submitRedemption.mock.calls[0]![2]).toHaveLength(2);
  });

  it("refuses channels that are not closing or whose grace period has elapsed", async () => {
    const open = await facilitator({
      live: channel({ closureStartedAt: 0n, status: ChannelStatus.Open }),
    });
    await expect(settle(open.scheme, await sealPayload(3_000n))).resolves.toMatchObject({
      errorReason: BatchError.CLOSE_STATE,
      success: false,
    });
    const late = await facilitator({ live: channel({ closureStartedAt: BigInt(NOW - 900) }) });
    await expect(settle(late.scheme, await sealPayload(3_000n))).resolves.toMatchObject({
      errorReason: BatchError.CLOSE_STATE,
      success: false,
    });
    const behind = await facilitator();
    await expect(settle(behind.scheme, await sealPayload(999n))).resolves.toMatchObject({
      errorReason: BatchError.CLOSE_STATE,
      success: false,
    });
    const above = await facilitator();
    await expect(settle(above.scheme, await sealPayload(10_001n))).resolves.toMatchObject({
      errorReason: BatchError.CLOSE_STATE,
      success: false,
    });
    expect(open.api.submitRedemption).not.toHaveBeenCalled();
  });

  it("authenticates the server through the receiver authorizer bound at deposit", async () => {
    const payload = await sealPayload(3_000n);
    const missing = await facilitator();
    await expect(
      missing.scheme.settle(
        {
          accepted: requirements(),
          payload: { ...payload, closeAuthorization: undefined },
          x402Version: 2,
        },
        requirements(),
      ),
    ).resolves.toMatchObject({ errorReason: BatchError.CLOSE_AUTHORIZATION, success: false });

    const forged = await facilitator();
    const impostor = await generateKeyPairSigner();
    const forgedAuthorization = await signCloseAuthorization(impostor, {
      channelId,
      feePayer: feePayer.address,
      maxClaimableAmount: 3_000n,
      network: NETWORK,
      validBefore: NOW + 120,
      voucherExpiresAt: 0n,
    });
    await expect(
      settle(forged.scheme, { ...payload, closeAuthorization: forgedAuthorization }),
    ).resolves.toMatchObject({ errorReason: BatchError.CLOSE_AUTHORIZATION, success: false });

    // A payer replaying an older voucher cannot freeze the watermark low: the
    // authorization binds the exact final amount.
    const stale = await facilitator();
    const older = await sealPayload(2_000n);
    await expect(
      settle(stale.scheme, { ...older, closeAuthorization: payload.closeAuthorization }),
    ).resolves.toMatchObject({ errorReason: BatchError.CLOSE_AUTHORIZATION, success: false });

    // No stored binding: fail closed.
    const unbound = await facilitator({ bound: false });
    await expect(settle(unbound.scheme, payload)).resolves.toMatchObject({
      errorReason: BatchError.RECEIVER_BINDING_UNAVAILABLE,
      success: false,
    });

    // A key other than the binding cannot authorize, even when validly signed.
    const rebound = await facilitator({ bound: false });
    await rebound.store.bind({ channelId, network: NETWORK, receiverAuthorizer: payer.address });
    await expect(settle(rebound.scheme, payload)).resolves.toMatchObject({
      errorReason: BatchError.RECEIVER_AUTHORIZER_MISMATCH,
      success: false,
    });
    expect(missing.api.submitRedemption).not.toHaveBeenCalled();
    expect(forged.api.submitRedemption).not.toHaveBeenCalled();
    expect(stale.api.submitRedemption).not.toHaveBeenCalled();
    expect(unbound.api.submitRedemption).not.toHaveBeenCalled();
  });

  it("refunds an open channel cooperatively with the server-authorized voucher", async () => {
    const open = channel({ closureStartedAt: 0n, status: ChannelStatus.Open });
    const refund = async (cumulative: bigint) => {
      const { closeAuthorization, voucher } = await sealPayload(cumulative);
      const { api, scheme } = await facilitator({ live: open });
      const response = await scheme.settle(
        {
          accepted: requirements(),
          payload: { channelConfig, closeAuthorization, type: "refund", voucher },
          x402Version: 2,
        } as never,
        requirements(),
      );
      return { api, response };
    };

    const above = await refund(3_000n);
    expect(above.response).toMatchObject({
      amount: "7000",
      extra: { channelState: { channelId, withdrawRequestedAt: 0 } },
      success: true,
      transaction: SIGNATURE,
    });
    const [, , instructions, key] = above.api.submitRedemption.mock.calls[0]!;
    expect(instructions).toHaveLength(3);
    expect(key).toBe(`batch:refund:${NETWORK}:${channelId}:3000`);

    // At the watermark the channel seals without a voucher precompile.
    const equal = await refund(1_000n);
    expect(equal.response).toMatchObject({ amount: "9000", success: true });
    expect(equal.api.submitRedemption.mock.calls[0]![2]).toHaveLength(2);

    // A closing channel cannot be refunded cooperatively through the seal path.
    const { closeAuthorization, voucher } = await sealPayload(3_000n);
    const closing = await facilitator();
    closing.api.readChannel = vi.fn().mockResolvedValue(undefined);
    closing.api.fetchChannel = vi.fn().mockResolvedValue(channel());
    await expect(
      closing.scheme.settle(
        {
          accepted: requirements(),
          payload: { channelConfig, closeAuthorization, type: "refund", voucher },
          x402Version: 2,
        } as never,
        requirements(),
      ),
    ).resolves.toMatchObject({ errorReason: BatchError.CLOSE_STATE, success: false });
  });

  it("rejects a claim against a closing channel with the dedicated code", async () => {
    const { scheme } = await facilitator();
    const signature = await signVoucher(payer, {
      channelId,
      cumulativeAmount: 3_000n,
      expiresAt: 0n,
    });
    const response = await scheme.settle(
      {
        accepted: requirements(),
        payload: {
          claims: [
            {
              channelConfig,
              channelId,
              voucher: { channelId, expiresAt: 0, maxClaimableAmount: "3000", signature },
            },
          ],
          type: "claim",
        },
        x402Version: 2,
      } as never,
      requirements(),
    );
    expect(response).toMatchObject({ errorReason: BatchError.CHANNEL_CLOSING, success: false });
  });
});
