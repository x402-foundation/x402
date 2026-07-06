import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";

/** The System Program, pinned as `account[4]` of a create-ATA instruction. */
export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

/**
 * Single-byte instruction discriminator for CreateAssociatedTokenIdempotent.
 * The legacy non-idempotent Create carries empty data (and a 7-account layout
 * including the rent sysvar), so pinning the data to exactly this byte is what
 * rejects a non-idempotent create being slipped into the same slot.
 */
export const CREATE_ATA_IDEMPOTENT_DISCRIMINATOR = 1;

/**
 * Minimal structural view of a decompiled instruction, shared by the v1 and v2
 * facilitator schemes (whose concrete instruction types differ only in generics).
 */
export type DecompiledInstructionLike = {
  programAddress: { toString(): string };
  accounts?: ReadonlyArray<{ address: { toString(): string } }>;
  data?: Readonly<Uint8Array>;
};

/**
 * Whether an instruction targets the Associated Token Account program.
 *
 * @param instruction - A decompiled top-level instruction
 * @returns True when the instruction's program is the ATA program
 */
export function isAssociatedTokenProgramInstruction(
  instruction: DecompiledInstructionLike,
): boolean {
  return instruction.programAddress.toString() === ASSOCIATED_TOKEN_PROGRAM_ADDRESS.toString();
}

/**
 * Accounts of a validated CreateAssociatedTokenIdempotent instruction that the
 * caller must additionally pin against the parsed TransferChecked instruction:
 * `ata` must equal the transfer destination (which the static path already
 * requires to be the ATA derived from payTo/tokenProgram/mint), and
 * `tokenProgram` must equal the transfer's token program. The token program is
 * an ATA derivation seed, so without that last pin a Token-2022 create could
 * point the rent at a different derived address than the one being paid.
 */
export type CreateAtaAccounts = {
  ata: string;
  tokenProgram: string;
};

/**
 * Statically validate an optional CreateAssociatedTokenIdempotent instruction
 * at index 2 of an exact-SVM payment transaction (see #2395).
 *
 * The fee payer (facilitator) funds the rent in the gasless flow, so every
 * degree of freedom must be pinned or a client could make the facilitator
 * rent-fund an arbitrary (owner, mint) ATA unrelated to the payment:
 *
 * - data == exactly the single idempotent discriminator byte `0x01`
 * - exactly six accounts: [funder, ata, owner, mint, systemProgram, tokenProgram]
 * - funder  == requirements.extra.feePayer
 * - owner   == requirements.payTo
 * - mint    == requirements.asset
 * - systemProgram == the System Program
 * - tokenProgram  ∈ {Token, Token-2022}
 *
 * @param instruction - The decompiled instruction at index 2
 * @param expected - Pinned values from the payment requirements
 * @param expected.payTo - The payment recipient (ATA owner)
 * @param expected.asset - The payment mint
 * @param expected.feePayer - The facilitator fee payer funding the rent
 * @returns The `{ ata, tokenProgram }` accounts on success, or an
 *   `invalidReason` string when any pin fails
 */
export function validateCreateAtaIdempotentInstruction(
  instruction: DecompiledInstructionLike,
  expected: { payTo: string; asset: string; feePayer: string },
): CreateAtaAccounts | { invalidReason: string } {
  const data = instruction.data;
  if (!data || data.length !== 1 || data[0] !== CREATE_ATA_IDEMPOTENT_DISCRIMINATOR) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_not_idempotent" };
  }

  const accounts = instruction.accounts ?? [];
  if (accounts.length !== 6) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_account_count" };
  }

  const [funder, ata, owner, mint, systemProgram, tokenProgram] = accounts.map(account =>
    account.address.toString(),
  );

  if (funder !== expected.feePayer) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_funder_mismatch" };
  }
  if (owner !== expected.payTo) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_owner_mismatch" };
  }
  if (mint !== expected.asset) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_mint_mismatch" };
  }
  if (systemProgram !== SYSTEM_PROGRAM_ADDRESS) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_system_program_mismatch" };
  }
  if (
    tokenProgram !== TOKEN_PROGRAM_ADDRESS.toString() &&
    tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS.toString()
  ) {
    return { invalidReason: "invalid_exact_svm_payload_create_ata_token_program_mismatch" };
  }

  return { ata, tokenProgram };
}
