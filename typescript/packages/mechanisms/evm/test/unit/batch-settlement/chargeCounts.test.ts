import { describe, expect, it } from "vitest";
import {
  CHARGE_COUNTS_METADATA_KEY,
  chargeCountsMetadata,
  parseChargeCountsMetadata,
} from "../../../src/batch-settlement/chargeCounts";

describe("CHARGE_COUNTS_METADATA_KEY", () => {
  it("is the x402ChargeCounts key of ERC-8021 m", () => {
    expect(CHARGE_COUNTS_METADATA_KEY).toBe("x402ChargeCounts");
  });
});

describe("chargeCountsMetadata", () => {
  it("wraps one bigint count per claim row under the metadata key", () => {
    expect(chargeCountsMetadata([3, 0n, 41])).toEqual({ x402ChargeCounts: [3n, 0n, 41n] });
  });

  it("returns undefined when there are no claim rows", () => {
    expect(chargeCountsMetadata([])).toBeUndefined();
  });
});

describe("parseChargeCountsMetadata", () => {
  it("round-trips the metadata it builds", () => {
    expect(parseChargeCountsMetadata(chargeCountsMetadata([3, 0, 41]))).toEqual([3n, 0n, 41n]);
  });

  it("accepts CBOR-parsed bigint values and plain safe integers", () => {
    expect(parseChargeCountsMetadata({ x402ChargeCounts: [1n, 2] })).toEqual([1n, 2n]);
  });

  it("returns undefined when the key is absent", () => {
    expect(parseChargeCountsMetadata(undefined)).toBeUndefined();
    expect(parseChargeCountsMetadata({})).toBeUndefined();
  });

  it("returns undefined for malformed values", () => {
    expect(parseChargeCountsMetadata({ x402ChargeCounts: "3" })).toBeUndefined();
    expect(parseChargeCountsMetadata({ x402ChargeCounts: { 0: 3n } })).toBeUndefined();
    expect(parseChargeCountsMetadata({ x402ChargeCounts: [1n, -1n] })).toBeUndefined();
    expect(parseChargeCountsMetadata({ x402ChargeCounts: [1.5] })).toBeUndefined();
    expect(parseChargeCountsMetadata({ x402ChargeCounts: [-1] })).toBeUndefined();
    expect(parseChargeCountsMetadata({ x402ChargeCounts: ["1"] })).toBeUndefined();
  });

  it("keeps an empty array as an empty list", () => {
    expect(parseChargeCountsMetadata({ x402ChargeCounts: [] })).toEqual([]);
  });
});
