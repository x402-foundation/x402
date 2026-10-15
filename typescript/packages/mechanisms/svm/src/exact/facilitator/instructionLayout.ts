import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS } from "../../constants";
import * as Errors from "./errors";
import {
  assertFeePayerIsolatedFromInstructions,
  IX_SET_COMPUTE_UNIT_LIMIT,
  IX_SET_COMPUTE_UNIT_PRICE,
  IX_TOKEN_TRANSFER_CHECKED,
  type DecodedInstructionView,
} from "./smartWalletVerification";

type Ix = DecodedInstructionView;
type Role = "computeLimit" | "computePrice" | "transfer" | "memo" | "guard" | "unknown";

/** Protocol roles, in the fixed relative order they must appear. */
const PROTOCOL_ORDER = ["computeLimit", "computePrice", "transfer", "memo"] as const;

/**
 * Identifies an instruction's role by program ID and discriminator, not position.
 * `guard` (currently only Lighthouse) may appear anywhere. Payload validity is
 * checked separately by the per-instruction verifiers.
 *
 * @param ix - Decompiled instruction
 * @returns The instruction's role
 */
function classify(ix: Ix): Role {
  const program = ix.programAddress.toString();
  const discriminator = ix.data?.[0];
  if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS.toString()) {
    if (discriminator === IX_SET_COMPUTE_UNIT_LIMIT) return "computeLimit";
    if (discriminator === IX_SET_COMPUTE_UNIT_PRICE) return "computePrice";
  } else if (
    program === TOKEN_PROGRAM_ADDRESS.toString() ||
    program === TOKEN_2022_PROGRAM_ADDRESS.toString()
  ) {
    if (discriminator === IX_TOKEN_TRANSFER_CHECKED && (ix.data?.length ?? 0) >= 10) {
      return "transfer";
    }
  } else if (program === MEMO_PROGRAM_ADDRESS) {
    return "memo";
  } else if (program === LIGHTHOUSE_PROGRAM_ADDRESS) {
    return "guard";
  }
  return "unknown";
}

/**
 * Identifies an instruction by program ID and a non-empty discriminator that is
 * matched as a byte prefix of the instruction data (an empty discriminator
 * never matches, so a whole program can't be allowlisted by accident).
 */
export type InstructionIdentity = { programAddress: string; discriminator: Uint8Array };

/** An ordered block of instructions (guards aside) allowed before/after the protocol instructions. */
export type InstructionTuple = InstructionIdentity[];

/**
 * Matches `tuple` against the front (or back) of `instructions`, skipping guard
 * instructions while scanning.
 *
 * @param instructions - Instructions to match against
 * @param tuple - Identities to match, in order
 * @param fromEnd - Match against the back instead of the front
 * @returns The matched instructions (guards included) and the rest, or null
 */
function matchTuple(
  instructions: readonly Ix[],
  tuple: InstructionTuple,
  fromEnd: boolean,
): { matched: Ix[]; rest: Ix[] } | null {
  if (tuple.length === 0) return null;
  let consumed = 0;
  let matchedCount = 0;
  while (matchedCount < tuple.length) {
    const ix = instructions[fromEnd ? instructions.length - 1 - consumed : consumed];
    if (!ix) return null;
    if (classify(ix) !== "guard") {
      const { programAddress, discriminator } =
        tuple[fromEnd ? tuple.length - 1 - matchedCount : matchedCount];
      const data = ix.data;
      const matches =
        discriminator.length > 0 &&
        ix.programAddress.toString() === programAddress &&
        !!data &&
        discriminator.every((byte, i) => data[i] === byte);
      if (!matches) return null;
      matchedCount++;
    }
    consumed++;
  }
  const split = fromEnd ? instructions.length - consumed : consumed;
  return fromEnd
    ? { matched: instructions.slice(split), rest: instructions.slice(0, split) }
    : { matched: instructions.slice(0, split), rest: instructions.slice(split) };
}

export type PartitionedInstructions = {
  computeLimitIx: Ix;
  computePriceIx: Ix;
  transferIx: Ix;
  /** First Memo instruction; `memoCount` is the total (only enforced when `extra.memo` is set). */
  memoIx?: Ix;
  memoCount: number;
};

/**
 * Resolves the Path 1 layout: strips a matched allowlisted preflight block from
 * the front and postflight block from the back (each fee-payer-isolation-checked,
 * since it is operator-configured arbitrary code), then partitions the rest by
 * identity. Protocol instructions (ComputeLimit, ComputePrice, TransferChecked,
 * optional Memo(s)) must appear in that relative order; guards may appear
 * anywhere since they only assert/abort. Anything else, a duplicate or
 * out-of-order protocol instruction, or a missing transfer is rejected.
 *
 * @param instructions - Decompiled top-level instructions
 * @param options - Scheme options; only the allowlists are read (empty/unset never match)
 * @param options.preflightInstructionAllowlist - Tuples allowed before the protocol instructions
 * @param options.postflightInstructionAllowlist - Tuples allowed after the protocol instructions
 * @param feePayerAddress - Facilitator fee payer that matched blocks must not reference
 * @returns The protocol instructions, or the first error reason encountered
 */
export function resolveProtocolLayout(
  instructions: readonly Ix[],
  options:
    | {
        preflightInstructionAllowlist?: readonly InstructionTuple[];
        postflightInstructionAllowlist?: readonly InstructionTuple[];
      }
    | undefined,
  feePayerAddress: string,
): PartitionedInstructions | { errorReason: string } {
  let rest = instructions;
  for (const [tuples, fromEnd] of [
    [options?.preflightInstructionAllowlist, false],
    [options?.postflightInstructionAllowlist, true],
  ] as const) {
    for (const tuple of tuples ?? []) {
      const match = matchTuple(rest, tuple, fromEnd);
      if (!match) continue;
      try {
        assertFeePayerIsolatedFromInstructions(match.matched, feePayerAddress);
      } catch {
        return { errorReason: Errors.ErrPreflightPostflightFeePayerNotIsolated };
      }
      rest = match.rest;
      break;
    }
  }

  const found: Partial<Record<Role, Ix>> = {};
  let memoCount = 0;
  let expectedIndex = 0;
  for (const ix of rest) {
    const role = classify(ix);
    if (role === "guard") continue;
    if (role === "unknown") return { errorReason: Errors.ErrUnknownInstruction };
    if (role === "memo" && found.memo) {
      memoCount++;
      continue;
    }
    if (role !== PROTOCOL_ORDER[expectedIndex]) {
      return { errorReason: Errors.ErrProtocolInstructionOrder };
    }
    found[role] = ix;
    expectedIndex++;
    if (role === "memo") memoCount = 1;
  }

  const { computeLimit, computePrice, transfer, memo } = found;
  if (!computeLimit || !computePrice || !transfer) {
    return { errorReason: Errors.ErrNoTransferInstruction };
  }
  return {
    computeLimitIx: computeLimit,
    computePriceIx: computePrice,
    transferIx: transfer,
    memoIx: memo,
    memoCount,
  };
}
