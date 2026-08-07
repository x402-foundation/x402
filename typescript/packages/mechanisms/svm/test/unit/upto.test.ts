import { address, generateKeyPairSigner, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/constants";
import { getPaymentChannelsTreasuryOwner } from "../../src/payment-channels/onchain";
import {
  buildOpenPaymentChannelTransaction,
  findPaymentChannelPda,
  verifyOpenTransaction,
} from "../../src/payment-channels/open";
import { encodeVoucherMessageBytes, VOUCHER_MAGIC } from "../../src/payment-channels/voucher";
import { UptoSvmScheme as UptoClientScheme } from "../../src/upto/client/scheme";
import { UptoSvmScheme as UptoServerScheme } from "../../src/upto/server/scheme";
import {
  getChannelDistributionHash,
  simulateOpenSettleDistribute,
  verifyOpenChannelAccount,
} from "../../src/upto/facilitator/channel";
import {
  ERR_SETTLEMENT_EXCEEDS_AMOUNT,
  UptoSvmScheme as UptoFacilitatorScheme,
} from "../../src/upto/facilitator/scheme";
import { toFacilitatorSvmSigner } from "../../src/signer";
import { type UptoSvmPayloadV2 } from "../../src/types";
import { resolveOpenSlot } from "../../src/utils";

// A valid 32-byte base58 pubkey reused as a deterministic blockhash in tests.
const DUMMY_BLOCKHASH = USDC_MAINNET_ADDRESS;
const PAY_TO = USDC_MAINNET_ADDRESS; // any valid base58 pubkey works as the recipient
const MINT = USDC_DEVNET_ADDRESS;
const FAR_FUTURE = 4_102_444_800; // 2100-01-01
// Challenge-bound open slot (`extra.recentSlot`), a channel-PDA seed.
const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;

describe("upto SVM scheme", () => {
  let serverAuthorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let server: UptoServerScheme;

  beforeAll(async () => {
    serverAuthorizer = await generateKeyPairSigner();
    server = new UptoServerScheme({
      receiverAuthorizerSigner: serverAuthorizer,
      withdrawDelay: WITHDRAW_DELAY,
    });
  });

  describe("server.parsePrice", () => {
    it("parses dollar prices to 6-decimal atomic units", async () => {
      const result = await server.parsePrice("$0.10", SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("100000");
      expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
    });

    it("uses the devnet USDC mint on devnet", async () => {
      const result = await server.parsePrice("1.00", SOLANA_DEVNET_CAIP2);
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(USDC_DEVNET_ADDRESS);
    });

    it("passes through pre-parsed AssetAmount", async () => {
      const result = await server.parsePrice(
        { amount: "500", asset: "CustomMint1111111111111111111111111111", extra: {} },
        SOLANA_MAINNET_CAIP2,
      );
      expect(result.amount).toBe("500");
    });
  });

  describe("server.enhancePaymentRequirements", () => {
    it("declares receiverAuthorizer/withdrawDelay and folds feePayer", async () => {
      const requirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { custom: "value" },
      } as PaymentRequirements;

      const result = await server.enhancePaymentRequirements(
        requirements,
        {
          x402Version: 2,
          scheme: "upto",
          network: SOLANA_DEVNET_CAIP2,
          extra: {
            feePayer: "FeePayer1111111111111111111111111111",
          },
        },
        [],
      );
      expect(result.extra).toEqual({
        custom: "value",
        feePayer: "FeePayer1111111111111111111111111111",
        receiverAuthorizer: serverAuthorizer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
    });

    it("rejects a facilitator without a valid feePayer", () => {
      const problem = server.validateFacilitatorSupport?.(
        SOLANA_DEVNET_CAIP2,
        {
          x402Version: 2,
          scheme: "upto",
          network: SOLANA_DEVNET_CAIP2,
          extra: {},
        },
        [],
      );
      expect(problem).toMatch(/feePayer/);
    });

    it("returns 6 asset decimals for registered stablecoin mints and symbols", () => {
      expect(server.getAssetDecimals?.(MINT, SOLANA_DEVNET_CAIP2)).toBe(6);
      expect(server.getAssetDecimals?.("USDC", SOLANA_MAINNET_CAIP2)).toBe(6);
    });

    it("throws for unknown assets instead of defaulting to 6", () => {
      expect(() =>
        server.getAssetDecimals?.("CustomMint1111111111111111111111111111", SOLANA_DEVNET_CAIP2),
      ).toThrow(/not a registered stablecoin/);
    });
  });

  describe("server.settleOnCancel", () => {
    const baseRequirements = {
      scheme: "upto",
      network: SOLANA_DEVNET_CAIP2,
      asset: MINT,
      amount: "1000000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    };

    it.each(["handler_failed", "handler_threw", "after_verify_aborted"] as const)(
      "returns zero-amount requirements for %s",
      reason => {
        const requirements = server.settleOnCancel({
          paymentPayload: {
            x402Version: 2,
            accepted: baseRequirements,
            payload: {},
          },
          requirements: baseRequirements,
          declaredExtensions: {},
          reason,
        });
        expect(requirements).toEqual({ ...baseRequirements, amount: "0" });
      },
    );
  });

  describe("server.enrichSettlementPayload", () => {
    it("signs a voucher the facilitator accepts", async () => {
      const channelId = USDC_MAINNET_ADDRESS;
      const enrichment = await server.enrichSettlementPayload!({
        paymentPayload: {
          x402Version: 2,
          accepted: {
            scheme: "upto",
            network: SOLANA_DEVNET_CAIP2,
            asset: MINT,
            amount: "1000000",
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
          },
          payload: {
            from: PAY_TO,
            maxAmount: "1000000",
            deposit: "1000000",
            channelId,
            authorizedSigner: serverAuthorizer.address,
            openTransaction: "unused",
            openSlot: OPEN_SLOT.toString(),
            expiresAt: FAR_FUTURE,
            validAfter: 0,
            nonce: "1",
          },
        },
        requirements: {
          scheme: "upto",
          network: SOLANA_DEVNET_CAIP2,
          asset: MINT,
          amount: "1858",
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
        },
        declaredExtensions: {},
      });
      expect(enrichment).toMatchObject({ voucherSignature: expect.any(String) });

      const { verifyVoucherSignature } = await import("../../src/payment-channels/voucher");
      await expect(
        verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId,
            cumulativeAmount: 1858n,
            expiresAt: BigInt(FAR_FUTURE),
          }),
          signatureBase58: (enrichment as { voucherSignature: string }).voucherSignature,
          signerBase58: serverAuthorizer.address,
        }),
      ).resolves.toBe(true);
    });

    it("signs a zero-amount refund voucher", async () => {
      const channelId = USDC_MAINNET_ADDRESS;
      const enrichment = await server.enrichSettlementPayload!({
        paymentPayload: {
          x402Version: 2,
          accepted: {
            scheme: "upto",
            network: SOLANA_DEVNET_CAIP2,
            asset: MINT,
            amount: "1000000",
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
          },
          payload: {
            from: PAY_TO,
            maxAmount: "1000000",
            deposit: "1000000",
            channelId,
            authorizedSigner: serverAuthorizer.address,
            openTransaction: "unused",
            openSlot: OPEN_SLOT.toString(),
            expiresAt: FAR_FUTURE,
            validAfter: 0,
            nonce: "1",
          },
        },
        requirements: {
          scheme: "upto",
          network: SOLANA_DEVNET_CAIP2,
          asset: MINT,
          amount: "0",
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
        },
        declaredExtensions: {},
      });
      expect(enrichment).toMatchObject({ voucherSignature: expect.any(String) });

      const { verifyVoucherSignature } = await import("../../src/payment-channels/voucher");
      await expect(
        verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId,
            cumulativeAmount: 0n,
            expiresAt: BigInt(FAR_FUTURE),
          }),
          signatureBase58: (enrichment as { voucherSignature: string }).voucherSignature,
          signerBase58: serverAuthorizer.address,
        }),
      ).resolves.toBe(true);
    });
  });

  describe("voucher encoding (cross-language golden)", () => {
    it("encodes magic ‖ channelId ‖ cumulative_le ‖ expiresAt_le into 50 bytes", () => {
      const channelId = USDC_MAINNET_ADDRESS;
      const bytes = encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: 1_000_000n,
        expiresAt: BigInt(FAR_FUTURE),
      });
      expect(bytes.byteLength).toBe(50);

      // bytes[0..2] == constant magic [0x56, 0x01]
      expect(Array.from(bytes.slice(0, 2))).toEqual([...VOUCHER_MAGIC]);
      expect([...VOUCHER_MAGIC]).toEqual([0x56, 0x01]);

      // bytes[2..34] == base58-decoded channelId
      const channelBytes = getBase58Encoder().encode(channelId) as Uint8Array;
      expect(Array.from(bytes.slice(2, 34))).toEqual(Array.from(channelBytes));

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getBigUint64(34, true)).toBe(1_000_000n); // cumulative, little-endian
      expect(view.getBigInt64(42, true)).toBe(BigInt(FAR_FUTURE)); // expiresAt, little-endian
    });
  });

  describe("payment-channel open", () => {
    it("derives the same channel PDA the open transaction commits to", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const salt = 42n;
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        salt,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const derived = await findPaymentChannelPda({
        authorizedSigner: receiverAuthorizer.address,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer: payer.address,
        salt,
      });
      expect(open.channelId).toBe(derived);
      expect(open.deposit).toBe(1_000_000n);
      expect(open.openSlot).toBe(OPEN_SLOT);

      // open_slot is a PDA seed: a different slot yields a different channel.
      const otherSlot = await findPaymentChannelPda({
        authorizedSigner: receiverAuthorizer.address,
        mint: MINT,
        openSlot: OPEN_SLOT + 1n,
        payee: receiverAuthorizer.address,
        payer: payer.address,
        salt,
      });
      expect(otherSlot).not.toBe(derived);
    });

    it("verifyOpenTransaction accepts a well-formed open and extracts facts", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(result.channelId).toBe(open.channelId);
      expect(result.deposit).toBe(1_000_000n);
      expect(result.openSlot).toBe(OPEN_SLOT);
      expect(result.payer).toBe(payer.address);
    });

    it("verifyOpenTransaction accepts a cold payTo distribution", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const split = { bps: 10_000, recipient: PAY_TO };
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        recipients: [split],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        recipients: [split],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(result.recipients).toEqual([split]);
    });

    it("verifyOpenTransaction rejects a mismatched delegated split", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        recipients: [{ bps: 9_900, recipient: PAY_TO }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: receiverAuthorizer.address,
          recipients: [{ bps: 10_000, recipient: PAY_TO }],
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/distribution bps/);
    });

    it("verifyOpenTransaction rejects a deposit above the ceiling", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 2_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: receiverAuthorizer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/!= maxCap/);
    });

    it("verifyOpenTransaction rejects a deposit below the ceiling", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 500_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: receiverAuthorizer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/!= maxCap/);
    });

    it("verifyOpenTransaction rejects a mismatched payee", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: USDC_DEVNET_ADDRESS, // wrong recipient
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/payee/);
    });

    it("binds openSlot to the challenged recentSlot freshness window", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const expected = {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: receiverAuthorizer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      };

      await expect(
        verifyOpenTransaction(open.transaction, {
          ...expected,
          recentSlot: OPEN_SLOT - 1n,
        }),
      ).rejects.toThrow(/ahead of challenged recentSlot/);
      await expect(
        verifyOpenTransaction(open.transaction, {
          ...expected,
          recentSlot: OPEN_SLOT + 1_501n,
        }),
      ).rejects.toThrow(/freshness window/);
    });

    it("binds the confirmed onchain channel state to the verified open", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const splits = [{ bps: 10_000, recipient: PAY_TO }];
      const expected = {
        authorizedSigner: receiverAuthorizer.address,
        deposit: 1_000_000n,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        payee: feePayer.address,
        payer: payer.address,
        rentPayer: feePayer.address,
        splits,
      };
      const channel = {
        discriminator: 1,
        version: 1,
        bump: 255,
        status: 0,
        salt: 42n,
        deposit: expected.deposit,
        settlement: { settled: 0n, payoutWatermark: 0n },
        closureStartedAt: 0n,
        payerWithdrawnAt: 0n,
        gracePeriod: expected.gracePeriod,
        distributionHash: Array.from(getChannelDistributionHash(splits)),
        payer: payer.address,
        payee: feePayer.address,
        authorizedSigner: receiverAuthorizer.address,
        mint: address(MINT),
        rentPayer: feePayer.address,
        openSlot: OPEN_SLOT,
      };

      expect(verifyOpenChannelAccount(PAY_TO, channel, expected)).toMatchObject({
        deposit: expected.deposit,
        mint: expected.mint,
        payer: expected.payer,
      });
      expect(() => verifyOpenChannelAccount(PAY_TO, { ...channel, status: 1 }, expected)).toThrow(
        /not open/,
      );
      expect(() =>
        verifyOpenChannelAccount(PAY_TO, { ...channel, deposit: 999_999n }, expected),
      ).toThrow(/channel deposit/);
      expect(() =>
        verifyOpenChannelAccount(
          PAY_TO,
          { ...channel, distributionHash: new Array(32).fill(0) },
          expected,
        ),
      ).toThrow(/distribution/);
    });

    it("matches the payment-channel program distribution hash golden", () => {
      const recipientOne = getBase58Decoder().decode(new Uint8Array(32).fill(1));
      const recipientTwo = getBase58Decoder().decode(new Uint8Array(32).fill(2));

      expect(
        Array.from(
          getChannelDistributionHash([
            { bps: 7_500, recipient: recipientOne },
            { bps: 2_500, recipient: recipientTwo },
          ]),
        ),
      ).toEqual([
        0x54, 0xc8, 0x97, 0x55, 0x87, 0x75, 0x0e, 0x88, 0x21, 0xe9, 0x3f, 0x5d, 0x4a, 0xf6, 0x07,
        0xd2, 0x0d, 0x55, 0xa5, 0x8b, 0xa1, 0xb9, 0xa4, 0xb4, 0x9f, 0x72, 0xa5, 0x42, 0xed, 0x87,
        0x4a, 0x3f,
      ]);
    });

    it("selects the payment-channels treasury owner per network", () => {
      expect(getPaymentChannelsTreasuryOwner(SOLANA_DEVNET_CAIP2)).toBe(
        "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap",
      );
      expect(getPaymentChannelsTreasuryOwner("solana-devnet")).toBe(
        "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap",
      );
      expect(getPaymentChannelsTreasuryOwner(SOLANA_MAINNET_CAIP2)).toBe(
        "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP",
      );
    });

    it("simulates open∥settle∥distribute with sigVerify disabled", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        recipients: [{ bps: 10_000, recipient: PAY_TO }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const simulateTransaction = vi.fn().mockReturnValue({
        send: async () => ({ value: { err: null } }),
      });
      const rpc = {
        getLatestBlockhash: () => ({
          send: async () => ({
            value: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 1n },
          }),
        }),
        simulateTransaction,
      };

      await simulateOpenSettleDistribute(feePayer, rpc as never, {
        openTransactionBase64: open.transaction,
        channel: {
          channelId: open.channelId,
          mint: MINT,
          network: SOLANA_DEVNET_CAIP2,
          payee: feePayer.address,
          payer: payer.address,
          rentPayer: feePayer.address,
          splits: [{ bps: 10_000, recipient: PAY_TO }],
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        },
      });

      expect(simulateTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          replaceRecentBlockhash: true,
          sigVerify: false,
        }),
      );
    });
  });

  describe("client.createPaymentPayload", () => {
    it("builds a delegated open with the payTo split and decimal salt nonce", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const client = new UptoClientScheme(payer);
      const requirements: PaymentRequirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          feePayer: feePayer.address,
          recentBlockhash: DUMMY_BLOCKHASH,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: receiverAuthorizer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      };

      const result = await client.createPaymentPayload(2, requirements);
      const payload = result.payload as unknown as UptoSvmPayloadV2;
      const open = await verifyOpenTransaction(payload.openTransaction, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        recipients: [{ bps: 10_000, recipient: PAY_TO }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });

      expect(payload.authorizedSigner).toBe(receiverAuthorizer.address);
      expect(payload.channelId).toBe(open.channelId);
      expect(payload.nonce).toBe(open.salt.toString());
      expect(payload.openSlot).toBe(OPEN_SLOT.toString());
      expect(open.openSlot).toBe(OPEN_SLOT); // challenge slot, not a client-fetched one
      expect(payload).not.toHaveProperty("profile");
    });

    it("resolveOpenSlot falls back to rpc.getSlot when extra.recentSlot is omitted", async () => {
      const getSlotSend = vi.fn().mockResolvedValue(OPEN_SLOT);
      const rpc = { getSlot: () => ({ send: getSlotSend }) } as never;
      const slot = await resolveOpenSlot(rpc, {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {},
      });
      expect(slot).toBe(OPEN_SLOT);
      expect(getSlotSend).toHaveBeenCalled();
    });

    it("resolveOpenSlot prefers a well-formed extra.recentSlot", async () => {
      const getSlotSend = vi.fn();
      const rpc = { getSlot: () => ({ send: getSlotSend }) } as never;
      const slot = await resolveOpenSlot(rpc, {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { recentSlot: OPEN_SLOT.toString() },
      });
      expect(slot).toBe(OPEN_SLOT);
      expect(getSlotSend).not.toHaveBeenCalled();
    });
  });

  describe("facilitator.getExtra", () => {
    it("exposes only feePayer from a single signer", async () => {
      const feePayer = await generateKeyPairSigner();
      const facilitator = new UptoFacilitatorScheme(toFacilitatorSvmSigner(feePayer));
      expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).toEqual({ feePayer: feePayer.address });
      expect(facilitator.getSigners(SOLANA_DEVNET_CAIP2)).toEqual([feePayer.address]);
    });

    it("randomly selects feePayer from configured signers", async () => {
      const feePayerA = await generateKeyPairSigner();
      const feePayerB = await generateKeyPairSigner();
      // Multi-key is a custom FacilitatorSvmSigner (same as exact); the factory
      // wraps a single keypair.
      const addresses = [feePayerA.address, feePayerB.address];
      const facilitator = new UptoFacilitatorScheme({
        getAddresses: () => addresses,
        getSigner: feePayer =>
          feePayer === feePayerA.address
            ? feePayerA
            : feePayer === feePayerB.address
              ? feePayerB
              : (() => {
                  throw new Error(`No signer for feePayer ${feePayer}`);
                })(),
        signTransaction: async () => "",
        simulateTransaction: async () => {},
        sendTransaction: async () => "",
        confirmTransaction: async () => {},
      });
      expect(facilitator.getSigners(SOLANA_DEVNET_CAIP2)).toEqual(addresses);

      const randomSpy = vi.spyOn(Math, "random");
      try {
        randomSpy.mockReturnValueOnce(0);
        expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).toEqual({ feePayer: feePayerA.address });
        randomSpy.mockReturnValueOnce(0.99);
        expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).toEqual({ feePayer: feePayerB.address });
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe("facilitator verify (pre-broadcast rejections)", () => {
    let feePayerAddress: string;
    let receiverAuthorizerAddress: string;
    let facilitator: UptoFacilitatorScheme;
    let basePayload: UptoSvmPayloadV2;

    beforeAll(async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      feePayerAddress = feePayer.address;
      receiverAuthorizerAddress = receiverAuthorizer.address;
      facilitator = new UptoFacilitatorScheme(toFacilitatorSvmSigner(feePayer));
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        recipients: [{ bps: 10_000, recipient: receiverAuthorizer.address }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      basePayload = {
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
    });

    const requirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
      scheme: "upto",
      network: SOLANA_DEVNET_CAIP2,
      asset: MINT,
      amount: "1000000",
      payTo: receiverAuthorizerAddress,
      maxTimeoutSeconds: 300,
      extra: {
        feePayer: feePayerAddress,
        recentSlot: OPEN_SLOT.toString(),
        receiverAuthorizer: receiverAuthorizerAddress,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      },
      ...overrides,
    });

    const wrap = (payload: UptoSvmPayloadV2, req: PaymentRequirements): PaymentPayload => ({
      x402Version: 2,
      accepted: req,
      payload: payload as unknown as Record<string, unknown>,
    });

    it("rejects a non-upto payload shape", async () => {
      const result = await facilitator.verify(
        { x402Version: 2, accepted: requirements(), payload: { transaction: "x" } },
        requirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_payload_type");
    });

    it("rejects a network mismatch", async () => {
      const req = requirements();
      const result = await facilitator.verify(
        wrap(basePayload, req),
        requirements({ network: SOLANA_MAINNET_CAIP2 }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("network_mismatch");
    });

    it("rejects a fee-payer mismatch", async () => {
      const req = requirements({
        extra: {
          feePayer: "OtherFeePayer111111111111111111111111",
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: receiverAuthorizerAddress,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("facilitator_mismatch");
    });

    it("rejects a receiver-authorizer mismatch", async () => {
      const req = requirements({
        extra: {
          feePayer: feePayerAddress,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: "OtherReceiver111111111111111111111111",
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_receiver_authorizer");
    });

    it("rejects a missing receiverAuthorizer", async () => {
      const req = requirements({
        extra: {
          feePayer: feePayerAddress,
          recentSlot: OPEN_SLOT.toString(),
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects a non-integer withdrawDelay", async () => {
      const req = requirements({
        extra: {
          feePayer: feePayerAddress,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: receiverAuthorizerAddress,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: 12.5,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects maxAmount ≠ requirements.amount", async () => {
      const result = await facilitator.verify(
        wrap(basePayload, requirements()),
        requirements({ amount: "999999" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_amount_mismatch");
    });

    it("rejects a deposit below the ceiling (must equal exactly)", async () => {
      const payload = { ...basePayload, deposit: "500000" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_deposit_not_ceiling");
    });

    it("rejects a deposit above the ceiling (must equal exactly)", async () => {
      const payload = { ...basePayload, deposit: "2000000" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_deposit_not_ceiling");
    });

    it("rejects requirements whose payTo mismatches the sealed split", async () => {
      const result = await facilitator.verify(
        wrap(basePayload, requirements()),
        requirements({ payTo: PAY_TO }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_open_transaction");
      expect(result.invalidMessage).toMatch(/distribution recipient/);
    });

    it("rejects a payload channelId that does not match the open transaction", async () => {
      const result = await facilitator.verify(
        wrap({ ...basePayload, channelId: PAY_TO }, requirements()),
        requirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_channel_id");
    });

    it("rejects an expired authorization", async () => {
      const payload = { ...basePayload, expiresAt: 1 };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_expired");
    });

    it("rejects a not-yet-active authorization", async () => {
      const payload = { ...basePayload, validAfter: FAR_FUTURE };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_not_yet_active");
    });

    it("rejects a non-receiver-authorizer authorized signer", async () => {
      const payload = {
        ...basePayload,
        authorizedSigner: "NotReceiver11111111111111111111111111",
      };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_receiver_authorizer");
    });

    it("rejects an undecodable open transaction", async () => {
      const payload = { ...basePayload, openTransaction: "not-a-valid-transaction" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_open_transaction");
    });
  });

  describe("facilitator settle (ceiling enforcement)", () => {
    it("rejects a settlement above the signed ceiling before any RPC", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const facilitator = new UptoFacilitatorScheme(toFacilitatorSvmSigner(feePayer));
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        recipients: [{ bps: 10_000, recipient: PAY_TO }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const payload: UptoSvmPayloadV2 = {
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
      const requirements: PaymentRequirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000001", // one over the ceiling
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          feePayer: feePayer.address,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: receiverAuthorizer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      };

      const result = await facilitator.settle(
        {
          x402Version: 2,
          accepted: requirements,
          payload: payload as unknown as Record<string, unknown>,
        },
        requirements,
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ERR_SETTLEMENT_EXCEEDS_AMOUNT);
    });
  });
});
