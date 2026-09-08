import { afterEach, describe, it, expect, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { keyPairFromSeed } from "@ton/crypto";
import { Address, beginCell, Cell } from "@ton/core";
import { ExactTvmScheme } from "../../../src/exact/facilitator/scheme";
import { buildJettonTransferBodyFields, parseJettonTransfer } from "../../../src/codecs/jetton";
import { SettlementBatcher } from "../../../src/exact/settlement-batcher";
import { SettlementCache } from "../../../src/settlement-cache";
import {
  DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
  ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
  ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
  ERR_EXACT_TVM_INSUFFICIENT_BALANCE,
  ERR_EXACT_TVM_INVALID_AMOUNT,
  ERR_EXACT_TVM_INVALID_ASSET,
  ERR_EXACT_TVM_INVALID_CODE_HASH,
  ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
  ERR_EXACT_TVM_INVALID_RECIPIENT,
  ERR_EXACT_TVM_INVALID_SEQNO,
  ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC,
  ERR_EXACT_TVM_INVALID_W5_MESSAGE,
  ERR_EXACT_TVM_INVALID_WALLET_ID,
  ERR_EXACT_TVM_SIMULATION_FAILED,
  ERR_EXACT_TVM_TRANSACTION_FAILED,
  ERR_EXACT_TVM_UNSUPPORTED_NETWORK,
  ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
  ERR_EXACT_TVM_UNSUPPORTED_VERSION,
  JETTON_TRANSFER_OPCODE,
  MIN_FACILITATOR_TON_BALANCE,
  TVM_TESTNET,
  USDT_TESTNET_MINTER,
  W5R1_CODE_HEX,
} from "../../../src/constants";
import { toClientTvmSigner, type FacilitatorTvmSigner } from "../../../src/signer";
import type {
  ParsedTvmSettlement,
  TvmAccountState,
  TvmJettonWalletData,
  TvmRelayRequest,
} from "../../../src/types";
import { parseExactTvmPayload } from "../../../src/exact/codec";
import {
  messageBodyHashMatches,
  parseTraceTransactions,
  traceTransactionBalanceBefore,
  traceTransactionComputeFees,
  traceTransactionFwdFees,
  traceTransactionHashToHex,
  traceTransactionStorageFees,
  transactionSucceeded,
} from "../../../src/trace-utils";

const PAY_TO = "0:2222222222222222222222222222222222222222222222222222222222222222";
const SOURCE_JETTON_WALLET = "0:3333333333333333333333333333333333333333333333333333333333333333";
const FACILITATOR = "0:4444444444444444444444444444444444444444444444444444444444444444";
const RECIPIENT_JETTON_WALLET =
  "0:5555555555555555555555555555555555555555555555555555555555555555";

describe("ExactTvmScheme facilitator", () => {
  it("advertises sponsored TVM support and signer addresses", () => {
    const signer = createMockSigner();
    const scheme = new ExactTvmScheme(signer);

    expect(scheme.scheme).toBe("exact");
    expect(scheme.caipFamily).toBe("tvm:*");
    expect(scheme.getExtra(TVM_TESTNET)).toEqual({ areFeesSponsored: true });
    expect(scheme.getExtra("tvm:999")).toBeUndefined();
    expect(scheme.getSigners(TVM_TESTNET)).toEqual([FACILITATOR]);
  });

  it("verifies a native W5R1 settlement BoC", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result).toEqual({ isValid: true, payer: fixture.payer });
    expect(fixture.signer.getJettonWallet).toHaveBeenCalledWith(
      fixture.requirements.asset,
      fixture.payer,
      TVM_TESTNET,
    );
    expect(fixture.signer.emulateExternalMessage).toHaveBeenCalled();
  });

  it("rejects unsupported x402 versions", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(
      { ...fixture.payload, x402Version: 1 },
      fixture.requirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_UNSUPPORTED_VERSION);
  });

  it("rejects amount mismatches", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, {
      ...fixture.requirements,
      amount: "10001",
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_AMOUNT);
  });

  it("rejects unsupported networks", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, {
      ...fixture.requirements,
      network: "tvm:999" as `${string}:${string}`,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_UNSUPPORTED_NETWORK);
  });

  it("rejects unsupported schemes", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(
      {
        ...fixture.payload,
        accepted: { ...fixture.payload.accepted, scheme: "upto" },
      },
      fixture.requirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_UNSUPPORTED_SCHEME);
  });

  it("rejects asset mismatches", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, {
      ...fixture.requirements,
      asset: "0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_ASSET);
  });

  it("rejects payee mismatches", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, {
      ...fixture.requirements,
      payTo: "0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_RECIPIENT);
  });

  it("rejects seqno mismatches for active payer wallets", async () => {
    const fixture = await createFixture({}, { payerAccount: { seqno: 1 } });
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_SEQNO);
  });

  it("rejects wallet id mismatches for active payer wallets", async () => {
    const fixture = await createFixture({}, { payerAccount: { walletId: 123 } });
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_WALLET_ID);
  });

  it("rejects invalid active payer wallet code", async () => {
    const fixture = await createFixture({}, { payerAccount: { code: beginCell().endCell() } });
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_CODE_HASH);
  });

  it("rejects insufficient payer jetton balance", async () => {
    const fixture = await createFixture({}, { jettonBalance: 9999n });
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INSUFFICIENT_BALANCE);
  });

  it("rejects insufficient facilitator TON balance", async () => {
    const fixture = await createFixture(
      {},
      { facilitatorBalance: MIN_FACILITATOR_TON_BALANCE - 1n },
    );
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE);
  });

  it("rejects simulation failures", async () => {
    const fixture = await createFixture({}, { trace: { transactions: {} } });
    const scheme = new ExactTvmScheme(fixture.signer);

    const result = await scheme.verify(fixture.payload, fixture.requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_SIMULATION_FAILED);
  });

  it("settles by re-verifying, batching, broadcasting, and checking the finalized trace", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer, { batchFlushSize: 1 });

    const result = await scheme.settle(fixture.payload, fixture.requirements);

    expect(result.success).toBe(true);
    expect(result.payer).toBe(fixture.payer);
    expect(result.network).toBe(TVM_TESTNET);
    expect(result.transaction).toBe("b".repeat(64));
    expect(fixture.signer.sendExternalMessage).toHaveBeenCalledWith(
      TVM_TESTNET,
      Buffer.from("relay"),
    );
    expect(fixture.signer.waitForTraceConfirmation).toHaveBeenCalled();
  });

  it("rejects duplicate in-flight settlement BoCs", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer, { batchFlushSize: 1 });
    const privateScheme = scheme as unknown as {
      settlementCache: { isDuplicate: (hash: string, timeoutSeconds: number) => boolean };
    };
    privateScheme.settlementCache.isDuplicate(fixture.settlement.settlementHash, 300);

    await expect(scheme.settle(fixture.payload, fixture.requirements)).resolves.toMatchObject({
      success: false,
      errorReason: ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
    });
  });

  it("releases settlement cache entries after successful confirmation", async () => {
    const fixture = await createFixture();
    const scheme = new ExactTvmScheme(fixture.signer, { batchFlushSize: 1 });

    await expect(scheme.settle(fixture.payload, fixture.requirements)).resolves.toMatchObject({
      success: true,
    });
    await expect(scheme.settle(fixture.payload, fixture.requirements)).resolves.toMatchObject({
      success: true,
    });
  });
});

describe("exact codec and jetton parsing", () => {
  it("rejects malformed settlement BoCs and invalid W5 payloads", async () => {
    expect(() => parseExactTvmPayload("not-a-boc")).toThrow(ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC);

    const externalOnly = beginCell().storeUint(0, 1).endCell().toBoc().toString("base64");
    expect(() => parseExactTvmPayload(externalOnly)).toThrow(ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC);

    const fixture = await createFixture();
    const invalidOpcodeBoc = await toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 12)), {
      network: TVM_TESTNET,
    }).signTransfer(
      0,
      Math.floor(Date.now() / 1000) + 60,
      [
        {
          address: SOURCE_JETTON_WALLET,
          amount: 1n,
          body: beginCell().storeUint(0, 1).endCell(),
        },
      ],
      { includeStateInit: false },
    );
    const tampered = Buffer.from(invalidOpcodeBoc, "base64");
    tampered[20] ^= 0xff;
    expect(() => parseExactTvmPayload(tampered.toString("base64"))).toThrow(
      new RegExp(`${ERR_EXACT_TVM_INVALID_W5_MESSAGE}|${ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC}`),
    );

    expect(fixture.settlement.transfer.destination).toBe(PAY_TO);
  });

  it("rejects invalid jetton transfer bodies", () => {
    const wallet = SOURCE_JETTON_WALLET;
    expect(() => parseJettonTransfer(wallet, beginCell().endCell())).toThrow(
      ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    );

    const wrongOpcode = beginCell().storeUint(0xdeadbeef, 32).endCell();
    expect(() => parseJettonTransfer(wallet, wrongOpcode)).toThrow(
      ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    );

    const withCustomPayload = beginCell()
      .storeUint(JETTON_TRANSFER_OPCODE, 32)
      .storeUint(0, 64)
      .storeCoins(1n)
      .storeAddress(Address.parse(PAY_TO))
      .storeAddress(null)
      .storeBit(true)
      .endCell();
    expect(() => parseJettonTransfer(wallet, withCustomPayload)).toThrow(
      ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    );
  });

  it("builds jetton transfer bodies with optional forward payload", () => {
    const forwardPayload = beginCell().storeUint(7, 8).endCell().toBoc().toString("base64");
    const body = buildJettonTransferBodyFields({
      amount: 100n,
      payTo: PAY_TO,
      extra: {
        forwardTonAmount: "1",
        responseDestination: PAY_TO,
        forwardPayload,
      },
    });
    const parsed = parseJettonTransfer(SOURCE_JETTON_WALLET, body);
    expect(parsed.forwardTonAmount).toBe(1n);
    expect(parsed.responseDestination).toBe(PAY_TO);
    expect(() =>
      buildJettonTransferBodyFields({
        amount: 1n,
        payTo: PAY_TO,
        extra: { forwardTonAmount: "-1" },
      }),
    ).toThrow(/Forward TON amount should be >= 0/);
  });
});

describe("trace utils", () => {
  it("parses trace transactions and fee metadata", () => {
    const trace = {
      transactions: {
        one: {
          description: {
            aborted: false,
            compute_ph: { skipped: false, success: true, gas_fees: "100" },
            action: { success: true, total_fwd_fees: "250" },
            storage_ph: { storage_fees_collected: "10", storage_fees_due: "5" },
          },
          out_msgs: [{ fwd_fee: "250" }],
          account_state_before: { balance: "1000" },
        },
      },
    };
    expect(parseTraceTransactions(trace)).toHaveLength(1);
    expect(transactionSucceeded(trace.transactions.one)).toBe(true);
    expect(traceTransactionFwdFees(trace.transactions.one)).toBe(250n);
    expect(traceTransactionComputeFees(trace.transactions.one)).toBe(100n);
    expect(traceTransactionStorageFees(trace.transactions.one)).toBe(15n);
    expect(traceTransactionBalanceBefore(trace.transactions.one)).toBe(1000n);
    expect(traceTransactionHashToHex("YWJj")).toBe("616263");
    expect(traceTransactionHashToHex("a".repeat(64))).toBe("a".repeat(64));
    expect(
      messageBodyHashMatches(
        { message_content: { hash: beginCell().endCell().hash().toString("base64") } },
        beginCell().endCell().hash(),
      ),
    ).toBe(true);
    expect(() => parseTraceTransactions({ transactions: [] })).toThrow(
      /did not return transactions dict/,
    );
  });
});

describe("SettlementBatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails queued settlements when broadcast or confirmation fails", async () => {
    const cache = new SettlementCache();
    const fixture = await createFixture();
    const settlementVerifier = vi.fn(() => "confirmed-tx");

    const failingBroadcastSigner = createMockSigner({
      trace: traceForSettlement(fixture.settlement),
    });
    failingBroadcastSigner.buildRelayExternalBocBatch.mockRejectedValue(
      new Error("broadcast failed"),
    );
    const broadcastBatcher = new SettlementBatcher(failingBroadcastSigner, cache, {
      batchFlushSize: 1,
      settlementVerifier,
    });
    await expect(broadcastBatcher.enqueue(createQueuedSettlement(fixture))).resolves.toMatchObject({
      success: false,
      errorReason: ERR_EXACT_TVM_TRANSACTION_FAILED,
      errorMessage: "broadcast failed",
    });

    const failingConfirmationSigner = createMockSigner({
      trace: traceForSettlement(fixture.settlement),
    });
    failingConfirmationSigner.waitForTraceConfirmation.mockRejectedValue(
      new Error("confirmation failed"),
    );
    const confirmationBatcher = new SettlementBatcher(failingConfirmationSigner, cache, {
      batchFlushSize: 1,
      settlementVerifier,
    });
    await expect(
      confirmationBatcher.enqueue(createQueuedSettlement(fixture)),
    ).resolves.toMatchObject({
      success: false,
      errorMessage: "confirmation failed",
    });

    settlementVerifier.mockImplementation(() => {
      throw new Error("verification failed");
    });
    const verificationBatcher = new SettlementBatcher(
      createMockSigner({ trace: traceForSettlement(fixture.settlement) }),
      cache,
      { batchFlushSize: 1, settlementVerifier },
    );
    await expect(
      verificationBatcher.enqueue(createQueuedSettlement(fixture)),
    ).resolves.toMatchObject({
      success: false,
      errorMessage: "verification failed",
    });
  });

  it("flushes queued settlements when the timer elapses", async () => {
    vi.useFakeTimers();
    const cache = new SettlementCache();
    const fixture = await createFixture();
    const settlementVerifier = vi.fn(() => "confirmed-tx");
    const batcher = new SettlementBatcher(
      createMockSigner({ trace: traceForSettlement(fixture.settlement) }),
      cache,
      {
        flushIntervalSeconds: 1,
        batchFlushSize: 10,
        settlementVerifier,
      },
    );

    const resultPromise = batcher.enqueue(createQueuedSettlement(fixture));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      transaction: "confirmed-tx",
    });
  });
});

function createQueuedSettlement(fixture: Awaited<ReturnType<typeof createFixture>>): {
  network: string;
  settlementHash: string;
  settlement: ParsedTvmSettlement;
  relayRequest: TvmRelayRequest;
} {
  return {
    network: TVM_TESTNET,
    settlementHash: fixture.settlement.settlementHash,
    settlement: fixture.settlement,
    relayRequest: {
      destination: fixture.settlement.transfer.sourceWallet,
      body: fixture.settlement.transfer.forwardPayload,
      stateInit: fixture.settlement.stateInit,
      forwardTonAmount: fixture.settlement.transfer.attachedTonAmount,
    },
  };
}

async function createFixture(
  overrides: Partial<PaymentRequirements> = {},
  options: {
    jettonBalance?: bigint;
    facilitatorBalance?: bigint;
    payerAccount?: { seqno?: number; walletId?: number; code?: Cell };
    trace?: Record<string, unknown>;
  } = {},
) {
  const keyPair = keyPairFromSeed(Buffer.alloc(32, 7));
  const clientSigner = toClientTvmSigner(keyPair, { network: TVM_TESTNET });
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: TVM_TESTNET,
    amount: "10000",
    asset: USDT_TESTNET_MINTER,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
  const body = buildJettonTransferBodyFields({
    amount: BigInt(requirements.amount),
    payTo: requirements.payTo,
    extra: requirements.extra,
  });
  const settlementBoc = await clientSigner.signTransfer(
    0,
    Math.floor(Date.now() / 1000) + 60,
    [
      {
        address: SOURCE_JETTON_WALLET,
        amount: DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
        body,
      },
    ],
    { includeStateInit: true },
  );
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      settlementBoc,
      asset: requirements.asset,
    },
  };
  const settlement = parseExactTvmPayload(settlementBoc);
  const trace = options.trace ?? traceForSettlement(settlement);
  const signer = createMockSigner({
    payer: settlement.payer,
    trace,
    facilitatorBalance: options.facilitatorBalance,
    payerAccountState: options.payerAccount
      ? activeW5Account({
          address: settlement.payer,
          publicKey: keyPair.publicKey,
          seqno: options.payerAccount.seqno ?? settlement.seqno,
          walletId: options.payerAccount.walletId ?? settlement.walletId,
          code: options.payerAccount.code,
        })
      : undefined,
    jettonWalletData: {
      address: SOURCE_JETTON_WALLET,
      balance: options.jettonBalance ?? 10000n,
      owner: settlement.payer,
      jettonMinter: requirements.asset,
    },
  });
  return { payload, requirements, signer, payer: settlement.payer, settlement };
}

function createMockSigner({
  payer,
  trace,
  facilitatorBalance,
  payerAccountState,
  jettonWalletData,
}: {
  payer?: string;
  trace?: Record<string, unknown>;
  facilitatorBalance?: bigint;
  payerAccountState?: TvmAccountState;
  jettonWalletData?: TvmJettonWalletData;
} = {}): FacilitatorTvmSigner & Record<string, ReturnType<typeof vi.fn>> {
  const accountState = (address: string): TvmAccountState => {
    if (address === FACILITATOR) {
      return account(address, {
        balance: facilitatorBalance ?? MIN_FACILITATOR_TON_BALANCE + 1n,
      });
    }
    if (payer && address === payer) {
      return payerAccountState ?? account(address, { isUninitialized: true });
    }
    return account(address);
  };

  return {
    getAddresses: vi.fn(() => [FACILITATOR]),
    getAddressesForNetwork: vi.fn(() => [FACILITATOR]),
    getAccountState: vi.fn(async (address: string) => accountState(address)),
    getJettonWallet: vi.fn(async (_asset: string, owner: string) =>
      owner === PAY_TO ? RECIPIENT_JETTON_WALLET : SOURCE_JETTON_WALLET,
    ),
    getJettonWalletData: vi.fn(async () => {
      if (!jettonWalletData) throw new Error("missing jetton wallet data");
      return jettonWalletData;
    }),
    buildRelayExternalBoc: vi.fn(async () => Buffer.from("relay")),
    buildRelayExternalBocBatch: vi.fn(async () => Buffer.from("relay")),
    emulateExternalMessage: vi.fn(async () => trace ?? { transactions: {} }),
    sendExternalMessage: vi.fn(async () => "external-hash"),
    waitForTraceConfirmation: vi.fn(async () => trace ?? { transactions: {} }),
  };
}

function account(address: string, overrides: Partial<TvmAccountState> = {}): TvmAccountState {
  return {
    address,
    balance: 0n,
    isActive: false,
    isUninitialized: false,
    isFrozen: false,
    stateInit: null,
    ...overrides,
  };
}

function activeW5Account({
  address,
  publicKey,
  seqno,
  walletId,
  code,
}: {
  address: string;
  publicKey: Buffer;
  seqno: number;
  walletId: number;
  code?: Cell;
}): TvmAccountState {
  return account(address, {
    isActive: true,
    isUninitialized: false,
    stateInit: {
      code: code ?? Cell.fromBoc(Buffer.from(W5R1_CODE_HEX, "hex"))[0],
      data: beginCell()
        .storeUint(1, 1)
        .storeUint(seqno, 32)
        .storeUint(walletId, 32)
        .storeBuffer(publicKey, 32)
        .storeBit(false)
        .endCell(),
    },
  });
}

function traceForSettlement(settlement: ParsedTvmSettlement): Record<string, unknown> {
  const outHash = "out-message-hash";
  const recipientHash = "recipient-message-hash";
  return {
    transactions: {
      payer: {
        account: settlement.payer,
        hash: "a".repeat(64),
        hash_norm: "b".repeat(64),
        description: successDescription(),
        in_msg: {
          message_content: { hash: settlement.body.hash().toString("base64") },
        },
        out_msgs: [
          {
            destination: settlement.transfer.sourceWallet,
            hash: outHash,
            fwd_fee: "1000",
            message_content: { hash: settlement.transfer.bodyHash.toString("base64") },
          },
        ],
      },
      sourceWallet: {
        account: settlement.transfer.sourceWallet,
        hash: "c".repeat(64),
        hash_norm: "d".repeat(64),
        description: successDescription(),
        in_msg: { hash: outHash },
        out_msgs: [
          {
            destination: RECIPIENT_JETTON_WALLET,
            hash: recipientHash,
          },
        ],
      },
      recipientWallet: {
        account: RECIPIENT_JETTON_WALLET,
        hash: "e".repeat(64),
        hash_norm: "f".repeat(64),
        description: successDescription(),
        in_msg: { hash: recipientHash },
        out_msgs: [],
      },
    },
    is_incomplete: false,
  };
}

function successDescription() {
  return {
    aborted: false,
    compute_ph: { skipped: false, success: true, gas_fees: "1000" },
    action: { success: true, total_fwd_fees: "1000" },
    storage_ph: { storage_fees_collected: "0", storage_fees_due: "0" },
  };
}
