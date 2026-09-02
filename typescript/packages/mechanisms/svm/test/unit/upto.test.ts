import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type KeyPairSigner,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { getPaymentChannelsTreasuryOwner } from "../../src/payment-channels/onchain";
import {
  buildOpenPaymentChannelTransaction,
  findPaymentChannelPda,
  OPEN_DEFAULT_COMPUTE_UNIT_LIMIT,
  OPEN_MAX_COMPUTE_UNIT_LIMIT,
  verifyOpenTransaction,
} from "../../src/payment-channels/open";
import { encodeVoucherMessageBytes, VOUCHER_MAGIC } from "../../src/payment-channels/voucher";
import { UptoSvmScheme as UptoClientScheme } from "../../src/upto/client/scheme";
import { resolveUptoSvmMemo, SLOT_COMMITMENT } from "../../src/upto/shared";
import { UptoSvmScheme as UptoServerScheme } from "../../src/upto/server/scheme";
import {
  DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT,
  getChannelDistributionHash,
  reclaimComputeUnitLimit,
  simulateOpenSettleDistribute,
  submitSettle,
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

type MutableCompiledMessage = {
  header: {
    numReadonlyNonSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numSignerAccounts: number;
  };
  instructions: {
    accountIndices?: number[];
    data?: Uint8Array;
    programAddressIndex: number;
  }[];
  staticAccounts: string[];
};

/**
 * Decode an open wire transaction, apply a compiled-message mutation, and
 * re-sign with the payer so `verifyOpenTransaction` still sees a valid
 * `payload.from` signature over the tampered bytes.
 *
 * @param payer - Payer keypair that originally signed the open
 * @param transactionBase64 - Base64 wire transaction to mutate
 * @param mutate - In-place compiled-message mutation
 * @returns Base64 wire transaction with the payer signature refreshed
 */
async function resignMutatedOpen(
  payer: KeyPairSigner,
  transactionBase64: string,
  mutate: (compiled: MutableCompiledMessage) => void,
): Promise<string> {
  const decoded = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const mutable: MutableCompiledMessage = {
    header: { ...compiled.header },
    instructions: compiled.instructions.map(ix => ({
      accountIndices: ix.accountIndices ? [...ix.accountIndices] : undefined,
      data: ix.data ? new Uint8Array(ix.data) : undefined,
      programAddressIndex: ix.programAddressIndex,
    })),
    staticAccounts: [...compiled.staticAccounts],
  };
  mutate(mutable);
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...compiled,
    header: mutable.header,
    instructions: mutable.instructions,
    staticAccounts: mutable.staticAccounts as typeof compiled.staticAccounts,
  });
  // Refresh only the payer signature; the fee-payer slot stays empty (as in
  // a client-submitted open awaiting sponsor co-sign).
  const signed = await partiallySignTransaction([payer.keyPair], {
    messageBytes,
    signatures: Object.fromEntries(Object.keys(decoded.signatures).map(addr => [addr, null])),
  } as never);
  return getBase64EncodedWireTransaction(signed);
}

/** Encodes SetComputeUnitLimit: discriminator(2) + units u32 LE. */
function makeComputeLimitData(units: number): Uint8Array {
  const buf = new ArrayBuffer(5);
  const view = new DataView(buf);
  view.setUint8(0, 2);
  view.setUint32(1, units, true);
  return new Uint8Array(buf);
}

/** Encodes SetComputeUnitPrice: discriminator(3) + microlamports u64 LE. */
function makeComputePriceData(microLamports: bigint): Uint8Array {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 3);
  view.setBigUint64(1, microLamports, true);
  return new Uint8Array(buf);
}

/** Decodes a wire transaction's top-level instructions to (program, data) pairs. */
function decodeTopLevelInstructions(txBase64: string): { program: string; data: Uint8Array }[] {
  const compiled = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(getBase64Codec().encode(txBase64)).messageBytes,
  );
  return compiled.instructions.map(ix => ({
    program: compiled.staticAccounts[ix.programAddressIndex]!,
    data: new Uint8Array(ix.data ?? []),
  }));
}

/** Reads the u32 LE units of a SetComputeUnitLimit instruction data. */
function readComputeLimitData(data: Uint8Array): number {
  expect(data[0]).toBe(2);
  expect(data).toHaveLength(5);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
}

/** Reads the u64 LE microlamports of a SetComputeUnitPrice instruction data. */
function readComputePriceData(data: Uint8Array): bigint {
  expect(data[0]).toBe(3);
  expect(data).toHaveLength(9);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
}

/**
 * Ensure `program` is among `staticAccounts` (as a readonly nonsigner) and
 * return its index. Matches how wallets inject ComputeBudget / Lighthouse.
 *
 * @param compiled - Mutable compiled message
 * @param program - Program address to locate or append
 * @returns Index into `staticAccounts`
 */
function ensureReadonlyProgramIndex(compiled: MutableCompiledMessage, program: string): number {
  const existing = compiled.staticAccounts.indexOf(program);
  if (existing >= 0) return existing;
  compiled.staticAccounts.push(program);
  compiled.header.numReadonlyNonSignerAccounts += 1;
  return compiled.staticAccounts.length - 1;
}

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

  describe("server payment flow", () => {
    it("declares escrow as the only supported payment flow", () => {
      expect(server.defaultAssetTransferMethod).toBe("channel");
      expect(server.paymentFlows).toEqual({
        channel: { supported: ["escrow"], default: "escrow" },
      });
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
          phase: "cancel",
          reason,
          settledPhases: ["before-handler"],
        });
        expect(requirements).toEqual({ ...baseRequirements, amount: "0" });
      },
    );
  });

  describe("server.enrichSettlementPayload", () => {
    const settlePayload = (channelId: string) => ({
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
    });

    const acceptedRequirements = {
      scheme: "upto",
      network: SOLANA_DEVNET_CAIP2,
      asset: MINT,
      amount: "1000000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    };

    it("skips voucher signing on before-handler deposit settle", async () => {
      const enrichment = await server.enrichSettlementPayload!({
        paymentPayload: {
          x402Version: 2,
          accepted: acceptedRequirements,
          payload: settlePayload(USDC_MAINNET_ADDRESS),
        },
        requirements: acceptedRequirements,
        declaredExtensions: {},
        phase: "before-handler",
      });
      expect(enrichment).toBeUndefined();
    });

    it("signs a voucher the facilitator accepts", async () => {
      const channelId = USDC_MAINNET_ADDRESS;
      const enrichment = await server.enrichSettlementPayload!({
        paymentPayload: {
          x402Version: 2,
          accepted: acceptedRequirements,
          payload: settlePayload(channelId),
        },
        requirements: {
          ...acceptedRequirements,
          amount: "1858",
        },
        declaredExtensions: {},
        phase: "after-handler",
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
          accepted: acceptedRequirements,
          payload: settlePayload(channelId),
        },
        requirements: {
          ...acceptedRequirements,
          amount: "0",
        },
        declaredExtensions: {},
        phase: "cancel",
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

    it("verifyOpenTransaction accepts ComputeBudget prefix + Lighthouse suffix (Phantom/Solflare)", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      // Opt out of the built-in ComputeBudget prefix: this exercises a wallet
      // injecting its own prefix onto a bare open.
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        computeUnitLimit: 0,
        computeUnitPriceMicroLamports: 0,
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const wrapped = await resignMutatedOpen(payer, open.transaction, compiled => {
        const computeBudgetIdx = ensureReadonlyProgramIndex(
          compiled,
          COMPUTE_BUDGET_PROGRAM_ADDRESS,
        );
        const lighthouseIdx = ensureReadonlyProgramIndex(compiled, LIGHTHOUSE_PROGRAM_ADDRESS);
        compiled.instructions = [
          {
            accountIndices: [],
            data: makeComputeLimitData(200_000),
            programAddressIndex: computeBudgetIdx,
          },
          {
            accountIndices: [],
            data: makeComputePriceData(1n),
            programAddressIndex: computeBudgetIdx,
          },
          ...compiled.instructions,
          { accountIndices: [], data: new Uint8Array([0]), programAddressIndex: lighthouseIdx },
          { accountIndices: [], data: new Uint8Array([1]), programAddressIndex: lighthouseIdx },
        ];
      });

      const result = await verifyOpenTransaction(wrapped, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(result.channelId).toBe(open.channelId);
    });

    it("verifyOpenTransaction rejects a non-allowlisted instruction after open", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        // Reuse system program already present in the open accounts as a smuggled ix.
        const systemIdx = compiled.staticAccounts.indexOf("11111111111111111111111111111111");
        if (systemIdx < 0) throw new Error("expected system program in open static accounts");
        compiled.instructions.push({
          accountIndices: [0],
          data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
          programAddressIndex: systemIdx,
        });
      });

      await expect(
        verifyOpenTransaction(tampered, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/only Lighthouse or Memo are allowed after open/);
    });

    it("verifyOpenTransaction rejects Lighthouse that references the fee payer", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        const lighthouseIdx = ensureReadonlyProgramIndex(compiled, LIGHTHOUSE_PROGRAM_ADDRESS);
        // Fee payer is always staticAccounts[0].
        compiled.instructions.push({
          accountIndices: [0],
          data: new Uint8Array([0]),
          programAddressIndex: lighthouseIdx,
        });
      });

      await expect(
        verifyOpenTransaction(tampered, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/feePayer must not appear in Lighthouse instruction accounts/);
    });

    it("verifyOpenTransaction rejects SetComputeUnitPrice above the spec cap", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        const computeBudgetIdx = ensureReadonlyProgramIndex(
          compiled,
          COMPUTE_BUDGET_PROGRAM_ADDRESS,
        );
        compiled.instructions = [
          {
            accountIndices: [],
            data: makeComputePriceData(BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) + 1n),
            programAddressIndex: computeBudgetIdx,
          },
          ...compiled.instructions,
        ];
      });

      await expect(
        verifyOpenTransaction(tampered, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/SetComputeUnitPrice .* exceeds/);
    });

    it("verifyOpenTransaction accepts open + 3 Lighthouse + Memo", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        memo: "order-12345",
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const wrapped = await resignMutatedOpen(payer, open.transaction, compiled => {
        const lighthouseIdx = ensureReadonlyProgramIndex(compiled, LIGHTHOUSE_PROGRAM_ADDRESS);
        compiled.instructions.push(
          { accountIndices: [], data: new Uint8Array([0]), programAddressIndex: lighthouseIdx },
          { accountIndices: [], data: new Uint8Array([1]), programAddressIndex: lighthouseIdx },
          { accountIndices: [], data: new Uint8Array([2]), programAddressIndex: lighthouseIdx },
        );
      });

      const result = await verifyOpenTransaction(wrapped, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        memo: "order-12345",
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(result.channelId).toBe(open.channelId);
    });

    it("verifyOpenTransaction rejects a fourth Lighthouse instruction", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        const lighthouseIdx = ensureReadonlyProgramIndex(compiled, LIGHTHOUSE_PROGRAM_ADDRESS);
        for (let n = 0; n < 4; n += 1) {
          compiled.instructions.push({
            accountIndices: [],
            data: new Uint8Array([n]),
            programAddressIndex: lighthouseIdx,
          });
        }
      });

      await expect(
        verifyOpenTransaction(tampered, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/at most 3 Lighthouse instructions|at most 4 optional instructions/);
    });

    it("verifyOpenTransaction rejects Memo that references the fee payer", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        const memoIdx = ensureReadonlyProgramIndex(compiled, MEMO_PROGRAM_ADDRESS);
        // Replace the client memo with one that references the fee payer.
        const memoIxIndex = compiled.instructions.findIndex(
          ix => compiled.staticAccounts[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS,
        );
        if (memoIxIndex < 0) throw new Error("expected memo instruction from builder");
        compiled.instructions[memoIxIndex] = {
          accountIndices: [0],
          data: new TextEncoder().encode("tampered"),
          programAddressIndex: memoIdx,
        };
      });

      await expect(
        verifyOpenTransaction(tampered, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/feePayer must not appear in Memo instruction accounts/);
    });

    it("verifyOpenTransaction enforces extra.memo match and count", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        memo: "order-12345",
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          memo: "different-memo",
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/does not match extra\.memo/);

      const missingMemo = await resignMutatedOpen(payer, open.transaction, compiled => {
        compiled.instructions = compiled.instructions.filter(
          ix => compiled.staticAccounts[ix.programAddressIndex] !== MEMO_PROGRAM_ADDRESS,
        );
      });
      await expect(
        verifyOpenTransaction(missingMemo, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          memo: "order-12345",
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/expected exactly one Memo instruction/);
    });

    it("verifyOpenTransaction enforces lowered operator compute caps", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const withBudget = await resignMutatedOpen(payer, open.transaction, compiled => {
        const computeBudgetIdx = ensureReadonlyProgramIndex(
          compiled,
          COMPUTE_BUDGET_PROGRAM_ADDRESS,
        );
        compiled.instructions = [
          {
            accountIndices: [],
            data: makeComputeLimitData(100_000),
            programAddressIndex: computeBudgetIdx,
          },
          {
            accountIndices: [],
            data: makeComputePriceData(1_000n),
            programAddressIndex: computeBudgetIdx,
          },
          ...compiled.instructions,
        ];
      });

      await expect(
        verifyOpenTransaction(withBudget, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          maxComputeUnits: 50_000,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/SetComputeUnitLimit 100000 exceeds 50000/);

      await expect(
        verifyOpenTransaction(withBudget, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          maxPriorityFeeMicroLamports: 500,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/SetComputeUnitPrice 1000 exceeds 500/);

      // Operator cannot raise above the normative ceilings.
      const overSpec = await resignMutatedOpen(payer, open.transaction, compiled => {
        const computeBudgetIdx = ensureReadonlyProgramIndex(
          compiled,
          COMPUTE_BUDGET_PROGRAM_ADDRESS,
        );
        compiled.instructions = [
          {
            accountIndices: [],
            data: makeComputeLimitData(OPEN_MAX_COMPUTE_UNIT_LIMIT + 1),
            programAddressIndex: computeBudgetIdx,
          },
          ...compiled.instructions,
        ];
      });
      await expect(
        verifyOpenTransaction(overSpec, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          maxComputeUnits: OPEN_MAX_COMPUTE_UNIT_LIMIT * 2,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(
        new RegExp(`SetComputeUnitLimit .* exceeds ${OPEN_MAX_COMPUTE_UNIT_LIMIT}`),
      );
    });

    it("buildOpenPaymentChannelTransaction emits Memo (seller or random nonce)", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();

      const withSellerMemo = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        memo: "pi_invoice_1",
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const sellerCompiled = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(getBase64Codec().encode(withSellerMemo.transaction))
          .messageBytes,
      );
      const sellerMemoIx = sellerCompiled.instructions.find(
        ix => sellerCompiled.staticAccounts[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS,
      );
      expect(sellerMemoIx).toBeDefined();
      expect(new TextDecoder().decode(new Uint8Array(sellerMemoIx!.data!))).toBe("pi_invoice_1");

      const randomA = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const randomB = await buildOpenPaymentChannelTransaction({
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT + 1n,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const decodeMemo = (tx: string): string => {
        const compiled = getCompiledTransactionMessageDecoder().decode(
          getTransactionDecoder().decode(getBase64Codec().encode(tx)).messageBytes,
        );
        const memoIx = compiled.instructions.find(
          ix => compiled.staticAccounts[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS,
        );
        return new TextDecoder().decode(new Uint8Array(memoIx!.data!));
      };
      const memoA = decodeMemo(randomA.transaction);
      const memoB = decodeMemo(randomB.transaction);
      expect(memoA).toMatch(/^[0-9a-f]{32}$/);
      expect(memoB).toMatch(/^[0-9a-f]{32}$/);
      expect(memoA).not.toBe(memoB);

      await expect(
        buildOpenPaymentChannelTransaction({
          authorizedSigner: receiverAuthorizer.address,
          blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
          deposit: 1_000_000n,
          feePayer: feePayer.address,
          gracePeriod: WITHDRAW_DELAY,
          memo: "x".repeat(MAX_MEMO_BYTES + 1),
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          payer,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
      ).rejects.toThrow(/extra\.memo exceeds maximum/);
    });

    it("buildOpenPaymentChannelTransaction emits a right-sized ComputeBudget prefix by default", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      // SetComputeUnitLimit then SetComputeUnitPrice, both before the open.
      const instructions = decodeTopLevelInstructions(open.transaction);
      expect(instructions[0]!.program).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
      expect(readComputeLimitData(instructions[0]!.data)).toBe(OPEN_DEFAULT_COMPUTE_UNIT_LIMIT);
      expect(instructions[1]!.program).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
      expect(readComputePriceData(instructions[1]!.data)).toBe(
        BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS),
      );
      expect(instructions.filter(ix => ix.program === COMPUTE_BUDGET_PROGRAM_ADDRESS)).toHaveLength(
        2,
      );

      // The default-built prefix passes verification under the default caps.
      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(result.channelId).toBe(open.channelId);
    });

    it("buildOpenPaymentChannelTransaction honors compute budget overrides and opt-out", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      const baseArgs = {
        authorizedSigner: receiverAuthorizer.address,
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        feePayer: feePayer.address,
        gracePeriod: WITHDRAW_DELAY,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      };

      const overridden = await buildOpenPaymentChannelTransaction({
        ...baseArgs,
        computeUnitLimit: 120_000,
        computeUnitPriceMicroLamports: 5,
      });
      const overriddenIxs = decodeTopLevelInstructions(overridden.transaction);
      expect(readComputeLimitData(overriddenIxs[0]!.data)).toBe(120_000);
      expect(readComputePriceData(overriddenIxs[1]!.data)).toBe(5n);

      // 0 omits each instruction (a wallet may inject its own prefix).
      const bare = await buildOpenPaymentChannelTransaction({
        ...baseArgs,
        computeUnitLimit: 0,
        computeUnitPriceMicroLamports: 0,
      });
      const bareIxs = decodeTopLevelInstructions(bare.transaction);
      expect(bareIxs.filter(ix => ix.program === COMPUTE_BUDGET_PROGRAM_ADDRESS)).toHaveLength(0);

      // The spec ceilings are enforced at build time.
      await expect(
        buildOpenPaymentChannelTransaction({
          ...baseArgs,
          computeUnitLimit: OPEN_MAX_COMPUTE_UNIT_LIMIT + 1,
        }),
      ).rejects.toThrow(/computeUnitLimit/);
      await expect(
        buildOpenPaymentChannelTransaction({
          ...baseArgs,
          computeUnitPriceMicroLamports: MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS + 1,
        }),
      ).rejects.toThrow(/computeUnitPriceMicroLamports/);
    });

    it("UptoSvmFacilitatorConfig rejects invalid limit options", () => {
      const feePayer = address(USDC_MAINNET_ADDRESS);
      const mockSigner = {
        getAddresses: () => [feePayer],
        getSigner: () => ({}),
      };
      expect(
        () =>
          new UptoFacilitatorScheme(mockSigner as never, {
            maxPriorityFeeMicroLamports: Number.NaN,
          }),
      ).toThrow(/maxPriorityFeeMicroLamports/);
      expect(
        () =>
          new UptoFacilitatorScheme(mockSigner as never, {
            maxComputeUnits: 0,
          }),
      ).toThrow(/maxComputeUnits/);
      expect(
        () =>
          new UptoFacilitatorScheme(mockSigner as never, {
            maxRequiredSignatures: 0,
          }),
      ).toThrow(/maxRequiredSignatures/);
      expect(
        () =>
          new UptoFacilitatorScheme(mockSigner as never, {
            maxChannelLifetimeSecs: 0,
          }),
      ).toThrow(/maxChannelLifetimeSecs/);
      expect(
        () =>
          new UptoFacilitatorScheme(mockSigner as never, {
            settleComputeUnitLimit: 0,
          }),
      ).toThrow(/settleComputeUnitLimit/);
      expect(
        () =>
          new UptoFacilitatorScheme(mockSigner as never, {
            computeUnitPriceMicroLamports: -1,
          }),
      ).toThrow(/computeUnitPriceMicroLamports/);
      expect(
        () =>
          new UptoFacilitatorScheme(
            toFacilitatorSvmSigner({
              address: feePayer,
              signTransactions: vi.fn(),
              signMessages: vi.fn(),
            } as never),
            {
              maxPriorityFeeMicroLamports: 0,
              maxComputeUnits: 1,
              maxRequiredSignatures: 1,
              maxChannelLifetimeSecs: 1,
              computeUnitPriceMicroLamports: 0,
              settleComputeUnitLimit: 1,
            },
          ),
      ).not.toThrow();
    });

    it("verifyOpenTransaction accepts payee==feePayer privilege union (upto profile)", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: receiverAuthorizer.address,
        feePayer: feePayer.address,
        from: payer.address,
        maxCap: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      });
      expect(result.channelId).toBe(open.channelId);
    });

    it("verifyOpenTransaction rejects remaining accounts beyond the 14 pinned slots", async () => {
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        // The open follows the built ComputeBudget prefix; find it by accounts.
        const ix = compiled.instructions.find(
          candidate => (candidate.accountIndices?.length ?? 0) > 0,
        );
        if (!ix?.accountIndices || ix.accountIndices.length === 0) {
          throw new Error("expected open account indices");
        }
        ix.accountIndices.push(ix.accountIndices[0]!);
      });

      await expect(
        verifyOpenTransaction(tampered, {
          authorizedSigner: receiverAuthorizer.address,
          feePayer: feePayer.address,
          from: payer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          openSlot: OPEN_SLOT,
          payee: feePayer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        }),
      ).rejects.toThrow(/exactly 14 accounts/);
    });

    it("verifyOpenTransaction rejects an unexpected writable static account", async () => {
      const payer = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const receiverAuthorizer = await generateKeyPairSigner();
      // Distinct payee so elevating a readonly nonsigner is not an allowed privilege union.
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
      const tampered = await resignMutatedOpen(payer, open.transaction, compiled => {
        // Move the writable/readonly nonsigner boundary one slot left so a
        // formerly read-only account becomes writable in the header.
        if (compiled.header.numReadonlyNonSignerAccounts < 1) {
          throw new Error("expected readonly nonsigner accounts to elevate");
        }
        compiled.header.numReadonlyNonSignerAccounts -= 1;
      });

      await expect(
        verifyOpenTransaction(tampered, {
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
      ).rejects.toThrow(/writable but is not among the open instruction's writable roles/);
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

    it("simulates open + settle + distribute with replaceRecentBlockhash via the signer", async () => {
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

      const simulateTransaction = vi.fn().mockResolvedValue(undefined);
      const signer = { simulateTransaction };

      await simulateOpenSettleDistribute(feePayer, signer, SOLANA_DEVNET_CAIP2, {
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

      expect(simulateTransaction).toHaveBeenCalledWith(expect.any(String), SOLANA_DEVNET_CAIP2, {
        replaceRecentBlockhash: true,
      });
    });
  });

  describe("facilitator.submitSettle compute budget", () => {
    const SIG =
      "5VERYvERYVeryvERYVERYVeryVeryVeRYvERYveRYVeRYVerYVERYveryVERYVERYVeryVERYVERYVeryv";

    /** Minimal instruction submitted through settle in these tests. */
    const memoIx = {
      programAddress: MEMO_PROGRAM_ADDRESS as never,
      accounts: [] as const,
      data: new TextEncoder().encode("settle"),
    };

    /**
     * Facilitator signer mock capturing settle simulate/send/confirm.
     *
     * @returns Mock signer plus spies
     */
    function makeSettleSigner() {
      const simulateTransaction = vi.fn().mockResolvedValue(undefined);
      const sendTransaction = vi.fn().mockResolvedValue(SIG);
      const confirmTransaction = vi.fn().mockResolvedValue(undefined);
      const signer = {
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: DUMMY_BLOCKHASH,
          lastValidBlockHeight: 1n,
        }),
        simulateTransaction,
        sendTransaction,
        confirmTransaction,
      };
      return { signer, simulateTransaction, sendTransaction };
    }

    it("simulates before send and applies the static default compute budget", async () => {
      const feePayer = await generateKeyPairSigner();
      const { signer, simulateTransaction, sendTransaction } = makeSettleSigner();

      const signature = await submitSettle(feePayer, signer as never, SOLANA_DEVNET_CAIP2, [
        memoIx,
      ]);
      expect(signature).toBe(SIG);
      expect(simulateTransaction).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(1);

      // Broadcast: static limit + default price, then the payload ix.
      const wire = sendTransaction.mock.calls[0]![0] as string;
      const instructions = decodeTopLevelInstructions(wire);
      expect(instructions[0]!.program).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
      expect(readComputeLimitData(instructions[0]!.data)).toBe(DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT);
      expect(instructions[1]!.program).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
      expect(readComputePriceData(instructions[1]!.data)).toBe(
        BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS),
      );
      expect(instructions[2]!.program).toBe(MEMO_PROGRAM_ADDRESS);
    });

    it("does not send when simulation fails", async () => {
      const feePayer = await generateKeyPairSigner();
      const { signer, sendTransaction } = makeSettleSigner();
      signer.simulateTransaction.mockRejectedValue(new Error("sim failed"));

      await expect(
        submitSettle(feePayer, signer as never, SOLANA_DEVNET_CAIP2, [memoIx]),
      ).rejects.toThrow("sim failed");
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("honors the compute-unit limit override", async () => {
      const feePayer = await generateKeyPairSigner();
      const { signer, sendTransaction } = makeSettleSigner();

      await submitSettle(feePayer, signer as never, SOLANA_DEVNET_CAIP2, [memoIx], {
        computeUnitLimit: 222_222,
      });

      const wire = sendTransaction.mock.calls[0]![0] as string;
      expect(readComputeLimitData(decodeTopLevelInstructions(wire)[0]!.data)).toBe(222_222);
    });

    it("honors the compute-unit price option, omitting the instruction at 0", async () => {
      const feePayer = await generateKeyPairSigner();
      const priced = makeSettleSigner();
      await submitSettle(feePayer, priced.signer as never, SOLANA_DEVNET_CAIP2, [memoIx], {
        computeUnitPriceMicroLamports: 250,
      });
      const pricedIxs = decodeTopLevelInstructions(priced.sendTransaction.mock.calls[0]![0]);
      expect(readComputePriceData(pricedIxs[1]!.data)).toBe(250n);

      const unpriced = makeSettleSigner();
      await submitSettle(feePayer, unpriced.signer as never, SOLANA_DEVNET_CAIP2, [memoIx], {
        computeUnitPriceMicroLamports: 0,
      });
      const unpricedIxs = decodeTopLevelInstructions(unpriced.sendTransaction.mock.calls[0]![0]);
      expect(unpricedIxs.filter(ix => ix.program === COMPUTE_BUDGET_PROGRAM_ADDRESS)).toHaveLength(
        1,
      );
      expect(readComputeLimitData(unpricedIxs[0]!.data)).toBe(DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT);
    });

    it("reclaimComputeUnitLimit scales with batch size and clamps to the tx max", () => {
      expect(reclaimComputeUnitLimit(1)).toBe(30_000);
      expect(reclaimComputeUnitLimit(2)).toBe(35_000);
      expect(reclaimComputeUnitLimit(8)).toBe(65_000);
      expect(reclaimComputeUnitLimit(1_000_000)).toBe(1_400_000);
    });
  });

  describe("client.createPaymentPayload", () => {
    it("reports the devnet/mainnet USDC mints as default assets for spend controls", async () => {
      const payer = await generateKeyPairSigner();
      const client = new UptoClientScheme(payer);
      expect(client.findDefaultAsset?.(USDC_DEVNET_ADDRESS, SOLANA_DEVNET_CAIP2)?.asset).toBe(
        USDC_DEVNET_ADDRESS,
      );
      expect(client.findDefaultAsset?.(USDC_MAINNET_ADDRESS, SOLANA_MAINNET_CAIP2)?.asset).toBe(
        USDC_MAINNET_ADDRESS,
      );
    });

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

    // The open's ComputeBudget prefix is fixed by the scheme, not the caller:
    // the facilitator's compute-unit and priority-fee caps are verified
    // against it.
    it("emits the open compute budget defaults", async () => {
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
      const instructions = decodeTopLevelInstructions(payload.openTransaction);
      expect(readComputeLimitData(instructions[0]!.data)).toBe(OPEN_DEFAULT_COMPUTE_UNIT_LIMIT);
      expect(readComputePriceData(instructions[1]!.data)).toBe(
        BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS),
      );
    });

    // An empty extra.memo is a seller that set no memo, not a demand for an
    // empty one. Client and facilitator resolve through the same helper, so
    // neither side can decide a memo was requested when the other did not.
    it("treats an empty extra.memo as unset and emits a nonce instead", async () => {
      expect(resolveUptoSvmMemo({ memo: "" })).toBeUndefined();
      expect(resolveUptoSvmMemo({ memo: "order-42" })).toBe("order-42");
      expect(resolveUptoSvmMemo({})).toBeUndefined();

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
          memo: "",
          recentBlockhash: DUMMY_BLOCKHASH,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: receiverAuthorizer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      };

      const result = await client.createPaymentPayload(2, requirements);
      const payload = result.payload as unknown as UptoSvmPayloadV2;
      const memoIx = decodeTopLevelInstructions(payload.openTransaction).find(
        ix => ix.program === MEMO_PROGRAM_ADDRESS,
      );
      expect(new TextDecoder().decode(memoIx!.data)).toMatch(/^[0-9a-f]{32}$/);
    });

    // The facilitator rejects an unsupported token program too, but the client
    // is where the error can still name the field that is wrong.
    it("rejects an extra.tokenProgram that is not a supported SPL token program", async () => {
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
          tokenProgram: PAY_TO,
          withdrawDelay: WITHDRAW_DELAY,
        },
      };

      await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
        "is not a supported SPL token program",
      );
    });

    it("resolveOpenSlot falls back to rpc.getSlot when extra.recentSlot is omitted", async () => {
      const getSlotSend = vi.fn().mockResolvedValue(OPEN_SLOT);
      const getSlot = vi.fn().mockReturnValue({ send: getSlotSend });
      const rpc = { getSlot } as never;
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
      expect(getSlot).toHaveBeenCalledWith({ commitment: SLOT_COMMITMENT });
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
        getAccountInfo: vi.fn(),
        getLatestBlockhash: vi.fn(),
        getSlot: vi.fn(),
        getProgramAccounts: vi.fn(),
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
        expiresAt: Math.floor(Date.now() / 1000) + 300,
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

    it("rejects a fractional expiresAt before open", async () => {
      const payload = {
        ...basePayload,
        expiresAt: Math.floor(Date.now() / 1000) + 300.5,
      };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_payload_type");
    });

    it("rejects a fractional validAfter before open", async () => {
      const payload = { ...basePayload, validAfter: 0.5 };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
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

    // The mismatch above is the more specific answer, so a malformed
    // receiverAuthorizer only surfaces once the payload agrees with it.
    it("rejects a malformed receiver authorizer the payload agrees with", async () => {
      const bad = "OtherReceiver111111111111111111111111";
      const req = requirements({
        extra: {
          feePayer: feePayerAddress,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: bad,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: WITHDRAW_DELAY,
        },
      });
      const result = await facilitator.verify(
        wrap({ ...basePayload, authorizedSigner: bad }, req),
        req,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects a malformed asset", async () => {
      const req = requirements({ asset: "NotAMint11111111111111111111111111111" });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects a malformed payer", async () => {
      const req = requirements();
      const result = await facilitator.verify(
        wrap({ ...basePayload, from: "NotAPayer11111111111111111111111111111" }, req),
        req,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_payer_mismatch");
    });

    it("rejects a token program that is not an SPL token program", async () => {
      const req = requirements({
        extra: {
          feePayer: feePayerAddress,
          recentSlot: OPEN_SLOT.toString(),
          receiverAuthorizer: receiverAuthorizerAddress,
          tokenProgram: "SysvarC1ock11111111111111111111111111111111",
          withdrawDelay: WITHDRAW_DELAY,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
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

    // A non-numeric requirements.amount must be reported as a structured
    // verify failure, not thrown as an uncaught BigInt SyntaxError.
    it("rejects a non-numeric requirements.amount instead of throwing", async () => {
      const result = await facilitator.verify(
        wrap(basePayload, requirements()),
        requirements({ amount: "not-a-number" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_amount");
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
