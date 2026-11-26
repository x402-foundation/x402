import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS } from "../../constants";
import { TOKEN_PROGRAMS } from "../splits";
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
 * Identifies an instruction's role by program ID and discriminator.
 * A Lighthouse guard may appear anywhere. Verifiers check the payload.
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
  } else if (TOKEN_PROGRAMS.has(program)) {
    if (discriminator === IX_TOKEN_TRANSFER_CHECKED && (ix.data?.length ?? 0) >= 10) {
      return "transfer";
    }
  } else if (program === MEMO_PROGRAM_ADDRESS) {
    return "memo";
  } else if (
    program === LIGHTHOUSE_PROGRAM_ADDRESS &&
    discriminator !== undefined &&
    discriminator >= 2 &&
    discriminator <= 17
  ) {
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

/** Ordered instructions allowed before or after the protocol instructions. */
export type InstructionTuple = InstructionIdentity[];

/**
 * Matches `tuple` against the front or back of `instructions`.
 *
 * @param instructions - Instructions to match against
 * @param tuple - Identities to match, in order
 * @param fromEnd - Match against the back instead of the front
 * @returns The matched instructions and the rest, or null
 */
function matchTuple(
  instructions: readonly Ix[],
  tuple: InstructionTuple,
  fromEnd: boolean,
): { matched: Ix[]; rest: Ix[] } | null {
  if (tuple.length === 0 || instructions.length < tuple.length) return null;
  const start = fromEnd ? instructions.length - tuple.length : 0;
  const matched = instructions.slice(start, start + tuple.length);
  for (let i = 0; i < tuple.length; i++) {
    const ix = matched[i];
    const { programAddress, discriminator } = tuple[i];
    const data = ix.data;
    const matches =
      discriminator.length > 0 &&
      ix.programAddress.toString() === programAddress &&
      !!data &&
      discriminator.every((byte, index) => data[index] === byte);
    if (!matches) return null;
  }
  return {
    matched,
    rest: fromEnd ? instructions.slice(0, start) : instructions.slice(start + tuple.length),
  };
}

/**
 * Validates Lighthouse assertion guards and removes them from the protocol sequence.
 *
 * @param instructions - Top-level instructions
 * @param feePayerAddress - Sponsor address that guards must not reference
 * @returns The non-guard instructions, or the guard-policy error
 */
export function stripAssertionGuards<T extends Ix>(
  instructions: readonly T[],
  feePayerAddress: string,
): T[] | { errorReason: string } {
  // Validate all Lighthouse instructions before stripping tuples or returning a
  // recoverable layout error, including ones explicitly configured in an allowlist.
  for (const ix of instructions) {
    if (ix.programAddress.toString() !== LIGHTHOUSE_PROGRAM_ADDRESS) continue;
    if (classify(ix) !== "guard") {
      return { errorReason: Errors.ErrInvalidLighthouseInstruction };
    }
    try {
      assertFeePayerIsolatedFromInstructions([ix], feePayerAddress);
    } catch {
      return { errorReason: Errors.ErrFeePayerTransferringFunds };
    }
  }
  return instructions.filter(ix => classify(ix) !== "guard");
}

export type PartitionedInstructions = {
  computeLimitIx?: Ix;
  computePriceIx?: Ix;
  transferIx: Ix;
  /** First Memo instruction; `memoCount` is the total (only enforced when `extra.memo` is set). */
  memoIx?: Ix;
  memoCount: number;
};

/**
 * Strips Lighthouse guards, then one allowlisted preflight or postflight block.
 * ComputeLimit, ComputePrice, TransferChecked, and Memo must then follow that order.
 *
 * @param instructions - Decompiled top-level instructions
 * @param options - Scheme options; only the allowlists are read (empty/unset never match)
 * @param options.preflightInstructionAllowlist - Tuples allowed before the protocol instructions
 * @param options.postflightInstructionAllowlist - Tuples allowed after the protocol instructions
 * @param feePayerAddress - Facilitator fee payer that matched blocks must not reference
 * @param version - Transaction message version (v1 has no ComputeBudget prefix)
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
  version: number | string = 0,
): PartitionedInstructions | { errorReason: string } {
  const protocol = stripAssertionGuards(instructions, feePayerAddress);
  if ("errorReason" in protocol) return protocol;
  if (
    version === 1 &&
    instructions.some(
      ix => ix.programAddress.toString() === COMPUTE_BUDGET_PROGRAM_ADDRESS.toString(),
    )
  ) {
    return { errorReason: Errors.ErrTransactionV1ComputeBudgetInstruction };
  }
  let rest = protocol;
  for (const [tuples, fromEnd] of [
    [options?.preflightInstructionAllowlist, false],
    [options?.postflightInstructionAllowlist, true],
  ] as const) {
    for (const tuple of tuples ?? []) {
      const match = matchTuple(rest, tuple, fromEnd);
      if (!match) continue;
      if (
        match.matched.some(
          ix =>
            TOKEN_PROGRAMS.has(ix.programAddress.toString()) &&
            ix.data?.[0] === IX_TOKEN_TRANSFER_CHECKED,
        )
      ) {
        return { errorReason: Errors.ErrPreflightPostflightTransferNotAllowed };
      }
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
  let expectedIndex = version === 1 ? 2 : 0;
  for (const ix of rest) {
    const role = classify(ix);
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
  if ((version !== 1 && (!computeLimit || !computePrice)) || !transfer) {
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
