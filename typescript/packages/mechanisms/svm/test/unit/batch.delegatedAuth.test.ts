import { address, generateKeyPairSigner, type Signature } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { buildDepositPayload } from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import {
  BatchDelegatedAuthIdentityConflictError,
  InMemoryBatchDelegatedAuthStore,
} from "../../src/batch-settlement/facilitator/delegatedAuthStore";
import { InMemoryBatchReceiverAuthorizerStore } from "../../src/batch-settlement/facilitator/receiverAuthorizerStore";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import type {
  BatchChannelConfig,
  BatchRefundPayload,
  BatchSealPayload,
} from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import type { Channel } from "../../src/payment-channels/generated/accounts/channel";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { ChannelStatus } from "../../src/payment-channels/onchain";
import { signVoucher } from "../../src/payment-channels/voucher";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const SIGNATURE = USDC_DEVNET_ADDRESS as Signature;
const NOW = 1_800_000_000;
const CALLER = "service-a";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let server: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  server = await generateKeyPairSigner();
});

function requirements(receiverAuthorizer = server.address): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    extra: {
      feePayer: feePayer.address,
      receiverAuthorizer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function signer() {
  return {
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
    getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ADDRESS }),
    getAddresses: () => [feePayer.address],
    getLatestBlockhash: vi.fn(),
    getSigner: () => feePayer,
    getSlot: vi.fn(),
    sendTransaction: vi.fn().mockResolvedValue(SIGNATURE),
    signTransaction: vi.fn().mockResolvedValue("signed"),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

function channel(channelConfig: BatchChannelConfig, overrides: Partial<Channel> = {}): Channel {
  return {
    authorizedSigner: address(payer.address),
    bump: 1,
    closureStartedAt: BigInt(NOW - 60),
    deposit: 10_000n,
    discriminator: 1,
    distributionHash: getChannelDistributionHash([{ bps: 10_000, recipient: RECEIVER }]),
    gracePeriod: 900,
    mint: address(MINT),
    openSlot: BigInt(channelConfig.openSlot),
    payee: address(feePayer.address),
    payer: address(payer.address),
    payerWithdrawnAt: 0n,
    rentPayer: address(feePayer.address),
    salt: BigInt(channelConfig.salt),
    settlement: { payoutWatermark: 0n, settled: 0n },
    status: ChannelStatus.Closing,
    version: 1,
    ...overrides,
  };
}

function delegatedScheme(identity: string | undefined, options: { delegate?: boolean } = {}) {
  const identities = new InMemoryBatchDelegatedAuthStore();
  const bindings = new InMemoryBatchReceiverAuthorizerStore();
  const scheme = new BatchSvmScheme(signer() as never, {
    receiverAuthorizerStore: bindings,
    ...(options.delegate === false
      ? {}
      : {
          delegatedReceiverAuth: {
            identityStore: identities,
            receiverAuthorizer: server.address,
            resolveCallerIdentity: () => identity,
          },
        }),
  });
  return { bindings, identities, scheme };
}

describe("batch-settlement delegated receiver authorization", () => {
  it("advertises the delegated key and binds the caller on open", async () => {
    const { identities, scheme } = delegatedScheme(CALLER);
    expect(scheme.getExtra(NETWORK)).toMatchObject({ receiverAuthorizer: server.address });

    const opened = await buildDepositPayload({
      blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: MINT,
      openSlot: 123n,
      payer,
      receiver: RECEIVER,
      receiverAuthorizer: server.address,
      salt: 0n,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    const api = scheme as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    api.fetchChannel = vi
      .fn()
      .mockResolvedValue(
        channel(opened.payload.channelConfig, { closureStartedAt: 0n, status: ChannelStatus.Open }),
      );
    api.broadcastDurably = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
    api.completeOrPending = vi.fn().mockResolvedValue(undefined);
    api.trackChannel = vi.fn().mockResolvedValue(undefined);

    const openedResult = await scheme.settle(
      { accepted: requirements(), payload: opened.payload, x402Version: 2 },
      requirements(),
    );
    expect(openedResult.success, JSON.stringify(openedResult)).toBe(true);
    expect(await identities.get(NETWORK, opened.channelId)).toMatchObject({
      callerIdentity: CALLER,
    });
  });

  it("rejects a delegated open with no caller identity", async () => {
    const { identities, scheme } = delegatedScheme(undefined);
    const opened = await buildDepositPayload({
      blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: MINT,
      openSlot: 124n,
      payer,
      receiver: RECEIVER,
      receiverAuthorizer: server.address,
      salt: 0n,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    const api = scheme as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    api.broadcastDurably = vi.fn();
    api.trackChannel = vi.fn().mockResolvedValue(undefined);

    await expect(
      scheme.settle(
        { accepted: requirements(), payload: opened.payload, x402Version: 2 },
        requirements(),
      ),
    ).resolves.toMatchObject({
      errorReason: BatchError.DELEGATED_UNAUTHENTICATED,
      success: false,
    });
    expect(api.broadcastDurably).not.toHaveBeenCalled();
    expect(await identities.get(NETWORK, opened.channelId)).toBeUndefined();
  });

  it("seals and refunds a matching caller without closeAuthorization", async () => {
    const opened = await buildDepositPayload({
      blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: MINT,
      openSlot: 125n,
      payer,
      receiver: RECEIVER,
      receiverAuthorizer: server.address,
      salt: 0n,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    const { bindings, identities, scheme } = delegatedScheme(CALLER);
    await bindings.bind({
      channelId: opened.channelId,
      network: NETWORK,
      receiverAuthorizer: server.address,
    });
    await identities.bind({
      callerIdentity: CALLER,
      channelId: opened.channelId,
      network: NETWORK,
    });
    const live = channel(opened.payload.channelConfig);
    stubClose(scheme, opened.channelId, live);

    const voucher = await signedVoucher(opened.channelId, 1_000n);
    const seal: BatchSealPayload = {
      channelConfig: opened.payload.channelConfig,
      channelId: opened.channelId,
      type: "seal",
      voucher,
    };
    await expect(
      scheme.settle({ accepted: requirements(), payload: seal, x402Version: 2 }, requirements()),
    ).resolves.toMatchObject({
      success: true,
      transaction: SIGNATURE,
    });

    stubClose(
      scheme,
      opened.channelId,
      channel(opened.payload.channelConfig, { status: ChannelStatus.Open }),
    );
    const refund: BatchRefundPayload = {
      channelConfig: opened.payload.channelConfig,
      type: "refund",
      voucher,
    };
    await expect(
      scheme.settle({ accepted: requirements(), payload: refund, x402Version: 2 }, requirements()),
    ).resolves.toMatchObject({ success: true });
  });

  it("rejects a delegated close whose caller does not match, and a facilitator that does not delegate", async () => {
    const opened = await buildDepositPayload({
      blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: MINT,
      openSlot: 126n,
      payer,
      receiver: RECEIVER,
      receiverAuthorizer: server.address,
      salt: 0n,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    const mismatched = delegatedScheme("someone-else");
    await mismatched.bindings.bind({
      channelId: opened.channelId,
      network: NETWORK,
      receiverAuthorizer: server.address,
    });
    await mismatched.identities.bind({
      callerIdentity: CALLER,
      channelId: opened.channelId,
      network: NETWORK,
    });
    stubClose(mismatched.scheme, opened.channelId, channel(opened.payload.channelConfig));
    const voucher = await signedVoucher(opened.channelId, 1_000n);
    const seal: BatchSealPayload = {
      channelConfig: opened.payload.channelConfig,
      channelId: opened.channelId,
      type: "seal",
      voucher,
    };
    await expect(
      mismatched.scheme.settle(
        { accepted: requirements(), payload: seal, x402Version: 2 },
        requirements(),
      ),
    ).resolves.toMatchObject({
      errorReason: BatchError.DELEGATED_UNAUTHENTICATED,
      success: false,
    });

    const plain = delegatedScheme(CALLER, { delegate: false });
    await plain.bindings.bind({
      channelId: opened.channelId,
      network: NETWORK,
      receiverAuthorizer: server.address,
    });
    stubClose(plain.scheme, opened.channelId, channel(opened.payload.channelConfig));
    await expect(
      plain.scheme.settle(
        { accepted: requirements(), payload: seal, x402Version: 2 },
        requirements(),
      ),
    ).resolves.toMatchObject({
      errorReason: BatchError.CLOSE_AUTHORIZATION,
      success: false,
    });
  });

  it("InMemoryBatchDelegatedAuthStore bind is first-writer-wins", async () => {
    const store = new InMemoryBatchDelegatedAuthStore();
    const binding = {
      callerIdentity: CALLER,
      channelId: payer.address,
      network: NETWORK,
    };

    await store.bind(binding);
    await store.bind(binding);

    await expect(store.bind({ ...binding, callerIdentity: "other" })).rejects.toBeInstanceOf(
      BatchDelegatedAuthIdentityConflictError,
    );
    expect(await store.get(NETWORK, payer.address)).toMatchObject({ callerIdentity: CALLER });
    await store.delete(NETWORK, payer.address);
    expect(await store.get(NETWORK, payer.address)).toBeUndefined();
  });

  it("drops the caller identity when rent cleanup deletes the channel", async () => {
    const { identities, scheme } = delegatedScheme(CALLER);
    const channelId = payer.address;
    await identities.bind({ callerIdentity: CALLER, channelId, network: NETWORK });
    const manager = scheme.createRentCleanupManager(NETWORK);
    await (manager as unknown as { storage: { delete(id: string): Promise<void> } }).storage.delete(
      channelId,
    );
    expect(await identities.get(NETWORK, channelId)).toBeUndefined();
  });
});

function stubClose(scheme: BatchSvmScheme, channelId: string, live: Channel): void {
  const api = scheme as unknown as {
    deriveChannelId: ReturnType<typeof vi.fn>;
    distributeInstruction: ReturnType<typeof vi.fn>;
    fetchChannel: ReturnType<typeof vi.fn>;
    readChannel: ReturnType<typeof vi.fn>;
    sealDependencies(): { nowSeconds(): number };
    submitRedemption: ReturnType<typeof vi.fn>;
    trackChannel: ReturnType<typeof vi.fn>;
  };
  api.deriveChannelId = vi.fn().mockResolvedValue(channelId);
  api.fetchChannel = vi.fn().mockResolvedValue(live);
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
}

async function signedVoucher(channelId: string, cumulative: bigint) {
  return {
    channelId,
    expiresAt: 0,
    maxClaimableAmount: cumulative.toString(),
    signature: await signVoucher(payer, { channelId, cumulativeAmount: cumulative, expiresAt: 0n }),
  };
}
