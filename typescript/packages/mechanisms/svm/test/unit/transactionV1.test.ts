/**
 * Unit coverage for the shared version-1 helpers: config reading, budget
 * policy, the version-neutral instruction view, and client-side builders.
 */
import { createTransactionMessage } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { COMPUTE_BUDGET_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS } from "../../src/constants";
import {
  applyTransactionV1Config,
  checkTransactionV1Budget,
  computeBudgetInstructions,
  DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  getCompiledInstructions,
  maxTransactionSize,
  priorityFeeLamports,
  readTransactionV1Config,
  type TransactionV1Config,
} from "../../src/transactionV1";

const LIMITS = { maxComputeUnits: 200_000, maxPriceMicroLamports: 5_000_000 };
const VALID: TransactionV1Config = {
  mask: 0b1111,
  priorityFeeLamports: 1n,
  computeUnitLimit: 20_000,
  loadedAccountsDataSizeLimit: DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
};

describe("maxTransactionSize", () => {
  it("is 4096 bytes for version 1 and 1232 for legacy and version 0", () => {
    expect(maxTransactionSize(1)).toBe(4096);
    expect(maxTransactionSize(0)).toBe(1232);
    expect(maxTransactionSize("legacy")).toBe(1232);
  });
});

describe("priorityFeeLamports", () => {
  it("rounds the total fee up and is zero for a zero price", () => {
    expect(priorityFeeLamports(20_000, 1)).toBe(1n);
    expect(priorityFeeLamports(1_000_000, 1)).toBe(1n);
    expect(priorityFeeLamports(1_000_001, 1)).toBe(2n);
    expect(priorityFeeLamports(20_000, 0)).toBe(0n);
  });
});

describe("computeBudgetInstructions", () => {
  it("emits the limit then the price on version 0, omitting zero values", () => {
    const both = computeBudgetInstructions(0, {
      computeUnitLimit: 20_000,
      computeUnitPriceMicroLamports: 1,
    });
    expect(both.map(ix => ix.data?.[0])).toEqual([2, 3]);
    expect(
      computeBudgetInstructions(0, { computeUnitLimit: 0, computeUnitPriceMicroLamports: 0 }),
    ).toEqual([]);
  });

  it("emits nothing on version 1", () => {
    expect(
      computeBudgetInstructions(1, { computeUnitLimit: 20_000, computeUnitPriceMicroLamports: 1 }),
    ).toEqual([]);
  });
});

describe("applyTransactionV1Config", () => {
  it("leaves a version-0 message unchanged", () => {
    const message = createTransactionMessage({ version: 0 });
    expect(
      applyTransactionV1Config(
        0,
        { computeUnitLimit: 0, computeUnitPriceMicroLamports: 0 },
        message,
      ),
    ).toBe(message);
  });

  it("sets both limits on version 1 and omits a zero fee", () => {
    const message = applyTransactionV1Config(
      1,
      { computeUnitLimit: 20_000, computeUnitPriceMicroLamports: 0 },
      createTransactionMessage({ version: 1 }),
    ) as { config?: Record<string, unknown> };
    expect(message.config).toEqual({
      computeUnitLimit: 20_000,
      loadedAccountsDataSizeLimit: DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    });
  });

  it.each([0, -1, 1.5])("refuses a version-1 compute unit limit of %s", limit => {
    expect(() =>
      applyTransactionV1Config(
        1,
        { computeUnitLimit: limit, computeUnitPriceMicroLamports: 1 },
        createTransactionMessage({ version: 1 }),
      ),
    ).toThrow(/positive computeUnitLimit/);
  });
});

describe("getCompiledInstructions", () => {
  it("joins version-1 headers and payloads", () => {
    const data = new Uint8Array([1]);
    expect(
      getCompiledInstructions({
        version: 1,
        instructionHeaders: [{ programAccountIndex: 2 }],
        instructionPayloads: [{ instructionAccountIndices: [1], instructionData: data }],
      }),
    ).toEqual([{ programAddressIndex: 2, accountIndices: [1], data }]);
  });

  it("refuses version-1 headers and payloads of different lengths", () => {
    expect(() =>
      getCompiledInstructions({
        version: 1,
        instructionHeaders: [{ programAccountIndex: 2 }],
        instructionPayloads: [],
      }),
    ).toThrow(/differ in length/);
  });

  it("reads a version-0 instruction list, defaulting missing account indices", () => {
    expect(
      getCompiledInstructions({ version: 0, instructions: [{ programAddressIndex: 3 }] }),
    ).toEqual([{ programAddressIndex: 3, accountIndices: [], data: undefined }]);
    expect(getCompiledInstructions({ version: 1 })).toEqual([]);
    expect(getCompiledInstructions({ version: 0 })).toEqual([]);
  });
});

describe("readTransactionV1Config", () => {
  it("reads values in mask bit order", () => {
    expect(
      readTransactionV1Config({
        configMask: 0b11111,
        configValues: [
          { kind: "u64", value: 7n },
          { kind: "u32", value: 20_000 },
          { kind: "u32", value: 65_536 },
          { kind: "u32", value: 32_768 },
        ],
      }),
    ).toEqual({
      mask: 0b11111,
      priorityFeeLamports: 7n,
      computeUnitLimit: 20_000,
      loadedAccountsDataSizeLimit: 65_536,
      heapSize: 32_768,
    });
  });

  it("reads a set bit whose value is missing as zero", () => {
    expect(readTransactionV1Config({ configMask: 0b11111, configValues: [] })).toEqual({
      mask: 0b11111,
      priorityFeeLamports: 0n,
      computeUnitLimit: 0,
      loadedAccountsDataSizeLimit: 0,
      heapSize: 0,
    });
  });

  it("returns only the mask for an empty config", () => {
    expect(readTransactionV1Config({})).toEqual({ mask: 0 });
  });
});

describe("checkTransactionV1Budget", () => {
  it("accepts a complete config within the caps", () => {
    expect(checkTransactionV1Budget(VALID, [MEMO_PROGRAM_ADDRESS], LIMITS)).toBeUndefined();
  });

  it.each<[string, TransactionV1Config, string[], string]>([
    ["one priority-fee bit", { ...VALID, mask: 0b1101 }, [], "priority_fee_bits"],
    ["a heap request", { ...VALID, mask: 0b11111, heapSize: 32_768 }, [], "heap_size"],
    [
      "a ComputeBudget instruction",
      VALID,
      [COMPUTE_BUDGET_PROGRAM_ADDRESS],
      "compute_budget_instruction",
    ],
    [
      "no compute unit limit",
      { ...VALID, computeUnitLimit: undefined },
      [],
      "compute_unit_limit_missing",
    ],
    [
      "a compute unit limit over the cap",
      { ...VALID, computeUnitLimit: 200_001 },
      [],
      "compute_unit_limit_too_high",
    ],
    [
      "no loaded-account-data budget",
      { ...VALID, loadedAccountsDataSizeLimit: undefined },
      [],
      "loaded_accounts_data_size_limit_missing",
    ],
    [
      "a fee one lamport over the cap",
      { ...VALID, priorityFeeLamports: 100_001n },
      [],
      "priority_fee_too_high",
    ],
    [
      "a u64-max fee",
      { ...VALID, priorityFeeLamports: (1n << 64n) - 1n },
      [],
      "priority_fee_too_high",
    ],
  ])("rejects %s", (_name, config, programs, violation) => {
    expect(checkTransactionV1Budget(config, programs, LIMITS)).toBe(violation);
  });

  it("treats an unset fee as zero and an unset cap as unbounded", () => {
    expect(
      checkTransactionV1Budget(
        { ...VALID, priorityFeeLamports: undefined, computeUnitLimit: 1_400_000 },
        [],
        { maxPriceMicroLamports: 0 },
      ),
    ).toBeUndefined();
  });
});
