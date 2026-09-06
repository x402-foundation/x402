import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import { beforeEach, describe, expect, it, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  broadcastOpen: vi.fn(),
  channelExists: vi.fn(),
  fetchAndVerifyOpenChannel: vi.fn(),
  simulateOpenSettleDistribute: vi.fn(),
  submitSettle: vi.fn(),
}));

vi.mock("../../src/upto/facilitator/channel", async () => {
  const actual = await vi.importActual<typeof import("../../src/upto/facilitator/channel")>(
    "../../src/upto/facilitator/channel",
  );
  return {
    ...actual,
    broadcastOpen: channelMocks.broadcastOpen,
    channelExists: channelMocks.channelExists,
    fetchAndVerifyOpenChannel: channelMocks.fetchAndVerifyOpenChannel,
    simulateOpenSettleDistribute: channelMocks.simulateOpenSettleDistribute,
    submitSettle: channelMocks.submitSettle,
  };
});

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({
      getSlot: () => ({ send: async () => 123_456_789n }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
        }),
      }),
    }),
  };
});

import { TOKEN_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { signVoucher } from "../../src/payment-channels/voucher";
import { toFacilitatorSvmSigner } from "../../src/signer";
import {
  decodeTransactionFromPayload,
  transactionMessageHash,
  TransactionOnchainFailureError,
} from "../../src/utils";
import { UptoSvmScheme } from "../../src/upto/facilitator/scheme";
import { ErrSettlementPending } from "../../src/exact/facilitator/errors";
import {
  ChannelOpenConfirmationError,
  SettlementConfirmationTimeoutError,
} from "../../src/upto/facilitator/channel";
import type { UptoSvmPayloadV2 } from "../../src/types";
import { challengeExpiresAt, MAX_TIMEOUT_SECONDS } from "./upto.testUtils";

const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;

/**
 * Wires a real (unmocked-at-the-signature-level) open channel + payload fixture
 * matching `upto.facilitator.test.ts`'s `buildFixture`, but exposes the raw
 * `FacilitatorSvmSigner` so pending-settlement-store tests can override
 * `confirmTransaction` without touching real RPC.
 */
async function buildFixture(config: ConstructorParameters<typeof UptoSvmScheme>[1] = {}) {
  const payer = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const receiverAuthorizer = await generateKeyPairSigner();
  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner: receiverAuthorizer.address,
    blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 0n },
    deposit: 1_000_000n,
    feePayer: feePayer.address,
    gracePeriod: WITHDRAW_DELAY,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: OPEN_SLOT,
    payee: feePayer.address,
    payer,
    recipients: [{ bps: 10_000, recipient: receiverAuthorizer.address }],
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: SOLANA_DEVNET_CAIP2,
    asset: USDC_DEVNET_ADDRESS,
    amount: "1000000",
    payTo: receiverAuthorizer.address,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      feePayer: feePayer.address,
      recentSlot: OPEN_SLOT.toString(),
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: WITHDRAW_DELAY,
    },
  };
  const uptoPayload: UptoSvmPayloadV2 = {
    authorizedSigner: receiverAuthorizer.address,
    channelId: open.channelId,
    deposit: "1000000",
    expiresAt: challengeExpiresAt(),
    from: payer.address,
    maxAmount: "1000000",
    nonce: open.salt.toString(),
    openSlot: OPEN_SLOT.toString(),
    openTransaction: open.transaction,
    validAfter: 0,
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: uptoPayload as unknown as Record<string, unknown>,
  };
  channelMocks.fetchAndVerifyOpenChannel.mockResolvedValue({
    authorizedSigner: receiverAuthorizer.address,
    channelId: open.channelId,
    deposit: 1_000_000n,
    mint: requirements.asset,
    openSlot: OPEN_SLOT,
    payee: feePayer.address,
    payer: payer.address,
    rentPayer: feePayer.address,
    splits: [{ bps: 10_000, recipient: receiverAuthorizer.address }],
  });
  const rawSigner = toFacilitatorSvmSigner(feePayer);
  const facilitator = new UptoSvmScheme(rawSigner, config);
  return {
    facilitator,
    payload,
    requirements,
    receiverAuthorizer,
    uptoPayload,
    rawSigner,
    feePayer,
  };
}

/**
 * Mirrors `UptoSvmScheme.settleDeposit`'s pending-settlement key: the open
 * transaction's message hash (not just channelId), so a differently-shaped
 * retry can't reconcile against a stale signature.
 */
function depositKeyFor(requirements: PaymentRequirements, uptoPayload: UptoSvmPayloadV2): string {
  return `upto:deposit:${requirements.network}:${transactionMessageHash(
    decodeTransactionFromPayload({ transaction: uptoPayload.openTransaction }),
  )}`;
}

describe("UptoSvmScheme deposit pending-settlement store integration", () => {
  let store: PendingSettlementStore;

  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.simulateOpenSettleDistribute.mockResolvedValue(undefined);
    channelMocks.broadcastOpen.mockResolvedValue(USDC_MAINNET_ADDRESS);
    channelMocks.submitSettle.mockResolvedValue(USDC_MAINNET_ADDRESS);
    store = new InMemoryPendingSettlementStore();
  });

  it("cache-miss + broadcast success: leaves no pending entry", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture({
      pendingSettlementStore: store,
    });
    const depositKey = depositKeyFor(requirements, uptoPayload);

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(channelMocks.broadcastOpen).toHaveBeenCalledTimes(1);
    expect(await store.get(depositKey)).toBeUndefined();
  });

  it("cache-miss + open confirmation timeout: returns settlement_pending and populates the store keyed by the channel", async () => {
    channelMocks.broadcastOpen.mockRejectedValue(
      new ChannelOpenConfirmationError(
        "OpenSig1111111111111111111111111111111111111",
        new Error("rpc: confirmation timeout"),
      ),
    );
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture({
      pendingSettlementStore: store,
    });
    const depositKey = depositKeyFor(requirements, uptoPayload);

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("OpenSig1111111111111111111111111111111111111");
    expect(await store.get(depositKey)).toBe("OpenSig1111111111111111111111111111111111111");
  });

  it("cache-miss + open confirmation fails onchain (terminal): returns transaction_failed and releases the dedup lock", async () => {
    channelMocks.broadcastOpen.mockRejectedValue(
      new TransactionOnchainFailureError("Transaction failed onchain: {}"),
    );
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture({
      pendingSettlementStore: store,
    });
    const depositKey = depositKeyFor(requirements, uptoPayload);

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_upto_svm_channel_broadcast");
    expect(await store.get(depositKey)).toBeUndefined();
  });

  it("cache-hit: skips channelExists/broadcastOpen entirely and reconciles against the cached signature", async () => {
    const { facilitator, payload, requirements, uptoPayload, rawSigner } = await buildFixture({
      pendingSettlementStore: store,
    });
    const depositKey = depositKeyFor(requirements, uptoPayload);
    await store.set(depositKey, "CachedOpenSig111111111111111111111111111111");
    const confirmTransaction = vi.fn().mockResolvedValue(undefined);
    rawSigner.confirmTransaction = confirmTransaction;

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("CachedOpenSig111111111111111111111111111111");
    expect(channelMocks.channelExists).not.toHaveBeenCalled();
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.simulateOpenSettleDistribute).not.toHaveBeenCalled();
    expect(confirmTransaction).toHaveBeenCalledWith(
      "CachedOpenSig111111111111111111111111111111",
      requirements.network,
    );
    expect(await store.get(depositKey)).toBeUndefined();
  });

  it("cache-hit still pending: returns settlement_pending again and preserves the store entry", async () => {
    const { facilitator, payload, requirements, uptoPayload, rawSigner } = await buildFixture({
      pendingSettlementStore: store,
    });
    const depositKey = depositKeyFor(requirements, uptoPayload);
    await store.set(depositKey, "CachedOpenSig222222222222222222222222222222");
    rawSigner.confirmTransaction = vi.fn().mockRejectedValue(new Error("still not confirmed"));

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.transaction).toBe("CachedOpenSig222222222222222222222222222222");
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(await store.get(depositKey)).toBe("CachedOpenSig222222222222222222222222222222");
  });

  it("terminal failure (channel already open) never touches the store", async () => {
    channelMocks.channelExists.mockResolvedValue(true);
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture({
      pendingSettlementStore: store,
    });
    const depositKey = depositKeyFor(requirements, uptoPayload);

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_upto_svm_channel_already_open");
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(await store.get(depositKey)).toBeUndefined();
  });
});

describe("UptoSvmScheme claim pending-settlement store integration", () => {
  let store: PendingSettlementStore;

  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.simulateOpenSettleDistribute.mockResolvedValue(undefined);
    channelMocks.broadcastOpen.mockResolvedValue(USDC_MAINNET_ADDRESS);
    channelMocks.submitSettle.mockResolvedValue(USDC_MAINNET_ADDRESS);
    store = new InMemoryPendingSettlementStore();
  });

  async function buildClaimPayload(fixture: Awaited<ReturnType<typeof buildFixture>>) {
    const voucherSignature = await signVoucher(fixture.receiverAuthorizer, {
      channelId: fixture.uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(fixture.uptoPayload.expiresAt),
    });
    return {
      payload: { ...fixture.payload, payload: { ...fixture.uptoPayload, voucherSignature } },
      requirements: { ...fixture.requirements, amount: "0" },
    };
  }

  it("cache-miss + broadcast success: leaves no pending entry", async () => {
    const fixture = await buildFixture({ pendingSettlementStore: store });
    const { payload, requirements } = await buildClaimPayload(fixture);
    const settlementKey = `upto:${requirements.network}:${fixture.uptoPayload.channelId}`;

    const result = await fixture.facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
    expect(await store.get(settlementKey)).toBeUndefined();
  });

  it("cache-miss + settle confirmation timeout: returns settlement_pending and populates the store keyed by the channel", async () => {
    channelMocks.submitSettle.mockRejectedValue(
      new SettlementConfirmationTimeoutError(
        "ClaimSig1111111111111111111111111111111111111" as never,
      ),
    );
    const fixture = await buildFixture({ pendingSettlementStore: store });
    const { payload, requirements } = await buildClaimPayload(fixture);
    const settlementKey = `upto:${requirements.network}:${fixture.uptoPayload.channelId}`;

    const result = await fixture.facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("ClaimSig1111111111111111111111111111111111111");
    expect(await store.get(settlementKey)).toBe("ClaimSig1111111111111111111111111111111111111");
  });

  it("cache-hit: skips fetchAndVerifyOpenChannel/submitSettle entirely and reconciles against the cached signature", async () => {
    const fixture = await buildFixture({ pendingSettlementStore: store });
    const { payload, requirements } = await buildClaimPayload(fixture);
    const settlementKey = `upto:${requirements.network}:${fixture.uptoPayload.channelId}`;
    await store.set(settlementKey, "CachedClaimSig11111111111111111111111111111");
    const confirmTransaction = vi.fn().mockResolvedValue(undefined);
    fixture.rawSigner.confirmTransaction = confirmTransaction;

    const result = await fixture.facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("CachedClaimSig11111111111111111111111111111");
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).not.toHaveBeenCalled();
    expect(confirmTransaction).toHaveBeenCalledWith(
      "CachedClaimSig11111111111111111111111111111",
      requirements.network,
    );
    expect(await store.get(settlementKey)).toBeUndefined();
  });

  it("cache-hit still pending: returns settlement_pending again and preserves the store entry", async () => {
    const fixture = await buildFixture({ pendingSettlementStore: store });
    const { payload, requirements } = await buildClaimPayload(fixture);
    const settlementKey = `upto:${requirements.network}:${fixture.uptoPayload.channelId}`;
    await store.set(settlementKey, "CachedClaimSig22222222222222222222222222222");
    fixture.rawSigner.confirmTransaction = vi
      .fn()
      .mockRejectedValue(new Error("still not confirmed"));

    const result = await fixture.facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.transaction).toBe("CachedClaimSig22222222222222222222222222222");
    expect(channelMocks.submitSettle).not.toHaveBeenCalled();
    expect(await store.get(settlementKey)).toBe("CachedClaimSig22222222222222222222222222222");
  });

  it("terminal failure (settlement exceeds signed ceiling) never touches the store", async () => {
    const fixture = await buildFixture({ pendingSettlementStore: store });
    const { payload } = await buildClaimPayload(fixture);
    const settlementKey = `upto:${fixture.requirements.network}:${fixture.uptoPayload.channelId}`;

    const result = await fixture.facilitator.settle(payload, {
      ...fixture.requirements,
      amount: "1000001",
    });

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_upto_svm_payload_settlement_exceeds_amount");
    expect(channelMocks.submitSettle).not.toHaveBeenCalled();
    expect(await store.get(settlementKey)).toBeUndefined();
  });
});
