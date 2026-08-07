/**
 * Payment-channel open: client-side transaction builder + server-side verifier.
 *
 * Scoped to the `upto` pull flow: the client builds a payer-signed `open`
 * transaction with the fee payer as transaction sponsor, rent payer, and
 * zero-share channel payee, and the receiver authorizer as authorized signer.
 */

import {
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
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";

import {
  getOpenInstruction,
  getOpenInstructionDataDecoder,
  OPEN_DISCRIMINATOR,
} from "./generated/instructions/open";
import { findEventAuthorityPda } from "./generated/pdas/eventAuthority";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";
import { verifyEd25519Signature } from "./voucher";

const U64_MAX = (1n << 64n) - 1n;

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
    msg => appendTransactionMessageInstructions([instruction], msg),
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

/**
 * Decode and validate a client-submitted open transaction (base64).
 *
 * Asserts the embedded open instruction targets the payment-channels program,
 * that `feePayer`, `payee`, `mint`, `tokenProgram`, `authorizedSigner`,
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
  ) as unknown as {
    addressTableLookups?: readonly unknown[];
    header: { numSignerAccounts: number };
    instructions: readonly {
      accountIndices?: readonly number[];
      data?: Uint8Array | undefined;
      programAddressIndex: number;
    }[];
    staticAccounts: readonly string[];
  };

  // The fee payer co-signs this client-supplied transaction, so a malicious
  // client could otherwise smuggle a fee-payer-authorized instruction (e.g.
  // `SystemProgram.transfer { from: feePayer }`) alongside the open and drain
  // the sponsor. Two defenses, before any account binding:
  //   1. Reject Address Lookup Tables — they hide instruction programs/accounts
  //      from `staticAccounts`. The in-SDK open builder never uses them.
  //   2. Require exactly one payment-channels `open` instruction. Nothing else
  //      gets the fee payer's signature or expands its fee exposure.
  if (message.addressTableLookups && message.addressTableLookups.length > 0) {
    throw new Error(
      "verifyOpenTransaction: address lookup tables are not permitted in an open transaction",
    );
  }
  if (message.instructions.length !== 1) {
    throw new Error(
      `verifyOpenTransaction: expected exactly one open instruction, found ${message.instructions.length}`,
    );
  }

  // Required-signer set must equal the distinct addresses in
  // `{ payload.from, extra.feePayer }` — no other signature may be required.
  const expectedSigners = new Set(
    expected.feePayer === expected.from ? [expected.from] : [expected.feePayer, expected.from],
  );
  const numSigners = message.header.numSignerAccounts;
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
  const instruction = message.instructions[0];
  if (!instruction) {
    throw new Error("verifyOpenTransaction: no payment-channels open instruction found");
  }
  const program = message.staticAccounts[instruction.programAddressIndex];
  if (program !== programIdStr) {
    throw new Error(
      `verifyOpenTransaction: unexpected instruction program ${program}; only the channel open may be co-signed`,
    );
  }
  if (
    !instruction.data ||
    instruction.data.length < 1 ||
    instruction.data[0] !== OPEN_DISCRIMINATOR
  ) {
    throw new Error("verifyOpenTransaction: payment-channels instruction is not `open`");
  }
  const openIx = {
    accountIndices: instruction.accountIndices ?? [],
    data: instruction.data,
  };

  const indices = openIx.accountIndices;
  if (indices.length < 14) {
    throw new Error(
      `verifyOpenTransaction: open instruction has too few accounts (${indices.length})`,
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
