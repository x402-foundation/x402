import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  broadcastOpen: vi.fn(),
  channelExists: vi.fn(),
  fetchAndVerifyOpenChannel: vi.fn(),
  simulateOpenSettleDistribute: vi.fn(),
  simulateZeroChargeSettle: vi.fn(),
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
    simulateZeroChargeSettle: channelMocks.simulateZeroChargeSettle,
    submitSettle: channelMocks.submitSettle,
  };
});

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({
      getSlot: () => ({ send: async () => 123_456_789n }),
    }),
  };
});

import {
  TOKEN_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/constants";
import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { signVoucher } from "../../src/payment-channels/voucher";
import { toFacilitatorSvmSigner } from "../../src/signer";
import type { FacilitatorSvmSigner } from "../../src/signer";
import { ERR_UNEXPECTED_VOUCHER, UptoSvmScheme } from "../../src/upto/facilitator/scheme";
import type { UptoChannelStorage } from "../../src/upto/facilitator/channelStorage";
import { UptoSvmRentCleanupManager } from "../../src/upto/facilitator/rentCleanupManager";
import type { UptoSvmPayloadV2 } from "../../src/types";

const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;
const FAR_FUTURE = 4_102_444_800;

describe("UptoSvmScheme facilitator channel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.channelExists.mockResolvedValue(true);
    channelMocks.simulateOpenSettleDistribute.mockResolvedValue(undefined);
    channelMocks.simulateZeroChargeSettle.mockResolvedValue(undefined);
    channelMocks.broadcastOpen.mockResolvedValue(USDC_MAINNET_ADDRESS);
    channelMocks.submitSettle.mockResolvedValue(USDC_MAINNET_ADDRESS);
  });

  async function buildFixture() {
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
      expiresAt: FAR_FUTURE,
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
    const facilitator = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer));
    return { facilitator, payload, requirements, receiverAuthorizer, uptoPayload };
  }

  it("settles without a prior verify on the same instance when the channel is open", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(FAR_FUTURE),
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
    expect(channelMocks.simulateZeroChargeSettle).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
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

  it("allows repeated verify for an already-open channel", async () => {
    const { facilitator, payload, requirements } = await buildFixture();

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledTimes(2);
    expect(channelMocks.simulateZeroChargeSettle).toHaveBeenCalledTimes(2);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
  });

  it("indexes the channel on verify and retains it after settle", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    const stored = await facilitator.getChannelStorage().get(uptoPayload.channelId);
    expect(stored).toMatchObject({
      channelId: uptoPayload.channelId,
      payTo: requirements.payTo,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      network: requirements.network,
      expiresAt: FAR_FUTURE,
    });
    const firstSeenAt = stored!.firstSeenAt;
    const expiresAt = stored!.expiresAt;

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(FAR_FUTURE),
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

  it("simulates open∥settle∥distribute before broadcasting a fresh open", async () => {
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

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });

    expect(callOrder).toEqual(["simulateOpenSettleDistribute", "broadcastOpen"]);
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        openTransactionBase64: uptoPayload.openTransaction,
        channel: expect.objectContaining({
          channelId: uptoPayload.channelId,
          payer: uptoPayload.from,
        }),
      }),
    );
    expect(channelMocks.simulateZeroChargeSettle).not.toHaveBeenCalled();
  });

  it("does not broadcast open when composite settlement simulation fails", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.simulateOpenSettleDistribute.mockRejectedValue(
      new Error("zero-charge settlement simulation failed: missing treasury ATA"),
    );

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_svm_settlement_simulation",
    });
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
  });

  it("returns broadcast_failed when open broadcast fails after a successful sim", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.broadcastOpen.mockRejectedValue(new Error("sendTransaction failed"));

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_svm_channel_broadcast",
    });
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).toHaveBeenCalledTimes(1);
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
  });

  it("returns state_mismatch when the confirmed channel does not bind", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    channelMocks.fetchAndVerifyOpenChannel.mockRejectedValue(
      new Error("channel deposit 0 != expected 1000000"),
    );

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_svm_channel_state",
    });
  });

  it("returns state_mismatch at settle when the channel cannot be rebound", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    channelMocks.fetchAndVerifyOpenChannel.mockRejectedValue(new Error("channel is not open"));
    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(FAR_FUTURE),
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

  it("rejects a missing voucher signature at settle", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(
      facilitator.settle(payload, { ...requirements, amount: "0" }),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_missing_voucher",
    });
  });

  it("rejects a forged voucher signature at settle", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    const forged = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 1n, // wrong amount vs settle requirements
      expiresAt: BigInt(FAR_FUTURE),
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

  it("accepts a zero-amount settle with an explicit voucher for 0", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(FAR_FUTURE),
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
        expiresAt: BigInt(FAR_FUTURE),
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
        expiresAt: BigInt(FAR_FUTURE),
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
        expiresAt: BigInt(FAR_FUTURE),
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
          expiresAt: FAR_FUTURE,
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
        expiresAt: BigInt(FAR_FUTURE),
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
        expiresAt: BigInt(FAR_FUTURE),
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

    it("returns isValid true when channel storage upsert fails after verify", async () => {
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
        expiresAt: FAR_FUTURE,
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
        scheme.verify(
          {
            x402Version: 2,
            accepted: requirements,
            payload: uptoPayload as unknown as Record<string, unknown>,
          },
          requirements,
        ),
      ).resolves.toMatchObject({
        isValid: true,
      });
      expect(failingStorage.upsert).toHaveBeenCalled();
      expect(onStorageError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ channelId: uptoPayload.channelId, phase: "verify" }),
      );
    });

    it("throws when UptoSvmScheme is constructed with a signer lacking getSigner", () => {
      const exactOnlySigner: FacilitatorSvmSigner = {
        getAddresses: () => ["11111111111111111111111111111111" as never],
        signTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        confirmTransaction: vi.fn(),
      };
      expect(() => new UptoSvmScheme(exactOnlySigner)).toThrow(
        "UptoSvmScheme requires getSigner on the signer",
      );
    });

    it("throws when UptoSvmRentCleanupManager is constructed with a signer lacking getSigner", () => {
      const exactOnlySigner: FacilitatorSvmSigner = {
        getAddresses: () => ["11111111111111111111111111111111" as never],
        signTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        confirmTransaction: vi.fn(),
      };
      expect(
        () =>
          new UptoSvmRentCleanupManager({
            signer: exactOnlySigner,
            storage: { upsert: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
            network: SOLANA_DEVNET_CAIP2,
          }),
      ).toThrow("UptoSvmRentCleanupManager requires getSigner on the signer");
    });
  });
});
