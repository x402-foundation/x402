/**
 * Batch-settlement single-shot entry points: the codecs and wire guards, the
 * corrective-402 check, the tracked-channel builders, the facilitator's
 * settlement-readiness and open-slot checks, and the resource server's store
 * verdicts.
 */
import {
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildBatchRefundPayload,
  buildBatchTopUpPayload,
  buildBatchVoucherPayload,
  type BatchTrackedChannel,
} from "../../src/batch-settlement/client/builders";
import { buildDepositPayload, signBatchVoucher } from "../../src/batch-settlement/client/channel";
import { checkCorrectiveState } from "../../src/batch-settlement/client/corrective";
import { BatchSvmScheme as BatchClient } from "../../src/batch-settlement/client/scheme";
import { deriveBatchChannelId, encodeBatchVoucherMessage } from "../../src/batch-settlement/codec";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchSvmScheme as BatchFacilitator } from "../../src/batch-settlement/facilitator/scheme";
import { assertSettlementAccounts } from "../../src/batch-settlement/facilitator/settlementAccounts";
import { encodeReceiverBindingMemo } from "../../src/batch-settlement/receiverBinding";
import { BatchSvmScheme as BatchServer } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import type { ChannelState } from "../../src/batch-settlement/server/types";
import {
  isBatchChannelState,
  isBatchExtra,
  isBatchPaymentPayloadEnvelope,
  isBatchPaymentRequired,
  isBatchRequirements,
  isBatchSettlementResponse,
  isBatchVoucherState,
  isTransactionVersionList,
  type BatchChannelConfig,
  type BatchPayload,
} from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { getPaymentChannelsTreasuryOwner } from "../../src/payment-channels/onchain";
import { findPaymentChannelPda } from "../../src/payment-channels/open";
import {
  decodeTokenAccount,
  unusableSettlementAccount,
} from "../../src/payment-channels/tokenAccount";
import { settlementAtaReader, tokenAccountData } from "./helpers/tokenAccount";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const BLOCKHASH = { blockhash: RECEIVER, lastValidBlockHeight: 1n };

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let receiverAuthorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let channelConfig: BatchChannelConfig;
let depositPayload: Extract<BatchPayload, { type: "deposit" }>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  receiverAuthorizer = await generateKeyPairSigner();
  const built = await buildDepositPayload({
    blockhash: BLOCKHASH,
    depositAmount: 10_000n,
    feePayer: feePayer.address,
    firstCharge: 1_000n,
    mint: MINT,
    openSlot: 123n,
    payer,
    receiver: RECEIVER,
    receiverAuthorizer: receiverAuthorizer.address,
    salt: 42n,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  });
  channelId = built.channelId;
  channelConfig = built.payload.channelConfig;
  depositPayload = built.payload;
});

function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    extra: {
      feePayer: feePayer.address,
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
      ...extra,
    },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function tracked(charged: bigint, deposit: bigint): BatchTrackedChannel {
  return {
    channelConfig,
    chargedCumulativeAmount: charged.toString(),
    deposit: deposit.toString(),
  };
}

function wireVersion(transactionBase64: string): number | string {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version;
}

describe("batch codecs", () => {
  it("encodes the 50-byte voucher message and refuses a non-decimal amount", () => {
    const bytes = encodeBatchVoucherMessage({
      channelId,
      expiresAt: 0,
      maxClaimableAmount: "18446744073709551615",
    });
    expect(bytes).toHaveLength(50);
    expect([...bytes.slice(0, 2)]).toEqual([0x56, 0x01]);
    expect([...bytes.slice(34, 42)]).toEqual(new Array(8).fill(255));
    expect(() =>
      encodeBatchVoucherMessage({ channelId, expiresAt: 0, maxClaimableAmount: "1e3" }),
    ).toThrow(/unsigned integer/);
    expect(() =>
      encodeBatchVoucherMessage({ channelId, expiresAt: 1.5, maxClaimableAmount: "1" }),
    ).toThrow(/safe integer/);
  });

  it("derives the channel id the open creates; receiver is not a seed", async () => {
    await expect(deriveBatchChannelId(channelConfig, feePayer.address)).resolves.toBe(channelId);
    await expect(
      deriveBatchChannelId(
        { ...channelConfig, receiver: payer.address } as never,
        feePayer.address,
      ),
    ).resolves.toBe(channelId);
    await expect(
      deriveBatchChannelId({ ...channelConfig, salt: "0x2a" }, feePayer.address),
    ).rejects.toThrow(/unsigned integer/);
    await expect(deriveBatchChannelId(channelConfig, feePayer.address)).resolves.toBe(
      await findPaymentChannelPda({
        authorizedSigner: payer.address,
        mint: MINT,
        openSlot: 123n,
        payee: feePayer.address,
        payer: payer.address,
        salt: 42n,
      }),
    );
  });

  it("encodes the receiver-binding memo", () => {
    expect(encodeReceiverBindingMemo(receiverAuthorizer.address)).toBe(
      `x402:batch-settlement:svm:rcvauth:v1:${receiverAuthorizer.address}`,
    );
  });
});

describe("batch wire guards", () => {
  it("accepts requirements and refuses an unknown transaction version", () => {
    expect(isBatchRequirements(requirements())).toBe(true);
    expect(
      isBatchRequirements(
        requirements({ maxClaimChannels: 18, maxSettleChannels: 13, transactionVersions: [0, 1] }),
      ),
    ).toBe(true);
    expect(isBatchRequirements(requirements({ transactionVersions: [0, 2] }))).toBe(false);
    expect(isBatchRequirements(requirements({ transactionVersions: ["1"] }))).toBe(false);
    expect(isBatchRequirements(requirements({ maxClaimChannels: 0 }))).toBe(false);
    expect(isBatchRequirements({ ...requirements(), scheme: "exact" })).toBe(false);
    expect(isBatchRequirements({ ...requirements(), network: "eip155:1" })).toBe(false);
    expect(isBatchRequirements({ ...requirements(), amount: "1e3" })).toBe(false);
    expect(isBatchExtra(null)).toBe(false);
    expect(isTransactionVersionList([0, 1])).toBe(true);
    expect(isTransactionVersionList("0")).toBe(false);
  });

  it("checks the PaymentPayload envelope", () => {
    const envelope = { accepted: requirements(), payload: depositPayload, x402Version: 2 };
    expect(isBatchPaymentPayloadEnvelope(envelope)).toBe(true);
    expect(isBatchPaymentPayloadEnvelope({ ...envelope, x402Version: 1 })).toBe(false);
    expect(isBatchPaymentPayloadEnvelope({ ...envelope, payload: { type: "nope" } })).toBe(false);
    expect(isBatchPaymentPayloadEnvelope({ ...envelope, resource: "x" })).toBe(false);
  });

  it("checks settlement responses", () => {
    const state = {
      balance: "100000",
      channelId,
      chargedCumulativeAmount: "5000",
      totalClaimed: "3000",
      withdrawRequestedAt: 0,
    };
    expect(isBatchChannelState(state)).toBe(true);
    const response = {
      amount: "",
      extra: { channelState: state, chargedAmount: "1000", commitmentId: `${channelId}:5000` },
      network: NETWORK,
      payer: payer.address,
      success: true,
      transaction: "",
    };
    expect(isBatchSettlementResponse(response)).toBe(true);
    expect(isBatchSettlementResponse({ ...response, amount: null })).toBe(false);
    expect(isBatchSettlementResponse({ ...response, extra: { commitmentId: "" } })).toBe(false);
    expect(isBatchSettlementResponse({ ...response, extra: [] })).toBe(false);
    expect(isBatchSettlementResponse(null)).toBe(false);
  });

  it("checks a corrective PaymentRequired", () => {
    const voucherState = { expiresAt: 0, signature: "sig", signedMaxClaimable: "3000" };
    expect(isBatchVoucherState(voucherState)).toBe(true);
    const accept = requirements({ voucherState });
    const required = {
      accepts: [accept, { scheme: "exact" }],
      error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
      x402Version: 2,
    };
    expect(isBatchPaymentRequired(required)).toBe(true);
    expect(isBatchPaymentRequired({ ...required, accepts: [] })).toBe(false);
    expect(
      isBatchPaymentRequired({
        ...required,
        accepts: [requirements({ voucherState: { ...voucherState, signedMaxClaimable: "x" } })],
      }),
    ).toBe(false);
  });
});

describe("checkCorrectiveState", () => {
  async function corrective(
    charged: string,
    signed: bigint,
    overrides: Record<string, unknown> = {},
  ) {
    const voucher = await signBatchVoucher(payer, {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: signed,
    });
    return requirements({
      channelState: {
        balance: "10000",
        channelId,
        chargedCumulativeAmount: charged,
        totalClaimed: "2000",
        withdrawRequestedAt: 0,
      },
      voucherState: {
        expiresAt: 0,
        signature: voucher.signature,
        signedMaxClaimable: signed.toString(),
      },
      ...overrides,
    });
  }

  it("adopts a snapshot the client's own voucher proves", async () => {
    await expect(
      checkCorrectiveState({ accept: await corrective("3000", 3000n), channelConfig, channelId }),
    ).resolves.toMatchObject({ chargedCumulativeAmount: 3000n });
    await expect(
      checkCorrectiveState({
        accept: await corrective("2000", 3000n),
        channelConfig,
        channelId,
        deposit: 10_000n,
      }),
    ).resolves.toMatchObject({ chargedCumulativeAmount: 2000n });
  });

  it.each([
    ["no channelState", { channelState: undefined }, BatchError.CUMULATIVE_AMOUNT_MISMATCH],
    ["no voucherState", { voucherState: undefined }, BatchError.CUMULATIVE_AMOUNT_MISMATCH],
    [
      "a malformed voucherState",
      { voucherState: { expiresAt: 0 } },
      BatchError.CUMULATIVE_AMOUNT_MISMATCH,
    ],
    [
      "a nonzero expiry",
      { voucherState: { expiresAt: 1, signature: "x", signedMaxClaimable: "3000" } },
      BatchError.VOUCHER_EXPIRY,
    ],
  ])("refuses %s", async (_label, overrides, code) => {
    const accept = await corrective("3000", 3000n, overrides);
    await expect(checkCorrectiveState({ accept, channelConfig, channelId })).rejects.toThrow(code);
  });

  it("refuses another channel, a foreign signature, an overclaim and an underclaim", async () => {
    const accept = await corrective("3000", 3000n);
    await expect(
      checkCorrectiveState({ accept, channelConfig, channelId: feePayer.address }),
    ).rejects.toThrow(BatchError.CHANNEL_ID_MISMATCH);
    await expect(
      checkCorrectiveState({
        accept,
        channelConfig: { payerAuthorizer: feePayer.address },
        channelId,
      }),
    ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);
    await expect(
      checkCorrectiveState({ accept: await corrective("4000", 3000n), channelConfig, channelId }),
    ).rejects.toThrow(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
    await expect(
      checkCorrectiveState({ accept: await corrective("1000", 3000n), channelConfig, channelId }),
    ).rejects.toThrow(/below totalClaimed/);
    await expect(
      checkCorrectiveState({ accept, channelConfig, channelId, deposit: 2_000n }),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
  });
});

describe("tracked-channel builders", () => {
  it("builds the next voucher at charged + amount", async () => {
    const payload = await buildBatchVoucherPayload({
      channel: tracked(3_000n, 10_000n),
      requirements: requirements(),
      signer: payer,
    });
    expect(payload).toMatchObject({
      channelConfig,
      type: "voucher",
      voucher: { channelId, expiresAt: 0, maxClaimableAmount: "4000" },
    });
    await expect(
      buildBatchVoucherPayload({
        channel: tracked(9_500n, 10_000n),
        requirements: requirements(),
        signer: payer,
      }),
    ).rejects.toThrow(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
  });

  it("builds a top-up in the advertised version with the next voucher", async () => {
    const v0 = await buildBatchTopUpPayload({
      blockhash: BLOCKHASH,
      channel: tracked(3_000n, 4_000n),
      depositAmount: "6000",
      requirements: requirements({ memo: "invoice-42" }),
      signer: payer,
    });
    expect(v0).toMatchObject({
      deposit: { amount: "6000" },
      type: "deposit",
      voucher: { maxClaimableAmount: "4000" },
    });
    expect(wireVersion(v0.deposit.transaction)).toBe(0);
    const v1 = await buildBatchTopUpPayload({
      blockhash: BLOCKHASH,
      channel: tracked(3_000n, 4_000n),
      depositAmount: 6_000n,
      requirements: requirements({ transactionVersions: [0, 1] }),
      signer: payer,
    });
    expect(wireVersion(v1.deposit.transaction)).toBe(1);
    const signerV0 = await buildBatchTopUpPayload({
      blockhash: BLOCKHASH,
      channel: tracked(3_000n, 4_000n),
      depositAmount: 6_000n,
      requirements: requirements({ transactionVersions: [0, 1] }),
      signer: payer,
      transactionVersions: [0],
    });
    expect(wireVersion(signerV0.deposit.transaction)).toBe(0);
  });

  it("refuses a top-up that does not cover the next charge or adds nothing", async () => {
    const args = {
      blockhash: BLOCKHASH,
      channel: tracked(3_000n, 3_000n),
      requirements: requirements(),
      signer: payer,
    };
    await expect(buildBatchTopUpPayload({ ...args, depositAmount: 500n })).rejects.toThrow(
      BatchError.CUMULATIVE_EXCEEDS_DEPOSIT,
    );
    await expect(buildBatchTopUpPayload({ ...args, depositAmount: 0n })).rejects.toThrow(
      /must be positive/,
    );
  });

  it("builds a refund at the confirmed cumulative, with or without request_close", async () => {
    const refund = await buildBatchRefundPayload({
      channel: tracked(3_000n, 10_000n),
      requirements: requirements(),
      signer: payer,
    });
    expect(refund).toMatchObject({ type: "refund", voucher: { maxClaimableAmount: "3000" } });
    expect(refund.transaction).toBeUndefined();
    const withClose = await buildBatchRefundPayload({
      blockhash: BLOCKHASH,
      channel: tracked(3_000n, 10_000n),
      requirements: requirements({ transactionVersions: [1] }),
      signer: payer,
      withTransaction: true,
    });
    expect(wireVersion(withClose.transaction!)).toBe(1);
  });

  it("refuses a channel the signer does not own or a sponsor that is the payer", async () => {
    const other = await generateKeyPairSigner();
    const base = { channel: tracked(0n, 10_000n), requirements: requirements() };
    await expect(buildBatchVoucherPayload({ ...base, signer: other })).rejects.toThrow(
      BatchError.CHANNEL_STATE,
    );
    await expect(
      buildBatchVoucherPayload({
        ...base,
        channel: {
          ...base.channel,
          channelConfig: { ...channelConfig, payerAuthorizer: other.address },
        },
        signer: payer,
      }),
    ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);
    await expect(
      buildBatchVoucherPayload({
        ...base,
        channel: { ...base.channel, channelConfig: { ...channelConfig, voucherSigner: "server" } },
        signer: payer,
      }),
    ).rejects.toThrow(BatchError.PAYLOAD_TYPE);
    await expect(
      buildBatchVoucherPayload({
        ...base,
        requirements: requirements({ feePayer: payer.address }),
        signer: payer,
      }),
    ).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);
    await expect(
      buildBatchVoucherPayload({
        ...base,
        requirements: requirements({ feePayer: 7 }),
        signer: payer,
      }),
    ).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);
    await expect(
      buildBatchVoucherPayload({ ...base, requirements: requirements({ memo: 7 }), signer: payer }),
    ).rejects.toThrow(/extra.memo/);
  });
});

describe("batch client terms", () => {
  it("refuses a challenge whose fee payer is the client itself", async () => {
    const client = new BatchClient(payer, { depositAmount: "10000", rpcUrl: "http://127.0.0.1:1" });
    await expect(
      client.createPaymentPayload(2, requirements({ feePayer: payer.address })),
    ).rejects.toThrow(BatchError.FEE_PAYER_MISMATCH);
  });
});

describe("settlement-readiness checks", () => {
  const owners = () => [payer.address, RECEIVER, getPaymentChannelsTreasuryOwner(NETWORK)];
  const args = () => ({
    deposit: 10_000n,
    payer: payer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    treasuryOwner: getPaymentChannelsTreasuryOwner(NETWORK),
  });

  it("accepts healthy, funded settlement accounts", async () => {
    const getAccountInfo = vi.fn().mockImplementation(settlementAtaReader({ mint: MINT, owners }));
    await expect(
      assertSettlementAccounts({ getAccountInfo }, requirements(), args()),
    ).resolves.toBeUndefined();
    expect(getAccountInfo).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["frozen", { state: 2 }, /payer ATA \w+ is frozen/],
    ["uninitialized", { state: 0 }, /payer ATA \w+ is in account state 0/],
    ["unfunded", { amount: 1n }, /payer ATA \w+ holds 1, less than the 10000 deposit/],
    ["for another mint", { mint: RECEIVER }, /payer ATA \w+ holds mint/],
    ["owned by another wallet", { owner: RECEIVER }, /payer ATA \w+ is owned by/],
    [
      "carrying a non-allowlisted extension",
      { extensionBytes: new Uint8Array([2, 1, 0, 0, 0]) },
      /payer ATA \w+ carries token account extension 1/,
    ],
  ])("refuses a payer ATA %s", async (_label, override, message) => {
    const getAccountInfo = vi.fn().mockImplementation(
      settlementAtaReader({
        mint: MINT,
        owners,
        override: owner => (owner === payer.address ? override : undefined),
      }),
    );
    await expect(
      assertSettlementAccounts({ getAccountInfo }, requirements(), args()),
    ).rejects.toThrow(message);
  });

  it("refuses a recipient ATA that is frozen, and one with no data", async () => {
    const frozen = vi.fn().mockImplementation(
      settlementAtaReader({
        mint: MINT,
        owners,
        override: owner => (owner === RECEIVER ? { state: 2 } : undefined),
      }),
    );
    await expect(
      assertSettlementAccounts({ getAccountInfo: frozen }, requirements(), args()),
    ).rejects.toThrow(/recipient ATA \w+ is frozen/);
    const empty = vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ADDRESS });
    await expect(
      assertSettlementAccounts({ getAccountInfo: empty }, requirements(), args()),
    ).rejects.toThrow(/is not an initialized token account/);
  });

  it("decodes token accounts and their extensions", () => {
    const base = { mint: MINT, owner: RECEIVER };
    expect(decodeTokenAccount(new Uint8Array(10))).toBeUndefined();
    expect(decodeTokenAccount(tokenAccountData({ ...base, amount: 7n }))).toMatchObject({
      amount: 7n,
      mint: MINT,
      owner: RECEIVER,
      state: 1,
    });
    // ImmutableOwner (7, empty) then zero padding is allowed.
    const immutable = new Uint8Array([2, 7, 0, 0, 0, 0, 0, 0, 0]);
    expect(
      decodeTokenAccount(tokenAccountData({ ...base, extensionBytes: immutable }))
        ?.unsupportedExtension,
    ).toBeUndefined();
    // A Mint-type marker, a truncated header and an overrunning length are refused.
    for (const [bytes, extension] of [
      [new Uint8Array([1]), 1],
      [new Uint8Array([2, 7, 0]), 0xffff],
      [new Uint8Array([2, 7, 0, 9, 0]), 0xffff],
    ] as const) {
      expect(
        decodeTokenAccount(tokenAccountData({ ...base, extensionBytes: bytes }))
          ?.unsupportedExtension,
      ).toBe(extension);
    }
    expect(
      unusableSettlementAccount(
        { data: tokenAccountData(base), programOwner: RECEIVER },
        RECEIVER,
        MINT,
        TOKEN_PROGRAM_ADDRESS,
      ),
    ).toMatch(/is not owned by/);
  });
});

describe("batch facilitator open-slot window and accepted versions", () => {
  function facilitatorSigner(slot: bigint) {
    const atas = settlementAtaReader({
      mint: MINT,
      owners: () => [payer.address, RECEIVER, getPaymentChannelsTreasuryOwner(NETWORK)],
      fallback: null,
    });
    return {
      confirmTransaction: vi.fn(),
      // The mint reads as SPL Token's; the channel does not exist yet.
      getAccountInfo: vi
        .fn()
        .mockImplementation(async (account: string) =>
          account === MINT ? { owner: TOKEN_PROGRAM_ADDRESS } : atas(account),
        ),
      getAddresses: vi.fn(() => [feePayer.address]),
      getLatestBlockhash: vi.fn(),
      getSigner: vi.fn(() => feePayer),
      getSlot: vi.fn().mockResolvedValue(slot),
      sendTransaction: vi.fn(),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
    };
  }

  function payment(): PaymentPayload {
    return { accepted: requirements(), payload: depositPayload, x402Version: 2 };
  }

  it("judges openSlot against the cluster slot when the challenge carries none", async () => {
    const inWindow = new BatchFacilitator(facilitatorSigner(123n + 1_500n) as never);
    await expect(inWindow.verify(payment(), requirements())).resolves.toMatchObject({
      isValid: true,
    });
    for (const slot of [122n, 123n + 1_501n]) {
      const scheme = new BatchFacilitator(facilitatorSigner(slot) as never);
      await expect(scheme.verify(payment(), requirements())).resolves.toMatchObject({
        invalidReason: BatchError.SETUP_TRANSACTION,
        isValid: false,
      });
    }
  });

  it("advertises and enforces its configured accepted set", async () => {
    const scheme = new BatchFacilitator(facilitatorSigner(200n) as never, {
      transactionVersions: [1],
    });
    expect(scheme.getExtra(NETWORK).transactionVersions).toEqual([1]);
    await expect(scheme.verify(payment(), requirements())).resolves.toMatchObject({
      invalidReason: "unsupported_transaction_version",
      isValid: false,
    });
    expect(
      () =>
        new BatchFacilitator(facilitatorSigner(200n) as never, {
          transactionVersions: [] as never,
        }),
    ).toThrow(/non-empty/);
  });
});

describe("batch resource server store verdicts", () => {
  function state(overrides: Partial<ChannelState> = {}): ChannelState {
    return {
      channelConfig,
      channelId,
      chargedCumulativeAmount: 3_000n,
      deposit: 10_000n,
      feePayer: feePayer.address,
      mint: MINT,
      onchainSyncedAt: Date.now(),
      openSlot: 123n,
      payer: payer.address,
      payerAuthorizer: payer.address,
      payoutWatermark: 0n,
      receiver: RECEIVER,
      receiverAuthorizer: receiverAuthorizer.address,
      salt: 42n,
      settled: 0n,
      signedMaxClaimable: 3_000n,
      status: "open",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
      ...overrides,
    };
  }

  it("refuses a paid request on a channel the payer is closing", async () => {
    const store = new MemoryChannelStore();
    await store.put(state({ closeRequestedAt: 1_785_000_000, status: "closing" }));
    const server = new BatchServer({ store });
    const voucher = await buildBatchVoucherPayload({
      channel: tracked(3_000n, 10_000n),
      requirements: requirements(),
      signer: payer,
    });
    await expect(
      server.schemeHooks.onBeforeVerify!({
        declaredExtensions: {},
        paymentPayload: { accepted: requirements(), payload: voucher, x402Version: 2 },
        requirements: requirements(),
      }),
    ).resolves.toMatchObject({ abort: true, reason: BatchError.CHANNEL_CLOSING });
  });
});

describe("payment-channels helpers", () => {
  it("derives the channel PDA as 32 bytes", async () => {
    expect(getBase58Encoder().encode(channelId)).toHaveLength(32);
  });
});
