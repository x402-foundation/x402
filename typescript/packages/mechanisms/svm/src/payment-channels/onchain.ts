/**
 * Server-side onchain instruction builders for the payment-channels program.
 *
 * Scoped to what the `upto` payment-channel scheme needs: the Ed25519 verify
 * precompile, settle_and_seal (with optional voucher), distribute, and reclaim.
 */

import {
  type AccountMeta,
  type Address,
  address,
  getBase58Decoder,
  getBase58Encoder,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";

import { SOLANA_DEVNET_CAIP2 } from "../constants";
import { getDistributeInstruction } from "./generated/instructions/distribute";
import { getReclaimInstruction, RECLAIM_DISCRIMINATOR } from "./generated/instructions/reclaim";
import { getSealInstruction } from "./generated/instructions/seal";
import { getSettleInstruction } from "./generated/instructions/settle";
import { getSettleAndSealInstruction } from "./generated/instructions/settleAndSeal";
import { findEventAuthorityPda } from "./generated/pdas/eventAuthority";
import { ChannelStatus } from "./generated/types/channelStatus";
import { encodeVoucherMessageBytes } from "./voucher";

export { RECLAIM_DISCRIMINATOR, ChannelStatus };

/**
 * Concrete instruction shape returned by every builder here: program address,
 * a concrete account list, and a `Uint8Array` data buffer. Avoids the
 * `data?: Uint8Array | undefined` widening of the base `Instruction` interface.
 */
export type ServerInstruction = Instruction &
  InstructionWithAccounts<readonly AccountMeta[]> &
  InstructionWithData<ReadonlyUint8Array>;

/** Sysvar address holding the current transaction's instructions list. */
export const INSTRUCTIONS_SYSVAR_ADDRESS =
  "Sysvar1nstructions1111111111111111111111111" as Address<"Sysvar1nstructions1111111111111111111111111">;

/** Ed25519 signature-verification precompile program id. */
export const ED25519_PROGRAM_ADDRESS =
  "Ed25519SigVerify111111111111111111111111111" as Address<"Ed25519SigVerify111111111111111111111111111">;

/** Associated Token program id (Token and Token-2022 share the same ATA program). */
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address<"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL">;

/** Canonical payment-channels program id (Surfnet/mainnet deployment). */
export const PAYMENT_CHANNELS_PROGRAM_ID =
  "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX" as Address<"CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX">;

/**
 * Treasury owner baked into mainnet payment-channels program:
 * `Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP`. `distribute` validates the
 * treasury token account against `ATA(TREASURY_OWNER, mint, token_program)`,
 * so this must match the onchain constant exactly — otherwise settlement fails
 * with `TreasuryAccountMismatch` (0x961).
 */
const MAINNET_TREASURY_OWNER_BYTES = new Uint8Array([
  0xb0, 0x41, 0xd9, 0xd3, 0x37, 0xb7, 0x21, 0xbe, 0x57, 0x89, 0x4e, 0xb6, 0x9c, 0x3b, 0x68, 0x09,
  0xa5, 0x3a, 0x0e, 0x2b, 0x6a, 0x23, 0x99, 0xfc, 0x7d, 0x5b, 0x7e, 0xda, 0x8c, 0xac, 0x89, 0xaa,
]);

const MAINNET_TREASURY_OWNER = getBase58Decoder().decode(MAINNET_TREASURY_OWNER_BYTES) as Address;

const DEVNET_TREASURY_OWNER =
  "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap" as Address<"4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap">;

/**
 * Payment-channels `TREASURY_OWNER` for the program binary on `network`.
 *
 * @param network - CAIP-2 (or legacy v1) Solana network identifier
 * @returns Treasury owner pubkey used to derive the treasury ATA
 */
export function getPaymentChannelsTreasuryOwner(network: string): Address {
  if (network === SOLANA_DEVNET_CAIP2 || network === "solana-devnet") {
    return DEVNET_TREASURY_OWNER;
  }
  return MAINNET_TREASURY_OWNER;
}

const U16_LE = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);

// ─────────────────────────────────────────────────────────────────────
// Ed25519 precompile
// ─────────────────────────────────────────────────────────────────────

/**
 * Build an Ed25519 verify precompile instruction over the 50-byte voucher
 * message. Layout matches `build_ed25519_verify_instruction` in the Rust
 * payment-channels program helpers.
 *
 * @param args - Precompile inputs
 * @param args.message - The canonical voucher payload (50 bytes, magic-prefixed)
 * @param args.signature - 64-byte Ed25519 signature
 * @param args.signer - 32-byte verifying key
 * @returns The precompile instruction
 */
export function buildEd25519VerifyInstruction(args: {
  message: Uint8Array;
  signature: Uint8Array;
  signer: Uint8Array;
}): ServerInstruction {
  if (args.signer.byteLength !== 32)
    throw new Error(`signer must be 32 bytes, got ${args.signer.byteLength}`);
  if (args.signature.byteLength !== 64) {
    throw new Error(`signature must be 64 bytes, got ${args.signature.byteLength}`);
  }

  const publicKeyOffset = 16;
  const signatureOffset = publicKeyOffset + 32; // 48
  const messageDataOffset = signatureOffset + 64; // 112
  const messageDataSize = args.message.byteLength;
  if (messageDataSize > 0xffff) {
    throw new Error(`voucher message too long: ${messageDataSize}`);
  }
  const currentInstruction = 0xffff;

  // Header (16 bytes): num_signatures (1) + padding (1) + 12 bytes of offsets
  // + 2 bytes message_data_size.
  const data = new Uint8Array(messageDataOffset + messageDataSize);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  data.set(U16_LE(signatureOffset), 2);
  data.set(U16_LE(currentInstruction), 4);
  data.set(U16_LE(publicKeyOffset), 6);
  data.set(U16_LE(currentInstruction), 8);
  data.set(U16_LE(messageDataOffset), 10);
  data.set(U16_LE(messageDataSize), 12);
  data.set(U16_LE(currentInstruction), 14);
  data.set(args.signer, publicKeyOffset);
  data.set(args.signature, signatureOffset);
  data.set(args.message, messageDataOffset);

  return {
    accounts: [],
    data,
    programAddress: ED25519_PROGRAM_ADDRESS,
  } as ServerInstruction;
}

// ─────────────────────────────────────────────────────────────────────
// settle_and_seal
// ─────────────────────────────────────────────────────────────────────

/** A voucher to settle: the receiver-authorizer-signed cumulative amount for a channel. */
export interface SettleVoucher {
  /** The voucher signer (base58); for `upto` this is the receiver authorizer. */
  authorizedSigner: string;
  /** 64-byte Ed25519 signature over the voucher message, base58. */
  signatureBase58: string;
  /** Cumulative settled amount (base units). */
  cumulativeAmount: bigint;
  /** Voucher deadline (Unix seconds, i64). */
  expiresAt: bigint;
}

/** Arguments to {@link buildSettleAndSealInstructions}. */
export interface SettleAndSealBuildArgs {
  /** Payment-channel address being settled (base58). */
  channelId: string;
  /** Payee signer authorized to settle the channel. */
  payeeSigner: TransactionSigner;
  /** Payment-channels program id override. */
  programId?: Address | undefined;
  /** Optional final voucher. When present, an Ed25519 precompile IX is prepended. */
  voucher?: SettleVoucher | undefined;
}

/**
 * Build the instruction(s) for an onchain settle_and_seal. If a voucher
 * is provided, an Ed25519 precompile IX is prepended at index 0 — the
 * settle_and_seal IX references the instructions sysvar at index `-1`
 * (the precompile immediately before it). With no voucher, the channel is
 * sealed with a zero settlement (full refund).
 *
 * @param args - Build inputs
 * @returns Instructions in submit order (precompile first when a voucher is settled)
 */
export function buildSettleAndSealInstructions(args: SettleAndSealBuildArgs): ServerInstruction[] {
  const programId = args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;
  const channel = address(args.channelId);
  const instructions: ServerInstruction[] = [];

  let cumulativeAmount = 0n;
  let expiresAt = 0n;
  let hasVoucher = 0;

  if (args.voucher) {
    cumulativeAmount = args.voucher.cumulativeAmount;
    expiresAt = args.voucher.expiresAt;
    hasVoucher = 1;

    const signerBytes = getBase58Bytes(args.voucher.authorizedSigner);
    if (signerBytes.byteLength !== 32) {
      throw new Error(`authorizedSigner must decode to 32 bytes; got ${signerBytes.byteLength}`);
    }
    const signatureBytes = getBase58Bytes(args.voucher.signatureBase58);
    if (signatureBytes.byteLength !== 64) {
      throw new Error(
        `voucher signature must decode to 64 bytes; got ${signatureBytes.byteLength}`,
      );
    }
    const message = encodeVoucherMessageBytes({
      channelId: args.channelId,
      cumulativeAmount,
      expiresAt,
    });
    instructions.push(
      buildEd25519VerifyInstruction({ message, signature: signatureBytes, signer: signerBytes }),
    );
  }

  const ix = getSettleAndSealInstruction(
    {
      channel,
      instructionsSysvar: INSTRUCTIONS_SYSVAR_ADDRESS,
      payee: args.payeeSigner,
      // The program reads the voucher from the ed25519 precompile; the
      // settle_and_seal args carry only the hasVoucher flag.
      settleAndSealArgs: { hasVoucher },
    },
    { programAddress: programId },
  );
  instructions.push(ix as unknown as ServerInstruction);

  return instructions;
}

/**
 * Build the permissionless seal instruction for a Closing channel whose grace
 * period has elapsed.
 *
 * @param channelId - Payment-channel address
 * @returns The seal instruction
 */
export function buildSealInstruction(channelId: string): ServerInstruction {
  return getSealInstruction({ channel: address(channelId) }) as unknown as ServerInstruction;
}

// ─────────────────────────────────────────────────────────────────────
// settle (watermark-only, batched redemption)
// ─────────────────────────────────────────────────────────────────────

/** Arguments to {@link buildSettleInstructions}. */
export interface SettleBuildArgs {
  /** Payment-channel address being settled (base58). */
  channelId: string;
  /** The cumulative voucher to redeem (signed by the channel's authorized signer). */
  voucher: SettleVoucher;
  /** Payment-channels program id override. */
  programId?: Address | undefined;
}

/**
 * Build the instruction pair for an on-chain `settle`: an Ed25519 precompile
 * verifying the voucher, followed by the `settle` instruction that advances the
 * channel's `settled` watermark to the voucher's cumulative amount. Unlike
 * {@link buildSettleAndSealInstructions}, this neither seals the channel
 * nor moves tokens — it is the batched redemption step. `settle` is
 * permissionless; the precompile signature is the authority, so the operator
 * only fee-pays.
 *
 * @param args - Build inputs
 * @returns `[ed25519_verify, settle]` in submit order
 */
export function buildSettleInstructions(args: SettleBuildArgs): ServerInstruction[] {
  const programId = args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;
  const channel = address(args.channelId);

  const signerBytes = getBase58Bytes(args.voucher.authorizedSigner);
  if (signerBytes.byteLength !== 32) {
    throw new Error(`authorizedSigner must decode to 32 bytes; got ${signerBytes.byteLength}`);
  }
  const signatureBytes = getBase58Bytes(args.voucher.signatureBase58);
  if (signatureBytes.byteLength !== 64) {
    throw new Error(`voucher signature must decode to 64 bytes; got ${signatureBytes.byteLength}`);
  }
  const message = encodeVoucherMessageBytes({
    channelId: args.channelId,
    cumulativeAmount: args.voucher.cumulativeAmount,
    expiresAt: args.voucher.expiresAt,
  });

  const verify = buildEd25519VerifyInstruction({
    message,
    signature: signatureBytes,
    signer: signerBytes,
  });
  const settle = getSettleInstruction(
    { channel, instructionsSysvar: INSTRUCTIONS_SYSVAR_ADDRESS },
    { programAddress: programId },
  );
  return [verify, settle as unknown as ServerInstruction];
}

// ─────────────────────────────────────────────────────────────────────
// distribute
// ─────────────────────────────────────────────────────────────────────

/** Arguments to {@link buildDistributeInstruction}. */
export interface DistributeBuildArgs {
  channelId: string;
  payee: string;
  payer: string;
  /** Operator key that funded the channel rent at open; reclaims it on distribute. */
  rentPayer: string;
  mint: string;
  tokenProgram: string;
  splits: readonly { bps: number; recipient: string }[];
  network: string;
  programId?: Address | undefined;
}

/**
 * Build a distribute instruction with the dynamic recipient-ATA tail.
 *
 * @param args - Build inputs
 * @returns The distribute instruction
 */
export async function buildDistributeInstruction(
  args: DistributeBuildArgs,
): Promise<ServerInstruction> {
  const programId = args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;
  const mint = address(args.mint);
  const tokenProgram = address(args.tokenProgram);
  const channel = address(args.channelId);
  const payer = address(args.payer);
  const payee = address(args.payee);
  const rentPayer = address(args.rentPayer);

  const [channelTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: channel,
    tokenProgram,
  });
  const [payerTokenAccount] = await findAssociatedTokenPda({ mint, owner: payer, tokenProgram });
  const [payeeTokenAccount] = await findAssociatedTokenPda({ mint, owner: payee, tokenProgram });
  const [eventAuthority] = await findEventAuthorityPda({ programAddress: programId });
  const treasury = getPaymentChannelsTreasuryOwner(args.network);
  const [treasuryTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: treasury,
    tokenProgram,
  });

  const recipientTokenAccounts: Address[] = [];
  const distributions: { bps: number; recipient: Address }[] = [];
  for (const split of args.splits) {
    const recipient = address(split.recipient);
    const [recipientAta] = await findAssociatedTokenPda({ mint, owner: recipient, tokenProgram });
    recipientTokenAccounts.push(recipientAta);
    distributions.push({ bps: split.bps, recipient });
  }

  const ix = getDistributeInstruction(
    {
      channel,
      channelTokenAccount,
      distributeArgs: { recipients: distributions },
      eventAuthority,
      mint,
      payeeTokenAccount,
      payer,
      rentPayer,
      payerTokenAccount,
      recipientTokenAccounts,
      selfProgram: programId,
      tokenProgram,
      treasuryTokenAccount,
    },
    { programAddress: programId },
  );
  return ix as unknown as ServerInstruction;
}

// ─────────────────────────────────────────────────────────────────────
// reclaim
// ─────────────────────────────────────────────────────────────────────

/** Arguments to {@link buildReclaimInstruction}. */
export interface ReclaimBuildArgs {
  /** Distributed channel PDA (base58). */
  channelId: string;
  /** Must equal `Channel.rent_payer`; receives reclaimed lamports. */
  rentPayer: string;
  /** Payment-channels program id override. */
  programId?: Address | undefined;
}

/**
 * Build a permissionless `reclaim` instruction for a `Distributed` channel.
 * Accounts: `[channel writable, rentPayer writable]`. Batchable.
 *
 * @param args - Build inputs
 * @returns The reclaim instruction
 */
export function buildReclaimInstruction(args: ReclaimBuildArgs): ServerInstruction {
  const programId = args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;
  return getReclaimInstruction(
    {
      channel: address(args.channelId),
      rentPayer: address(args.rentPayer),
    },
    { programAddress: programId },
  ) as unknown as ServerInstruction;
}

// ─────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────

/**
 *
 * @param value
 */
function getBase58Bytes(value: string): Uint8Array {
  // The kit base58 codec's `encode` decodes base58 text → bytes.
  return getBase58Encoder().encode(value) as Uint8Array;
}
