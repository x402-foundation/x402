import { findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Signature,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { BatchError } from "../../src/batch-settlement/errors";
import {
  broadcastExpiredWithoutLanding,
  InMemoryBatchPendingSettlementStore,
} from "../../src/batch-settlement/facilitator/recovery";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import { InMemoryBatchReceiverAuthorizerStore } from "../../src/batch-settlement/facilitator/receiverAuthorizerStore";
import type { BatchChannelConfig, BatchSettlePayload } from "../../src/batch-settlement/types";
import {
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { createRpcCapabilitiesFromRpc } from "../../src/signer";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const CHANNEL_ID = USDC_MAINNET_ADDRESS;
const BLOCKHASH = "11111111111111111111111111111111";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let wire: string;
let signature: string;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 1n },
        m,
      ),
    m =>
      appendTransactionMessageInstruction(
        { accounts: [], data: new Uint8Array([1]), programAddress: address(MEMO_PROGRAM_ADDRESS) },
        m,
      ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  wire = getBase64EncodedWireTransaction(signed);
  signature = getSignatureFromTransaction(signed);
});

function requirements(payTo = USDC_MAINNET_ADDRESS): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    extra: { feePayer: feePayer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS, withdrawDelay: 900 },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo,
    scheme: "batch-settlement",
  };
}

function channelConfig(): BatchChannelConfig {
  return {
    openSlot: 1,
    payer: payer.address,
    payerAuthorizer: payer.address,
    receiver: USDC_MAINNET_ADDRESS,
    salt: "0",
    token: MINT,
    withdrawDelay: 900,
  };
}

function transport(overrides: Record<string, unknown> = {}) {
  return {
    confirmTransaction: vi.fn().mockRejectedValue(new Error("Transaction confirmation timeout")),
    getAccountInfo: vi.fn(),
    getAddresses: vi.fn(() => [feePayer.address]),
    getConfirmedTransaction: vi.fn().mockResolvedValue(null),
    getSigner: vi.fn(() => feePayer),
    isBlockhashValid: vi.fn().mockResolvedValue(false),
    sendTransaction: vi.fn().mockResolvedValue(signature),
    signTransaction: vi.fn().mockResolvedValue("signed"),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

type Internals = {
  reconcileBroadcast(
    key: string,
    signature: string,
    network: string,
    payer: string,
  ): Promise<{ ok: true } | { ok: false; response: SettleResponse }>;
  broadcastDurably(
    key: string,
    network: string,
    payer: string,
    broadcast: (onPrepared: (signature: string, wire: string) => Promise<void>) => Promise<string>,
  ): Promise<unknown>;
  resolveTerms: unknown;
  deriveChannelId: unknown;
  trackChannel: unknown;
};

const KEY = `batch:distribute:${NETWORK}:${MINT}:${USDC_MAINNET_ADDRESS}:${CHANNEL_ID}`;
const wireKey = () => `batch:transaction:${NETWORK}:${signature}:wire`;

async function pendingScheme(signer: ReturnType<typeof transport>, key = KEY) {
  const store = new InMemoryBatchPendingSettlementStore();
  await store.set(key, signature);
  await store.set(wireKey(), wire);
  const scheme = new BatchSvmScheme(signer as never, {
    receiverAuthorizerStore: new InMemoryBatchReceiverAuthorizerStore(),
    pendingSettlementStore: store,
  });
  return { internals: scheme as unknown as Internals, scheme, store };
}

describe("expiry of a broadcast that was never confirmed", () => {
  it("releases the queue when the blockhash expired and the network has no record", async () => {
    const signer = transport();
    const { internals, store } = await pendingScheme(signer);

    const result = await internals.reconcileBroadcast(KEY, signature, NETWORK, "");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response).toMatchObject({
      success: false,
      errorReason: "transaction_failed",
      transaction: signature,
    });
    expect(result.response.errorMessage).toContain("expired");
    expect(signer.isBlockhashValid).toHaveBeenCalledWith(BLOCKHASH, NETWORK);
    expect(signer.getConfirmedTransaction).toHaveBeenCalledWith(signature, NETWORK);
    expect(await store.get(KEY)).toBeUndefined();
    expect(await store.get(wireKey())).toBeUndefined();
    // The stored bytes were resent once before their fate was decided.
    expect(signer.sendTransaction).toHaveBeenCalledWith(wire, NETWORK);
  });

  it("stays pending while the blockhash is still valid", async () => {
    const signer = transport({ isBlockhashValid: vi.fn().mockResolvedValue(true) });
    const { internals, store } = await pendingScheme(signer);

    const result = await internals.reconcileBroadcast(KEY, signature, NETWORK, "");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.errorReason).toBe("settlement_pending");
    expect(signer.getConfirmedTransaction).not.toHaveBeenCalled();
    expect(await store.get(KEY)).toBe(signature);
    expect(await store.get(wireKey())).toBe(wire);
  });

  it("stays pending when the expired blockhash's transaction is found in history", async () => {
    const signer = transport({
      getConfirmedTransaction: vi.fn().mockResolvedValue({ slot: 5n, meta: null, transaction: {} }),
    });
    const { internals, store } = await pendingScheme(signer);

    const result = await internals.reconcileBroadcast(KEY, signature, NETWORK, "");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.errorReason).toBe("settlement_pending");
    expect(await store.get(KEY)).toBe(signature);
  });

  it("stays pending when the signer cannot check blockhash validity", async () => {
    const signer = transport({ isBlockhashValid: undefined });
    const { internals, store } = await pendingScheme(signer);

    const result = await internals.reconcileBroadcast(KEY, signature, NETWORK, "");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.errorReason).toBe("settlement_pending");
    expect(await store.get(KEY)).toBe(signature);
  });

  it("never classifies a broadcast as expired without its bytes or on a failing check", async () => {
    const signer = transport();
    expect(await broadcastExpiredWithoutLanding(signer, signature, NETWORK, undefined)).toBe(false);
    expect(
      await broadcastExpiredWithoutLanding(signer, signature, NETWORK, "not-a-transaction"),
    ).toBe(false);
    const failing = transport({
      isBlockhashValid: vi.fn().mockRejectedValue(new Error("rpc down")),
    });
    expect(await broadcastExpiredWithoutLanding(failing, signature, NETWORK, wire)).toBe(false);
    expect(await broadcastExpiredWithoutLanding(transport(), signature, NETWORK, wire)).toBe(true);
  });
});

describe("ambiguous payout attribution", () => {
  it("answers with its own reason and releases the sweep queue", async () => {
    const payTo = payer.address; // merchant is also the channel's refund beneficiary
    const key = `batch:distribute:${NETWORK}:${MINT}:${payTo}:${CHANNEL_ID}`;
    const [recipient] = await findAssociatedTokenPda({
      mint: address(MINT),
      owner: address(payTo),
      tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    });
    const [escrow] = await findAssociatedTokenPda({
      mint: address(MINT),
      owner: address(CHANNEL_ID),
      tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    });
    const token = (accountIndex: number, owner: string, amount: string) => ({
      accountIndex,
      mint: MINT,
      owner,
      uiTokenAmount: { amount },
    });
    const signer = transport({
      confirmTransaction: vi.fn().mockResolvedValue({ slot: 100n }),
      getConfirmedTransaction: vi.fn().mockResolvedValue({
        slot: 100n,
        transaction: { message: { accountKeys: [recipient, escrow] } },
        meta: {
          err: null,
          preTokenBalances: [token(0, payTo, "100"), token(1, CHANNEL_ID, "9800")],
          // The escrow is gone: a sealed close refunded the payer, who is also the merchant.
          postTokenBalances: [token(0, payTo, "9900")],
        },
      }),
    });
    const record = vi.fn();
    const store = new InMemoryBatchPendingSettlementStore();
    await store.set(key, signature);
    const scheme = new BatchSvmScheme(signer as never, {
      receiverAuthorizerStore: new InMemoryBatchReceiverAuthorizerStore(),
      pendingSettlementStore: store,
      onDistributionConfirmed: record,
    });
    const api = scheme as unknown as Internals;
    api.resolveTerms = vi.fn().mockResolvedValue({
      feePayer: feePayer.address,
      feePayerSigner: feePayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      voucherSigner: "client",
      withdrawDelay: 900,
    });
    api.deriveChannelId = vi.fn().mockResolvedValue(CHANNEL_ID);
    api.trackChannel = vi.fn().mockResolvedValue(undefined);
    const payload: BatchSettlePayload = {
      type: "settle",
      channels: [{ channelId: CHANNEL_ID, channelConfig: channelConfig() }],
    };
    const payment = { accepted: requirements(payTo), payload, x402Version: 2 } as PaymentPayload;

    const response = await scheme.settleDistributions(payment, payload, requirements(payTo));

    expect(response).toMatchObject({
      success: false,
      errorReason: BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS,
      transaction: signature,
    });
    expect(record).not.toHaveBeenCalled();
    // The queue is released: nothing pending, the outcome recorded by signature.
    expect(await store.get(key)).toBeUndefined();
    expect(JSON.parse((await store.get(`${key}:result`))!)).toMatchObject({
      errorReason: BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS,
    });
  });
});

describe("wire records", () => {
  it("drops the bytes written by a broadcast that lost its reservation", async () => {
    const signer = transport();
    const store = new InMemoryBatchPendingSettlementStore();
    await store.set(KEY, "other-signature");
    const scheme = new BatchSvmScheme(signer as never, {
      receiverAuthorizerStore: new InMemoryBatchReceiverAuthorizerStore(),
      pendingSettlementStore: store,
    });
    const api = scheme as unknown as Internals & { reconcileBroadcast: unknown };
    api.reconcileBroadcast = vi
      .fn()
      .mockResolvedValue({ ok: true, replayed: false, signature: "other-signature" });

    await api.broadcastDurably(KEY, NETWORK, "", async onPrepared => {
      await onPrepared(signature, wire);
      return signature;
    });

    expect(await store.get(wireKey())).toBeUndefined();
    expect(await store.get(KEY)).toBe("other-signature");
  });
});

describe("confirmation polling", () => {
  it("searches transaction history on the first lookup only", async () => {
    const getSignatureStatuses = vi
      .fn()
      .mockReturnValueOnce({ send: async () => ({ value: [null] }) })
      .mockReturnValue({
        send: async () => ({ value: [{ slot: 7n, confirmationStatus: "confirmed", err: null }] }),
      });
    const caps = createRpcCapabilitiesFromRpc({ getSignatureStatuses } as never);

    await caps.confirmTransaction("recover" as Signature, { searchTransactionHistory: true });

    expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
    expect(getSignatureStatuses.mock.calls[0]).toEqual([
      ["recover"],
      { searchTransactionHistory: true },
    ]);
    expect(getSignatureStatuses.mock.calls[1]).toEqual([["recover"]]);
  });
});
