import { address, generateKeyPairSigner, getBase64Codec, type Signature } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { buildDepositPayload } from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import type { BatchReceiverBindingHistoryReader } from "../../src/batch-settlement/facilitator/types";
import {
  InMemoryPaymentChannelStorage,
  ReceiverAuthorizerConflictError,
  checkOpenBindings,
} from "../../src/payment-channels/storage";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import {
  encodeReceiverBindingMemo,
  parseReceiverBindingMemo,
  RECEIVER_BINDING_MEMO_PREFIX,
} from "../../src/batch-settlement/receiverBinding";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import type { Channel } from "../../src/payment-channels/generated/accounts/channel";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { ChannelStatus } from "../../src/payment-channels/onchain";
import {
  buildOpenPaymentChannelTransaction,
  verifyOpenTransaction,
  type BuildOpenArgs,
} from "../../src/payment-channels/open";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const SIGNATURE = USDC_DEVNET_ADDRESS as Signature;
const OPEN_SLOT = 123n;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let server: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  server = await generateKeyPairSigner();
});

function requirements(receiverAuthorizer: string): PaymentRequirements {
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

function openArgs(overrides: Partial<BuildOpenArgs> = {}): BuildOpenArgs {
  return {
    authorizedSigner: payer.address,
    bindingMemo: encodeReceiverBindingMemo(server.address),
    blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
    deposit: 10_000n,
    feePayer: feePayer.address,
    gracePeriod: 900,
    mint: MINT,
    openSlot: OPEN_SLOT,
    payee: feePayer.address,
    payer,
    recipients: [{ bps: 10_000, recipient: RECEIVER }],
    salt: 0n,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

function verifyOpen(transaction: string, expectedBindingMemo?: string) {
  return verifyOpenTransaction(transaction, {
    authorizedSigner: payer.address,
    expectedBindingMemo,
    feePayer: feePayer.address,
    from: payer.address,
    maxCap: 10_000n,
    mint: MINT,
    openSlot: OPEN_SLOT,
    payee: feePayer.address,
    recipients: [{ bps: 10_000, recipient: RECEIVER }],
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  });
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
    openSlot: OPEN_SLOT,
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

function signer() {
  return {
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
    getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ADDRESS }),
    getAddresses: vi.fn(() => [feePayer.address]),
    getLatestBlockhash: vi.fn(),
    getSigner: vi.fn(() => feePayer),
    getSlot: vi.fn(),
    sendTransaction: vi.fn().mockResolvedValue(SIGNATURE),
    signTransaction: vi.fn().mockResolvedValue("signed"),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

describe("batch-settlement receiver-authorizer binding", () => {
  it("keeps the first binding for a channel and refuses a different key", async () => {
    const store = new InMemoryPaymentChannelStorage();
    const binding = {
      callerIdentity: "",
      channelId: RECEIVER,
      expiresAt: 0,
      lastActivityAt: 1,
      network: NETWORK,
      payTo: "",
      receiverAuthorizer: server.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await store.recordOpen(binding);
    const same = await store.recordOpen(binding);
    expect(same.revertToken).toBe("");
    const other = await store.recordOpen({ ...binding, receiverAuthorizer: payer.address });
    expect(() =>
      checkOpenBindings({ ...binding, receiverAuthorizer: payer.address }, other.record),
    ).toThrow(ReceiverAuthorizerConflictError);
    expect(await store.get(NETWORK, RECEIVER)).toMatchObject({
      receiverAuthorizer: server.address,
    });
    // The same PDA on another network is a separate channel.
    expect(await store.get("solana:other" as typeof NETWORK, RECEIVER)).toBeUndefined();
    await store.delete(NETWORK, RECEIVER);
    expect(await store.get(NETWORK, RECEIVER)).toBeUndefined();
  });

  it("round-trips the binding memo and rejects anything else", () => {
    const memo = encodeReceiverBindingMemo(server.address);
    expect(memo).toBe(`${RECEIVER_BINDING_MEMO_PREFIX}${server.address}`);
    expect(parseReceiverBindingMemo(memo)).toBe(server.address);
    expect(parseReceiverBindingMemo(server.address)).toBeUndefined();
    expect(parseReceiverBindingMemo(`${RECEIVER_BINDING_MEMO_PREFIX}not-a-key`)).toBeUndefined();
    expect(parseReceiverBindingMemo(RECEIVER_BINDING_MEMO_PREFIX)).toBeUndefined();
  });

  it("requires exactly one matching binding memo in the open", async () => {
    const expected = encodeReceiverBindingMemo(server.address);
    const bound = await buildOpenPaymentChannelTransaction(openArgs({ memo: "invoice-42" }));
    await expect(verifyOpen(bound.transaction, expected)).resolves.toMatchObject({
      channelId: bound.channelId,
    });
    // Without an expectation the verifier keeps its previous behavior.
    const unbound = await buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined }));
    await expect(verifyOpen(unbound.transaction)).resolves.toBeDefined();

    await expect(verifyOpen(unbound.transaction, expected)).rejects.toThrow(/found 0/);
    const duplicate = await buildOpenPaymentChannelTransaction(openArgs({ memo: expected }));
    await expect(verifyOpen(duplicate.transaction, expected)).rejects.toThrow(/found 2/);
    const other = await buildOpenPaymentChannelTransaction(
      openArgs({ bindingMemo: encodeReceiverBindingMemo(payer.address) }),
    );
    await expect(verifyOpen(other.transaction, expected)).rejects.toThrow(/found 0/);
    const both = await buildOpenPaymentChannelTransaction(
      openArgs({ memo: encodeReceiverBindingMemo(payer.address) }),
    );
    await expect(verifyOpen(both.transaction, expected)).rejects.toThrow(/found 2/);
  });

  it("keeps a bound open within the packet limit and refuses an oversized one", async () => {
    const open = await buildOpenPaymentChannelTransaction(openArgs({ memo: "invoice-42" }));
    expect(getBase64Codec().encode(open.transaction).byteLength).toBeLessThanOrEqual(1232);
    await expect(
      buildOpenPaymentChannelTransaction(
        openArgs({ bindingMemo: "x".repeat(1_000), memo: "invoice-42" }),
      ),
    ).rejects.toThrow(/1232-byte packet limit/);
  });

  it("refuses a channel the payer bound to its own key when the server's key is advertised", async () => {
    const store = new InMemoryPaymentChannelStorage();
    const scheme = new BatchSvmScheme(signer() as never, { channelStorage: store });
    const api = scheme as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // The payer opens directly against the facilitator, advertising its own key.
    const attack = await buildDepositPayload({
      blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: MINT,
      openSlot: OPEN_SLOT,
      payer,
      receiver: RECEIVER,
      receiverAuthorizer: payer.address,
      salt: 0n,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    });
    const channelId = attack.channelId;
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    api.fetchChannel = vi.fn().mockResolvedValue(channel());
    api.broadcastDurably = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
    api.completeOrPending = vi.fn().mockResolvedValue(undefined);
    await expect(
      scheme.settle(
        { accepted: requirements(payer.address), payload: attack.payload, x402Version: 2 },
        requirements(payer.address),
      ),
    ).resolves.toMatchObject({ success: true, transaction: SIGNATURE });
    expect((await store.get(NETWORK, channelId))?.receiverAuthorizer).toBe(payer.address);

    // Voucher and top-up do not read the binding. Cooperative refund does.
    const serverRequirements = requirements(server.address);
    const channelConfig = { ...attack.payload.channelConfig, receiverAuthorizer: server.address };
    const reads = vi.spyOn(store, "get");
    await expect(
      scheme.verify(
        {
          accepted: serverRequirements,
          payload: { channelConfig, type: "voucher", voucher: attack.payload.voucher },
          x402Version: 2,
        },
        serverRequirements,
      ),
    ).resolves.toMatchObject({ isValid: true });
    api.readChannel = vi.fn().mockResolvedValue(channel());
    await scheme.verify(
      {
        accepted: serverRequirements,
        payload: { ...attack.payload, channelConfig },
        x402Version: 2,
      },
      serverRequirements,
    );
    expect(reads).not.toHaveBeenCalled();
    api.readChannel = vi.fn().mockResolvedValue(undefined);
    await expect(
      scheme.verify(
        {
          accepted: serverRequirements,
          payload: { channelConfig, type: "refund", voucher: attack.payload.voucher },
          x402Version: 2,
        },
        serverRequirements,
      ),
    ).resolves.toMatchObject({
      invalidReason: BatchError.RECEIVER_AUTHORIZER_MISMATCH,
      isValid: false,
    });
  });

  it("broadcasts an open only after the channel row is recorded", async () => {
    const attack = await openedDeposit();
    const down = new InMemoryPaymentChannelStorage();
    vi.spyOn(down, "recordOpen").mockRejectedValue(new Error("store down"));
    const failed = await facilitatorFor(down);
    await expect(failed.scheme.settle(attack.payment, attack.requirements)).resolves.toMatchObject({
      errorReason: "transaction_failed",
      success: false,
    });
    expect(failed.broadcast).not.toHaveBeenCalled();

    const stored = new InMemoryPaymentChannelStorage();
    const opened = await facilitatorFor(stored);
    await expect(opened.scheme.settle(attack.payment, attack.requirements)).resolves.toMatchObject({
      success: true,
      transaction: SIGNATURE,
    });
    expect(opened.broadcast).toHaveBeenCalledOnce();
    expect((await stored.get(NETWORK, attack.channelId))?.receiverAuthorizer).toBe(payer.address);
  });

  it("does not broadcast when the channel write fails, even with a history reader", async () => {
    const attack = await openedDeposit();
    const store = new InMemoryPaymentChannelStorage();
    vi.spyOn(store, "recordOpen").mockRejectedValue(new Error("store down"));
    const { broadcast, scheme } = await facilitatorFor(store, {
      getSignaturesForAddress: vi.fn(),
      getTransaction: vi.fn(),
    });
    await expect(scheme.settle(attack.payment, attack.requirements)).resolves.toMatchObject({
      errorReason: "transaction_failed",
      success: false,
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(await store.get(NETWORK, attack.channelId)).toBeUndefined();
  });

  it("skips the bind when only a history reader is configured", async () => {
    const attack = await openedDeposit();
    const { broadcast, scheme } = await facilitatorFor(undefined, {
      getSignaturesForAddress: vi.fn(),
      getTransaction: vi.fn(),
    });
    await expect(scheme.settle(attack.payment, attack.requirements)).resolves.toMatchObject({
      success: true,
      transaction: SIGNATURE,
    });
    expect(broadcast).toHaveBeenCalledOnce();
  });
});

async function openedDeposit() {
  const built = await buildDepositPayload({
    blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
    depositAmount: 10_000n,
    feePayer: feePayer.address,
    firstCharge: 1_000n,
    mint: MINT,
    openSlot: OPEN_SLOT,
    payer,
    receiver: RECEIVER,
    receiverAuthorizer: payer.address,
    salt: 0n,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  });
  return {
    channelId: built.channelId,
    payment: { accepted: requirements(payer.address), payload: built.payload, x402Version: 2 },
    requirements: requirements(payer.address),
  };
}

async function facilitatorFor(
  store: InMemoryPaymentChannelStorage | undefined,
  historyReader?: BatchReceiverBindingHistoryReader,
) {
  const scheme = new BatchSvmScheme(signer() as never, {
    ...(store ? { channelStorage: store } : {}),
    ...(historyReader ? { receiverBindingHistoryReader: historyReader } : {}),
  });
  const api = scheme as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const broadcast = vi.fn().mockResolvedValue({ ok: true, signature: SIGNATURE });
  api.readChannel = vi.fn().mockResolvedValue(undefined);
  api.fetchChannel = vi.fn().mockResolvedValue(channel());
  api.broadcastDurably = broadcast;
  api.completeOrPending = vi.fn().mockResolvedValue(undefined);
  return { broadcast, scheme };
}
