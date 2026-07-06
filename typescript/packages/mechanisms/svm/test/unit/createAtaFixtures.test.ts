import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCreateAtaIdempotentInstruction } from "../../src/exact/createAta";

/**
 * Byte-fixture suite for the optional index-2 CreateAssociatedTokenIdempotent
 * instruction (#2395 / #2798).
 *
 * Fixture sets (both contributed on the PR under Apache-2.0, SPDX headers kept
 * inside the JSON files):
 * - ata-create-fixtures.json — chopmob-cloud: 1 ACCEPT + 3 REJECT (SPL Token)
 * - ata-create-fixtures-token2022.json — DrVelvetFog: 1 ACCEPT + 1 REJECT
 *   driving the token-program derivation seed (PYUSD, a live Token-2022 mint)
 *
 * Each fixture is evaluated against the FULL static-path pin set: the shared
 * validator (`validateCreateAtaIdempotentInstruction`) plus the two caller
 * pins the facilitator applies after parsing the transfer —
 * tokenProgram == the transfer's token program and ata == the transfer
 * destination. neg-02 (tampered destination) intentionally passes the isolated
 * validator — that function never reads `account[1]` — and only rejects at the
 * caller's destination pin, exercising the transitive guard
 * (ata == transfer destination == derived ATA). Pointing it at the validator
 * alone would read as a false accept.
 */

type Fixture = {
  id: string;
  description: string;
  instruction: {
    program_id: string;
    data_b64: string;
    accounts: Array<{ pubkey: string }>;
  };
  expected_verdict: "ACCEPT" | "REJECT";
};

type FixtureFile = {
  context: {
    payTo: string;
    payment_mint: string;
    transfer_token_program: string;
    fee_payer: string;
    transfer_destination: string;
  };
  fixtures: Fixture[];
};

/** Reason each REJECT fixture must fail with, against the real error codes. */
const EXPECTED_REASONS: Record<string, string> = {
  "fixture-neg-01-legacy-create": "invalid_exact_svm_payload_create_ata_not_idempotent",
  "fixture-neg-02-tampered-destination":
    "invalid_exact_svm_payload_create_ata_destination_mismatch",
  "fixture-neg-03-sender-funder": "invalid_exact_svm_payload_create_ata_funder_mismatch",
  "fixture-neg-04-cross-program-create":
    "invalid_exact_svm_payload_create_ata_token_program_mismatch",
};

function loadFixtureFile(name: string): FixtureFile {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as FixtureFile;
}

/** Adapt a JSON fixture instruction to the validator's decompiled-instruction shape. */
function toInstruction(fixture: Fixture) {
  return {
    programAddress: { toString: () => fixture.instruction.program_id },
    accounts: fixture.instruction.accounts.map(account => ({
      address: { toString: () => account.pubkey },
    })),
    data: Uint8Array.from(Buffer.from(fixture.instruction.data_b64, "base64")),
  };
}

/**
 * Run the full static-path pin set: shared validator, then the facilitator's
 * caller pins (token program == transfer's, ata == transfer destination).
 */
function verdictFor(
  fixture: Fixture,
  context: FixtureFile["context"],
): { verdict: "ACCEPT" | "REJECT"; reason?: string } {
  const result = validateCreateAtaIdempotentInstruction(toInstruction(fixture), {
    payTo: context.payTo,
    asset: context.payment_mint,
    feePayer: context.fee_payer,
  });
  if ("invalidReason" in result) {
    return { verdict: "REJECT", reason: result.invalidReason };
  }
  if (result.tokenProgram !== context.transfer_token_program) {
    return {
      verdict: "REJECT",
      reason: "invalid_exact_svm_payload_create_ata_token_program_mismatch",
    };
  }
  if (result.ata !== context.transfer_destination) {
    return {
      verdict: "REJECT",
      reason: "invalid_exact_svm_payload_create_ata_destination_mismatch",
    };
  }
  return { verdict: "ACCEPT" };
}

for (const file of ["ata-create-fixtures.json", "ata-create-fixtures-token2022.json"]) {
  describe(`byte fixtures: ${file}`, () => {
    const { context, fixtures } = loadFixtureFile(file);

    for (const fixture of fixtures) {
      it(`${fixture.id} — ${fixture.expected_verdict}`, () => {
        const { verdict, reason } = verdictFor(fixture, context);
        expect(verdict).toBe(fixture.expected_verdict);
        if (fixture.expected_verdict === "REJECT") {
          expect(reason).toBe(EXPECTED_REASONS[fixture.id]);
        }
      });
    }
  });
}
