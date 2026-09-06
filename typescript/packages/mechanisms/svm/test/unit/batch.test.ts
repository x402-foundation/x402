import { generateKeyPairSigner, getTransactionDecoder, getBase64Codec } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import { BatchError } from "../../src/batch-settlement/errors";
import {
  BatchChannelTracker,
  buildDepositPayload,
  buildRefundPayload,
  signBatchVoucher,
} from "../../src/batch-settlement/client/channel";
import {
  BatchSvmScheme as BatchClientScheme,
  type BatchClientChannelStorage,
} from "../../src/batch-settlement/client/scheme";
import {
  BatchSvmScheme as BatchFacilitatorScheme,
  calculateDistributionAmount,
} from "../../src/batch-settlement/facilitator/scheme";
import { BatchSvmScheme as BatchServerScheme } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore, type ChannelState } from "../../src/batch-settlement/server/storage";
import {
  isBatchPayload,
  isBatchFacilitatorPayload,
  isBatchVoucher,
  type BatchChannelConfig,
  type BatchVoucher,
} from "../../src/batch-settlement/types";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  buildRequestCloseTransaction,
  verifyRequestCloseTransaction,
} from "../../src/payment-channels/close";
import { SEAL_DISCRIMINATOR } from "../../src/payment-channels/generated/instructions/seal";
import { SETTLE_DISCRIMINATOR } from "../../src/payment-channels/generated/instructions/settle";
import { buildSealInstruction, buildSettleInstructions } from "../../src/payment-channels/onchain";
import { verifyOpenTransaction } from "../../src/payment-channels/open";
import {
  encodeVoucherMessageBytes,
  verifyVoucherSignature,
} from "../../src/payment-channels/voucher";
import { toFacilitatorSvmSigner } from "../../src/signer";

const DUMMY_BLOCKHASH = USDC_MAINNET_ADDRESS;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let channelConfig: BatchChannelConfig;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  const built = await buildDepositPayload({
    blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 1n },
    depositAmount: 10_000n,
    feePayer: feePayer.address,
    firstCharge: 1_000n,
    mint: MINT,
    openSlot: OPEN_SLOT,
    payer,
    receiver: RECEIVER,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: WITHDRAW_DELAY,
  });
  channelId = built.channelId;
  channelConfig = built.payload.channelConfig;
});

function requirements(amount = "1000"): PaymentRequirements {
  return {
    amount,
    asset: MINT,
    extra: {
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: WITHDRAW_DELAY,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function serverState(overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    channelConfig,
    channelId,
    chargedCumulativeAmount: 0n,
    deposit: 10_000n,
    feePayer: feePayer.address,
    mint: MINT,
    openSlot: OPEN_SLOT,
    payer: payer.address,
    payerAuthorizer: payer.address,
    payoutWatermark: 0n,
    receiver: RECEIVER,
    salt: BigInt(channelConfig.salt),
    settled: 0n,
    signedMaxClaimable: 0n,
    status: "open",
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: WITHDRAW_DELAY,
    ...overrides,
  };
}

async function signedVoucher(maxClaimableAmount: bigint, expiresAt = 0): Promise<BatchVoucher> {
  return signBatchVoucher(payer, { channelId, expiresAt, maxClaimableAmount });
}

describe("batch-settlement SVM", () => {
  describe("resource server", () => {
    it("parses stablecoin prices", async () => {
      const server = new BatchServerScheme();
      expect(await server.parsePrice("$0.001", SOLANA_MAINNET_CAIP2)).toMatchObject({
        amount: "1000",
        asset: USDC_MAINNET_ADDRESS,
      });
      expect(await server.parsePrice("1.00", SOLANA_DEVNET_CAIP2)).toMatchObject({
        amount: "1000000",
        asset: USDC_DEVNET_ADDRESS,
      });
    });

    it("publishes the authorization/channel requirements", async () => {
      const server = new BatchServerScheme({ withdrawDelay: 1_200 });
      const enhanced = await server.enhancePaymentRequirements(
        requirements(),
        {
          extra: { feePayer: feePayer.address },
          network: SOLANA_DEVNET_CAIP2,
          scheme: "batch-settlement",
          x402Version: 2,
        },
        [],
      );
      expect(server.defaultAssetTransferMethod).toBe("channel");
      expect(server.paymentFlows.channel.default).toBe("authorization");
      expect(enhanced.extra).toMatchObject({
        feePayer: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 1_200,
      });
      expect(enhanced.extra).not.toHaveProperty("paymentFlow");
    });

    it("broadcasts the deposit and commits its voucher only in the post-handler settle", async () => {
      const store = new MemoryChannelStore();
      const server = new BatchServerScheme({ store });
      const voucher = await signedVoucher(1_000n);
      const payment = {
        accepted: requirements(),
        payload: {
          channelConfig,
          deposit: { amount: "10000", transaction: "setup-transaction" },
          type: "deposit" as const,
          voucher,
        },
        x402Version: 2,
      };
      const verifyContext = {
        declaredExtensions: {},
        paymentPayload: payment,
        requirements: requirements(),
      };
      const beforeVerify = await server.schemeHooks.onBeforeVerify!(verifyContext);
      expect(beforeVerify).toBeUndefined();
      await server.schemeHooks.onAfterVerify!({
        ...verifyContext,
        result: { isValid: true, payer: payer.address },
      });

      expect(await store.get(channelId)).toMatchObject({
        chargedCumulativeAmount: 0n,
        pendingRequest: { maxClaimableAmount: 1_000n },
      });

      const forwarded = await server.schemeHooks.onBeforeSettle!({
        ...verifyContext,
        phase: "after-handler",
      });
      expect(forwarded).toBeUndefined();

      await server.schemeHooks.onAfterSettle!({
        ...verifyContext,
        phase: "after-handler",
        result: {
          extra: { channelState: { totalClaimed: "0", withdrawRequestedAt: 0 } },
          network: SOLANA_DEVNET_CAIP2,
          success: true,
          transaction: "open-signature",
        },
      });
      expect(await store.get(channelId)).toMatchObject({
        chargedCumulativeAmount: 1_000n,
        openSignature: "open-signature",
        pendingRequest: undefined,
        signedMaxClaimable: 1_000n,
      });
    });

    it("records a top-up's escrow so the reported balance is not pinned at the open amount", async () => {
      // `deposit` is written once when the channel is provisioned. If a top-up
      // never reached stored state, the balance reported to the client would
      // stay at the original open amount — and the client, which adopts that
      // balance as its own ceiling, would top up again on the next request that
      // exceeded it, and on every request after that, growing the escrow on
      // chain while believing it never had.
      const store = new MemoryChannelStore();
      const server = new BatchServerScheme({ store });

      const open = async (amount: bigint, confirmedBalance: string) => {
        const voucher = await signedVoucher(amount);
        const payment = {
          accepted: requirements(),
          payload: {
            channelConfig,
            deposit: { amount: "10000", transaction: "setup-transaction" },
            type: "deposit" as const,
            voucher,
          },
          x402Version: 2,
        };
        const verifyContext = {
          declaredExtensions: {},
          paymentPayload: payment,
          requirements: requirements(),
        };
        await server.schemeHooks.onBeforeVerify!(verifyContext);
        await server.schemeHooks.onAfterVerify!({
          ...verifyContext,
          result: { isValid: true, payer: payer.address },
        });
        await server.schemeHooks.onBeforeSettle!({ ...verifyContext, phase: "after-handler" });
        await server.schemeHooks.onAfterSettle!({
          ...verifyContext,
          phase: "after-handler",
          result: {
            extra: {
              channelState: {
                balance: confirmedBalance,
                totalClaimed: "0",
                withdrawRequestedAt: 0,
              },
            },
            network: SOLANA_DEVNET_CAIP2,
            success: true,
            transaction: "setup-signature",
          },
        });
      };

      // The channel opens with 10,000 escrowed.
      await open(1_000n, "10000");
      expect((await store.get(channelId))?.deposit).toBe(10_000n);

      // A top-up confirms 25,000 on chain; the facilitator reports it, and the
      // server must adopt it rather than keep reporting the open amount.
      await open(2_000n, "25000");
      expect((await store.get(channelId))?.deposit).toBe(25_000n);

      // A stale or malformed read must never lower a ceiling the chain has
      // already confirmed.
      await open(3_000n, "9000");
      expect((await store.get(channelId))?.deposit).toBe(25_000n);
      await open(4_000n, "not-a-number");
      expect((await store.get(channelId))?.deposit).toBe(25_000n);
    });

    it("releases a reservation without charging when the handler fails", async () => {
      const store = new MemoryChannelStore();
      const server = new BatchServerScheme({ store });
      const voucher = await signedVoucher(1_000n);
      const payment = {
        accepted: requirements(),
        payload: {
          channelConfig,
          deposit: { amount: "10000", transaction: "setup-transaction" },
          type: "deposit" as const,
          voucher,
        },
        x402Version: 2,
      };
      const context = {
        declaredExtensions: {},
        paymentPayload: payment,
        requirements: requirements(),
      };
      await server.schemeHooks.onBeforeVerify!(context);
      await server.schemeHooks.onAfterVerify!({
        ...context,
        result: { isValid: true, payer: payer.address },
      });
      await server.schemeHooks.onVerifiedPaymentCanceled!({
        ...context,
        reason: "handler_threw",
        settledPhases: ["before-handler"],
      });
      expect(await store.get(channelId)).toMatchObject({
        chargedCumulativeAmount: 0n,
        pendingRequest: undefined,
      });
    });

    it("rebuilds an unknown channel from the verified onchain snapshot", async () => {
      const store = new MemoryChannelStore();
      const server = new BatchServerScheme({ store });
      // The client believes it was charged 4000; the chain has settled 2000,
      // which is all this server can rebuild from.
      const voucher = await signedVoucher(5_000n);
      const context = {
        declaredExtensions: {},
        paymentPayload: {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher" as const, voucher },
          x402Version: 2,
        },
        requirements: requirements(),
      };

      // An empty store must not short-circuit the facilitator: only it can say
      // whether the voucher matches confirmed onchain state.
      expect(await server.schemeHooks.onBeforeVerify!(context)).toBeUndefined();
      expect(await store.get(channelId)).toBeUndefined();

      const verified = await server.schemeHooks.onAfterVerify!({
        ...context,
        result: {
          isValid: true,
          payer: payer.address,
          extra: {
            channelState: {
              channelId,
              balance: "10000",
              totalClaimed: "2000",
              withdrawRequestedAt: 0,
            },
          },
        },
      });

      const rebuilt = await store.get(channelId);
      // The settled watermark is the baseline: a record starting at zero would
      // accept vouchers the program can never apply.
      expect(rebuilt).toMatchObject({
        chargedCumulativeAmount: 2_000n,
        deposit: 10_000n,
        settled: 2_000n,
        signedMaxClaimable: 2_000n,
      });
      // 5000 is not 2000 + 1000, so the request is refused — but now there is a
      // record for the corrective 402 to report.
      expect(verified).toMatchObject({
        abort: true,
        reason: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
      });
    });

    it("serves the first voucher a rebuilt record expects", async () => {
      const store = new MemoryChannelStore();
      const server = new BatchServerScheme({ store });
      const voucher = await signedVoucher(3_000n);
      const context = {
        declaredExtensions: {},
        paymentPayload: {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher" as const, voucher },
          x402Version: 2,
        },
        requirements: requirements(),
      };
      await server.schemeHooks.onBeforeVerify!(context);
      const verified = await server.schemeHooks.onAfterVerify!({
        ...context,
        result: {
          isValid: true,
          payer: payer.address,
          extra: {
            channelState: {
              channelId,
              balance: "10000",
              // Settled at 2000, so 2000 + 1000 is exactly what this voucher
              // authorizes.
              totalClaimed: "2000",
              withdrawRequestedAt: 0,
            },
          },
        },
      });
      expect(verified).toBeUndefined();
      expect(await store.get(channelId)).toMatchObject({
        chargedCumulativeAmount: 2_000n,
        pendingRequest: { maxClaimableAmount: 3_000n },
      });
    });

    it("refuses to rebuild a record for a channel that is closing", async () => {
      const store = new MemoryChannelStore();
      const server = new BatchServerScheme({ store });
      const voucher = await signedVoucher(3_000n);
      const context = {
        declaredExtensions: {},
        paymentPayload: {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher" as const, voucher },
          x402Version: 2,
        },
        requirements: requirements(),
      };
      await server.schemeHooks.onBeforeVerify!(context);
      const verified = await server.schemeHooks.onAfterVerify!({
        ...context,
        result: {
          isValid: true,
          payer: payer.address,
          extra: {
            channelState: {
              channelId,
              balance: "10000",
              totalClaimed: "2000",
              // A forced close is running: its grace period bounds redemption,
              // so no further charge may be accepted.
              withdrawRequestedAt: 1_760_000_000,
            },
          },
        },
      });
      expect(verified).toMatchObject({ abort: true, reason: BatchError.CHANNEL_STATE });
      expect(await store.get(channelId)).toBeUndefined();
    });

    it("carries the charged base and its own proof in a corrective 402", async () => {
      const store = new MemoryChannelStore();
      const held = await signedVoucher(3_000n);
      await store.put(
        serverState({
          chargedCumulativeAmount: 3_000n,
          highestVoucherExpiresAt: 0,
          highestVoucherSignature: held.signature,
          settled: 2_000n,
          signedMaxClaimable: 3_000n,
        }),
      );
      const server = new BatchServerScheme({ store });
      const stale = await signedVoucher(9_000n);
      const paymentPayload = {
        accepted: requirements(),
        payload: { channelConfig, type: "voucher" as const, voucher: stale },
        x402Version: 2,
      };
      const context = { declaredExtensions: {}, paymentPayload, requirements: requirements() };
      expect(await server.schemeHooks.onBeforeVerify!(context)).toMatchObject({
        abort: true,
        reason: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
      });

      const accepts = [requirements()];
      const enriched = await server.enrichPaymentRequiredResponse({
        error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
        paymentPayload,
        paymentRequiredResponse: { accepts, x402Version: 2 },
        requirements: accepts,
        resourceInfo: { url: "https://example.test/paid" },
      });
      expect(enriched?.[0]?.extra).toMatchObject({
        channelState: { chargedCumulativeAmount: "3000", totalClaimed: "2000" },
        // The proof is the client's own signature at that cumulative amount,
        // so the client can check the base rather than trust it.
        voucherState: { expiresAt: 0, signature: held.signature, signedMaxClaimable: "3000" },
      });
      // And the proof verifies against the client's authorizer key.
      const state = enriched![0]!.extra!.voucherState as {
        signedMaxClaimable: string;
        expiresAt: number;
        signature: string;
      };
      expect(
        await verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId,
            cumulativeAmount: BigInt(state.signedMaxClaimable),
            expiresAt: BigInt(state.expiresAt),
          }),
          signatureBase58: state.signature,
          signerBase58: channelConfig.payerAuthorizer,
        }),
      ).toBe(true);
    });

    it("omits the voucher proof when it holds no accepted voucher", async () => {
      const store = new MemoryChannelStore();
      // A record rebuilt from chain has a base but no signature to prove it.
      await store.put(serverState({ chargedCumulativeAmount: 2_000n, settled: 2_000n }));
      const server = new BatchServerScheme({ store });
      const stale = await signedVoucher(9_000n);
      const paymentPayload = {
        accepted: requirements(),
        payload: { channelConfig, type: "voucher" as const, voucher: stale },
        x402Version: 2,
      };
      await server.schemeHooks.onBeforeVerify!({
        declaredExtensions: {},
        paymentPayload,
        requirements: requirements(),
      });
      const accepts = [requirements()];
      const enriched = await server.enrichPaymentRequiredResponse({
        error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
        paymentPayload,
        paymentRequiredResponse: { accepts, x402Version: 2 },
        requirements: accepts,
        resourceInfo: { url: "https://example.test/paid" },
      });
      expect(enriched?.[0]?.extra?.channelState).toMatchObject({
        chargedCumulativeAmount: "2000",
      });
      expect(enriched?.[0]?.extra?.voucherState).toBeUndefined();
    });

    it("reports the real charged amount when settling a replay", async () => {
      const store = new MemoryChannelStore();
      const voucher = await signedVoucher(1_000n);
      await store.put(
        serverState({
          chargedCumulativeAmount: 1_000n,
          highestVoucherExpiresAt: voucher.expiresAt,
          highestVoucherSignature: voucher.signature,
          signedMaxClaimable: 1_000n,
        }),
      );
      const server = new BatchServerScheme({ store });
      const context = {
        declaredExtensions: {},
        paymentPayload: {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher" as const, voucher },
          x402Version: 2,
        },
        requirements: requirements(),
      };
      await server.schemeHooks.onBeforeVerify!(context);

      const settled = await server.schemeHooks.onBeforeSettle!({
        ...context,
        phase: "after-handler",
      });
      // The replayed authorization was charged the request price. Reporting
      // zero would tell the client it paid nothing for a request it paid for.
      expect(settled).toMatchObject({
        result: {
          extra: { chargedAmount: "1000", commitmentId: `${channelId}:1000` },
          success: true,
        },
        skip: true,
      });
    });

    it("re-serves an exact replay only through the application response cache", async () => {
      const store = new MemoryChannelStore();
      const voucher = await signedVoucher(1_000n);
      await store.put(
        serverState({
          chargedCumulativeAmount: 1_000n,
          highestVoucherExpiresAt: voucher.expiresAt,
          highestVoucherSignature: voucher.signature,
          signedMaxClaimable: 1_000n,
        }),
      );
      const server = new BatchServerScheme({
        getReplayResponse: async commitment => ({ body: { commitment, replay: true } }),
        store,
      });
      const payment = {
        accepted: requirements(),
        payload: { channelConfig, type: "voucher" as const, voucher },
        x402Version: 2,
      };
      const context = {
        declaredExtensions: {},
        paymentPayload: payment,
        requirements: requirements(),
      };
      await server.schemeHooks.onBeforeVerify!(context);
      const replay = await server.schemeHooks.onAfterVerify!({
        ...context,
        result: { isValid: true, payer: payer.address },
      });
      expect(replay).toMatchObject({
        response: {
          body: {
            commitment: { channelId, commitmentId: `${channelId}:1000` },
            replay: true,
          },
        },
        skipHandler: true,
      });
    });
  });

  describe("wire types", () => {
    it("accepts only the current nested wire shapes", async () => {
      const voucher = await signedVoucher(1_000n);
      expect(isBatchVoucher(voucher)).toBe(true);
      expect(isBatchVoucher({ ...voucher, maxClaimableAmount: 1_000 })).toBe(false);
      expect(isBatchPayload({ channelConfig, type: "voucher", voucher })).toBe(true);
      expect(
        isBatchPayload({
          channelConfig,
          deposit: { amount: "10000", transaction: "tx" },
          type: "deposit",
          voucher,
        }),
      ).toBe(true);
      expect(isBatchPayload({ channelConfig, transaction: "tx", type: "refund" })).toBe(true);
      expect(isBatchPayload({ channelId, type: "voucher", voucher })).toBe(false);
      expect(
        isBatchFacilitatorPayload({
          claims: [
            {
              signature: voucher.signature,
              voucher: {
                channelConfig,
                channelId,
                expiresAt: voucher.expiresAt,
                maxClaimableAmount: voucher.maxClaimableAmount,
              },
            },
          ],
          type: "claim",
        }),
      ).toBe(true);
      expect(isBatchFacilitatorPayload({ claims: [], type: "claim" })).toBe(false);
    });
  });

  describe("client construction", () => {
    it("signs the canonical 50-byte voucher message", async () => {
      const voucher = await signedVoucher(5_000n);
      expect(voucher.maxClaimableAmount).toBe("5000");
      await expect(
        verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId,
            cumulativeAmount: 5_000n,
            expiresAt: 0n,
          }),
          signatureBase58: voucher.signature,
          signerBase58: payer.address,
        }),
      ).resolves.toBe(true);
    });

    it("tracks cumulative charges and carries the full channelConfig", async () => {
      const tracker = new BatchChannelTracker(channelId, channelConfig, payer);
      expect((await tracker.voucher(1_000n)).maxClaimableAmount).toBe("1000");
      expect((await tracker.voucher(1_500n)).maxClaimableAmount).toBe("2500");
      expect(tracker.channelConfig).toEqual(channelConfig);
    });

    /**
     * Register a pending allocation the way a restarted client would, without
     * touching an RPC.
     */
    async function pendingClient(pending: {
      amount: string;
      cumulative: string;
      deposit: string;
      confirmed?: { cumulative: string; deposit: string };
      payment: Record<string, unknown>;
    }) {
      const records = new Map();
      const storage: BatchClientChannelStorage = {
        delete: async key => {
          records.delete(key);
        },
        get: async key => records.get(key),
        set: async (key, record) => {
          records.set(key, record);
        },
      };
      const key = "pending-allocation";
      await storage.set(key, {
        channelConfig,
        channelId,
        chargedCumulativeAmount: pending.confirmed?.cumulative ?? "0",
        deposit: pending.confirmed?.deposit ?? "0",
        hasConfirmedState: pending.confirmed !== undefined,
        pending: {
          amount: pending.amount,
          chargedCumulativeAmount: pending.cumulative,
          deposit: pending.deposit,
          payment: pending.payment as never,
        },
      });
      const client = new BatchClientScheme(payer, { channelStorage: storage });
      await (
        client as unknown as { loadChannel(channelKey: string): Promise<unknown> }
      ).loadChannel(key);
      return { client, key, storage };
    }

    function voucherPayment(voucher: BatchVoucher) {
      return {
        payload: { channelConfig, type: "voucher" as const, voucher },
        x402Version: 2,
      };
    }

    it("adopts a corrective cumulative base against its own signature", async () => {
      const stale = await signedVoucher(1_000n);
      const { client, key, storage } = await pendingClient({
        amount: "1000",
        cumulative: "1000",
        deposit: "10000",
        payment: voucherPayment(stale),
      });
      // The server holds this client's own signature at 3000.
      const held = await signedVoucher(3_000n);
      const corrective = requirements();
      corrective.extra = {
        ...corrective.extra,
        channelState: {
          balance: "10000",
          channelId,
          chargedCumulativeAmount: "3000",
          totalClaimed: "2000",
          withdrawRequestedAt: 0,
        },
        voucherState: { expiresAt: 0, signature: held.signature, signedMaxClaimable: "3000" },
      };

      const result = await client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: requirements(), ...voucherPayment(stale) },
        paymentRequired: {
          accepts: [corrective],
          error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
          x402Version: 2,
        },
        requirements: requirements(),
        settleResponse: { success: false },
      } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);

      // The transport retries, now signing from the base the server proved.
      expect(result).toMatchObject({ recovered: true });
      expect(await storage.get(key)).toMatchObject({
        chargedCumulativeAmount: "3000",
        deposit: "10000",
      });
    });

    it("refuses a corrective base it did not sign", async () => {
      const stale = await signedVoucher(1_000n);
      const stranger = await generateKeyPairSigner();
      const forged = await signBatchVoucher(stranger, {
        channelId,
        expiresAt: 0,
        maxClaimableAmount: 3_000n,
      });
      const cases: { what: string; voucherState: unknown; charged: string }[] = [
        // Signed by a key that is not this client's authorizer.
        {
          charged: "3000",
          voucherState: { expiresAt: 0, signature: forged.signature, signedMaxClaimable: "3000" },
          what: "a foreign signature",
        },
        // A proof for less than the server claims to have charged.
        {
          charged: "4000",
          voucherState: {
            expiresAt: 0,
            signature: (await signedVoucher(3_000n)).signature,
            signedMaxClaimable: "3000",
          },
          what: "a base above the proof",
        },
        // No proof at all, and a base the chain does not corroborate.
        { charged: "3000", voucherState: undefined, what: "an unproven base" },
      ];

      for (const { what, voucherState, charged } of cases) {
        const { client, key, storage } = await pendingClient({
          amount: "1000",
          confirmed: { cumulative: "1000", deposit: "10000" },
          cumulative: "2000",
          deposit: "10000",
          payment: voucherPayment(stale),
        });
        const corrective = requirements();
        corrective.extra = {
          ...corrective.extra,
          channelState: {
            balance: "10000",
            channelId,
            chargedCumulativeAmount: charged,
            totalClaimed: "2000",
            withdrawRequestedAt: 0,
          },
          ...(voucherState ? { voucherState } : {}),
        };
        const result = await client.schemeHooks.onPaymentResponse!({
          paymentPayload: { accepted: requirements(), ...voucherPayment(stale) },
          paymentRequired: {
            accepts: [corrective],
            error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
            x402Version: 2,
          },
          requirements: requirements(),
          settleResponse: { success: false },
        } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);
        expect(result, what).toBeUndefined();
        // The confirmed base is restored, never the server's claim.
        expect(await storage.get(key), what).toMatchObject({
          chargedCumulativeAmount: "1000",
        });
      }
    });

    it("adopts an unproven base only when the chain corroborates it", async () => {
      const stale = await signedVoucher(1_000n);
      const { client, key, storage } = await pendingClient({
        amount: "1000",
        cumulative: "1000",
        deposit: "10000",
        payment: voucherPayment(stale),
      });
      const corrective = requirements();
      // A server that rebuilt its record from chain holds no voucher, so the
      // base it reports is the settled watermark itself.
      corrective.extra = {
        ...corrective.extra,
        channelState: {
          balance: "10000",
          channelId,
          chargedCumulativeAmount: "2000",
          totalClaimed: "2000",
          withdrawRequestedAt: 0,
        },
      };
      const result = await client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: requirements(), ...voucherPayment(stale) },
        paymentRequired: {
          accepts: [corrective],
          error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
          x402Version: 2,
        },
        requirements: requirements(),
        settleResponse: { success: false },
      } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);
      expect(result).toMatchObject({ recovered: true });
      expect(await storage.get(key)).toMatchObject({ chargedCumulativeAmount: "2000" });
    });

    it("does not take the server's word for what it charged or holds", async () => {
      const voucher = await signedVoucher(1_000n);
      const deposit = {
        payload: {
          channelConfig,
          deposit: { amount: "10000", transaction: "open-transaction" },
          type: "deposit" as const,
          voucher,
        },
        x402Version: 2,
      };
      const respond = async (
        extra: Record<string, unknown>,
      ): Promise<{ result: unknown; stored: unknown }> => {
        const { client, key, storage } = await pendingClient({
          amount: "1000",
          cumulative: "1000",
          deposit: "10000",
          payment: deposit,
        });
        const result = await client.schemeHooks.onPaymentResponse!({
          paymentPayload: { accepted: requirements(), ...deposit },
          requirements: requirements(),
          settleResponse: { extra, success: true },
        } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);
        return { result, stored: await storage.get(key) };
      };

      // A charge above the advertised price is refused outright.
      await expect(
        respond({
          chargedAmount: "1001",
          channelState: { balance: "10000", chargedCumulativeAmount: "1000" },
          commitmentId: `${channelId}:1000`,
        }),
      ).rejects.toThrow(/charged more than the advertised price/);

      // A cumulative the client cannot derive leaves local state alone rather
      // than adopting the server's accounting.
      expect(
        (
          await respond({
            chargedAmount: "1000",
            channelState: { balance: "10000", chargedCumulativeAmount: "9999" },
            commitmentId: `${channelId}:1000`,
          })
        ).stored,
      ).toBeUndefined();

      // The escrow is the deposit this client signed, not the balance the
      // server reports — here inflated tenfold.
      expect(
        (
          await respond({
            chargedAmount: "1000",
            channelState: { balance: "100000", chargedCumulativeAmount: "1000" },
            commitmentId: `${channelId}:1000`,
          })
        ).stored,
      ).toMatchObject({ chargedCumulativeAmount: "1000", deposit: "10000" });
    });

    it("discards a recovered pending open when settlement fails", async () => {
      const records = new Map();
      const storage: BatchClientChannelStorage = {
        delete: async key => {
          records.delete(key);
        },
        get: async key => records.get(key),
        set: async (key, record) => {
          records.set(key, record);
        },
      };
      const key = "recovered-pending-open";
      const voucher = await signedVoucher(1_000n);
      await storage.set(key, {
        channelConfig,
        channelId,
        chargedCumulativeAmount: "0",
        deposit: "0",
        hasConfirmedState: false,
        pending: {
          amount: "1000",
          chargedCumulativeAmount: "1000",
          deposit: "10000",
          payment: {
            payload: {
              channelConfig,
              deposit: { amount: "10000", transaction: "open-transaction" },
              type: "deposit",
              voucher,
            },
            x402Version: 2,
          },
        },
      });

      const client = new BatchClientScheme(payer, { channelStorage: storage });
      const recovered = await (
        client as unknown as { loadChannel(channelKey: string): Promise<unknown> }
      ).loadChannel(key);
      expect(recovered).toBeUndefined();

      await client.schemeHooks.onPaymentResponse!({
        paymentPayload: {
          accepted: requirements(),
          payload: {
            channelConfig,
            deposit: { amount: "10000", transaction: "open-transaction" },
            type: "deposit",
            voucher,
          },
          x402Version: 2,
        },
        requirements: requirements(),
        settleResponse: { success: false },
      } as Parameters<NonNullable<typeof client.schemeHooks.onPaymentResponse>>[0]);

      expect(await storage.get(key)).toBeUndefined();
      const restarted = new BatchClientScheme(payer, { channelStorage: storage });
      await expect(
        (restarted as unknown as { loadChannel(channelKey: string): Promise<unknown> }).loadChannel(
          key,
        ),
      ).resolves.toBeUndefined();
    });

    it("builds an open that binds the sponsor as payee/rent payer and receiver at 100%", async () => {
      const built = await buildDepositPayload({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 1n },
        depositAmount: 10_000n,
        feePayer: feePayer.address,
        firstCharge: 1_000n,
        memo: "invoice-42",
        mint: MINT,
        openSlot: OPEN_SLOT,
        payer,
        receiver: RECEIVER,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      const open = await verifyOpenTransaction(built.payload.deposit.transaction, {
        authorizedSigner: payer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 10_000n,
        memo: "invoice-42",
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        recipients: [{ bps: 10_000, recipient: RECEIVER }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(open.channelId).toBe(built.channelId);
      expect(built.payload.channelConfig).toMatchObject({
        openSlot: Number(OPEN_SLOT),
        payer: payer.address,
        payerAuthorizer: payer.address,
        receiver: RECEIVER,
        token: MINT,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(built.payload.voucher.maxClaimableAmount).toBe("1000");
    });

    it("builds and verifies the payer-signed forced-close transaction", async () => {
      const payload = await buildRefundPayload({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 1n },
        channelConfig,
        channelId,
        feePayer: feePayer.address,
        memo: "invoice-42",
        payer,
      });
      await expect(
        verifyRequestCloseTransaction(payload.transaction, {
          channelId,
          feePayer: feePayer.address,
          memo: "invoice-42",
          payer: payer.address,
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyRequestCloseTransaction(payload.transaction, {
          channelId: RECEIVER,
          feePayer: feePayer.address,
          payer: payer.address,
        }),
      ).rejects.toThrow("account binding mismatch");
    });
  });

  describe("onchain builders", () => {
    it("builds settle and seal with canonical discriminators", async () => {
      const voucher = await signedVoucher(1_000n);
      const settle = buildSettleInstructions({
        channelId,
        voucher: {
          authorizedSigner: payer.address,
          cumulativeAmount: 1_000n,
          expiresAt: 0n,
          signatureBase58: voucher.signature,
        },
      });
      expect(settle).toHaveLength(2);
      expect(settle[1]?.data[0]).toBe(SETTLE_DISCRIMINATOR);
      expect(buildSealInstruction(channelId).data[0]).toBe(SEAL_DISCRIMINATOR);
    });
  });

  describe("facilitator registration surface", () => {
    it("advertises one managed fee payer without a paymentFlow override", () => {
      const facilitator = new BatchFacilitatorScheme(toFacilitatorSvmSigner(feePayer));
      expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).toEqual({
        feePayer: feePayer.address,
      });
      expect(facilitator.getSigners(SOLANA_DEVNET_CAIP2)).toEqual([feePayer.address]);
    });

    it("rejects vouchers with a nonzero expiry", async () => {
      const server = new BatchServerScheme({ store: new MemoryChannelStore() });
      const expiring = await signedVoucher(1_000n, Math.floor(Date.now() / 1000) + 86_400);
      const result = await server.schemeHooks.onBeforeVerify!({
        declaredExtensions: {},
        paymentPayload: {
          accepted: requirements(),
          payload: { channelConfig, type: "voucher", voucher: expiring },
          x402Version: 2,
        },
        requirements: requirements(),
      });
      expect(result).toMatchObject({ abort: true, reason: BatchError.VOUCHER_EXPIRY });
    });

    it("rejects legacy payload shapes before touching RPC", async () => {
      const facilitator = new BatchFacilitatorScheme(toFacilitatorSvmSigner(feePayer));
      const result = await facilitator.verify(
        {
          accepted: requirements(),
          payload: { channelId, type: "voucher", voucher: await signedVoucher(1_000n) },
          x402Version: 2,
        },
        requirements(),
      );
      expect(result).toMatchObject({
        invalidReason: BatchError.PAYLOAD_TYPE,
        isValid: false,
      });
    });

    it("rejects cooperative-close fields without a trusted server binding", async () => {
      const facilitator = new BatchFacilitatorScheme(toFacilitatorSvmSigner(feePayer));
      const result = await facilitator.verify(
        {
          accepted: requirements(),
          payload: {
            channelConfig,
            closeAuthorization: { signature: "signature", validBefore: 2_000_000_000 },
            transaction: "request-close",
            type: "refund",
            voucher: await signedVoucher(1_000n),
          },
          x402Version: 2,
        },
        requirements(),
      );
      expect(result).toMatchObject({
        invalidReason: BatchError.CLOSE_AUTHORIZATION,
        isValid: false,
      });
    });

    it("sums only undistributed settled amounts", () => {
      expect(
        calculateDistributionAmount([
          { payoutWatermark: 1_000n, settled: 3_000n },
          { payoutWatermark: 500n, settled: 4_000n },
        ]),
      ).toBe(5_500n);
      expect(() => calculateDistributionAmount([{ payoutWatermark: 2n, settled: 1n }])).toThrow(
        BatchError.CHANNEL_STATE,
      );
    });
  });

  it("request-close transaction keeps the sponsor signature slot empty", async () => {
    const transaction = await buildRequestCloseTransaction({
      blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 1n },
      channelId,
      feePayer: feePayer.address,
      payer,
    });
    const decoded = getTransactionDecoder().decode(getBase64Codec().encode(transaction));
    expect(decoded.signatures[payer.address]).not.toBeNull();
    expect(decoded.signatures[feePayer.address]).toBeNull();
  });
});
