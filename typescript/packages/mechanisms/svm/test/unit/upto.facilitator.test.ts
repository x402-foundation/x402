import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
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
      getAccountInfo: () => ({ send: async () => ({ value: null }) }),
      getProgramAccounts: () => ({ send: async () => [] }),
      simulateTransaction: () => ({ send: async () => ({ value: { err: null } }) }),
      sendTransaction: () => ({ send: async () => USDC_MAINNET_ADDRESS }),
      getSignatureStatuses: () => ({
        send: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      }),
    }),
  };
});

import { TOKEN_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { signVoucher } from "../../src/payment-channels/voucher";
import { toFacilitatorSvmSigner } from "../../src/signer";
import type { FacilitatorSvmSigner } from "../../src/signer";
import {
  ERR_AUTHORIZER_ADDRESS_MISMATCH,
  ERR_AUTHORIZER_NOT_CONFIGURED,
  ERR_CHANNEL_ALREADY_OPEN,
  ERR_CHANNEL_BROADCAST,
  ERR_DELEGATED_SETTLE_UNAUTHENTICATED,
  ERR_EXPIRES_AT_MISMATCH,
  ERR_CHANNEL_LIFETIME_EXCEEDED,
  ERR_PAYLOAD_TYPE,
  ERR_UNEXPECTED_VOUCHER,
  UptoSvmScheme,
} from "../../src/upto/facilitator/scheme";
import {
  InMemoryUptoDelegatedAuthStore,
  UptoDelegatedAuthIdentityConflictError,
} from "../../src/upto/facilitator/delegatedAuthStore";
import { ErrSettlementPending } from "../../src/exact/facilitator/errors";
import {
  SettlementConfirmationTimeoutError,
  SettlementSimulationError,
} from "../../src/upto/facilitator/channel";
import type { UptoChannelStorage } from "../../src/upto/facilitator/channelStorage";
import { UptoSvmRentCleanupManager } from "../../src/upto/facilitator/rentCleanupManager";
import type { UptoSvmPayloadV2 } from "../../src/types";
import { challengeExpiresAt, MAX_TIMEOUT_SECONDS } from "./upto.testUtils";

const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;

describe("UptoSvmScheme facilitator channel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.simulateOpenSettleDistribute.mockResolvedValue(undefined);
    channelMocks.broadcastOpen.mockResolvedValue(USDC_MAINNET_ADDRESS);
    channelMocks.submitSettle.mockResolvedValue(USDC_MAINNET_ADDRESS);
  });

  async function buildFixture(
    config: ConstructorParameters<typeof UptoSvmScheme>[1] = {},
    keys?: { receiverAuthorizer?: Awaited<ReturnType<typeof generateKeyPairSigner>> },
  ) {
    const payer = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const receiverAuthorizer = keys?.receiverAuthorizer ?? (await generateKeyPairSigner());
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
    const facilitator = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer), config);
    return { facilitator, payload, requirements, receiverAuthorizer, uptoPayload };
  }

  it("settles without a prior verify on the same instance when the channel is open", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        {
          ...payload,
          payload: { ...uptoPayload, voucherSignature },
        },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true, amount: "0" });

    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
  });

  it("passes the configured settle compute budget through to submitSettle", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture({
        computeUnitPriceMicroLamports: 7,
        settleComputeUnitLimit: 123_456,
      });

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        {
          ...payload,
          payload: { ...uptoPayload, voucherSignature },
        },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true });

    expect(channelMocks.submitSettle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      SOLANA_DEVNET_CAIP2,
      expect.anything(),
      expect.objectContaining({
        computeUnitLimit: 123_456,
        computeUnitPriceMicroLamports: 7,
      }),
    );
  });

  it("passes the configured channel-read policy through to fetchAndVerifyOpenChannel", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture({
        channelReadMaxAttempts: 8,
        channelReadBackoffStepMs: 50,
      });

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        {
          ...payload,
          payload: { ...uptoPayload, voucherSignature },
        },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true });

    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { maxAttempts: 8, backoffStepMs: 50 },
    );
  });

  it("rejects settlement that exceeds the signed ceiling without touching the chain", async () => {
    const { facilitator, payload, requirements } = await buildFixture();

    await expect(
      facilitator.settle(payload, { ...requirements, amount: "1000001" }),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_settlement_exceeds_amount",
    });
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).not.toHaveBeenCalled();
  });

  it("verify is read-only and never broadcasts", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.channelExists).not.toHaveBeenCalled();
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    expect(channelMocks.simulateOpenSettleDistribute).not.toHaveBeenCalled();
  });

  it("rejects maxTimeoutSeconds above maxChannelLifetimeSecs", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    await expect(
      facilitator.verify(payload, { ...requirements, maxTimeoutSeconds: 7_200 }),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ERR_CHANNEL_LIFETIME_EXCEEDED,
    });
  });

  it("rejects expiresAt remaining above maxChannelLifetimeSecs", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    await expect(
      facilitator.verify(
        {
          ...payload,
          payload: { ...uptoPayload, expiresAt: challengeExpiresAt(4_000) },
        },
        requirements,
      ),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ERR_CHANNEL_LIFETIME_EXCEEDED,
    });
  });

  it("rejects expiresAt beyond maxTimeoutSeconds", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    await expect(
      facilitator.verify(
        {
          ...payload,
          payload: {
            ...uptoPayload,
            expiresAt: challengeExpiresAt(MAX_TIMEOUT_SECONDS + 600),
          },
        },
        requirements,
      ),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: ERR_EXPIRES_AT_MISMATCH,
    });
  });

  it("rejects when maxTimeoutSeconds exceeds a tighter maxChannelLifetimeSecs", async () => {
    const { facilitator, payload, requirements } = await buildFixture({
      maxChannelLifetimeSecs: 120,
    });
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: ERR_CHANNEL_LIFETIME_EXCEEDED,
    });
  });

  it("rejects deposit settle when the channel already exists", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(true);

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: false,
      errorReason: ERR_CHANNEL_ALREADY_OPEN,
    });
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.simulateOpenSettleDistribute).not.toHaveBeenCalled();
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
  });

  it("rejects concurrent deposit settles for the same channel", async () => {
    const { facilitator, payload, requirements } = await buildFixture();

    const results = await Promise.all([
      facilitator.settle(payload, requirements),
      facilitator.settle(payload, requirements),
    ]);

    const successes = results.filter(r => r.success);
    const duplicates = results.filter(r => r.errorReason === "duplicate_settlement");
    expect(successes).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(channelMocks.broadcastOpen).toHaveBeenCalledTimes(1);
  });

  it("does not let a successful deposit claim-cache-block the later claim settle", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: true,
    });
    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true, amount: "0" });
    expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
  });

  it("indexes the channel on deposit settle and retains it after claim", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: true,
    });
    const stored = await facilitator.getChannelStorage().get(uptoPayload.channelId);
    expect(stored).toMatchObject({
      channelId: uptoPayload.channelId,
      payTo: requirements.payTo,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      network: requirements.network,
      expiresAt: uptoPayload.expiresAt,
    });
    const firstSeenAt = stored!.firstSeenAt;
    const expiresAt = stored!.expiresAt;

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true });

    const afterSettle = await facilitator.getChannelStorage().get(uptoPayload.channelId);
    expect(afterSettle).toBeDefined();
    expect(afterSettle!.firstSeenAt).toBe(firstSeenAt);
    expect(afterSettle!.expiresAt).toBe(expiresAt);
  });

  it("simulates open + settle + distribute before broadcasting a fresh open on deposit settle", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);

    const callOrder: string[] = [];
    channelMocks.simulateOpenSettleDistribute.mockImplementation(async () => {
      callOrder.push("simulateOpenSettleDistribute");
    });
    channelMocks.broadcastOpen.mockImplementation(async () => {
      callOrder.push("broadcastOpen");
      return USDC_MAINNET_ADDRESS as never;
    });

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: true,
      transaction: USDC_MAINNET_ADDRESS,
      amount: "1000000",
    });

    expect(callOrder).toEqual(["simulateOpenSettleDistribute", "broadcastOpen"]);
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      SOLANA_DEVNET_CAIP2,
      expect.objectContaining({
        openTransactionBase64: uptoPayload.openTransaction,
        channel: expect.objectContaining({
          channelId: uptoPayload.channelId,
          payer: uptoPayload.from,
        }),
      }),
    );
  });

  it("does not broadcast open when composite settlement simulation fails on deposit", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.simulateOpenSettleDistribute.mockRejectedValue(
      new Error("zero-charge settlement simulation failed: missing treasury ATA"),
    );

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_settlement_simulation",
    });
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    expect(await facilitator.getChannelStorage().get(uptoPayload.channelId)).toBeUndefined();
  });

  it("indexes the channel before broadcast and releases the deposit cache on broadcast failure", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.broadcastOpen.mockRejectedValueOnce(new Error("sendTransaction failed"));

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_channel_broadcast",
    });
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).toHaveBeenCalledTimes(1);
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    expect(await facilitator.getChannelStorage().get(uptoPayload.channelId)).toMatchObject({
      channelId: uptoPayload.channelId,
      payTo: requirements.payTo,
    });

    channelMocks.broadcastOpen.mockResolvedValue(USDC_MAINNET_ADDRESS as never);
    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: true,
    });
    expect(channelMocks.broadcastOpen).toHaveBeenCalledTimes(2);
  });

  it("keeps the channel indexed when post-open rebind fails and allows deposit retry", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    channelMocks.fetchAndVerifyOpenChannel.mockRejectedValueOnce(
      new Error("channel deposit 0 != expected 1000000"),
    );

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_channel_state",
    });
    expect(await facilitator.getChannelStorage().get(uptoPayload.channelId)).toMatchObject({
      channelId: uptoPayload.channelId,
    });

    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: true,
    });
  });

  it("returns state_mismatch at claim settle when the channel cannot be rebound", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    channelMocks.fetchAndVerifyOpenChannel.mockRejectedValue(new Error("channel is not open"));
    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });

    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_channel_state",
    });
  });

  it("rejects a missing voucher signature on non-deposit settle", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    await expect(
      facilitator.settle(payload, { ...requirements, amount: "0" }),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_missing_voucher",
    });
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).not.toHaveBeenCalled();
  });

  it("rejects a forged voucher signature at claim settle", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    const forged = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 1n, // wrong amount vs settle requirements
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature: forged } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_voucher_signature",
    });
  });

  it("accepts a zero-amount claim settle with an explicit voucher for 0", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(uptoPayload.expiresAt),
    });
    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true, amount: "0" });
    // Zero-charge path: no voucher is submitted onchain (has_voucher = 0).
    expect(channelMocks.submitSettle).toHaveBeenCalled();
  });

  describe("duplicate settlement cache", () => {
    async function settleWithAmount(
      facilitator: UptoSvmScheme,
      payload: PaymentPayload,
      requirements: PaymentRequirements,
      receiverAuthorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
      uptoPayload: UptoSvmPayloadV2,
      amount: string,
    ) {
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: BigInt(amount),
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      return facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature } },
        { ...requirements, amount },
      );
    }

    it("rejects a replayed settle for the same channel after the first claim", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();

      await expect(
        settleWithAmount(facilitator, payload, requirements, receiverAuthorizer, uptoPayload, "0"),
      ).resolves.toMatchObject({ success: true, amount: "0" });
      await expect(
        settleWithAmount(facilitator, payload, requirements, receiverAuthorizer, uptoPayload, "0"),
      ).resolves.toMatchObject({
        success: false,
        errorReason: "duplicate_settlement",
      });
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
    });

    it("rejects concurrent settles with different valid amounts after one claim", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();

      const results = await Promise.all([
        settleWithAmount(
          facilitator,
          payload,
          requirements,
          receiverAuthorizer,
          uptoPayload,
          "100",
        ),
        settleWithAmount(
          facilitator,
          payload,
          requirements,
          receiverAuthorizer,
          uptoPayload,
          "200",
        ),
      ]);

      const successes = results.filter(r => r.success);
      const duplicates = results.filter(r => r.errorReason === "duplicate_settlement");
      expect(successes).toHaveLength(1);
      expect(duplicates).toHaveLength(1);
      expect(["100", "200"]).toContain(successes[0]?.amount);
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
    });

    it("does not claim the cache for an invalid voucher", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      const forged = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 1n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });

      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, voucherSignature: forged } },
          { ...requirements, amount: "0" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: "invalid_upto_svm_payload_voucher_signature",
      });
      expect(channelMocks.submitSettle).not.toHaveBeenCalled();

      await expect(
        settleWithAmount(facilitator, payload, requirements, receiverAuthorizer, uptoPayload, "0"),
      ).resolves.toMatchObject({ success: true, amount: "0" });
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
    });

    it("does not claim the cache when the channel is not open", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      channelMocks.fetchAndVerifyOpenChannel.mockRejectedValueOnce(
        new Error("channel is not open"),
      );

      await expect(
        settleWithAmount(facilitator, payload, requirements, receiverAuthorizer, uptoPayload, "0"),
      ).resolves.toMatchObject({
        success: false,
        errorReason: "invalid_upto_svm_channel_state",
      });
      expect(channelMocks.submitSettle).not.toHaveBeenCalled();

      await expect(
        settleWithAmount(facilitator, payload, requirements, receiverAuthorizer, uptoPayload, "0"),
      ).resolves.toMatchObject({ success: true, amount: "0" });
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
    });
  });

  describe("review fixes", () => {
    it.each([
      ["empty string", ""],
      ["malformed base58", "not-valid-base58!!!"],
    ])(
      "rejects client voucherSignature at verify (%s) without touching the chain",
      async (_label, voucherSignature) => {
        const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
        await expect(
          facilitator.verify(
            {
              ...payload,
              payload: { ...uptoPayload, voucherSignature },
            },
            requirements,
          ),
        ).resolves.toMatchObject({
          isValid: false,
          invalidReason: ERR_UNEXPECTED_VOUCHER,
        });
        expect(channelMocks.channelExists).not.toHaveBeenCalled();
        expect(channelMocks.simulateOpenSettleDistribute).not.toHaveBeenCalled();
        expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
        expect(channelMocks.submitSettle).not.toHaveBeenCalled();
      },
    );

    it("rejects a well-formed client voucher at verify without touching the chain", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      await expect(
        facilitator.verify(
          {
            ...payload,
            payload: { ...uptoPayload, voucherSignature },
          },
          requirements,
        ),
      ).resolves.toMatchObject({
        isValid: false,
        invalidReason: ERR_UNEXPECTED_VOUCHER,
      });
      expect(channelMocks.channelExists).not.toHaveBeenCalled();
      expect(channelMocks.simulateOpenSettleDistribute).not.toHaveBeenCalled();
      expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
      expect(channelMocks.submitSettle).not.toHaveBeenCalled();
    });

    it("accepts verify payloads that omit voucherSignature", async () => {
      const { facilitator, payload, requirements } = await buildFixture();
      await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
        isValid: true,
      });
      expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    });

    it("returns success when channel storage upsert fails after confirmed settle", async () => {
      const settleSignature = "SettleSig1111111111111111111111111111111111";
      const onStorageError = vi.fn();
      channelMocks.submitSettle.mockResolvedValue(settleSignature);
      const failingStorage: UptoChannelStorage = {
        upsert: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        get: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
      };
      const feePayer = await generateKeyPairSigner();
      const fixture = await (async () => {
        const payer = await generateKeyPairSigner();
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
          maxTimeoutSeconds: 300,
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
        const facilitator = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer), {
          channelStorage: failingStorage,
          onStorageError,
        });
        return {
          facilitator,
          payload: {
            x402Version: 2,
            accepted: requirements,
            payload: uptoPayload as unknown as Record<string, unknown>,
          },
          requirements,
          receiverAuthorizer,
          uptoPayload,
        };
      })();
      const voucherSignature = await signVoucher(fixture.receiverAuthorizer, {
        channelId: fixture.uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(fixture.uptoPayload.expiresAt),
      });

      await expect(
        fixture.facilitator.settle(
          {
            ...fixture.payload,
            payload: { ...fixture.uptoPayload, voucherSignature },
          },
          { ...fixture.requirements, amount: "0" },
        ),
      ).resolves.toMatchObject({
        success: true,
        transaction: settleSignature,
      });
      expect(failingStorage.upsert).toHaveBeenCalled();
      expect(onStorageError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ channelId: fixture.uptoPayload.channelId, phase: "settle" }),
      );
    });

    it("returns transaction_failed when submitSettle fails before confirmation", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      channelMocks.submitSettle.mockRejectedValue(new Error("rpc send failed"));
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, voucherSignature } },
          { ...requirements, amount: "0" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: "transaction_failed",
        transaction: "",
      });
    });

    // A confirmation timeout means the transaction's fate is unknown, not
    // failed — it is reported as the generic, non-terminal settlement_pending
    // reason (unified with EVM/the wire spec) with the broadcast signature
    // preserved, instead of the previous terminal-looking distinct reason, so
    // the resource server's automatic retry (and, on a subsequent settle
    // call, this scheme's own pending-settlement fast path) can reconcile
    // against it.
    it("returns settlement_pending with the broadcast signature when confirmation times out", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      channelMocks.submitSettle.mockRejectedValue(
        new SettlementConfirmationTimeoutError(
          "Sig11111111111111111111111111111111111111111" as never,
        ),
      );
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, voucherSignature } },
          { ...requirements, amount: "0" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: ErrSettlementPending,
        transaction: "Sig11111111111111111111111111111111111111111",
      });
    });

    // The claim cache must survive a confirmation timeout: the first
    // transaction may still land, so a retry must not be allowed to race a
    // second settle_and_seal against it while the outcome is unresolved.
    // (Reconciliation of the cached signature on a subsequent settle call is
    // covered by dedicated pending-settlement-store tests, which mock the
    // signer's confirmTransaction directly rather than exercising a real RPC.)
    it("keeps the claim cache entry after a confirmation timeout, blocking a fresh re-submit", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      channelMocks.submitSettle.mockRejectedValue(
        new SettlementConfirmationTimeoutError(
          "Sig11111111111111111111111111111111111111111" as never,
        ),
      );
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      const claimPayload = { ...payload, payload: { ...uptoPayload, voucherSignature } };
      const claimRequirements = { ...requirements, amount: "0" };

      await expect(facilitator.settle(claimPayload, claimRequirements)).resolves.toMatchObject({
        success: false,
        errorReason: ErrSettlementPending,
      });
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
    });

    it("releases the claim cache when submitSettle fails so a retry can proceed", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      channelMocks.submitSettle
        .mockRejectedValueOnce(new Error("rpc send failed"))
        .mockResolvedValueOnce(USDC_MAINNET_ADDRESS as never);
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      const claimPayload = { ...payload, payload: { ...uptoPayload, voucherSignature } };
      const claimRequirements = { ...requirements, amount: "0" };

      await expect(facilitator.settle(claimPayload, claimRequirements)).resolves.toMatchObject({
        success: false,
        errorReason: "transaction_failed",
      });
      await expect(facilitator.settle(claimPayload, claimRequirements)).resolves.toMatchObject({
        success: true,
        amount: "0",
      });
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(2);
    });

    it("fails closed when channel storage upsert fails before deposit broadcast", async () => {
      const onStorageError = vi.fn();
      const failingStorage: UptoChannelStorage = {
        upsert: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        get: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
      };
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
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
        maxTimeoutSeconds: 300,
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
      const scheme = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer), {
        channelStorage: failingStorage,
        onStorageError,
      });
      await expect(
        scheme.settle(
          {
            x402Version: 2,
            accepted: requirements,
            payload: uptoPayload as unknown as Record<string, unknown>,
          },
          requirements,
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: ERR_CHANNEL_BROADCAST,
      });
      expect(failingStorage.upsert).toHaveBeenCalled();
      expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
      expect(onStorageError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ channelId: uptoPayload.channelId, phase: "settle" }),
      );
    });

    it("succeeds on retry once channel storage recovers from a prior deposit failure", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
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
        maxTimeoutSeconds: 300,
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
      const toggleableStorage: UptoChannelStorage = {
        upsert: vi
          .fn()
          .mockRejectedValueOnce(new Error("storage unavailable"))
          .mockResolvedValueOnce(undefined),
        get: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
      };
      const scheme = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer), {
        channelStorage: toggleableStorage,
      });
      const payload = {
        x402Version: 2,
        accepted: requirements,
        payload: uptoPayload as unknown as Record<string, unknown>,
      };

      await expect(scheme.settle(payload, requirements)).resolves.toMatchObject({
        success: false,
        errorReason: ERR_CHANNEL_BROADCAST,
      });
      await expect(scheme.settle(payload, requirements)).resolves.toMatchObject({
        success: true,
      });
    });

    it("throws when UptoSvmScheme is constructed with a signer lacking upto read RPC", () => {
      const exactOnlySigner: FacilitatorSvmSigner = {
        getAddresses: () => ["11111111111111111111111111111111" as never],
        getSigner: vi.fn(),
        signTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        confirmTransaction: vi.fn(),
      };
      expect(() => new UptoSvmScheme(exactOnlySigner as never)).toThrow(
        "UptoSvmScheme requires getAccountInfo on the signer",
      );
    });

    it("throws when UptoSvmRentCleanupManager is constructed with a signer lacking upto read RPC", () => {
      const exactOnlySigner: FacilitatorSvmSigner = {
        getAddresses: () => ["11111111111111111111111111111111" as never],
        getSigner: vi.fn(),
        signTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        confirmTransaction: vi.fn(),
      };
      expect(
        () =>
          new UptoSvmRentCleanupManager({
            signer: exactOnlySigner as never,
            storage: { upsert: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
            network: SOLANA_DEVNET_CAIP2,
          }),
      ).toThrow("UptoSvmRentCleanupManager requires getAccountInfo on the signer");
    });

    it("returns invalid_upto_svm_settlement_simulation when claim submitSettle simulation fails", async () => {
      const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
        await buildFixture();
      channelMocks.submitSettle.mockRejectedValue(
        new SettlementSimulationError(new Error("sim failed")),
      );
      const voucherSignature = await signVoucher(receiverAuthorizer, {
        channelId: uptoPayload.channelId,
        cumulativeAmount: 0n,
        expiresAt: BigInt(uptoPayload.expiresAt),
      });
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, voucherSignature } },
          { ...requirements, amount: "0" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: "invalid_upto_svm_settlement_simulation",
      });
    });
  });

  describe("delegated receiver authorizer", () => {
    async function buildDelegatedFixture(
      resolveCallerIdentity: (ctx: {
        step: string;
      }) => Promise<string | undefined> | string | undefined = async (): Promise<string> => "svc-1",
    ): Promise<
      Awaited<ReturnType<typeof buildFixture>> & {
        authorizerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
        store: InMemoryUptoDelegatedAuthStore;
      }
    > {
      const store = new InMemoryUptoDelegatedAuthStore();
      const authorizerSigner = await generateKeyPairSigner();
      const fixture = await buildFixture(
        {
          authorizerSigner,
          resolveCallerIdentity,
          delegatedAuthStore: store,
        },
        { receiverAuthorizer: authorizerSigner },
      );
      return { ...fixture, authorizerSigner, store };
    }

    it("getExtra includes receiverAuthorizer only when authorizerSigner is set", async () => {
      const { facilitator } = await buildFixture();
      expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).toEqual({
        feePayer: expect.any(String),
      });
      expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).not.toHaveProperty("receiverAuthorizer");

      const authorizerSigner = await generateKeyPairSigner();
      const delegated = new UptoSvmScheme(toFacilitatorSvmSigner(await generateKeyPairSigner()), {
        authorizerSigner,
        resolveCallerIdentity: () => "svc-1",
      });
      expect(delegated.getExtra(SOLANA_DEVNET_CAIP2)).toEqual({
        feePayer: expect.any(String),
        receiverAuthorizer: authorizerSigner.address,
      });
    });

    it("constructor throws without resolveCallerIdentity", async () => {
      const feePayer = await generateKeyPairSigner();
      const authorizerSigner = await generateKeyPairSigner();
      expect(
        () => new UptoSvmScheme(toFacilitatorSvmSigner(feePayer), { authorizerSigner }),
      ).toThrow(/resolveCallerIdentity/);
    });

    it("InMemoryUptoDelegatedAuthStore bind is first-writer-wins", async () => {
      const store = new InMemoryUptoDelegatedAuthStore();
      const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
      const binding = {
        channelId: "ch-1",
        network: SOLANA_DEVNET_CAIP2,
        callerIdentity: "svc-1",
        expiresAt,
      };

      await store.bind(binding);
      await store.bind(binding);

      await expect(store.bind({ ...binding, callerIdentity: "svc-2" })).rejects.toBeInstanceOf(
        UptoDelegatedAuthIdentityConflictError,
      );

      expect(await store.get("ch-1", SOLANA_DEVNET_CAIP2)).toMatchObject({
        callerIdentity: "svc-1",
      });
    });

    it("InMemoryUptoDelegatedAuthStore bind replaces expired bindings", async () => {
      const store = new InMemoryUptoDelegatedAuthStore();
      const expiredAt = Math.floor(Date.now() / 1000) - 1;
      const expiresAt = Math.floor(Date.now() / 1000) + 3_600;

      await store.bind({
        channelId: "ch-1",
        network: SOLANA_DEVNET_CAIP2,
        callerIdentity: "svc-1",
        expiresAt: expiredAt,
      });
      await store.bind({
        channelId: "ch-1",
        network: SOLANA_DEVNET_CAIP2,
        callerIdentity: "svc-2",
        expiresAt,
      });

      expect(await store.get("ch-1", SOLANA_DEVNET_CAIP2)).toMatchObject({
        callerIdentity: "svc-2",
      });
    });

    it("routes a full-charge type=claim as a claim, not a deposit", async () => {
      const resolveCallerIdentity = vi.fn().mockResolvedValue("svc-1");
      const { facilitator, payload, requirements, uptoPayload, store, authorizerSigner } =
        await buildDelegatedFixture(resolveCallerIdentity);

      // Deposit first so the binding exists.
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "deposit" } },
          requirements,
        ),
      ).resolves.toMatchObject({ success: true });
      expect(channelMocks.broadcastOpen).toHaveBeenCalledTimes(1);

      channelMocks.broadcastOpen.mockClear();
      channelMocks.fetchAndVerifyOpenChannel.mockResolvedValue({
        authorizedSigner: authorizerSigner.address,
        channelId: uptoPayload.channelId,
        deposit: 1_000_000n,
        mint: requirements.asset,
        openSlot: OPEN_SLOT,
        payee: requirements.extra!.feePayer,
        payer: uptoPayload.from,
        rentPayer: requirements.extra!.feePayer,
        splits: [{ bps: 10_000, recipient: authorizerSigner.address }],
      });

      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "claim" } },
          requirements, // amount === maxAmount; old inference would treat this as a deposit
        ),
      ).resolves.toMatchObject({ success: true, amount: "1000000" });
      expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
      expect(await store.get(uptoPayload.channelId, requirements.network)).toBeUndefined();
    });

    it("rejects a delegated settle missing type", async () => {
      const { facilitator, payload, requirements } = await buildDelegatedFixture();
      await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
        success: false,
        errorReason: ERR_PAYLOAD_TYPE,
      });
      expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    });

    it("rejects client-supplied type at verify", async () => {
      const { facilitator, payload, requirements, uptoPayload } = await buildDelegatedFixture();
      await expect(
        facilitator.verify(
          { ...payload, payload: { ...uptoPayload, type: "deposit" } },
          requirements,
        ),
      ).resolves.toMatchObject({
        isValid: false,
        invalidReason: ERR_PAYLOAD_TYPE,
      });
    });

    it("signs and settles a delegated claim after a matching deposit identity", async () => {
      const resolveCallerIdentity = vi.fn().mockResolvedValue("svc-1");
      const { facilitator, payload, requirements, uptoPayload, store, authorizerSigner } =
        await buildDelegatedFixture(resolveCallerIdentity);

      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "deposit" } },
          requirements,
        ),
      ).resolves.toMatchObject({ success: true });
      expect(await store.get(uptoPayload.channelId, requirements.network)).toMatchObject({
        callerIdentity: "svc-1",
      });

      channelMocks.fetchAndVerifyOpenChannel.mockResolvedValue({
        authorizedSigner: authorizerSigner.address,
        channelId: uptoPayload.channelId,
        deposit: 1_000_000n,
        mint: requirements.asset,
        openSlot: OPEN_SLOT,
        payee: requirements.extra!.feePayer,
        payer: uptoPayload.from,
        rentPayer: requirements.extra!.feePayer,
        splits: [{ bps: 10_000, recipient: authorizerSigner.address }],
      });

      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "claim" } },
          { ...requirements, amount: "1858" },
        ),
      ).resolves.toMatchObject({ success: true, amount: "1858" });
      expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
      expect(resolveCallerIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ step: "deposit", channelId: uptoPayload.channelId }),
      );
      expect(resolveCallerIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ step: "claim", channelId: uptoPayload.channelId }),
      );
      expect(await store.get(uptoPayload.channelId, requirements.network)).toBeUndefined();
    });

    it("rejects a claim from a different identity without broadcasting", async () => {
      const resolveCallerIdentity = vi
        .fn()
        .mockResolvedValueOnce("svc-1")
        .mockResolvedValueOnce("svc-2");
      const { facilitator, payload, requirements, uptoPayload } =
        await buildDelegatedFixture(resolveCallerIdentity);

      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "deposit" } },
          requirements,
        ),
      ).resolves.toMatchObject({ success: true });
      channelMocks.fetchAndVerifyOpenChannel.mockClear();
      channelMocks.submitSettle.mockClear();

      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "claim" } },
          { ...requirements, amount: "1858" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: ERR_DELEGATED_SETTLE_UNAUTHENTICATED,
      });
      expect(channelMocks.submitSettle).not.toHaveBeenCalled();
      expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    });

    it("rejects a claim with no stored binding", async () => {
      const { facilitator, payload, requirements, uptoPayload } = await buildDelegatedFixture();
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "claim" } },
          { ...requirements, amount: "1858" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: ERR_DELEGATED_SETTLE_UNAUTHENTICATED,
      });
      expect(channelMocks.submitSettle).not.toHaveBeenCalled();
      expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    });

    it.each([
      ["undefined", async (): Promise<undefined> => undefined],
      [
        "throwing",
        async (): Promise<undefined> => {
          throw new Error("no creds");
        },
      ],
    ] as const)(
      "rejects when resolveCallerIdentity is %s at deposit and claim",
      async (_label, resolver) => {
        const { facilitator, payload, requirements, uptoPayload } =
          await buildDelegatedFixture(resolver);

        await expect(
          facilitator.settle(
            { ...payload, payload: { ...uptoPayload, type: "deposit" } },
            requirements,
          ),
        ).resolves.toMatchObject({
          success: false,
          errorReason: ERR_DELEGATED_SETTLE_UNAUTHENTICATED,
        });
        expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
        expect(channelMocks.simulateOpenSettleDistribute).not.toHaveBeenCalled();

        await expect(
          facilitator.settle(
            { ...payload, payload: { ...uptoPayload, type: "claim" } },
            { ...requirements, amount: "1858" },
          ),
        ).resolves.toMatchObject({
          success: false,
          errorReason: ERR_DELEGATED_SETTLE_UNAUTHENTICATED,
        });
        expect(channelMocks.submitSettle).not.toHaveBeenCalled();
      },
    );

    it("rejects a delegated claim when authorizerSigner is not configured", async () => {
      const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "claim" } },
          { ...requirements, amount: "1858" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: ERR_AUTHORIZER_NOT_CONFIGURED,
      });
    });

    it("rejects a delegated claim whose authorizer is not this facilitator", async () => {
      const authorizerSigner = await generateKeyPairSigner();
      const { facilitator, payload, requirements, uptoPayload } = await buildFixture({
        authorizerSigner,
        resolveCallerIdentity: () => "svc-1",
      });
      // extra.receiverAuthorizer is still the fixture's server key, not authorizerSigner
      await expect(
        facilitator.settle(
          { ...payload, payload: { ...uptoPayload, type: "claim" } },
          { ...requirements, amount: "1858" },
        ),
      ).resolves.toMatchObject({
        success: false,
        errorReason: ERR_AUTHORIZER_ADDRESS_MISMATCH,
      });
    });
  });
});
