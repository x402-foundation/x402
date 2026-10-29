import { describe, expect, it } from "vitest";
import { MAX_SPLIT_MEMO_BYTES, MAX_SPLITS } from "../../src/constants";
import {
  assertWithinMaxSplits,
  getMaxSplits,
  getSplits,
  hasSplits,
  parsePaymentLegs,
  SplitsError,
} from "../../src/splits";
import { payTo, testRequirements } from "./helpers";

const A = `0x${"aa".repeat(32)}`;
const B = `0x${"bb".repeat(32)}`;

/**
 * Requirements of 10000 with the given splits.
 *
 * @param splits - The `extra.splits` value
 * @returns Payment requirements
 */
function withSplits(splits: unknown) {
  return testRequirements({ amount: "10000", extra: { splits } });
}

describe("parsePaymentLegs", () => {
  it("returns the remainder to payTo first, then each split in order", () => {
    expect(
      parsePaymentLegs(
        withSplits([
          { payTo: A, amount: "300", memo: "platform fee" },
          { payTo: B, amount: "200" },
        ]),
      ),
    ).toEqual([
      { payTo, amount: 9500n },
      { payTo: A, amount: 300n },
      { payTo: B, amount: 200n },
    ]);
  });

  it("returns one leg of the full amount without splits", () => {
    expect(parsePaymentLegs(testRequirements())).toEqual([{ payTo, amount: 10000n }]);
    expect(parsePaymentLegs(withSplits([]))).toEqual([{ payTo, amount: 10000n }]);
  });

  it("accepts a remainder of one and the most splits", () => {
    expect(parsePaymentLegs(withSplits([{ payTo: A, amount: "9999" }]))[0].amount).toBe(1n);
    const most = Array.from({ length: MAX_SPLITS }, (_, i) => ({
      payTo: `0x${(i + 1).toString(16)}`,
      amount: "1",
    }));
    expect(parsePaymentLegs(withSplits(most))).toHaveLength(MAX_SPLITS + 1);
  });

  it("accepts a memo of exactly the byte limit", () => {
    const memo = "é".repeat(MAX_SPLIT_MEMO_BYTES / 2);
    expect(() => parsePaymentLegs(withSplits([{ payTo: A, amount: "1", memo }]))).not.toThrow();
  });

  it.each<[string, unknown, string]>([
    ["a non-array", { payTo: A, amount: "1" }, "must be an array"],
    ["null", null, "must be an array"],
    ["a non-object entry", ["x"], "must be an object"],
    ["an array entry", [[A, "1"]], "must be an object"],
    ["a remainder of zero", [{ payTo: A, amount: "10000" }], "leaves no remainder"],
    ["a negative remainder", [{ payTo: A, amount: "10001" }], "leaves no remainder"],
    ["a split equal to payTo", [{ payTo, amount: "1" }], "duplicates another recipient"],
    [
      "a split equal to payTo in upper case",
      [{ payTo: `0x${payTo.slice(2).toUpperCase()}`, amount: "1" }],
      "duplicates another recipient",
    ],
    [
      "two splits to one recipient",
      [
        { payTo: A, amount: "1" },
        { payTo: A, amount: "2" },
      ],
      "duplicates another recipient",
    ],
    [
      "a short and a padded form of one address",
      [
        { payTo: "0x2", amount: "1" },
        { payTo: `0x${"0".repeat(63)}2`, amount: "2" },
      ],
      "duplicates another recipient",
    ],
    ["an invalid address", [{ payTo: "0xzz", amount: "1" }], "not a valid Sui address"],
    ["an address without 0x", [{ payTo: "aa".repeat(32), amount: "1" }], "not a valid Sui address"],
    [
      "a too-long address",
      [{ payTo: `0x${"aa".repeat(33)}`, amount: "1" }],
      "not a valid Sui address",
    ],
    ["a missing payTo", [{ amount: "1" }], "not a valid Sui address"],
    ["amount 0", [{ payTo: A, amount: "0" }], "positive integer string"],
    ["a leading zero", [{ payTo: A, amount: "01" }], "positive integer string"],
    ["a decimal point", [{ payTo: A, amount: "1.0" }], "positive integer string"],
    ["a sign", [{ payTo: A, amount: "-1" }], "positive integer string"],
    ["an exponent", [{ payTo: A, amount: "1e3" }], "positive integer string"],
    ["a number", [{ payTo: A, amount: 1 }], "positive integer string"],
    ["an amount above u64", [{ payTo: A, amount: (1n << 64n).toString() }], "exceeds u64"],
    ["a non-string memo", [{ payTo: A, amount: "1", memo: 7 }], "memo must be a string"],
    [
      "a memo over the byte limit",
      [{ payTo: A, amount: "1", memo: "é".repeat(MAX_SPLIT_MEMO_BYTES / 2) + "x" }],
      `exceeds ${MAX_SPLIT_MEMO_BYTES} bytes`,
    ],
    [
      "an unknown field",
      [{ payTo: A, amount: "1", ataCreationRequired: false }],
      "unsupported field(s): ataCreationRequired",
    ],
    [
      "more than the most splits",
      Array.from({ length: MAX_SPLITS + 1 }, (_, i) => ({
        payTo: `0x${(i + 1).toString(16)}`,
        amount: "1",
      })),
      `at most ${MAX_SPLITS}`,
    ],
  ])("rejects %s", (_, splits, message) => {
    let error: unknown;
    try {
      parsePaymentLegs(withSplits(splits));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SplitsError);
    expect((error as SplitsError).reason).toBe("invalid_payment_requirements");
    expect((error as SplitsError).message).toContain(message);
  });

  it("rejects an invalid top-level payTo only when there are splits", () => {
    expect(() => parsePaymentLegs(testRequirements({ payTo: "not-an-address" }))).not.toThrow();
    expect(() =>
      parsePaymentLegs({
        ...withSplits([{ payTo: A, amount: "1" }]),
        payTo: "not-an-address",
      }),
    ).toThrow("payTo is not a valid Sui address");
  });

  it("rejects a non-positive total", () => {
    expect(() => parsePaymentLegs(testRequirements({ amount: "0" }))).toThrow(SplitsError);
  });
});

describe("hasSplits / getSplits", () => {
  it("treats absent and empty as no splits", () => {
    expect(hasSplits(testRequirements())).toBe(false);
    expect(hasSplits(withSplits([]))).toBe(false);
    expect(hasSplits(withSplits([{ payTo: A, amount: "1" }]))).toBe(true);
    // Malformed values count as splits so that they are validated, not ignored.
    expect(hasSplits(withSplits(null))).toBe(true);
    expect(hasSplits(withSplits({}))).toBe(true);
    expect(getSplits(testRequirements())).toEqual([]);
    expect(getSplits(withSplits([{ payTo: A, amount: "1" }]))).toEqual([{ payTo: A, amount: "1" }]);
  });
});

describe("getMaxSplits", () => {
  it.each<[unknown, number]>([
    [undefined, 0],
    [0, 0],
    [-1, 0],
    [1.5, 0],
    ["8", 0],
    [3, 3],
    [MAX_SPLITS, MAX_SPLITS],
    [100, MAX_SPLITS],
  ])("reads maxSplits %j as %d", (maxSplits, expected) => {
    expect(getMaxSplits(maxSplits === undefined ? {} : { maxSplits })).toBe(expected);
  });

  it("treats a missing extra as 0", () => {
    expect(getMaxSplits(undefined)).toBe(0);
  });
});

describe("assertWithinMaxSplits", () => {
  const legs = parsePaymentLegs(
    withSplits([
      { payTo: A, amount: "1" },
      { payTo: B, amount: "1" },
    ]),
  );

  it("allows up to the cap", () => {
    expect(() => assertWithinMaxSplits(legs, 2)).not.toThrow();
    expect(() => assertWithinMaxSplits(parsePaymentLegs(testRequirements()), 0)).not.toThrow();
  });

  it("rejects above the cap, and any splits at 0", () => {
    expect(() => assertWithinMaxSplits(legs, 1)).toThrow("accepts at most 1");
    expect(() => assertWithinMaxSplits(legs, 0)).toThrow("does not accept splits");
  });
});
