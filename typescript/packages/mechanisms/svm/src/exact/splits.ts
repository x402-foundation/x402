/**
 * Multi-payee splits for the exact scheme (scheme_exact_svm.md §5).
 *
 * Shared by the client (transaction construction), the server (requirements
 * checks against the facilitator's advertisement) and the facilitator (Path 1,
 * Path 2 and post-settlement verification).
 */

import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token-2022";
import type { Address } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  MAX_SPLITS,
  MAX_SPLIT_MEMO_BYTES,
  SYSTEM_PROGRAM_ADDRESS,
} from "../constants";
import { validateSvmAddress } from "../utils";
import * as Errors from "./facilitator/errors";

const U64_MAX = (1n << 64n) - 1n;
const CANONICAL_AMOUNT = /^[1-9][0-9]*$/;
const IX_CREATE_IDEMPOTENT = 1;

const TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ADDRESS.toString(),
  TOKEN_2022_PROGRAM_ADDRESS.toString(),
]);

/**
 * One entry of `PaymentRequirements.extra.splits`.
 */
export type ExactSvmSplit = {
  payTo: string;
  amount: string;
  memo?: string;
  ataCreationRequired?: boolean;
};

/**
 * One payment leg: the primary remainder to `payTo`, or one split.
 */
export type PaymentLeg = {
  owner: string;
  amount: bigint;
  /** The primary leg tolerates overpayment off the static path; split legs never do. */
  isPrimary: boolean;
  ataCreationRequired: boolean;
};

/**
 * A split rule violation, carrying the reason code a facilitator reports.
 */
export class SplitsError extends Error {
  /**
   * Creates a split rule violation.
   *
   * @param reason - Reason code (one of the split error constants)
   * @param message - Human-readable detail
   */
  constructor(
    readonly reason: string,
    message?: string,
  ) {
    super(message ? `${reason}: ${message}` : reason);
    this.name = "SplitsError";
  }
}

/**
 * Whether the requirements use the splits extension, either through a
 * non-empty `extra.splits` or a primary marked `extra.ataCreationRequired`.
 *
 * @param requirements - Payment requirements to inspect
 * @returns True when §5 applies
 */
export function usesSplitTerms(requirements: PaymentRequirements): boolean {
  const splits = requirements.extra?.splits;
  if (splits !== undefined && splits !== null && !(Array.isArray(splits) && splits.length === 0)) {
    return true;
  }
  return requirements.extra?.ataCreationRequired === true;
}

/**
 * Returns the `extra.splits` entries, or an empty array when absent.
 *
 * @param requirements - Payment requirements, already validated by {@link parsePaymentLegs}
 * @returns The split entries
 */
export function getSplits(requirements: PaymentRequirements): ExactSvmSplit[] {
  const splits = requirements.extra?.splits;
  return Array.isArray(splits) ? (splits as ExactSvmSplit[]) : [];
}

/**
 * Parses a base-unit amount that must be a canonical positive u64 decimal.
 *
 * @param value - Candidate amount
 * @param field - Field name for the error message
 * @returns The amount as a bigint
 */
function parseAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !CANONICAL_AMOUNT.test(value)) {
    throw new SplitsError(Errors.ErrSplitsInvalid, `${field} must be a positive integer string`);
  }
  const amount = BigInt(value);
  if (amount > U64_MAX) {
    throw new SplitsError(Errors.ErrSplitsInvalid, `${field} exceeds u64`);
  }
  return amount;
}

/**
 * Validates `extra.splits` and `extra.ataCreationRequired` and returns the
 * payment legs: the primary remainder first, then one leg per split in order.
 *
 * @param requirements - Payment requirements to validate
 * @returns The payment legs
 * @throws SplitsError when the requirements violate §5.1 or §5.2
 */
export function parsePaymentLegs(requirements: PaymentRequirements): PaymentLeg[] {
  const extra = requirements.extra ?? {};
  const rawSplits = extra.splits ?? [];
  if (!Array.isArray(rawSplits)) {
    throw new SplitsError(Errors.ErrSplitsInvalid, "extra.splits must be an array");
  }
  if (rawSplits.length > MAX_SPLITS) {
    throw new SplitsError(Errors.ErrSplitsInvalid, `extra.splits allows at most ${MAX_SPLITS}`);
  }
  if (extra.ataCreationRequired !== undefined && typeof extra.ataCreationRequired !== "boolean") {
    throw new SplitsError(Errors.ErrSplitsInvalid, "extra.ataCreationRequired must be a boolean");
  }

  const total = parseAmount(requirements.amount, "amount");
  const seen = new Set<string>([requirements.payTo]);
  const splitLegs: PaymentLeg[] = [];
  let splitTotal = 0n;

  rawSplits.forEach((raw: unknown, i: number) => {
    const field = `extra.splits[${i}]`;
    if (typeof raw !== "object" || raw === null) {
      throw new SplitsError(Errors.ErrSplitsInvalid, `${field} must be an object`);
    }
    const split = raw as Record<string, unknown>;
    if (typeof split.payTo !== "string" || !validateSvmAddress(split.payTo)) {
      throw new SplitsError(Errors.ErrSplitsInvalid, `${field}.payTo is not a valid address`);
    }
    if (seen.has(split.payTo)) {
      throw new SplitsError(Errors.ErrSplitsInvalid, `${field}.payTo duplicates another recipient`);
    }
    seen.add(split.payTo);
    const amount = parseAmount(split.amount, `${field}.amount`);
    if (split.memo !== undefined) {
      if (typeof split.memo !== "string") {
        throw new SplitsError(Errors.ErrSplitsInvalid, `${field}.memo must be a string`);
      }
      if (new TextEncoder().encode(split.memo).byteLength > MAX_SPLIT_MEMO_BYTES) {
        throw new SplitsError(
          Errors.ErrSplitsInvalid,
          `${field}.memo exceeds ${MAX_SPLIT_MEMO_BYTES} bytes`,
        );
      }
    }
    if (split.ataCreationRequired !== undefined && typeof split.ataCreationRequired !== "boolean") {
      throw new SplitsError(
        Errors.ErrSplitsInvalid,
        `${field}.ataCreationRequired must be a boolean`,
      );
    }
    splitTotal += amount;
    splitLegs.push({
      owner: split.payTo,
      amount,
      isPrimary: false,
      ataCreationRequired: split.ataCreationRequired === true,
    });
  });

  if (splitTotal >= total) {
    throw new SplitsError(Errors.ErrSplitRemainderNotPositive);
  }

  return [
    {
      owner: requirements.payTo,
      amount: total - splitTotal,
      isPrimary: true,
      ataCreationRequired: extra.ataCreationRequired === true,
    },
    ...splitLegs,
  ];
}

/**
 * Split capabilities a facilitator advertises in `/supported` `kinds[].extra`.
 * Both fail closed: absent means no support (§5.5).
 */
export type SplitCapabilities = {
  maxSplits: number;
  ataCreationSponsored: boolean;
};

/**
 * Reads the split capabilities from a `/supported` kind's `extra`.
 *
 * @param extra - The kind's `extra` object
 * @returns The advertised capabilities, defaulting to none
 */
export function getSplitCapabilities(
  extra: Record<string, unknown> | undefined,
): SplitCapabilities {
  const maxSplits = extra?.maxSplits;
  return {
    maxSplits:
      typeof maxSplits === "number" && Number.isInteger(maxSplits) && maxSplits > 0
        ? Math.min(maxSplits, MAX_SPLITS)
        : 0,
    ataCreationSponsored: extra?.ataCreationSponsored === true,
  };
}

/**
 * Checks parsed legs against advertised capabilities.
 *
 * @param legs - Legs from {@link parsePaymentLegs}
 * @param capabilities - What the facilitator advertises
 * @throws SplitsError when the legs exceed the capabilities
 */
export function assertWithinCapabilities(
  legs: readonly PaymentLeg[],
  capabilities: SplitCapabilities,
): void {
  const splitCount = legs.length - 1;
  if (splitCount > capabilities.maxSplits) {
    throw new SplitsError(
      Errors.ErrSplitCountExceeded,
      `${splitCount} splits, facilitator accepts ${capabilities.maxSplits}`,
    );
  }
  if (!capabilities.ataCreationSponsored && legs.some(leg => leg.ataCreationRequired)) {
    throw new SplitsError(
      Errors.ErrSplitAtaCreationNotAuthorized,
      "a recipient is marked ataCreationRequired but the facilitator does not sponsor ATA creation",
    );
  }
}

/**
 * Derives a leg owner's ATA for the asset under one token program.
 *
 * @param owner - Wallet that owns the ATA
 * @param mint - Token mint
 * @param tokenProgram - SPL Token or Token-2022
 * @returns The ATA address
 */
export async function deriveAta(
  owner: string,
  mint: string,
  tokenProgram: string,
): Promise<string> {
  const [ata] = await findAssociatedTokenPda({
    owner: owner as Address,
    mint: mint as Address,
    tokenProgram: tokenProgram as Address,
  });
  return ata.toString();
}

/**
 * Minimal instruction view; matches both decompiled kit instructions and the
 * smart-wallet module's DecodedInstructionView.
 */
type InstructionView = {
  programAddress: { toString(): string };
  accounts?: ReadonlyArray<{ address: { toString(): string } }>;
  data?: { readonly [index: number]: number; readonly length: number };
};

/**
 * Whether an instruction targets the Associated Token Account program.
 *
 * @param ix - Instruction to inspect
 * @returns True for any ATA program instruction
 */
export function isAtaProgramInstruction(ix: InstructionView): boolean {
  return ix.programAddress.toString() === ASSOCIATED_TOKEN_PROGRAM_ADDRESS;
}

/**
 * Validates an ATA-program instruction against §5.4 and §2.1.1: it must be a
 * `CreateIdempotent` funded by the fee payer that creates the ATA, for the
 * asset, of a recipient marked `ataCreationRequired`, at most once per owner.
 *
 * @param ix - ATA program instruction
 * @param ctx - Validation context
 * @param ctx.asset - Required mint
 * @param ctx.feePayer - Facilitator fee payer, the only allowed funding payer
 * @param ctx.markedOwners - Owners marked `ataCreationRequired`
 * @param ctx.createdOwners - Owners already created in this transaction (mutated)
 * @param ctx.tokenProgram - Token program the transfers use, when known
 * @returns The owner and token program of the created ATA
 * @throws SplitsError when the instruction is not an authorized creation
 */
export async function validateAtaCreation(
  ix: InstructionView,
  ctx: {
    asset: string;
    feePayer: string;
    markedOwners: ReadonlySet<string>;
    createdOwners: Set<string>;
    tokenProgram?: string;
  },
): Promise<{ owner: string; tokenProgram: string }> {
  const reject = (detail: string): never => {
    throw new SplitsError(Errors.ErrSplitAtaCreationNotAuthorized, detail);
  };
  const data = ix.data;
  if (!data || data.length !== 1 || data[0] !== IX_CREATE_IDEMPOTENT) {
    reject("ATA program instruction is not CreateIdempotent");
  }
  const accounts = (ix.accounts ?? []).map(a => a.address.toString());
  if (accounts.length !== 6) {
    reject("CreateIdempotent must have exactly 6 accounts");
  }
  const [payer, ata, owner, mint, systemProgram, tokenProgram] = accounts;
  if (payer !== ctx.feePayer) {
    reject("CreateIdempotent must be funded by the fee payer");
  }
  if (!ctx.markedOwners.has(owner)) {
    reject(`owner ${owner} is not a recipient marked ataCreationRequired`);
  }
  if (ctx.createdOwners.has(owner)) {
    reject(`duplicate CreateIdempotent for owner ${owner}`);
  }
  if (mint !== ctx.asset) {
    reject("CreateIdempotent mint does not match asset");
  }
  if (systemProgram !== SYSTEM_PROGRAM_ADDRESS || !TOKEN_PROGRAMS.has(tokenProgram)) {
    reject("CreateIdempotent has unexpected program accounts");
  }
  if (ctx.tokenProgram && tokenProgram !== ctx.tokenProgram) {
    reject("CreateIdempotent token program differs from the transfers'");
  }
  if (ata !== (await deriveAta(owner, ctx.asset, tokenProgram))) {
    reject("CreateIdempotent account is not the owner's ATA");
  }
  ctx.createdOwners.add(owner);
  return { owner, tokenProgram };
}

/**
 * Fee payer isolation with the bounded §2.1.1 exception: inside a validated
 * `CreateIdempotent`, the fee payer may be the funding payer (account 0) and,
 * when it is itself a recipient, the wallet owner (account 2). It must not
 * appear anywhere else or be invoked as a program.
 *
 * @param instructions - Top-level instructions (ALT-resolved)
 * @param feePayer - Facilitator fee payer
 * @param ctx - ATA creation context, see {@link validateAtaCreation}
 * @param ctx.asset - Required mint
 * @param ctx.markedOwners - Owners marked `ataCreationRequired`
 * @param ctx.tokenProgram - Token program the transfers use, when known
 * @returns The owners whose ATAs the transaction creates
 * @throws SplitsError or Error when isolation is violated
 */
export async function assertFeePayerIsolatedWithAtaCreation(
  instructions: ReadonlyArray<InstructionView>,
  feePayer: string,
  ctx: { asset: string; markedOwners: ReadonlySet<string>; tokenProgram?: string },
): Promise<Set<string>> {
  const createdOwners = new Set<string>();
  for (const ix of instructions) {
    if (ix.programAddress.toString() === feePayer) {
      throw new Error(
        `${Errors.ErrSmartWalletFeePayerNotIsolated}: fee payer ${feePayer} invoked as program`,
      );
    }
    const accounts = (ix.accounts ?? []).map(a => a.address.toString());
    if (isAtaProgramInstruction(ix)) {
      await validateAtaCreation(ix, { ...ctx, feePayer, createdOwners });
      // Account 0 is the fee payer by construction; account 2 may be the fee
      // payer only as a recipient's owner. Accounts 1, 3, 4, 5 are the ATA,
      // mint and programs, none of which can be the fee payer here.
      continue;
    }
    if (accounts.includes(feePayer)) {
      throw new Error(
        `${Errors.ErrSmartWalletFeePayerNotIsolated}: fee payer ${feePayer} appears in instruction accounts (program: ${ix.programAddress})`,
      );
    }
  }
  return createdOwners;
}

/**
 * A TransferChecked observed in a transaction or its CPI trace.
 */
export type ObservedTransfer = {
  programId: string;
  amount: bigint;
  mint: string;
  destination: string;
  authority: string;
};

/**
 * A leg with the ATAs it may be paid to (one per token program).
 */
export type LegDestinations = PaymentLeg & { atas: Set<string> };

/**
 * Derives both token-program ATAs for every leg.
 *
 * @param legs - Payment legs
 * @param asset - Token mint
 * @returns Legs annotated with their candidate destination ATAs
 */
export async function deriveLegDestinations(
  legs: readonly PaymentLeg[],
  asset: string,
): Promise<LegDestinations[]> {
  return Promise.all(
    legs.map(async leg => ({
      ...leg,
      atas: new Set(
        await Promise.all([...TOKEN_PROGRAMS].map(program => deriveAta(leg.owner, asset, program))),
      ),
    })),
  );
}

/**
 * Whether a transfer pays a leg: right destination, and the primary's amount
 * at least the remainder or a split's amount exactly its carve-out.
 *
 * @param transfer - Observed transfer
 * @param leg - Leg with candidate ATAs
 * @returns True when the transfer satisfies the leg
 */
export function transferPaysLeg(transfer: ObservedTransfer, leg: LegDestinations): boolean {
  if (!leg.atas.has(transfer.destination)) return false;
  return leg.isPrimary ? transfer.amount >= leg.amount : transfer.amount === leg.amount;
}

/**
 * Matches every `asset` transfer to exactly one leg and every leg to exactly
 * one transfer (§5.3, §5.5). Transfers of other mints are ignored.
 *
 * @param transfers - All observed transfers (top-level and CPI)
 * @param legs - Legs with candidate ATAs
 * @param asset - Required mint
 * @returns The transfer matched to each leg, in leg order
 * @throws SplitsError or Error naming the violated rule
 */
export function matchTransfersToLegs(
  transfers: readonly ObservedTransfer[],
  legs: readonly LegDestinations[],
  asset: string,
): ObservedTransfer[] {
  const matched: (ObservedTransfer | undefined)[] = legs.map(() => undefined);
  for (const transfer of transfers) {
    if (transfer.mint !== asset) continue;
    const legIndex = legs.findIndex(leg => transferPaysLeg(transfer, leg));
    if (legIndex === -1) {
      throw new SplitsError(
        Errors.ErrSplitUnexpectedTransfer,
        `transfer of ${transfer.amount} to ${transfer.destination} matches no leg`,
      );
    }
    if (matched[legIndex]) {
      throw new Error(Errors.ErrSmartWalletMultipleMatchingTransfers);
    }
    matched[legIndex] = transfer;
  }
  const missing = matched.findIndex(t => t === undefined);
  if (missing !== -1) {
    throw new SplitsError(Errors.ErrSplitLegUnmatched, `no transfer pays ${legs[missing].owner}`);
  }
  return matched as ObservedTransfer[];
}
