/**
 * Payment-channel open: client-side transaction builder + server-side verifier.
 *
 * Scoped to the `upto` pull flow: the client builds a payer-signed `open`
 * transaction with the fee payer as transaction sponsor, rent payer, and
 * zero-share channel payee, and the receiver authorizer as authorized signer.
 */

import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  type Address,
  address,
  type Blockhash,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Encoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getU64Encoder,
  getUtf8Encoder,
  isSignerRole,
  isWritableRole,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
} from "../constants";
import {
  getOpenInstruction,
  getOpenInstructionDataDecoder,
  OPEN_DISCRIMINATOR,
} from "./generated/instructions/open";
import {
  getTopUpInstruction,
  getTopUpInstructionDataDecoder,
  TOP_UP_DISCRIMINATOR,
} from "./generated/instructions/topUp";
import { findEventAuthorityPda } from "./generated/pdas/eventAuthority";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";
import { verifyEd25519Signature } from "./voucher";

const U64_MAX = (1n << 64n) - 1n;
/** Spec ceiling for `SetComputeUnitLimit` on an open transaction. */
export const OPEN_MAX_COMPUTE_UNIT_LIMIT = 400_000;
/**
 * Default `SetComputeUnitLimit` for a built open transaction. Without one the
 * runtime reserves 200,000 CU per instruction (SIMD-0170) — 400,000 for the
 * open + memo pair — while an observed open consumes ~51,000 CU. The default
 * keeps ~1.8x headroom over that, and any `SetComputeUnitPrice` priority fee
 * is charged on the requested limit, so right-sizing buys the same scheduling
 * priority at a fraction of the fee. Assumes standard SPL Token (or
 * Token-2022 without execution extensions) behavior — mints whose escrow
 * transfer runs compute-heavy extensions (e.g. transfer hooks) need an
 * explicit {@link BuildOpenArgs.computeUnitLimit} override, up to the spec
 * ceiling {@link OPEN_MAX_COMPUTE_UNIT_LIMIT}.
 */
export const OPEN_DEFAULT_COMPUTE_UNIT_LIMIT = 90_000;
/** Spec ceiling for optional Phantom/Solflare Lighthouse assertions after `open`. */
const OPEN_MAX_LIGHTHOUSE_INSTRUCTIONS = 3;
/** Max optional suffix length after `open` (3 Lighthouse + 1 Memo). */
const OPEN_MAX_OPTIONAL_SUFFIX = 4;

/**
 * Slot freshness / reclaim gate window for payment-channel PDAs.
 * `open` must land within this many slots of `open_slot`; `reclaim` (and
 * distribute's PDA deallocation fast path) require
 * `clock.slot > open_slot + OPEN_SLOT_WINDOW`.
 */
export const OPEN_SLOT_WINDOW = 1_500n;
const SYSTEM_PROGRAM_ID =
  "11111111111111111111111111111111" as Address<"11111111111111111111111111111111">;
const RENT_SYSVAR =
  "SysvarRent111111111111111111111111111111111" as Address<"SysvarRent111111111111111111111111111111111">;

/** Default channel close grace period (seconds). Mirrors the Rust client default. */
export const DEFAULT_GRACE_PERIOD_SECONDS = 900;

/** A recipient split, expressed in basis points. */
export interface ChannelSplit {
  bps: number;
  recipient: string;
}

/** Parameters for {@link buildOpenPaymentChannelTransaction}. */
export interface BuildOpenArgs {
  /** Payer (client) signer. Signs the open; pays the deposit. */
  payer: TransactionSigner;
  /** Channel payee. For `upto`, this is the fee payer (zero-share seat). */
  payee: string;
  /** SPL mint. */
  mint: string;
  /** Voucher signer recorded in the channel. */
  authorizedSigner: string;
  /** Transaction fee payer and channel rent payer. */
  feePayer: string;
  /** Escrow deposit = the authorized ceiling (base units). */
  deposit: bigint;
  /** Token program for the mint. */
  tokenProgram: string;
  /** Recent blockhash for the transaction lifetime. */
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  /**
   * Slot the channel is opened at (`openArgs.openSlot`, also a channel PDA
   * seed). Comes from the 402 challenge (`extra.recentSlot`, server-fetched);
   * the program requires `openSlot <= clock.slot <= openSlot + 1500`.
   */
  openSlot: bigint;
  /** Optional channel-derivation salt; random when omitted. */
  salt?: bigint | undefined;
  /** Forced-close grace period (seconds). */
  gracePeriod: number;
  /** Optional payment-channels program id override. */
  programId?: string | undefined;
  /** Optional distribution splits sealed into the channel at open. */
  recipients?: readonly ChannelSplit[] | undefined;
  /**
   * Optional seller memo (`extra.memo`). When set, used as Memo instruction
   * data; otherwise a random hex nonce is emitted for uniqueness.
   */
  memo?: string | undefined;
  /**
   * `SetComputeUnitLimit` units for the transaction. Defaults to
   * {@link OPEN_DEFAULT_COMPUTE_UNIT_LIMIT}; `0` omits the instruction (the
   * runtime then derives the spec-maximum 400,000 CU reservation). Must not
   * exceed {@link OPEN_MAX_COMPUTE_UNIT_LIMIT}; facilitators may enforce a
   * stricter `maxComputeUnits` at verification.
   */
  computeUnitLimit?: number | undefined;
  /**
   * `SetComputeUnitPrice` in microlamports per compute unit. The fee payer
   * (facilitator) pays the resulting priority fee on the requested limit.
   * Defaults to `DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (1); `0` omits the
   * instruction. Must not exceed `MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS`;
   * facilitators may enforce a stricter `maxPriorityFeeMicroLamports`.
   */
  computeUnitPriceMicroLamports?: number | undefined;
}

/** Result of {@link buildOpenPaymentChannelTransaction}. */
export interface BuiltOpen {
  /** Channel PDA (base58). */
  channelId: string;
  /** Base64 payer-signed open transaction; the fee-payer slot is left empty. */
  transaction: string;
  /** Escrow deposit (base units). */
  deposit: bigint;
  /** Channel-derivation salt. */
  salt: bigint;
  /** Slot the open is anchored to (channel PDA seed). */
  openSlot: bigint;
}

/** Parameters for a canonical payment-channel `top_up` transaction. */
export interface BuildTopUpArgs {
  payer: TransactionSigner;
  channelId: string;
  mint: string;
  tokenProgram: string;
  feePayer: string;
  amount: bigint;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  memo?: string | undefined;
  computeUnitLimit?: number | undefined;
  computeUnitPriceMicroLamports?: number | undefined;
  programId?: string | undefined;
}

/** Result of {@link buildTopUpPaymentChannelTransaction}. */
export interface BuiltTopUp {
  channelId: string;
  amount: bigint;
  transaction: string;
}

/**
 * Build the payer-signed canonical `top_up` transaction. The fee payer is
 * deliberately only the transaction fee payer: it is not an instruction
 * account in the six-account top-up layout.
 */
export async function buildTopUpPaymentChannelTransaction(
  args: BuildTopUpArgs,
): Promise<BuiltTopUp> {
  if (args.amount <= 0n) throw new Error("top-up amount must be positive");
  const programAddress = address(args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const mint = address(args.mint);
  const tokenProgram = address(args.tokenProgram);
  const [payerTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: args.payer.address,
    tokenProgram,
  });
  const [channelTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: address(args.channelId),
    tokenProgram,
  });
  const instruction = getTopUpInstruction(
    {
      channel: address(args.channelId),
      channelTokenAccount,
      mint,
      payer: args.payer,
      payerTokenAccount,
      tokenProgram,
      topUpArgs: { amount: args.amount },
    },
    { programAddress },
  );
  const computeUnitLimit = args.computeUnitLimit ?? OPEN_DEFAULT_COMPUTE_UNIT_LIMIT;
  const computeUnitPrice =
    args.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  if (
    !Number.isSafeInteger(computeUnitLimit) ||
    computeUnitLimit < 0 ||
    computeUnitLimit > OPEN_MAX_COMPUTE_UNIT_LIMIT
  ) {
    throw new Error(`computeUnitLimit must be an integer in [0, ${OPEN_MAX_COMPUTE_UNIT_LIMIT}]`);
  }
  if (
    !Number.isSafeInteger(computeUnitPrice) ||
    computeUnitPrice < 0 ||
    computeUnitPrice > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS
  ) {
    throw new Error(
      `computeUnitPriceMicroLamports must be an integer in [0, ${MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS}]`,
    );
  }
  const memo =
    args.memo ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  const memoData = new TextEncoder().encode(memo);
  if (memoData.byteLength > MAX_MEMO_BYTES)
    throw new Error(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
  const computeBudgetIxs = [
    ...(computeUnitLimit > 0
      ? [getSetComputeUnitLimitInstruction({ units: computeUnitLimit })]
      : []),
    ...(computeUnitPrice > 0
      ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })]
      : []),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    msg => setTransactionMessageFeePayer(address(args.feePayer), msg),
    msg =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: args.blockhash.blockhash as Blockhash,
          lastValidBlockHeight: args.blockhash.lastValidBlockHeight,
        },
        msg,
      ),
    msg =>
      appendTransactionMessageInstructions(
        [
          ...computeBudgetIxs,
          instruction,
          {
            accounts: [] as const,
            data: memoData,
            programAddress: MEMO_PROGRAM_ADDRESS as Address,
          },
        ],
        msg,
      ),
  );
  return {
    amount: args.amount,
    channelId: args.channelId,
    transaction: getBase64EncodedWireTransaction(
      await partiallySignTransactionMessageWithSigners(message),
    ),
  };
}

/**
 * Derive the channel PDA for the given open parameters.
 *
 * @param args - PDA seeds
 * @param args.payer
 * @param args.payee
 * @param args.mint
 * @param args.authorizedSigner
 * @param args.salt
 * @param args.openSlot
 * @param args.programId
 * @returns The channel PDA (base58)
 */
export async function findPaymentChannelPda(args: {
  payer: string;
  payee: string;
  mint: string;
  authorizedSigner: string;
  salt: bigint;
  openSlot: bigint;
  programId?: string | undefined;
}): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID),
    seeds: [
      getUtf8Encoder().encode("channel"),
      getAddressEncoder().encode(address(args.payer)),
      getAddressEncoder().encode(address(args.payee)),
      getAddressEncoder().encode(address(args.mint)),
      getAddressEncoder().encode(address(args.authorizedSigner)),
      getU64Encoder().encode(args.salt),
      getU64Encoder().encode(args.openSlot),
    ],
  });
  return pda;
}

/**
 * Build the payer-signed payment-channel open transaction (pull flow).
 *
 * The transaction uses the fee payer as transaction sponsor and is intentionally
 * left partially signed; the sponsor adds its signature before
 * broadcasting it.
 *
 * @param args - Open inputs
 * @returns The channel id + base64 transaction + deposit/salt
 */
export async function buildOpenPaymentChannelTransaction(args: BuildOpenArgs): Promise<BuiltOpen> {
  const programAddress = address(args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const tokenProgram = address(args.tokenProgram);
  const payer = args.payer;
  const payee = address(args.payee);
  const mint = address(args.mint);
  const authorizedSigner = address(args.authorizedSigner);
  const feePayer = address(args.feePayer);
  const salt = args.salt ?? randomU64();
  const openSlot = args.openSlot;
  const gracePeriod = args.gracePeriod;
  const recipients = (args.recipients ?? []).map(r => ({
    bps: r.bps,
    recipient: address(r.recipient),
  }));

  const channelId = await findPaymentChannelPda({
    payer: payer.address,
    payee: args.payee,
    mint: args.mint,
    authorizedSigner: args.authorizedSigner,
    salt,
    openSlot,
    programId: args.programId,
  });

  const [payerTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: payer.address,
    tokenProgram,
  });
  const [channelTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: address(channelId),
    tokenProgram,
  });
  const [eventAuthority] = await findEventAuthorityPda({ programAddress });

  // rentPayer is the fee payer: it funds the channel PDA + escrow-ATA rent at
  // open. It is the same key set as fee payer below, so a single sponsor
  // signature covers both the transaction fee-payer and rentPayer signer roles.
  // When the fee payer is the payer itself, reuse the
  // payer signer instance (kit rejects two distinct signer objects for one
  // address); otherwise a noop signer carries the fee-payer address into the
  // instruction without signing here.
  const rentPayerSigner = feePayer === payer.address ? payer : createNoopSigner(feePayer);

  const instruction = getOpenInstruction(
    {
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      authorizedSigner,
      channel: address(channelId),
      channelTokenAccount,
      eventAuthority,
      mint,
      openArgs: { deposit: args.deposit, gracePeriod, openSlot, recipients, salt },
      payee,
      payer,
      rentPayer: rentPayerSigner,
      payerTokenAccount,
      rent: RENT_SYSVAR,
      selfProgram: programAddress,
      tokenProgram,
    },
    { programAddress },
  );

  let memoData: Uint8Array;
  if (args.memo !== undefined) {
    memoData = new TextEncoder().encode(args.memo);
    if (memoData.byteLength > MAX_MEMO_BYTES) {
      throw new Error(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
    }
  } else {
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
    memoData = new TextEncoder().encode(
      Array.from(nonce)
        .map(b => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }
  const memoIx = {
    programAddress: MEMO_PROGRAM_ADDRESS as Address,
    accounts: [] as const,
    data: memoData,
  };

  const computeUnitLimit = args.computeUnitLimit ?? OPEN_DEFAULT_COMPUTE_UNIT_LIMIT;
  if (
    !Number.isSafeInteger(computeUnitLimit) ||
    computeUnitLimit < 0 ||
    computeUnitLimit > OPEN_MAX_COMPUTE_UNIT_LIMIT
  ) {
    throw new Error(
      `computeUnitLimit must be an integer in [0, ${OPEN_MAX_COMPUTE_UNIT_LIMIT}], received ${args.computeUnitLimit}`,
    );
  }
  const computeUnitPrice =
    args.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  if (
    !Number.isSafeInteger(computeUnitPrice) ||
    computeUnitPrice < 0 ||
    computeUnitPrice > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS
  ) {
    throw new Error(
      `computeUnitPriceMicroLamports must be an integer in [0, ${MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS}], received ${args.computeUnitPriceMicroLamports}`,
    );
  }
  // Spec layout: optional ComputeBudget prefix (SetComputeUnitLimit MUST
  // precede SetComputeUnitPrice) → exactly one open → optional Memo suffix.
  const computeBudgetIxs = [
    ...(computeUnitLimit > 0
      ? [getSetComputeUnitLimitInstruction({ units: computeUnitLimit })]
      : []),
    ...(computeUnitPrice > 0
      ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })]
      : []),
  ];

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    msg => setTransactionMessageFeePayer(feePayer, msg),
    msg =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: args.blockhash.blockhash as Blockhash,
          lastValidBlockHeight: args.blockhash.lastValidBlockHeight,
        },
        msg,
      ),
    msg => appendTransactionMessageInstructions([...computeBudgetIxs, instruction, memoIx], msg),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);

  return {
    channelId,
    deposit: args.deposit,
    openSlot,
    salt,
    transaction: getBase64EncodedWireTransaction(signed),
  };
}

/** Expected values the server validates a client-submitted open transaction against. */
export interface VerifyOpenExpected {
  /** Receiver authorizer key set as the channel authorized signer (base58). */
  authorizedSigner: string;
  /** Fee payer expected in the transaction fee-payer and rentPayer slots. */
  feePayer: string;
  /**
   * Payer wallet (`payload.from`). Must be a required signer, match the open
   * instruction payer, and have a valid signature over the message bytes.
   */
  from: string;
  /** SPL mint expected in the open. */
  mint: string;
  /** SPL Token or Token-2022 program expected in the open. */
  tokenProgram: string;
  /** Authorized ceiling — the open deposit must equal it exactly (`topUp` can
   *  raise an open channel's deposit, so `>=` would leave the ceiling advisory). */
  maxCap: bigint;
  /** Channel payee. For `upto`, this is the fee payer (zero-share seat). */
  payee: string;
  /** Forced-close grace period expected in the open args. */
  withdrawDelay: number;
  /** Slot expected in the open args and channel PDA seed. */
  openSlot: bigint;
  /** Server-issued slot used to enforce the program's open-slot freshness window. */
  recentSlot?: bigint | undefined;
  /** Optional payment-channels program id override. */
  programId?: string | undefined;
  /** Expected distribution splits sealed into the channel. */
  recipients?: readonly ChannelSplit[] | undefined;
  /**
   * Seller-required memo (`extra.memo`). When set, exactly one suffix Memo
   * instruction MUST match this UTF-8 value.
   */
  memo?: string | undefined;
  /**
   * Operator ceiling for `SetComputeUnitLimit`. Clamped to the spec max
   * ({@link OPEN_MAX_COMPUTE_UNIT_LIMIT}); unset uses the spec max.
   */
  maxComputeUnits?: number | undefined;
  /**
   * Operator ceiling for `SetComputeUnitPrice` (microlamports). Clamped to
   * {@link MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS}; unset uses that default.
   */
  maxPriorityFeeMicroLamports?: number | undefined;
  /**
   * Operator ceiling for required signatures. When set, rejects when
   * `numSignerAccounts` exceeds this value (exact `{from, feePayer}` set
   * check still applies).
   */
  maxRequiredSignatures?: number | undefined;
}

/** Expected bindings for a canonical six-account `top_up` transaction. */
export interface VerifyTopUpExpected {
  feePayer: string;
  from: string;
  channelId: string;
  mint: string;
  tokenProgram: string;
  amount: bigint;
  memo?: string | undefined;
  programId?: string | undefined;
  maxComputeUnits?: number | undefined;
  maxPriorityFeeMicroLamports?: number | undefined;
}

/** Decode and validate the canonical top-up transaction layout and bindings. */
export async function verifyTopUpTransaction(
  transactionBase64: string,
  expected: VerifyTopUpExpected,
): Promise<void> {
  const decoded = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as CompiledOpenMessage;
  if (message.addressTableLookups && message.addressTableLookups.length > 0) {
    throw new Error("verifyTopUpTransaction: address-lookup tables are not permitted");
  }
  const ix = findCanonicalOpenInstruction(
    message,
    expected.programId ?? PAYMENT_CHANNELS_PROGRAM_ID,
    expected.feePayer,
    {
      maxComputeUnits: Math.min(
        expected.maxComputeUnits ?? OPEN_MAX_COMPUTE_UNIT_LIMIT,
        OPEN_MAX_COMPUTE_UNIT_LIMIT,
      ),
      maxPriorityFeeMicroLamports: Math.min(
        expected.maxPriorityFeeMicroLamports ?? MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
        MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      ),
      expectedMemo: expected.memo,
    },
    TOP_UP_DISCRIMINATOR,
    "top_up",
  );
  if (message.staticAccounts[0] !== expected.feePayer)
    throw new Error("verifyTopUpTransaction: fee payer mismatch");
  if (message.header.numSignerAccounts !== (expected.feePayer === expected.from ? 1 : 2)) {
    throw new Error("verifyTopUpTransaction: unexpected required signer set");
  }
  const signature = decoded.signatures[expected.from as Address];
  if (
    !signature ||
    !(await verifyEd25519Signature({
      message: decoded.messageBytes as unknown as Uint8Array,
      publicKey: getBase58Encoder().encode(expected.from) as Uint8Array,
      signature: signature as Uint8Array,
    }))
  ) {
    throw new Error("verifyTopUpTransaction: missing or invalid payer signature");
  }
  const indices = ix.accountIndices;
  if (indices.length !== 6)
    throw new Error(
      `verifyTopUpTransaction: top_up must have exactly 6 accounts, found ${indices.length}`,
    );
  const account = (index: number): string => {
    const value = message.staticAccounts[indices[index] ?? -1];
    if (!value) throw new Error(`verifyTopUpTransaction: missing account ${index}`);
    return value;
  };
  const [payer, channel, payerAta, channelAta, mint, tokenProgram] = [
    account(0),
    account(1),
    account(2),
    account(3),
    account(4),
    account(5),
  ];
  if (
    payer !== expected.from ||
    channel !== expected.channelId ||
    mint !== expected.mint ||
    tokenProgram !== expected.tokenProgram
  )
    throw new Error("verifyTopUpTransaction: account binding mismatch");
  if (indices.includes(0))
    throw new Error("verifyTopUpTransaction: fee payer must not be a top_up account");
  const role = (i: number) => staticAccountRole(message.header, message.staticAccounts.length, i);
  for (const [slot, label] of [
    [0, "payer"],
    [1, "channel"],
    [2, "payer token account"],
    [3, "channel token account"],
  ] as const) {
    const accountIndex = indices[slot]!;
    if (!isWritableRole(role(accountIndex)) || (slot === 0 && !isSignerRole(role(accountIndex))))
      throw new Error(`verifyTopUpTransaction: ${label} privilege mismatch`);
  }
  const [expectedPayerAta] = await findAssociatedTokenPda({
    mint: address(expected.mint),
    owner: address(payer),
    tokenProgram: address(expected.tokenProgram),
  });
  const [expectedChannelAta] = await findAssociatedTokenPda({
    mint: address(expected.mint),
    owner: address(channel),
    tokenProgram: address(expected.tokenProgram),
  });
  if (payerAta !== expectedPayerAta || channelAta !== expectedChannelAta)
    throw new Error("verifyTopUpTransaction: ATA binding mismatch");
  if (getTopUpInstructionDataDecoder().decode(ix.data).topUpArgs.amount !== expected.amount)
    throw new Error("verifyTopUpTransaction: top-up amount mismatch");
}

/** Channel facts extracted from a verified open transaction. */
export interface VerifyOpenResult {
  channelId: string;
  payer: string;
  deposit: bigint;
  gracePeriod: number;
  /** Slot the open is anchored to (channel PDA seed); the program enforces its freshness. */
  openSlot: bigint;
  recipients: readonly ChannelSplit[];
  salt: bigint;
}

type CompiledOpenMessage = {
  addressTableLookups?: readonly unknown[];
  header: {
    numReadonlyNonSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numSignerAccounts: number;
  };
  instructions: readonly {
    accountIndices?: readonly number[];
    data?: Uint8Array | undefined;
    programAddressIndex: number;
  }[];
  staticAccounts: readonly string[];
};

/**
 * Decode and validate a client-submitted open transaction (base64).
 *
 * Asserts the top-level layout is an optional Compute Budget prefix, exactly
 * one payment-channels `open`, and an optional Lighthouse/Memo suffix (Phantom /
 * Solflare + uniqueness memo), that the open instruction has exactly the 14
 * pinned accounts (no remaining accounts), carries the required
 * writable/signer privileges (with Solana key-dedup privilege union), that
 * `feePayer`, `payee`, `mint`, `tokenProgram`, `authorizedSigner`,
 * `withdrawDelay`, and `openSlot` match expectations, that `deposit == maxCap`,
 * and that the channel PDA matches the recomputed value.
 *
 * @param transactionBase64 - The client-signed open transaction
 * @param expected - Values pinned by the requirements
 * @returns Extracted channel facts
 */
export async function verifyOpenTransaction(
  transactionBase64: string,
  expected: VerifyOpenExpected,
): Promise<VerifyOpenResult> {
  const programIdStr = expected.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;

  const txBytes = getBase64Codec().encode(transactionBase64);
  const decoded = getTransactionDecoder().decode(txBytes);
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as CompiledOpenMessage;

  // The fee payer co-signs this client-supplied transaction, so a malicious
  // client could otherwise smuggle a fee-payer-authorized instruction (e.g.
  // `SystemProgram.transfer { from: feePayer }`) alongside the open and drain
  // the sponsor. Defenses before account binding:
  //   1. Reject Address Lookup Tables — they hide instruction programs/accounts
  //      from `staticAccounts`. The in-SDK open builder never uses them.
  //   2. Allow only the spec's top-level layout: optional ComputeBudget prefix,
  //      exactly one payment-channels `open`, optional Lighthouse/Memo suffix.
  //      Wallets like Phantom/Solflare inject Lighthouse around the client open.
  if (message.addressTableLookups && message.addressTableLookups.length > 0) {
    throw new Error(
      "verifyOpenTransaction: address-lookup tables are not permitted in an open transaction — all accounts must be static so the fee-payer guard can validate them",
    );
  }

  const maxComputeUnits = Math.min(
    expected.maxComputeUnits ?? OPEN_MAX_COMPUTE_UNIT_LIMIT,
    OPEN_MAX_COMPUTE_UNIT_LIMIT,
  );
  const maxPriorityFeeMicroLamports = Math.min(
    expected.maxPriorityFeeMicroLamports ?? MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  );

  const openIx = findCanonicalOpenInstruction(message, programIdStr, expected.feePayer, {
    maxComputeUnits,
    maxPriorityFeeMicroLamports,
    expectedMemo: expected.memo,
  });

  // Required-signer set must equal the distinct addresses in
  // `{ payload.from, extra.feePayer }` — no other signature may be required.
  const expectedSigners = new Set(
    expected.feePayer === expected.from ? [expected.from] : [expected.feePayer, expected.from],
  );
  const numSigners = message.header.numSignerAccounts;
  if (expected.maxRequiredSignatures !== undefined && numSigners > expected.maxRequiredSignatures) {
    throw new Error(
      `verifyOpenTransaction: required-signer count ${numSigners} exceeds maxRequiredSignatures ${expected.maxRequiredSignatures}`,
    );
  }
  const signerAddresses = message.staticAccounts.slice(0, numSigners);
  if (signerAddresses.length !== expectedSigners.size) {
    throw new Error(
      `verifyOpenTransaction: required-signer count ${signerAddresses.length} != expected ${expectedSigners.size}`,
    );
  }
  for (const signer of signerAddresses) {
    if (!expectedSigners.has(signer)) {
      throw new Error(
        `verifyOpenTransaction: unexpected required signer ${signer}; expected {${[...expectedSigners].join(", ")}}`,
      );
    }
  }

  // The payer signature must be present and valid before the facilitator signs.
  const fromSignature = decoded.signatures[expected.from as Address];
  if (fromSignature == null) {
    throw new Error(`verifyOpenTransaction: missing signature for payload.from ${expected.from}`);
  }
  const fromPubkey = getBase58Encoder().encode(expected.from) as Uint8Array;
  const fromSigValid = await verifyEd25519Signature({
    message: decoded.messageBytes as unknown as Uint8Array,
    publicKey: fromPubkey,
    signature: fromSignature as unknown as Uint8Array,
  });
  if (!fromSigValid) {
    throw new Error(`verifyOpenTransaction: invalid signature for payload.from ${expected.from}`);
  }

  const indices = openIx.accountIndices;
  // Spec: exactly 14 pinned slots and no remaining accounts.
  if (indices.length !== 14) {
    throw new Error(
      `verifyOpenTransaction: open instruction must have exactly 14 accounts, found ${indices.length}`,
    );
  }
  const accountAt = (slot: number, label: string): string => {
    const idx = indices[slot];
    const addr = idx === undefined ? undefined : message.staticAccounts[idx];
    if (!addr) throw new Error(`verifyOpenTransaction: missing account at slot ${slot} (${label})`);
    return addr;
  };
  // Open account layout: 0 payer, 1 rentPayer, 2 payee, 3 mint,
  // 4 authorizedSigner, 5 channel, ...
  const payerAddr = accountAt(0, "payer");
  const rentPayerAddr = accountAt(1, "rentPayer");
  const payeeAddr = accountAt(2, "payee");
  const mintAddr = accountAt(3, "mint");
  const authorizedSignerAddr = accountAt(4, "authorizedSigner");
  const channelAddr = accountAt(5, "channel");
  const payerTokenAccountAddr = accountAt(6, "payerTokenAccount");
  const channelTokenAccountAddr = accountAt(7, "channelTokenAccount");
  const tokenProgramAddr = accountAt(8, "tokenProgram");
  const systemProgramAddr = accountAt(9, "systemProgram");
  const rentSysvarAddr = accountAt(10, "rent");
  const associatedTokenProgramAddr = accountAt(11, "associatedTokenProgram");
  const eventAuthorityAddr = accountAt(12, "eventAuthority");
  const selfProgramAddr = accountAt(13, "selfProgram");
  const feePayerAddr = message.staticAccounts[0];

  // Message-header privileges for each static account index. Solana unions
  // privileges across deduplicated keys, so a read-only role (payee /
  // authorizedSigner) MAY be writable/signer when it equals a writable or
  // signer role — that expected union must not cause rejection. Any address
  // outside the writable roles in the open table must not be writable.
  const accountRole = (accountIndex: number) =>
    staticAccountRole(message.header, message.staticAccounts.length, accountIndex);
  const requirePrivileges = (
    slot: number,
    label: string,
    required: { signer?: boolean; writable?: boolean },
  ): void => {
    const idx = indices[slot];
    if (idx === undefined) {
      throw new Error(`verifyOpenTransaction: missing account index at slot ${slot} (${label})`);
    }
    const role = accountRole(idx);
    if (required.signer && !isSignerRole(role)) {
      throw new Error(`verifyOpenTransaction: ${label} at slot ${slot} must be a signer`);
    }
    if (required.writable && !isWritableRole(role)) {
      throw new Error(`verifyOpenTransaction: ${label} at slot ${slot} must be writable`);
    }
  };
  requirePrivileges(0, "payer", { signer: true, writable: true });
  requirePrivileges(1, "rentPayer", { signer: true, writable: true });
  requirePrivileges(5, "channel", { writable: true });
  requirePrivileges(6, "payerTokenAccount", { writable: true });
  requirePrivileges(7, "channelTokenAccount", { writable: true });

  const writableRoleAddresses = new Set([
    payerAddr,
    rentPayerAddr,
    channelAddr,
    payerTokenAccountAddr,
    channelTokenAccountAddr,
  ]);
  for (let i = 0; i < message.staticAccounts.length; i += 1) {
    const addr = message.staticAccounts[i];
    if (!addr) continue;
    if (isWritableRole(accountRole(i)) && !writableRoleAddresses.has(addr)) {
      throw new Error(
        `verifyOpenTransaction: account ${addr} is writable but is not among the open instruction's writable roles`,
      );
    }
  }

  if (payerAddr !== expected.from) {
    throw new Error(
      `verifyOpenTransaction: payer ${payerAddr} != expected payload.from ${expected.from}`,
    );
  }
  if (feePayerAddr !== expected.feePayer) {
    throw new Error(
      `verifyOpenTransaction: feePayer ${feePayerAddr} != expected ${expected.feePayer}`,
    );
  }
  if (rentPayerAddr !== expected.feePayer) {
    throw new Error(
      `verifyOpenTransaction: rentPayer ${rentPayerAddr} != expected feePayer ${expected.feePayer}`,
    );
  }
  if (payeeAddr !== expected.payee) {
    throw new Error(`verifyOpenTransaction: payee ${payeeAddr} != expected ${expected.payee}`);
  }
  if (mintAddr !== expected.mint) {
    throw new Error(`verifyOpenTransaction: mint ${mintAddr} != expected ${expected.mint}`);
  }
  if (authorizedSignerAddr !== expected.authorizedSigner) {
    throw new Error(
      `verifyOpenTransaction: authorizedSigner ${authorizedSignerAddr} != expected ${expected.authorizedSigner}`,
    );
  }
  if (tokenProgramAddr !== expected.tokenProgram) {
    throw new Error(
      `verifyOpenTransaction: tokenProgram ${tokenProgramAddr} != expected ${expected.tokenProgram}`,
    );
  }
  const tokenProgram = address(expected.tokenProgram);
  const [expectedPayerTokenAccount] = await findAssociatedTokenPda({
    mint: address(expected.mint),
    owner: address(payerAddr),
    tokenProgram,
  });
  const [expectedChannelTokenAccount] = await findAssociatedTokenPda({
    mint: address(expected.mint),
    owner: address(channelAddr),
    tokenProgram,
  });
  const [expectedEventAuthority] = await findEventAuthorityPda({
    programAddress: address(programIdStr),
  });
  const fixedAccounts: readonly [string, string, string][] = [
    ["payerTokenAccount", payerTokenAccountAddr, expectedPayerTokenAccount],
    ["channelTokenAccount", channelTokenAccountAddr, expectedChannelTokenAccount],
    ["systemProgram", systemProgramAddr, SYSTEM_PROGRAM_ID],
    ["rent", rentSysvarAddr, RENT_SYSVAR],
    ["associatedTokenProgram", associatedTokenProgramAddr, ASSOCIATED_TOKEN_PROGRAM_ID],
    ["eventAuthority", eventAuthorityAddr, expectedEventAuthority],
    ["selfProgram", selfProgramAddr, programIdStr],
  ];
  for (const [label, actual, wanted] of fixedAccounts) {
    if (actual !== wanted) {
      throw new Error(`verifyOpenTransaction: ${label} ${actual} != expected ${wanted}`);
    }
  }

  const openData = getOpenInstructionDataDecoder().decode(openIx.data);
  const { deposit, gracePeriod, openSlot, recipients, salt } = openData.openArgs;

  if (deposit === 0n) throw new Error("verifyOpenTransaction: deposit must be greater than zero");
  if (deposit !== expected.maxCap) {
    throw new Error(
      `verifyOpenTransaction: deposit ${deposit} != maxCap ${expected.maxCap} — the deposit is the enforced ceiling and \`topUp\` can raise an open channel's deposit, so it must equal the authorized amount exactly`,
    );
  }
  if (gracePeriod !== expected.withdrawDelay) {
    throw new Error(
      `verifyOpenTransaction: gracePeriod ${gracePeriod} != expected withdrawDelay ${expected.withdrawDelay}`,
    );
  }
  if (openSlot !== expected.openSlot) {
    throw new Error(`verifyOpenTransaction: openSlot ${openSlot} != expected ${expected.openSlot}`);
  }
  if (expected.recentSlot !== undefined) {
    if (openSlot > expected.recentSlot) {
      throw new Error(
        `verifyOpenTransaction: openSlot ${openSlot} is ahead of challenged recentSlot ${expected.recentSlot}`,
      );
    }
    if (expected.recentSlot - openSlot > OPEN_SLOT_WINDOW) {
      throw new Error(
        `verifyOpenTransaction: openSlot ${openSlot} is outside the ${OPEN_SLOT_WINDOW}-slot freshness window of challenged recentSlot ${expected.recentSlot}`,
      );
    }
  }
  const expectedRecipients = expected.recipients ?? [];
  if (recipients.length !== expectedRecipients.length) {
    throw new Error(
      `verifyOpenTransaction: expected ${expectedRecipients.length} distribution recipients, found ${recipients.length}`,
    );
  }
  for (let i = 0; i < expectedRecipients.length; i += 1) {
    const expectedRecipient = expectedRecipients[i];
    const actualRecipient = recipients[i];
    if (!expectedRecipient || !actualRecipient) {
      throw new Error(`verifyOpenTransaction: missing distribution recipient at index ${i}`);
    }
    if (actualRecipient.recipient !== expectedRecipient.recipient) {
      throw new Error(
        `verifyOpenTransaction: distribution recipient ${actualRecipient.recipient} != expected ${expectedRecipient.recipient} at index ${i}`,
      );
    }
    if (actualRecipient.bps !== expectedRecipient.bps) {
      throw new Error(
        `verifyOpenTransaction: distribution bps ${actualRecipient.bps} != expected ${expectedRecipient.bps} at index ${i}`,
      );
    }
  }

  // `openSlot` is taken from the decoded args: it is a PDA seed, so a wrong
  // value yields a mismatched channel address, and the program itself enforces
  // the freshness window (`openSlot <= clock.slot <= openSlot + 1500`).
  const derivedChannel = await findPaymentChannelPda({
    payer: payerAddr,
    payee: payeeAddr,
    mint: mintAddr,
    authorizedSigner: authorizedSignerAddr,
    salt,
    openSlot,
    programId: expected.programId,
  });
  if (derivedChannel !== channelAddr) {
    throw new Error(
      `verifyOpenTransaction: channel PDA ${channelAddr} != derived ${derivedChannel}`,
    );
  }

  return {
    channelId: channelAddr,
    deposit,
    gracePeriod,
    openSlot,
    payer: payerAddr,
    recipients: recipients.map(recipient => ({
      bps: recipient.bps,
      recipient: recipient.recipient,
    })),
    salt,
  };
}

type OpenLayoutLimits = {
  maxComputeUnits: number;
  maxPriorityFeeMicroLamports: number;
  expectedMemo?: string | undefined;
};

/**
 * Locate the canonical payment-channels `open` in a compiled message and enforce
 * the upto SVM top-level layout:
 * optional ComputeBudget prefix → exactly one `open` → optional Lighthouse/Memo suffix.
 *
 * @param message - Compiled transaction message
 * @param programIdStr - Expected payment-channels program id
 * @param feePayer - Expected fee payer; must not appear outside `open` accounts
 * @param limits - Operator/spec compute caps and optional seller memo
 * @returns The open instruction's accounts + data
 */
function findCanonicalOpenInstruction(
  message: CompiledOpenMessage,
  programIdStr: string,
  feePayer: string,
  limits: OpenLayoutLimits,
  discriminator = OPEN_DISCRIMINATOR,
  instructionName = "open",
): { accountIndices: readonly number[]; data: Uint8Array } {
  const { instructions, staticAccounts } = message;
  if (instructions.length === 0) {
    throw new Error("verifyOpenTransaction: no payment-channels open instruction found");
  }

  let i = 0;
  let seenLimit = false;
  let seenPrice = false;
  while (i < instructions.length) {
    const ix = instructions[i];
    if (!ix) break;
    const program = staticAccounts[ix.programAddressIndex];
    if (program !== COMPUTE_BUDGET_PROGRAM_ADDRESS) break;
    rejectFeePayerOutsideOpen(ix, staticAccounts, feePayer, "ComputeBudget");
    const data = ix.data;
    if (!data || data.length < 1) {
      throw new Error("verifyOpenTransaction: malformed ComputeBudget instruction");
    }
    if (data[0] === 2) {
      // SetComputeUnitLimit: discriminator + u32 LE units
      if (seenLimit) {
        throw new Error("verifyOpenTransaction: duplicate SetComputeUnitLimit instruction");
      }
      if (seenPrice) {
        throw new Error(
          "verifyOpenTransaction: SetComputeUnitLimit must precede SetComputeUnitPrice",
        );
      }
      if (data.length !== 5) {
        throw new Error("verifyOpenTransaction: SetComputeUnitLimit must be exactly 5 bytes");
      }
      const units = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
      if (units > limits.maxComputeUnits) {
        throw new Error(
          `verifyOpenTransaction: SetComputeUnitLimit ${units} exceeds ${limits.maxComputeUnits}`,
        );
      }
      seenLimit = true;
    } else if (data[0] === 3) {
      // SetComputeUnitPrice: discriminator + u64 LE microlamports
      if (seenPrice) {
        throw new Error("verifyOpenTransaction: duplicate SetComputeUnitPrice instruction");
      }
      if (data.length !== 9) {
        throw new Error("verifyOpenTransaction: SetComputeUnitPrice must be exactly 9 bytes");
      }
      const microLamports = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getBigUint64(1, true);
      if (microLamports > BigInt(limits.maxPriorityFeeMicroLamports)) {
        throw new Error(
          `verifyOpenTransaction: SetComputeUnitPrice ${microLamports} exceeds ${limits.maxPriorityFeeMicroLamports}`,
        );
      }
      seenPrice = true;
    } else {
      throw new Error(
        `verifyOpenTransaction: unsupported ComputeBudget instruction type ${data[0]}`,
      );
    }
    i += 1;
  }

  const openInstruction = instructions[i];
  if (!openInstruction) {
    throw new Error("verifyOpenTransaction: no payment-channels open instruction found");
  }
  const openProgram = staticAccounts[openInstruction.programAddressIndex];
  if (openProgram !== programIdStr) {
    throw new Error(
      `verifyOpenTransaction: unexpected instruction program ${openProgram}; expected payment-channels open after the ComputeBudget prefix`,
    );
  }
  if (
    !openInstruction.data ||
    openInstruction.data.length < 1 ||
    openInstruction.data[0] !== discriminator
  ) {
    throw new Error(
      `verifyOpenTransaction: payment-channels instruction is not \`${instructionName}\``,
    );
  }
  i += 1;

  let lighthouseCount = 0;
  let optionalCount = 0;
  const memoDatas: Uint8Array[] = [];
  while (i < instructions.length) {
    const ix = instructions[i];
    if (!ix) break;
    const program = staticAccounts[ix.programAddressIndex];
    optionalCount += 1;
    if (optionalCount > OPEN_MAX_OPTIONAL_SUFFIX) {
      throw new Error(
        `verifyOpenTransaction: at most ${OPEN_MAX_OPTIONAL_SUFFIX} optional instructions are allowed after open`,
      );
    }
    if (program === LIGHTHOUSE_PROGRAM_ADDRESS) {
      lighthouseCount += 1;
      if (lighthouseCount > OPEN_MAX_LIGHTHOUSE_INSTRUCTIONS) {
        throw new Error(
          `verifyOpenTransaction: at most ${OPEN_MAX_LIGHTHOUSE_INSTRUCTIONS} Lighthouse instructions are allowed after open`,
        );
      }
      rejectFeePayerOutsideOpen(ix, staticAccounts, feePayer, "Lighthouse");
    } else if (program === MEMO_PROGRAM_ADDRESS) {
      rejectFeePayerOutsideOpen(ix, staticAccounts, feePayer, "Memo");
      if (ix.data) memoDatas.push(ix.data);
      else memoDatas.push(new Uint8Array());
    } else {
      throw new Error(
        `verifyOpenTransaction: unexpected instruction program ${program}; only Lighthouse or Memo are allowed after open`,
      );
    }
    i += 1;
  }

  if (limits.expectedMemo !== undefined) {
    if (memoDatas.length !== 1) {
      throw new Error(
        `verifyOpenTransaction: expected exactly one Memo instruction matching extra.memo, found ${memoDatas.length}`,
      );
    }
    const actualMemo = new TextDecoder().decode(memoDatas[0]!);
    if (actualMemo !== limits.expectedMemo) {
      throw new Error("verifyOpenTransaction: Memo instruction data does not match extra.memo");
    }
  }

  return {
    accountIndices: openInstruction.accountIndices ?? [],
    data: openInstruction.data,
  };
}

/**
 * Reject optional-wrapper instructions that reference the fee payer as an
 * account or as the invoked program (sponsor isolation outside `open` slots).
 *
 * @param ix - Compiled instruction
 * @param ix.accountIndices - Account indices in the instruction
 * @param ix.programAddressIndex - Program address index
 * @param staticAccounts - Message static account keys
 * @param feePayer - Expected fee payer
 * @param label - Instruction region label for errors
 */
function rejectFeePayerOutsideOpen(
  ix: { accountIndices?: readonly number[]; programAddressIndex: number },
  staticAccounts: readonly string[],
  feePayer: string,
  label: string,
): void {
  if (staticAccounts[ix.programAddressIndex] === feePayer) {
    throw new Error(
      `verifyOpenTransaction: feePayer must not be the invoked program of a ${label} instruction`,
    );
  }
  for (const accountIndex of ix.accountIndices ?? []) {
    if (staticAccounts[accountIndex] === feePayer) {
      throw new Error(
        `verifyOpenTransaction: feePayer must not appear in ${label} instruction accounts`,
      );
    }
  }
}

/**
 * Resolve the compiled-message {@link AccountRole} for a static account index
 * from the Solana message header partitioning:
 * `[writable signers | readonly signers | writable nonsigners | readonly nonsigners]`.
 *
 * @param header - Compiled message header
 * @param header.numReadonlyNonSignerAccounts - Readonly nonsigner count
 * @param header.numReadonlySignerAccounts - Readonly signer count
 * @param header.numSignerAccounts - Total signer count
 * @param staticAccountCount - Length of `staticAccounts`
 * @param accountIndex - Index into `staticAccounts`
 * @returns The account role at that index
 */
function staticAccountRole(
  header: {
    numReadonlyNonSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numSignerAccounts: number;
  },
  staticAccountCount: number,
  accountIndex: number,
): AccountRole {
  const numWritableSigners = header.numSignerAccounts - header.numReadonlySignerAccounts;
  const numWritableNonSigners =
    staticAccountCount - header.numSignerAccounts - header.numReadonlyNonSignerAccounts;
  if (accountIndex < numWritableSigners) return AccountRole.WRITABLE_SIGNER;
  if (accountIndex < header.numSignerAccounts) return AccountRole.READONLY_SIGNER;
  if (accountIndex < header.numSignerAccounts + numWritableNonSigners) {
    return AccountRole.WRITABLE;
  }
  return AccountRole.READONLY;
}

/**
 * Parse an unsigned-integer-like value (bigint, safe number, or digit string)
 * into a u64 bigint.
 *
 * @param value - The value to parse
 * @param name - Field name for error messages
 * @returns The parsed bigint
 */
export function parseU64(value: bigint | number | string, name: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
    parsed = BigInt(value);
  } else if (/^\d+$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error(`${name} must be an unsigned integer`);
  }
  if (parsed < 0n || parsed > U64_MAX) throw new Error(`${name} must fit in u64`);
  return parsed;
}

/**
 * Generate a random u64 salt.
 *
 * @returns A random u64 bigint
 */
export function randomU64(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}
