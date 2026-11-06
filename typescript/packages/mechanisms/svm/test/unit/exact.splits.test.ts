import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme as ExactSvmClient } from "../../src/exact/client/scheme";
import { ExactSvmScheme as ExactSvmFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactSvmScheme as ExactSvmServer } from "../../src/exact/server/scheme";
import { verifyPostSettlementLegs } from "../../src/exact/facilitator/smartWalletVerification";
import * as Errors from "../../src/exact/facilitator/errors";
import {
  assertFeePayerIsolatedWithAtaCreation,
  deriveLegDestinations,
  getSplitCapabilities,
  matchTransfersToLegs,
  parsePaymentLegs,
  SplitsError,
  validateAtaCreation,
  type ObservedTransfer,
} from "../../src/exact/splits";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import type { FacilitatorSvmSigner } from "../../src/signer";

const BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";
const SWIG_PROGRAM = "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB";

const existingAccounts = new Set<string>();

vi.mock("@solana-program/token-2022", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana-program/token-2022")>();
  return { ...actual, fetchMint: vi.fn() };
});

vi.mock("../../src/utils", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/utils")>();
  return {
    ...actual,
    createRpcClient: () => ({
      getAccountInfo: (address: string) => ({
        send: async () => ({ value: existingAccounts.has(address) ? { data: [] } : null }),
      }),
      getLatestBlockhash: () => ({
        send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n } }),
      }),
    }),
  };
});

type Parties = {
  payer: KeyPairSigner;
  feePayer: KeyPairSigner;
  merchant: KeyPairSigner;
  platform: KeyPairSigner;
  referrer: KeyPairSigner;
};

async function parties(): Promise<Parties> {
  const [payer, feePayer, merchant, platform, referrer] = await Promise.all(
    Array.from({ length: 5 }, () => generateKeyPairSigner()),
  );
  return { payer, feePayer, merchant, platform, referrer };
}

function requirements(p: Parties, extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    asset: USDC_DEVNET_ADDRESS,
    amount: "1050000",
    payTo: p.merchant.address,
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: p.feePayer.address,
      recentBlockhash: BLOCKHASH,
      splits: [
        { payTo: p.platform.address, amount: "40000", memo: "platform fee" },
        { payTo: p.referrer.address, amount: "10000", memo: "referral" },
      ],
      ...extra,
    },
  };
}

function payment(req: PaymentRequirements, transaction: string): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://example.com", description: "", mimeType: "application/json" },
    accepted: req,
    payload: { transaction },
  };
}

function facilitatorSigner(feePayer: string): FacilitatorSvmSigner {
  return {
    getAddresses: () => [feePayer as Address],
    signTransaction: vi.fn(async (tx: string) => tx),
    simulateTransaction: vi.fn(async () => undefined),
    sendTransaction: vi.fn(async () => "sig"),
    confirmTransaction: vi.fn(async () => undefined),
    simulateTransactionWithInnerInstructions: vi.fn(async () => ({ innerInstructions: [] })),
    getConfirmedTransactionInnerInstructions: vi.fn(async () => ({ innerInstructions: [] })),
    getTokenAccountBalance: vi.fn(async () => null),
    fetchAddressLookupTables: vi.fn(async () => ({})),
  } as unknown as FacilitatorSvmSigner;
}

function compiledOf(base64: string) {
  const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  return getCompiledTransactionMessageDecoder().decode(messageBytes);
}

function instructionsOf(base64: string) {
  return decompileTransactionMessage(compiledOf(base64)).instructions;
}

async function ata(owner: string): Promise<Address> {
  const [address] = await findAssociatedTokenPda({
    owner: owner as Address,
    mint: USDC_DEVNET_ADDRESS as Address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
  });
  return address;
}

async function transfer(p: Parties, owner: string, amount: bigint): Promise<Instruction> {
  const [source] = await findAssociatedTokenPda({
    owner: p.payer.address,
    mint: USDC_DEVNET_ADDRESS as Address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
  });
  return getTransferCheckedInstruction(
    {
      source,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: await ata(owner),
      authority: p.payer,
      amount,
      decimals: 6,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS as Address },
  );
}

async function buildTransaction(p: Parties, instructions: Instruction[]): Promise<string> {
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageComputeUnitPrice(1, m),
    m => setTransactionMessageFeePayer(p.feePayer.address, m),
    m =>
      prependTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: 60_000 }), m),
    m => appendTransactionMessageInstructions(instructions, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 1n },
        m,
      ),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(tx));
}

const memo = (text: string): Instruction => ({
  programAddress: MEMO_PROGRAM_ADDRESS as Address,
  data: new TextEncoder().encode(text),
});

beforeEach(() => {
  existingAccounts.clear();
  vi.mocked(fetchMint).mockResolvedValue({
    data: { decimals: 6 },
    programAddress: TOKEN_PROGRAM_ADDRESS,
  } as never);
});

describe("parsePaymentLegs", () => {
  it("puts the remainder on the primary leg, then splits in order", async () => {
    const p = await parties();
    const legs = parsePaymentLegs(requirements(p));
    expect(legs.map(l => [l.owner, l.amount, l.isPrimary])).toEqual([
      [p.merchant.address, 1_000_000n, true],
      [p.platform.address, 40_000n, false],
      [p.referrer.address, 10_000n, false],
    ]);
  });

  it.each([
    ["a non-canonical amount", { amount: "040000" }, Errors.ErrSplitsInvalid],
    ["a zero amount", { amount: "0" }, Errors.ErrSplitsInvalid],
    ["an amount above u64", { amount: "18446744073709551616" }, Errors.ErrSplitsInvalid],
    ["an invalid address", { payTo: "not-an-address" }, Errors.ErrSplitsInvalid],
    ["a memo over 566 bytes", { memo: "x".repeat(567) }, Errors.ErrSplitsInvalid],
    ["a non-boolean ataCreationRequired", { ataCreationRequired: "yes" }, Errors.ErrSplitsInvalid],
  ])("rejects a split with %s", async (_, override, reason) => {
    const p = await parties();
    const req = requirements(p);
    (req.extra.splits as Record<string, unknown>[])[0] = {
      ...(req.extra.splits as Record<string, unknown>[])[0],
      ...override,
    };
    expect(() => parsePaymentLegs(req)).toThrow(reason);
  });

  it("rejects a split paying the primary payTo or another split", async () => {
    const p = await parties();
    const toPrimary = requirements(p, {
      splits: [{ payTo: p.merchant.address, amount: "1" }],
    });
    const duplicate = requirements(p, {
      splits: [
        { payTo: p.platform.address, amount: "1" },
        { payTo: p.platform.address, amount: "2" },
      ],
    });
    expect(() => parsePaymentLegs(toPrimary)).toThrow(Errors.ErrSplitsInvalid);
    expect(() => parsePaymentLegs(duplicate)).toThrow(Errors.ErrSplitsInvalid);
  });

  it("rejects splits that consume the whole amount", async () => {
    const p = await parties();
    const req = requirements(p, { splits: [{ payTo: p.platform.address, amount: "1050000" }] });
    expect(() => parsePaymentLegs(req)).toThrow(Errors.ErrSplitRemainderNotPositive);
  });

  it("rejects more than eight splits", async () => {
    const p = await parties();
    const recipients = await Promise.all(Array.from({ length: 9 }, () => generateKeyPairSigner()));
    const req = requirements(p, {
      splits: recipients.map(r => ({ payTo: r.address, amount: "1" })),
    });
    expect(() => parsePaymentLegs(req)).toThrow(Errors.ErrSplitsInvalid);
  });
});

describe("getSplitCapabilities", () => {
  it("fails closed when the keys are absent or malformed", () => {
    expect(getSplitCapabilities(undefined)).toEqual({ maxSplits: 0, ataCreationSponsored: false });
    expect(getSplitCapabilities({ maxSplits: "8", ataCreationSponsored: "true" })).toEqual({
      maxSplits: 0,
      ataCreationSponsored: false,
    });
    expect(getSplitCapabilities({ maxSplits: 3, ataCreationSponsored: true })).toEqual({
      maxSplits: 3,
      ataCreationSponsored: true,
    });
  });
});

describe("matchTransfersToLegs", () => {
  async function setup() {
    const p = await parties();
    const legs = await deriveLegDestinations(
      parsePaymentLegs(requirements(p)),
      USDC_DEVNET_ADDRESS,
    );
    const t = async (owner: string, amount: bigint): Promise<ObservedTransfer> => ({
      programId: TOKEN_PROGRAM_ADDRESS,
      amount,
      mint: USDC_DEVNET_ADDRESS,
      destination: await ata(owner),
      authority: p.payer.address,
    });
    return { p, legs, t };
  }

  it("lets the primary overpay but holds splits to their exact amount", async () => {
    const { p, legs, t } = await setup();
    const matched = matchTransfersToLegs(
      [
        await t(p.merchant.address, 1_000_001n),
        await t(p.platform.address, 40_000n),
        await t(p.referrer.address, 10_000n),
      ],
      legs,
      USDC_DEVNET_ADDRESS,
    );
    expect(matched.map(m => m.amount)).toEqual([1_000_001n, 40_000n, 10_000n]);

    const transfers1 = [
      await t(p.merchant.address, 1_000_000n),
      await t(p.platform.address, 40_001n),
      await t(p.referrer.address, 10_000n),
    ];
    expect(() => matchTransfersToLegs(transfers1, legs, USDC_DEVNET_ADDRESS)).toThrow(
      Errors.ErrSplitUnexpectedTransfer,
    );
  });

  it("rejects an asset transfer to an undeclared recipient", async () => {
    const { p, legs, t } = await setup();
    const stranger = await generateKeyPairSigner();
    const transfers2 = [
      await t(p.merchant.address, 1_000_000n),
      await t(p.platform.address, 40_000n),
      await t(p.referrer.address, 10_000n),
      await t(stranger.address, 1n),
    ];
    expect(() => matchTransfersToLegs(transfers2, legs, USDC_DEVNET_ADDRESS)).toThrow(
      Errors.ErrSplitUnexpectedTransfer,
    );
  });

  it("rejects a missing leg and a leg paid twice", async () => {
    const { p, legs, t } = await setup();
    const transfers3 = [
      await t(p.merchant.address, 1_000_000n),
      await t(p.platform.address, 40_000n),
    ];
    expect(() => matchTransfersToLegs(transfers3, legs, USDC_DEVNET_ADDRESS)).toThrow(
      Errors.ErrSplitLegUnmatched,
    );
    const transfers4 = [
      await t(p.merchant.address, 1_000_000n),
      await t(p.platform.address, 40_000n),
      await t(p.platform.address, 40_000n),
      await t(p.referrer.address, 10_000n),
    ];
    expect(() => matchTransfersToLegs(transfers4, legs, USDC_DEVNET_ADDRESS)).toThrow(
      Errors.ErrSmartWalletMultipleMatchingTransfers,
    );
  });
});

describe("exact client with splits", () => {
  it("refuses splits without an approveSplits hook, or when it declines", async () => {
    const p = await parties();
    await expect(
      new ExactSvmClient(p.payer).createPaymentPayload(2, requirements(p)),
    ).rejects.toThrow(/approveSplits/);
    const declining = new ExactSvmClient(p.payer, { approveSplits: () => false });
    await expect(declining.createPaymentPayload(2, requirements(p))).rejects.toThrow(
      /not approved/,
    );
  });

  it("passes the splits and the primary remainder to approveSplits", async () => {
    const p = await parties();
    const approveSplits = vi.fn(() => true);
    await new ExactSvmClient(p.payer, { approveSplits }).createPaymentPayload(2, requirements(p));
    expect(approveSplits).toHaveBeenCalledWith(
      [
        { payTo: p.platform.address, amount: "40000", memo: "platform fee" },
        { payTo: p.referrer.address, amount: "10000", memo: "referral" },
      ],
      expect.objectContaining({ payTo: p.merchant.address, primaryAmount: "1000000" }),
    );
  });

  it("builds compute budget, one transfer per leg in order, then the memo", async () => {
    const p = await parties();
    const client = new ExactSvmClient(p.payer, { approveSplits: () => true });
    const { payload } = await client.createPaymentPayload(2, requirements(p));
    const ixs = instructionsOf((payload as { transaction: string }).transaction);
    expect(ixs.map(ix => ix.programAddress.toString())).toEqual([
      "ComputeBudget111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      MEMO_PROGRAM_ADDRESS,
    ]);
    expect(ixs.slice(2, 5).map(ix => ix.accounts![2].address)).toEqual([
      await ata(p.merchant.address),
      await ata(p.platform.address),
      await ata(p.referrer.address),
    ]);
  });

  it("adds a fee-payer-funded CreateIdempotent only for marked recipients without an ATA", async () => {
    const p = await parties();
    existingAccounts.add(await ata(p.merchant.address));
    const req = requirements(p, {
      ataCreationRequired: true,
      splits: [
        { payTo: p.platform.address, amount: "40000", ataCreationRequired: true },
        { payTo: p.referrer.address, amount: "10000" },
      ],
    });
    const client = new ExactSvmClient(p.payer, { approveSplits: () => true });
    const { payload } = await client.createPaymentPayload(2, req);
    const ixs = instructionsOf((payload as { transaction: string }).transaction);
    const creates = ixs.filter(ix => ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(creates).toHaveLength(1);
    expect(creates[0].accounts![0].address).toBe(p.feePayer.address);
    expect(creates[0].accounts![2].address).toBe(p.platform.address);
    expect(ixs[2].programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  });

  it("builds a single-payee transfer unchanged when there are no splits", async () => {
    const p = await parties();
    const req = requirements(p, { splits: [] });
    const { payload } = await new ExactSvmClient(p.payer).createPaymentPayload(2, req);
    const ixs = instructionsOf((payload as { transaction: string }).transaction);
    expect(ixs).toHaveLength(4);
    expect(ixs[2].accounts![2].address).toBe(await ata(p.merchant.address));
  });
});

describe("exact facilitator with splits", () => {
  async function clientTransaction(p: Parties, req: PaymentRequirements): Promise<string> {
    const client = new ExactSvmClient(p.payer, { approveSplits: () => true });
    const { payload } = await client.createPaymentPayload(2, req);
    return (payload as { transaction: string }).transaction;
  }

  it("advertises split capabilities only when configured", async () => {
    const p = await parties();
    const signer = facilitatorSigner(p.feePayer.address);
    expect(new ExactSvmFacilitator(signer).getExtra(SOLANA_DEVNET_CAIP2)).toEqual({
      feePayer: p.feePayer.address,
      transactionVersions: [0, 1],
    });
    expect(
      new ExactSvmFacilitator(signer, undefined, {
        maxSplits: 8,
        ataCreationSponsored: true,
      }).getExtra(SOLANA_DEVNET_CAIP2),
    ).toEqual({
      feePayer: p.feePayer.address,
      transactionVersions: [0, 1],
      maxSplits: 8,
      ataCreationSponsored: true,
    });
    expect(() => new ExactSvmFacilitator(signer, undefined, { maxSplits: 9 })).toThrow(/maxSplits/);
  });

  it("accepts a client-built split charge on Path 1", async () => {
    const p = await parties();
    const req = requirements(p);
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 2,
    });
    const result = await facilitator.verify(payment(req, await clientTransaction(p, req)), req);
    expect(result).toMatchObject({ isValid: true, payer: p.payer.address });
  });

  it("accepts sponsored ATA creation for marked recipients, including the primary", async () => {
    const p = await parties();
    const req = requirements(p, {
      ataCreationRequired: true,
      splits: [{ payTo: p.platform.address, amount: "40000", ataCreationRequired: true }],
    });
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 1,
      ataCreationSponsored: true,
    });
    const result = await facilitator.verify(payment(req, await clientTransaction(p, req)), req);
    expect(result).toMatchObject({ isValid: true });
  });

  it("builds and accepts a version-1 split charge with sponsored ATA creation", async () => {
    const p = await parties();
    const req = requirements(p, {
      transactionVersions: [0, 1],
      splits: [
        { payTo: p.platform.address, amount: "40000", ataCreationRequired: true },
        { payTo: p.referrer.address, amount: "10000" },
      ],
    });
    const tx = await clientTransaction(p, req);
    expect(compiledOf(tx).version).toBe(1);
    // Version 1 has no ComputeBudget prefix: 1 creation, 3 transfers, memo.
    const programs = instructionsOf(tx).map(ix => ix.programAddress.toString());
    expect(programs).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      MEMO_PROGRAM_ADDRESS,
    ]);

    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 2,
      ataCreationSponsored: true,
    });
    expect(await facilitator.verify(payment(req, tx), req)).toMatchObject({
      isValid: true,
      payer: p.payer.address,
    });
  });

  it("rejects a version-1 split charge carrying a ComputeBudget instruction", async () => {
    const p = await parties();
    const req = requirements(p);
    const tx = pipe(
      createTransactionMessage({ version: 1 }),
      m =>
        setTransactionMessageConfig(
          { computeUnitLimit: 60_000, loadedAccountsDataSizeLimit: 4_194_304 },
          m,
        ),
      m => setTransactionMessageFeePayer(p.feePayer.address, m),
      m =>
        appendTransactionMessageInstructions(
          [getSetComputeUnitLimitInstruction({ units: 60_000 })],
          m,
        ),
    );
    const withLegs = appendTransactionMessageInstructions(
      [
        await transfer(p, p.merchant.address, 1_000_000n),
        await transfer(p, p.platform.address, 40_000n),
        await transfer(p, p.referrer.address, 10_000n),
        memo("nonce"),
      ],
      tx,
    );
    const signed = await partiallySignTransactionMessageWithSigners(
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 1n },
        withLegs,
      ),
    );
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
    });
    expect(
      await facilitator.verify(payment(req, getBase64EncodedWireTransaction(signed)), req),
    ).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrTransactionV1ComputeBudgetInstruction,
    });
  });

  it("rejects splits beyond the advertised maxSplits, and unadvertised sponsorship", async () => {
    const p = await parties();
    const req = requirements(p);
    const tx = await clientTransaction(p, req);
    const noSplits = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address));
    expect(await noSplits.verify(payment(req, tx), req)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrSplitCountExceeded,
    });

    const marked = requirements(p, { ataCreationRequired: true });
    const noSponsorship = new ExactSvmFacilitator(
      facilitatorSigner(p.feePayer.address),
      undefined,
      {
        maxSplits: 8,
      },
    );
    expect(
      await noSponsorship.verify(payment(marked, await clientTransaction(p, marked)), marked),
    ).toMatchObject({ isValid: false, invalidReason: Errors.ErrSplitAtaCreationNotAuthorized });
  });

  it("rejects a creation for a recipient the requirements did not mark", async () => {
    const p = await parties();
    const marked = requirements(p, { ataCreationRequired: true });
    const tx = await clientTransaction(p, marked);
    const unmarked = requirements(p);
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
      ataCreationSponsored: true,
    });
    expect(await facilitator.verify(payment(unmarked, tx), unmarked)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrSplitAtaCreationNotAuthorized,
    });
  });

  it("rejects a client-funded creation", async () => {
    const p = await parties();
    const req = requirements(p, { ataCreationRequired: true });
    const create = getCreateAssociatedTokenIdempotentInstruction({
      payer: p.payer,
      ata: await ata(p.merchant.address),
      owner: p.merchant.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
    });
    const tx = await buildTransaction(p, [
      create,
      await transfer(p, p.merchant.address, 1_000_000n),
      await transfer(p, p.platform.address, 40_000n),
      await transfer(p, p.referrer.address, 10_000n),
      memo("nonce"),
    ]);
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
      ataCreationSponsored: true,
    });
    expect(await facilitator.verify(payment(req, tx), req)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrSplitAtaCreationNotAuthorized,
    });
  });

  it("rejects legs out of order or with a wrong carve-out on Path 1", async () => {
    const p = await parties();
    const req = requirements(p);
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
    });
    const swapped = await buildTransaction(p, [
      await transfer(p, p.merchant.address, 1_000_000n),
      await transfer(p, p.referrer.address, 10_000n),
      await transfer(p, p.platform.address, 40_000n),
      memo("nonce"),
    ]);
    expect(await facilitator.verify(payment(req, swapped), req)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrRecipientMismatch,
    });
    const shortSplit = await buildTransaction(p, [
      await transfer(p, p.merchant.address, 1_010_000n),
      await transfer(p, p.platform.address, 30_000n),
      await transfer(p, p.referrer.address, 10_000n),
      memo("nonce"),
    ]);
    expect(await facilitator.verify(payment(req, shortSplit), req)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrAmountMismatch,
    });
  });

  it("fits and verifies eight splits, and refuses a charge over the size limit", async () => {
    const p = await parties();
    const recipients = await Promise.all(Array.from({ length: 8 }, () => generateKeyPairSigner()));
    const eight = requirements(p, {
      splits: recipients.map(r => ({ payTo: r.address, amount: "1000" })),
    });
    const tx = await clientTransaction(p, eight);
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
      ataCreationSponsored: true,
    });
    expect(await facilitator.verify(payment(eight, tx), eight)).toMatchObject({ isValid: true });

    const withCreates = requirements(p, {
      ataCreationRequired: true,
      splits: recipients.map(r => ({
        payTo: r.address,
        amount: "1000",
        ataCreationRequired: true,
      })),
    });
    const client = new ExactSvmClient(p.payer, { approveSplits: () => true });
    await expect(client.createPaymentPayload(2, withCreates)).rejects.toThrow(/1232-byte limit/);
  });

  it("rejects a CreateIdempotent under a different token program than the transfers", async () => {
    const p = await parties();
    const req = requirements(p, { ataCreationRequired: true });
    const [ata2022] = await findAssociatedTokenPda({
      owner: p.merchant.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS as Address,
    });
    const create = getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(p.feePayer.address),
      ata: ata2022,
      owner: p.merchant.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS as Address,
    });
    const tx = await buildTransaction(p, [
      create,
      await transfer(p, p.merchant.address, 1_000_000n),
      await transfer(p, p.platform.address, 40_000n),
      await transfer(p, p.referrer.address, 10_000n),
      memo("nonce"),
    ]);
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
      ataCreationSponsored: true,
    });
    expect(await facilitator.verify(payment(req, tx), req)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrSplitAtaCreationNotAuthorized,
    });
  });

  it("rejects a split transfer carrying trailing multisig signer accounts", async () => {
    const p = await parties();
    const req = requirements(p);
    const extraSigner = await generateKeyPairSigner();
    const base = await transfer(p, p.platform.address, 40_000n);
    const withSigner: Instruction = {
      ...base,
      accounts: [
        ...(base.accounts ?? []),
        { address: extraSigner.address, role: AccountRole.READONLY_SIGNER, signer: extraSigner },
      ] as never,
    };
    const tx = await buildTransaction(p, [
      await transfer(p, p.merchant.address, 1_000_000n),
      withSigner,
      await transfer(p, p.referrer.address, 10_000n),
      memo("nonce"),
    ]);
    // Raise the signature ceiling so the layout check, not the signer count, rejects it.
    const facilitator = new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
      maxSplits: 8,
      maxRequiredSignatures: 3,
    });
    expect(await facilitator.verify(payment(req, tx), req)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrNoTransferInstruction,
    });
  });

  describe("Path 2", () => {
    const options = {
      maxSplits: 8,
      enableSmartWalletVerification: true,
      smartWalletMaxComputeUnits: 400_000,
    };
    // A smart wallet instruction whose CPI performs the transfers.
    const wrapper: Instruction = {
      programAddress: SWIG_PROGRAM as Address,
      data: new Uint8Array([0]),
    };

    async function cpiTransfer(p: Parties, owner: string, amount: bigint) {
      return {
        programId: TOKEN_PROGRAM_ADDRESS,
        parsed: {
          type: "transferChecked",
          info: {
            mint: USDC_DEVNET_ADDRESS,
            destination: await ata(owner),
            authority: p.payer.address,
            tokenAmount: { amount: amount.toString() },
          },
        },
      };
    }

    function signerWithTrace(p: Parties, inner: unknown[]): FacilitatorSvmSigner {
      return {
        ...facilitatorSigner(p.feePayer.address),
        simulateTransactionWithInnerInstructions: vi.fn(async () => ({
          innerInstructions: [{ index: 2, instructions: inner }],
        })),
      } as unknown as FacilitatorSvmSigner;
    }

    it("verifies every leg in the CPI trace, in any order", async () => {
      const p = await parties();
      const req = requirements(p);
      const tx = await buildTransaction(p, [wrapper, memo("nonce")]);
      const signer = signerWithTrace(p, [
        await cpiTransfer(p, p.referrer.address, 10_000n),
        await cpiTransfer(p, p.merchant.address, 1_000_000n),
        await cpiTransfer(p, p.platform.address, 40_000n),
      ]);
      const facilitator = new ExactSvmFacilitator(signer, undefined, options);
      expect(await facilitator.verify(payment(req, tx), req)).toMatchObject({
        isValid: true,
        payer: p.payer.address,
      });
    });

    it("rejects an unexpected asset transfer and an unpaid leg", async () => {
      const p = await parties();
      const req = requirements(p);
      const stranger = await generateKeyPairSigner();
      const tx = await buildTransaction(p, [wrapper, memo("nonce")]);
      const legs = [
        await cpiTransfer(p, p.merchant.address, 1_000_000n),
        await cpiTransfer(p, p.platform.address, 40_000n),
        await cpiTransfer(p, p.referrer.address, 10_000n),
      ];

      const leak = new ExactSvmFacilitator(
        signerWithTrace(p, [...legs, await cpiTransfer(p, stranger.address, 1n)]),
        undefined,
        options,
      );
      expect(await leak.verify(payment(req, tx), req)).toMatchObject({
        isValid: false,
        invalidReason: Errors.ErrSplitUnexpectedTransfer,
      });

      const unpaid = new ExactSvmFacilitator(
        signerWithTrace(p, legs.slice(0, 2)),
        undefined,
        options,
      );
      expect(await unpaid.verify(payment(req, tx), req)).toMatchObject({
        isValid: false,
        invalidReason: Errors.ErrSplitLegUnmatched,
      });
    });

    it("accepts a sponsored CreateIdempotent next to the wallet instruction", async () => {
      const p = await parties();
      const req = requirements(p, { ataCreationRequired: true });
      const create = getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(p.feePayer.address),
        ata: await ata(p.merchant.address),
        owner: p.merchant.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
      });
      const tx = await buildTransaction(p, [create, wrapper, memo("nonce")]);
      const signer = signerWithTrace(p, [
        await cpiTransfer(p, p.merchant.address, 1_000_000n),
        await cpiTransfer(p, p.platform.address, 40_000n),
        await cpiTransfer(p, p.referrer.address, 10_000n),
      ]);
      const sponsored = new ExactSvmFacilitator(signer, undefined, {
        ...options,
        ataCreationSponsored: true,
      });
      expect(await sponsored.verify(payment(req, tx), req)).toMatchObject({ isValid: true });

      // Same creation, but the requirements do not mark the merchant.
      const unmarked = requirements(p);
      expect(await sponsored.verify(payment(unmarked, tx), unmarked)).toMatchObject({
        isValid: false,
        invalidReason: Errors.ErrSplitAtaCreationNotAuthorized,
      });
    });

    it("settles only when every CPI leg is in the confirmed trace", async () => {
      const p = await parties();
      const req = requirements(p);
      const tx = await buildTransaction(p, [wrapper, memo("nonce")]);
      const legs = [
        await cpiTransfer(p, p.merchant.address, 1_000_000n),
        await cpiTransfer(p, p.platform.address, 40_000n),
        await cpiTransfer(p, p.referrer.address, 10_000n),
      ];
      const settleWith = async (confirmedInner: unknown[]) => {
        const signer = {
          ...signerWithTrace(p, legs),
          getConfirmedTransactionInnerInstructions: vi.fn(async () => ({
            innerInstructions: [{ index: 2, instructions: confirmedInner }],
          })),
        } as unknown as FacilitatorSvmSigner;
        return new ExactSvmFacilitator(signer, undefined, options).settle(payment(req, tx), req);
      };

      expect(await settleWith(legs)).toMatchObject({ success: true, transaction: "sig" });
      // Simulation showed every leg; the confirmed execution skipped a split.
      expect(await settleWith(legs.slice(0, 2))).toMatchObject({
        success: false,
        errorReason: Errors.ErrPostSettlementTransferNotConfirmed,
      });
    });

    it("keeps the ATA program on the allowlist for single-payee charges", async () => {
      const p = await parties();
      const req = requirements(p, { splits: [] });
      const create = getCreateAssociatedTokenIdempotentInstruction({
        payer: p.payer,
        ata: await ata(p.merchant.address),
        owner: p.merchant.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
      });
      const tx = await buildTransaction(p, [create, wrapper, memo("nonce")]);
      const signer = signerWithTrace(p, [await cpiTransfer(p, p.merchant.address, 1_050_000n)]);
      const facilitator = new ExactSvmFacilitator(signer, undefined, options);
      const result = await facilitator.verify(payment(req, tx), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain(Errors.ErrSmartWalletProgramNotAllowed);
    });
  });
});

describe("verifyPostSettlementLegs", () => {
  async function legsFor(p: Parties, extra: Record<string, unknown> = {}) {
    return deriveLegDestinations(parsePaymentLegs(requirements(p, extra)), USDC_DEVNET_ADDRESS);
  }

  it("treats top-level legs as executed without fetching the CPI trace", async () => {
    const p = await parties();
    const legs = await legsFor(p);
    const signer = facilitatorSigner(p.feePayer.address);
    const topLevel = await Promise.all(
      legs.map(async leg => ({
        programId: TOKEN_PROGRAM_ADDRESS,
        amount: leg.amount,
        mint: USDC_DEVNET_ADDRESS,
        destination: await ata(leg.owner),
        authority: p.payer.address,
      })),
    );
    const result = await verifyPostSettlementLegs(
      signer,
      "sig",
      SOLANA_DEVNET_CAIP2,
      legs,
      USDC_DEVNET_ADDRESS,
      [p.feePayer.address],
      topLevel,
      null,
    );
    expect(result).toEqual({ verified: true, method: "topLevel" });
    expect(signer.getConfirmedTransactionInnerInstructions).not.toHaveBeenCalled();
  });

  it("fails when a CPI leg is missing from the confirmed trace", async () => {
    const p = await parties();
    const legs = await legsFor(p);
    const result = await verifyPostSettlementLegs(
      facilitatorSigner(p.feePayer.address),
      "sig",
      SOLANA_DEVNET_CAIP2,
      legs,
      USDC_DEVNET_ADDRESS,
      [p.feePayer.address],
      [],
      null,
    );
    expect(result).toEqual({ verified: false, method: "innerInstructions" });
  });

  it("checks per-leg balance deltas, starting a created ATA from zero", async () => {
    const p = await parties();
    const legs = await legsFor(p, {
      splits: [{ payTo: p.platform.address, amount: "50000", ataCreationRequired: true }],
    });
    const atas = await Promise.all(legs.map(leg => ata(leg.owner)));
    const after = new Map([
      [atas[0], 5_000_000n + 1_000_000n],
      [atas[1], 50_000n],
    ]);
    const signer = {
      ...facilitatorSigner(p.feePayer.address),
      getConfirmedTransactionInnerInstructions: vi.fn(async () => ({ innerInstructions: null })),
      getTokenAccountBalance: vi.fn(
        async (address: string) => after.get(address as Address) ?? null,
      ),
    } as unknown as FacilitatorSvmSigner;
    const balances = [
      { ata: atas[0], before: 5_000_000n },
      { ata: atas[1], before: null },
    ];
    expect(
      await verifyPostSettlementLegs(
        signer,
        "sig",
        SOLANA_DEVNET_CAIP2,
        legs,
        USDC_DEVNET_ADDRESS,
        [p.feePayer.address],
        [],
        balances,
      ),
    ).toEqual({ verified: true, method: "balanceDelta" });

    after.set(atas[1], 49_999n);
    expect(
      await verifyPostSettlementLegs(
        signer,
        "sig",
        SOLANA_DEVNET_CAIP2,
        legs,
        USDC_DEVNET_ADDRESS,
        [p.feePayer.address],
        [],
        balances,
      ),
    ).toEqual({ verified: false, method: "balanceDelta" });
  });
});

describe("exact server with splits", () => {
  it("refuses requirements the selected facilitator does not advertise", async () => {
    const p = await parties();
    const server = new ExactSvmServer();
    const kind = (extra: Record<string, unknown>) => ({
      x402Version: 2,
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2 as never,
      extra: { feePayer: p.feePayer.address, ...extra },
    });
    await expect(server.enhancePaymentRequirements(requirements(p), kind({}), [])).rejects.toThrow(
      SplitsError,
    );
    await expect(
      server.enhancePaymentRequirements(
        requirements(p, { ataCreationRequired: true }),
        kind({ maxSplits: 2 }),
        [],
      ),
    ).rejects.toThrow(Errors.ErrSplitAtaCreationNotAuthorized);
    await expect(
      server.enhancePaymentRequirements(requirements(p), kind({ maxSplits: 2 }), []),
    ).resolves.toMatchObject({ extra: { feePayer: p.feePayer.address } });
  });
});

describe("split rule edges", () => {
  it("rejects malformed split entries and flags", async () => {
    const p = await parties();
    const bad: Record<string, unknown>[] = [
      { splits: "not-an-array" },
      { ataCreationRequired: "yes" },
      { splits: [null] },
      { splits: [{ payTo: p.platform.address, amount: "1", memo: 7 }] },
    ];
    for (const extra of bad) {
      expect(() => parsePaymentLegs(requirements(p, extra))).toThrow(Errors.ErrSplitsInvalid);
    }
    const noExtra = { ...requirements(p), extra: undefined } as unknown as PaymentRequirements;
    expect(parsePaymentLegs(noExtra)).toHaveLength(1);
  });

  it("validates every CreateIdempotent field", async () => {
    const p = await parties();
    const good = async () => ({
      programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      accounts: [
        p.feePayer.address,
        await ata(p.merchant.address),
        p.merchant.address,
        USDC_DEVNET_ADDRESS,
        "11111111111111111111111111111111",
        TOKEN_PROGRAM_ADDRESS,
      ].map(address => ({ address })),
      data: new Uint8Array([1]),
    });
    const ctx = () => ({
      asset: USDC_DEVNET_ADDRESS,
      feePayer: p.feePayer.address,
      markedOwners: new Set([p.merchant.address as string]),
      createdOwners: new Set<string>(),
    });
    await expect(validateAtaCreation(await good(), ctx())).resolves.toEqual({
      owner: p.merchant.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const variants: Array<(ix: Awaited<ReturnType<typeof good>>) => void> = [
      ix => (ix.data = new Uint8Array([0])),
      ix => (ix.accounts = ix.accounts.slice(0, 5)),
      ix => (ix.accounts[3] = { address: TOKEN_PROGRAM_ADDRESS }),
      ix => (ix.accounts[4] = { address: TOKEN_PROGRAM_ADDRESS }),
      ix => (ix.accounts[1] = { address: p.platform.address }),
    ];
    for (const mutate of variants) {
      const ix = await good();
      mutate(ix);
      await expect(validateAtaCreation(ix, ctx())).rejects.toThrow(
        Errors.ErrSplitAtaCreationNotAuthorized,
      );
    }
    const twice = ctx();
    await validateAtaCreation(await good(), twice);
    await expect(validateAtaCreation(await good(), twice)).rejects.toThrow(/duplicate/);
  });

  it("rejects the fee payer as a program or in any other instruction", async () => {
    const p = await parties();
    const ctx = { asset: USDC_DEVNET_ADDRESS, markedOwners: new Set<string>() };
    await expect(
      assertFeePayerIsolatedWithAtaCreation(
        [{ programAddress: p.feePayer.address }],
        p.feePayer.address,
        ctx,
      ),
    ).rejects.toThrow(/invoked as program/);
    await expect(
      assertFeePayerIsolatedWithAtaCreation(
        [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: p.feePayer.address }] }],
        p.feePayer.address,
        ctx,
      ),
    ).rejects.toThrow(Errors.ErrSmartWalletFeePayerNotIsolated);
  });

  it("ignores transfers of other mints when matching legs", async () => {
    const p = await parties();
    const legs = await deriveLegDestinations(
      parsePaymentLegs(requirements(p)),
      USDC_DEVNET_ADDRESS,
    );
    const pay = async (owner: string, amount: bigint, mint = USDC_DEVNET_ADDRESS) => ({
      programId: TOKEN_PROGRAM_ADDRESS,
      amount,
      mint,
      destination: await ata(owner),
      authority: p.payer.address,
    });
    const other = await generateKeyPairSigner();
    const matched = matchTransfersToLegs(
      [
        await pay(p.merchant.address, 1_000_000n),
        await pay(p.platform.address, 40_000n),
        await pay(p.referrer.address, 10_000n),
        await pay(other.address, 5n, other.address),
      ],
      legs,
      USDC_DEVNET_ADDRESS,
    );
    expect(matched).toHaveLength(3);
  });

  describe("Path 1 split rejections", () => {
    const facilitatorFor = (p: Parties, extra: Partial<Record<string, unknown>> = {}) =>
      new ExactSvmFacilitator(facilitatorSigner(p.feePayer.address), undefined, {
        maxSplits: 8,
        ...extra,
      });
    const legsTx = async (p: Parties, tail: Instruction[] = [memo("nonce")]) =>
      buildTransaction(p, [
        await transfer(p, p.merchant.address, 1_000_000n),
        await transfer(p, p.platform.address, 40_000n),
        await transfer(p, p.referrer.address, 10_000n),
        ...tail,
      ]);

    it("rejects a compute limit above the configured cap", async () => {
      const p = await parties();
      const req = requirements(p);
      const result = await facilitatorFor(p, { maxComputeUnits: 1_000 }).verify(
        payment(req, await legsTx(p)),
        req,
      );
      expect(result.invalidReason).toBe(Errors.ErrComputeLimitInstructionTooHigh);
    });

    it("rejects legs under different token programs", async () => {
      const p = await parties();
      const req = requirements(p);
      const split2022 = {
        ...(await transfer(p, p.platform.address, 40_000n)),
        programAddress: TOKEN_2022_PROGRAM_ADDRESS as Address,
      };
      const tx = await buildTransaction(p, [
        await transfer(p, p.merchant.address, 1_000_000n),
        split2022,
        await transfer(p, p.referrer.address, 10_000n),
        memo("nonce"),
      ]);
      expect((await facilitatorFor(p).verify(payment(req, tx), req)).invalidReason).toBe(
        Errors.ErrSplitLegUnmatched,
      );
    });

    it("rejects a facilitator authority and mixed authorities", async () => {
      const p = await parties();
      const req = requirements(p);
      const selfSpend = new ExactSvmFacilitator(
        {
          ...facilitatorSigner(p.feePayer.address),
          getAddresses: () => [p.feePayer.address, p.payer.address],
        } as unknown as FacilitatorSvmSigner,
        undefined,
        { maxSplits: 8 },
      );
      expect((await selfSpend.verify(payment(req, await legsTx(p)), req)).invalidReason).toBe(
        Errors.ErrFeePayerTransferringFunds,
      );

      const other = await generateKeyPairSigner();
      const mixed = await buildTransaction(p, [
        await transfer(p, p.merchant.address, 1_000_000n),
        await transfer({ ...p, payer: other }, p.platform.address, 40_000n),
        await transfer(p, p.referrer.address, 10_000n),
        memo("nonce"),
      ]);
      expect(
        (await facilitatorFor(p, { maxRequiredSignatures: 3 }).verify(payment(req, mixed), req))
          .invalidReason,
      ).toBe(Errors.ErrSplitAuthorityMismatch);
    });

    it("rejects a wrong mint, an unknown tail instruction, and the fee payer in a memo", async () => {
      const p = await parties();
      const req = requirements(p);
      const wrongMint = { ...req, asset: p.referrer.address };
      expect(
        (await facilitatorFor(p).verify(payment(wrongMint, await legsTx(p)), wrongMint))
          .invalidReason,
      ).toBe(Errors.ErrMintMismatch);

      const unknownTail = await legsTx(p, [
        { programAddress: SWIG_PROGRAM as Address, data: new Uint8Array([0]) },
      ]);
      expect((await facilitatorFor(p).verify(payment(req, unknownTail), req)).invalidReason).toBe(
        Errors.ErrUnknownOptionalInstruction,
      );

      const feePayerMemo = await legsTx(p, [
        {
          ...memo("nonce"),
          accounts: [{ address: p.feePayer.address, role: AccountRole.READONLY }],
        } as Instruction,
      ]);
      expect(
        (await facilitatorFor(p).verify(payment(req, feePayerMemo), req)).invalidReason,
      ).toContain(Errors.ErrSmartWalletFeePayerNotIsolated);
    });

    it("rejects a memo mismatch and a failed simulation", async () => {
      const p = await parties();
      const withMemo = requirements(p, { memo: "pi_123" });
      expect(
        (await facilitatorFor(p).verify(payment(withMemo, await legsTx(p)), withMemo))
          .invalidReason,
      ).toBe(Errors.ErrMemoMismatch);

      const req = requirements(p);
      const failing = new ExactSvmFacilitator(
        {
          ...facilitatorSigner(p.feePayer.address),
          simulateTransaction: vi.fn(async () => {
            throw new Error("insufficient funds");
          }),
        } as unknown as FacilitatorSvmSigner,
        undefined,
        { maxSplits: 8 },
      );
      expect(await failing.verify(payment(req, await legsTx(p)), req)).toMatchObject({
        isValid: false,
        invalidReason: Errors.ErrTransactionSimulationFailed,
        invalidMessage: "insufficient funds",
      });
    });
  });

  it("returns unverified when a leg's balance cannot be established", async () => {
    const p = await parties();
    const legs = await deriveLegDestinations(
      parsePaymentLegs(requirements(p)),
      USDC_DEVNET_ADDRESS,
    );
    const atas = await Promise.all(legs.map(leg => ata(leg.owner)));
    const run = (getTokenAccountBalance: () => Promise<bigint | null>, before: bigint | null) =>
      verifyPostSettlementLegs(
        {
          ...facilitatorSigner(p.feePayer.address),
          getConfirmedTransactionInnerInstructions: vi.fn(async () => ({
            innerInstructions: null,
          })),
          getTokenAccountBalance: vi.fn(getTokenAccountBalance),
        } as unknown as FacilitatorSvmSigner,
        "sig",
        SOLANA_DEVNET_CAIP2,
        legs,
        USDC_DEVNET_ADDRESS,
        [p.feePayer.address],
        [],
        atas.map(a => ({ ata: a, before })),
      );
    // Unmarked leg with no pre-balance: no baseline to compare against.
    expect(await run(async () => 1n, null)).toEqual({ verified: false, method: "unverified" });
    expect(
      await run(async () => {
        throw new Error("rpc down");
      }, 0n),
    ).toEqual({ verified: false, method: "unverified" });
    expect(await run(async () => null, 0n)).toEqual({ verified: false, method: "unverified" });
  });
});
