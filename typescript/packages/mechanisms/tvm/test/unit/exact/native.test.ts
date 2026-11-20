import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { keyPairFromSeed } from "@ton/crypto";
import { beginCell, Cell } from "@ton/core";
import { ExactTvmScheme as ExactTvmClientScheme } from "../../../src/exact/client/scheme";
import { ExactTvmScheme as ExactTvmFacilitatorScheme } from "../../../src/exact/facilitator/scheme";
import { ExactTvmScheme as ExactTvmServerScheme } from "../../../src/exact/server/scheme";
import { parseExactTvmNativePayload } from "../../../src/exact/codec";
import { isNativeTransfer } from "../../../src/codecs/native";
import {
  DEFAULT_TVM_OUTER_GAS_BUFFER,
  ERR_EXACT_TVM_INSUFFICIENT_BALANCE,
  ERR_EXACT_TVM_INVALID_AMOUNT,
  ERR_EXACT_TVM_INVALID_ASSET,
  ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
  ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER,
  ERR_EXACT_TVM_INVALID_RECIPIENT,
  ERR_EXACT_TVM_SIMULATION_FAILED,
  MIN_FACILITATOR_TON_BALANCE,
  NATIVE_ASSET,
  TVM_TESTNET,
  USDT_TESTNET_MINTER,
} from "../../../src/constants";
import { toClientTvmSigner, type FacilitatorTvmSigner } from "../../../src/signer";
import type {
  ParsedNativeTransfer,
  ParsedTvmSettlement,
  TvmAccountState,
} from "../../../src/types";

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getAccountState: vi.fn(),
    getJettonWallet: vi.fn(),
    emulateTrace: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("../../../src/provider", () => ({
  createTvmProviderClient: vi.fn(() => mockProvider),
}));

const PAY_TO = "0:2222222222222222222222222222222222222222222222222222222222222222";
const FACILITATOR = "0:4444444444444444444444444444444444444444444444444444444444444444";
const AMOUNT = 10_000_000n; // 0.01 TON
const FWD_FEE = 400_000n;
const COMMENT = beginCell().storeUint(0, 32).storeStringTail("inv-42").endCell();
const COMMENT_B64 = COMMENT.toBoc().toString("base64");
const keyPair = keyPairFromSeed(Buffer.alloc(32, 7));

function nativeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: TVM_TESTNET,
    amount: AMOUNT.toString(),
    asset: NATIVE_ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true, forwardPayload: COMMENT_B64 },
    ...overrides,
  };
}

async function signNativePayment(
  options: { amount?: bigint; body?: Cell; to?: string; includeStateInit?: boolean } = {},
) {
  const signer = toClientTvmSigner(keyPair, { network: TVM_TESTNET });
  return signer.signTransfer(
    0,
    Math.floor(Date.now() / 1000) + 60,
    [
      {
        address: options.to ?? PAY_TO,
        amount: options.amount ?? AMOUNT,
        body: options.body ?? COMMENT,
      },
    ],
    { includeStateInit: options.includeStateInit ?? true },
  );
}

function payloadFor(settlementBoc: string, requirements: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { settlementBoc, asset: NATIVE_ASSET },
  };
}

function nativeTrace(
  settlement: ParsedTvmSettlement,
  options: { sentValue?: bigint; sendPayment?: boolean; bounced?: boolean } = {},
): Record<string, unknown> {
  const transfer = settlement.transfer as ParsedNativeTransfer;
  return {
    transactions: {
      payer: {
        account: settlement.payer,
        hash: "a".repeat(64),
        description: {
          aborted: false,
          compute_ph: { skipped: false, success: true, gas_fees: "1000000" },
          action: { success: true },
          storage_ph: { storage_fees_collected: "2000", storage_fees_due: "0" },
        },
        in_msg: { message_content: { hash: settlement.body.hash().toString("base64") } },
        out_msgs:
          options.sendPayment === false
            ? []
            : [
                {
                  destination: PAY_TO,
                  hash: "payment-msg",
                  value: String(options.sentValue ?? AMOUNT),
                  fwd_fee: FWD_FEE.toString(),
                  message_content: { hash: transfer.body.hash().toString("base64") },
                },
              ],
      },
      merchant: {
        account: PAY_TO,
        hash: "b".repeat(64),
        description: {
          aborted: Boolean(options.bounced),
          compute_ph: { skipped: Boolean(options.bounced), success: !options.bounced },
          ...(options.bounced ? { bounce: { type: "ok" } } : {}),
        },
        in_msg: { hash: "payment-msg" },
      },
    },
  };
}

function facilitatorSigner(
  payer: string,
  trace: Record<string, unknown>,
  payerBalance: bigint,
): FacilitatorTvmSigner & Record<string, ReturnType<typeof vi.fn>> {
  const state = (address: string, overrides: Partial<TvmAccountState>): TvmAccountState => ({
    address,
    balance: 0n,
    isActive: false,
    isUninitialized: false,
    isFrozen: false,
    stateInit: null,
    ...overrides,
  });
  return {
    getAddresses: vi.fn(() => [FACILITATOR]),
    getAddressesForNetwork: vi.fn(() => [FACILITATOR]),
    getAccountState: vi.fn(async (address: string) =>
      address === FACILITATOR
        ? state(address, { balance: MIN_FACILITATOR_TON_BALANCE + 1n, isActive: true })
        : state(address, { balance: payerBalance, isUninitialized: address === payer }),
    ),
    getJettonWallet: vi.fn(),
    getJettonWalletData: vi.fn(),
    buildRelayExternalBoc: vi.fn(async () => Buffer.from("relay")),
    buildRelayExternalBocBatch: vi.fn(async () => Buffer.from("relay")),
    emulateExternalMessage: vi.fn(async () => trace),
    sendExternalMessage: vi.fn(async () => "external-hash"),
    waitForTraceConfirmation: vi.fn(async () => trace),
  };
}

async function facilitatorFixture(
  options: {
    boc?: string;
    requirements?: PaymentRequirements;
    payerBalance?: bigint;
    trace?: Parameters<typeof nativeTrace>[1];
  } = {},
) {
  const boc = options.boc ?? (await signNativePayment());
  const requirements = options.requirements ?? nativeRequirements();
  const settlement = parseExactTvmNativePayload(boc);
  const signer = facilitatorSigner(
    settlement.payer,
    nativeTrace(settlement, options.trace),
    options.payerBalance ?? AMOUNT * 2n,
  );
  return {
    scheme: new ExactTvmFacilitatorScheme(signer),
    signer,
    settlement,
    payload: payloadFor(boc, requirements),
    requirements,
  };
}

describe("native TON codec", () => {
  it("parses destination, exact value and body of the signed transfer", async () => {
    const settlement = parseExactTvmNativePayload(await signNativePayment());

    expect(isNativeTransfer(settlement.transfer)).toBe(true);
    const transfer = settlement.transfer as ParsedNativeTransfer;
    expect(transfer.destination).toBe(PAY_TO);
    expect(transfer.amount).toBe(AMOUNT);
    expect(transfer.body.hash().equals(COMMENT.hash())).toBe(true);
    expect(transfer.hasExtraCurrencies).toBe(false);
    expect(transfer.hasStateInit).toBe(false);
  });
});

describe("native TON client", () => {
  const signer = toClientTvmSigner(keyPair, { network: TVM_TESTNET });

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.getAccountState.mockResolvedValue({
      address: signer.address,
      balance: AMOUNT,
      isActive: false,
      isUninitialized: true,
      isFrozen: false,
      stateInit: null,
    });
  });

  it("signs one transfer of exactly amount to payTo without Jetton lookups or emulation", async () => {
    const client = new ExactTvmClientScheme(signer);

    const result = await client.createPaymentPayload(2, nativeRequirements());
    const payload = result.payload as { settlementBoc: string; asset: string };
    const settlement = parseExactTvmNativePayload(payload.settlementBoc);

    expect(payload.asset).toBe(NATIVE_ASSET);
    expect((settlement.transfer as ParsedNativeTransfer).amount).toBe(AMOUNT);
    expect((settlement.transfer as ParsedNativeTransfer).destination).toBe(PAY_TO);
    expect(settlement.stateInit).not.toBeNull();
    expect(mockProvider.getJettonWallet).not.toHaveBeenCalled();
    expect(mockProvider.emulateTrace).not.toHaveBeenCalled();
  });

  it("sends an empty body when forwardPayload is omitted", async () => {
    const client = new ExactTvmClientScheme(signer);

    const result = await client.createPaymentPayload(
      2,
      nativeRequirements({ extra: { areFeesSponsored: true } }),
    );
    const settlement = parseExactTvmNativePayload(
      (result.payload as { settlementBoc: string }).settlementBoc,
    );

    expect(
      (settlement.transfer as ParsedNativeTransfer).body.hash().equals(Cell.EMPTY.hash()),
    ).toBe(true);
  });

  it("refuses when the wallet balance does not cover the amount", async () => {
    mockProvider.getAccountState.mockResolvedValue({
      address: signer.address,
      balance: AMOUNT - 1n,
      isActive: true,
      isUninitialized: false,
      isFrozen: false,
      stateInit: null,
    });
    const client = new ExactTvmClientScheme(signer);

    await expect(client.createPaymentPayload(2, nativeRequirements())).rejects.toThrow(
      "below the payment amount",
    );
  });

  it("refuses Jetton-only extra fields", async () => {
    const client = new ExactTvmClientScheme(signer);

    await expect(
      client.createPaymentPayload(
        2,
        nativeRequirements({ extra: { areFeesSponsored: true, forwardTonAmount: "0" } }),
      ),
    ).rejects.toThrow("must not set");
  });
});

describe("native TON facilitator", () => {
  it("accepts a valid payment", async () => {
    const { scheme, payload, requirements, settlement } = await facilitatorFixture();

    expect(await scheme.verify(payload, requirements)).toEqual({
      isValid: true,
      payer: settlement.payer,
    });
  });

  it("relays only gas, never the payment value", async () => {
    const { scheme, signer, payload, requirements } = await facilitatorFixture();
    const enqueue = vi
      .spyOn(
        (scheme as unknown as { batcher: { enqueue: (...args: unknown[]) => unknown } }).batcher,
        "enqueue",
      )
      .mockResolvedValue({ success: true, transaction: "native-tx" });

    const result = await scheme.settle(payload, requirements);

    expect(result.success).toBe(true);
    const relayRequest = (enqueue.mock.calls[0][0] as { relayRequest: { relayAmount: bigint } })
      .relayRequest;
    expect(relayRequest.relayAmount).toBe(1_000_000n + 2_000n + DEFAULT_TVM_OUTER_GAS_BUFFER);
    expect(relayRequest.relayAmount < AMOUNT).toBe(true);
    expect(signer.buildRelayExternalBoc).toHaveBeenCalled();
  });

  it("rejects a wallet whose balance covers the amount but not the forward fee", async () => {
    const { scheme, payload, requirements } = await facilitatorFixture({
      payerBalance: AMOUNT + FWD_FEE - 1n,
    });

    const result = await scheme.verify(payload, requirements);

    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INSUFFICIENT_BALANCE);
  });

  it.each([
    ["recipient", { to: "0:" + "9".repeat(64) }, ERR_EXACT_TVM_INVALID_RECIPIENT],
    ["amount", { amount: AMOUNT - 1n }, ERR_EXACT_TVM_INVALID_AMOUNT],
    ["body", { body: Cell.EMPTY }, ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER],
  ])("rejects a settlement with a different %s", async (_name, signOptions, reason) => {
    const { scheme, payload, requirements } = await facilitatorFixture({
      boc: await signNativePayment(signOptions),
    });

    const result = await scheme.verify(payload, requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(reason);
  });

  it.each([{ forwardTonAmount: "0" }, { responseDestination: PAY_TO }])(
    "rejects Jetton-only extra field %o",
    async extraField => {
      const requirements = nativeRequirements({
        extra: { areFeesSponsored: true, forwardPayload: COMMENT_B64, ...extraField },
      });
      const { scheme, payload } = await facilitatorFixture({ requirements });

      const result = await scheme.verify(payload, requirements);

      expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER);
    },
  );

  it("rejects a native payload against Jetton requirements", async () => {
    const { scheme, payload } = await facilitatorFixture();

    // The settlement is decoded as a Jetton transfer first, which a plain TON transfer is not.
    const result = await scheme.verify(payload, nativeRequirements({ asset: USDT_TESTNET_MINTER }));

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
  });

  it("rejects a payload whose asset differs from native requirements", async () => {
    const { scheme, payload, requirements } = await facilitatorFixture();

    const result = await scheme.verify(
      { ...payload, payload: { ...payload.payload, asset: USDT_TESTNET_MINTER } },
      requirements,
    );

    expect(result.invalidReason).toBe(ERR_EXACT_TVM_INVALID_ASSET);
  });

  it.each([
    ["skipped action", { sendPayment: false }],
    ["wrong value", { sentValue: AMOUNT - 1n }],
    ["bounce", { bounced: true }],
  ])("rejects a trace with a %s", async (_name, trace) => {
    const { scheme, payload, requirements } = await facilitatorFixture({ trace });

    const result = await scheme.verify(payload, requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ERR_EXACT_TVM_SIMULATION_FAILED);
  });

  it("returns the payer transaction hash from a finalized trace", async () => {
    const { settlement } = await facilitatorFixture();

    expect(
      ExactTvmFacilitatorScheme.verifyFinalizedTraceSettlement(nativeTrace(settlement), {
        settlement,
      }),
    ).toBe("a".repeat(64));
  });
});

describe("native TON server", () => {
  it("parses a TON price as nanotons of the native asset", async () => {
    const server = new ExactTvmServerScheme();

    expect(await server.parsePrice("0.01 TON", TVM_TESTNET)).toEqual({
      amount: AMOUNT.toString(),
      asset: NATIVE_ASSET,
      extra: { areFeesSponsored: true },
    });
  });

  it("converts decimal native amounts with 9 decimals and adds no Jetton defaults", async () => {
    const server = new ExactTvmServerScheme();

    const requirements = await server.enhancePaymentRequirements(
      nativeRequirements({ amount: "0.5", extra: {} }),
      { x402Version: 2, scheme: "exact", network: TVM_TESTNET },
      [],
    );

    expect(requirements.asset).toBe(NATIVE_ASSET);
    expect(requirements.amount).toBe("500000000");
    expect(requirements.extra).toEqual({ areFeesSponsored: true });
  });
});
