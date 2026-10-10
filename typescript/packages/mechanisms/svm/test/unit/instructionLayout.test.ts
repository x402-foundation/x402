import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS } from "../../src/constants";
import * as Errors from "../../src/exact/facilitator/errors";
import {
  resolveProtocolLayout,
  type InstructionTuple,
} from "../../src/exact/facilitator/instructionLayout";
import type { DecodedInstructionView } from "../../src/exact/facilitator/smartWalletVerification";

const FEE_PAYER = "FeePayer1111111111111111111111111111111111";
const SETUP = "Setup11111111111111111111111111111111111111";
const FINISH = "Finish1111111111111111111111111111111111111";

const ix = (
  programAddress: string,
  data: number[] = [],
  accounts: string[] = [],
): DecodedInstructionView => ({
  programAddress,
  data: new Uint8Array(data),
  accounts: accounts.map(address => ({ address })),
});

const limit = ix(COMPUTE_BUDGET_PROGRAM_ADDRESS, [2, 0, 0, 0, 0]);
const price = ix(COMPUTE_BUDGET_PROGRAM_ADDRESS, [3, 0, 0, 0, 0, 0, 0, 0, 0]);
const transfer = ix(TOKEN_PROGRAM_ADDRESS, [12, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
const memo = ix(MEMO_PROGRAM_ADDRESS, [0x61]);
const guard = ix(LIGHTHOUSE_PROGRAM_ADDRESS, [1]);
const protocol = [limit, price, transfer];

const layout = (
  instructions: DecodedInstructionView[],
  allowlists: {
    preflightInstructionAllowlist?: InstructionTuple[];
    postflightInstructionAllowlist?: InstructionTuple[];
  } = {},
) => resolveProtocolLayout(instructions, allowlists, FEE_PAYER);
const reason = (result: object) => ("errorReason" in result ? result.errorReason : undefined);

describe("resolveProtocolLayout", () => {
  it("finds protocol instructions regardless of guard placement", () => {
    const result = layout([guard, limit, guard, price, transfer, guard, memo]);
    expect(result).toMatchObject({ memoCount: 1 });
  });

  it("tolerates multiple memos and reports the count", () => {
    expect(layout([...protocol, memo, memo])).toMatchObject({ memoCount: 2 });
  });

  it.each([
    ["wrong compute budget discriminator", ix(COMPUTE_BUDGET_PROGRAM_ADDRESS, [9])],
    ["compute budget with no data", ix(COMPUTE_BUDGET_PROGRAM_ADDRESS)],
    [
      "non-TransferChecked token instruction",
      ix(TOKEN_PROGRAM_ADDRESS, [3, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
    ],
    ["truncated TransferChecked", ix(TOKEN_PROGRAM_ADDRESS, [12])],
    ["unrecognized program", ix(SETUP, [1])],
  ])("rejects %s as unknown", (_name, bad) => {
    expect(reason(layout([...protocol, bad]))).toBe(Errors.ErrUnknownInstruction);
  });

  it.each([
    ["memo before transfer", [limit, price, memo, transfer]],
    ["duplicate transfer", [...protocol, transfer]],
    ["duplicate compute limit", [limit, limit, price, transfer]],
    ["price before limit", [price, limit, transfer]],
    ["transfer after memo", [...protocol, memo, transfer]],
    ["transfer without compute budget", [transfer]],
  ])("rejects %s as out of order", (_name, instructions) => {
    expect(reason(layout(instructions))).toBe(Errors.ErrProtocolInstructionOrder);
  });

  it.each([
    ["empty", []],
    ["missing transfer", [limit, price]],
    ["only guards", [guard]],
  ])("reports a missing transfer for %s", (_name, instructions) => {
    expect(reason(layout(instructions))).toBe(Errors.ErrNoTransferInstruction);
  });

  describe("allowlists", () => {
    const tuple = (programAddress: string, ...discriminator: number[]): InstructionTuple => [
      { programAddress, discriminator: new Uint8Array(discriminator) },
    ];
    const setupTuple = tuple(SETUP, 0xaa);
    const finishTuple = tuple(FINISH, 0xbb);
    const setup = (...accounts: string[]) => ix(SETUP, [0xaa, 1], accounts);
    const finish = (...accounts: string[]) => ix(FINISH, [0xbb], accounts);

    it("accepts preflight and postflight blocks together, and nothing without an allowlist", () => {
      const instructions = [setup(), ...protocol, finish()];
      const allowlists = {
        preflightInstructionAllowlist: [setupTuple],
        postflightInstructionAllowlist: [finishTuple],
      };
      expect(reason(layout(instructions, allowlists))).toBeUndefined();
      expect(reason(layout(instructions))).toBe(Errors.ErrUnknownInstruction);
    });

    it("does not match a block on the wrong side or with the wrong discriminator", () => {
      expect(
        reason(layout([...protocol, setup()], { preflightInstructionAllowlist: [setupTuple] })),
      ).toBe(Errors.ErrUnknownInstruction);
      expect(
        reason(
          layout([setup(), ...protocol], { preflightInstructionAllowlist: [tuple(SETUP, 0xff)] }),
        ),
      ).toBe(Errors.ErrUnknownInstruction);
    });

    it("matches multi-instruction tuples with guards interspersed and long discriminators", () => {
      const long = [1, 2, 3, 4, 5, 6, 7, 8];
      const both = [...tuple(SETUP, ...long), ...tuple(FINISH, 0xbb)];
      const instructions = [ix(SETUP, [...long, 9]), guard, finish(), ...protocol];
      expect(
        reason(layout(instructions, { preflightInstructionAllowlist: [both] })),
      ).toBeUndefined();
    });

    it.each([
      [
        "preflight",
        [setup(FEE_PAYER), ...protocol],
        { preflightInstructionAllowlist: [setupTuple] },
      ],
      [
        "postflight",
        [...protocol, finish(FEE_PAYER)],
        { postflightInstructionAllowlist: [finishTuple] },
      ],
      [
        "interspersed guard",
        [ix(LIGHTHOUSE_PROGRAM_ADDRESS, [1], [FEE_PAYER]), setup(), ...protocol],
        { preflightInstructionAllowlist: [setupTuple] },
      ],
    ])("rejects a matched %s block that references the fee payer", (_name, instructions, lists) => {
      expect(reason(layout(instructions, lists))).toBe(
        Errors.ErrPreflightPostflightFeePayerNotIsolated,
      );
    });

    it.each([
      ["empty tuple", []],
      ["empty discriminator", tuple(SETUP)],
    ])("fails closed on an %s", (_name, bad) => {
      expect(reason(layout([setup(), ...protocol], { preflightInstructionAllowlist: [bad] }))).toBe(
        Errors.ErrUnknownInstruction,
      );
    });
  });
});
