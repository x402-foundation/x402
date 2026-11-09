import { describe, it, expect } from "vitest";
import { selectInputHoldings } from "../../src/signer-factory.js";

describe("selectInputHoldings", () => {
  it("picks the smallest single holding that covers the amount", () => {
    const holdings = new Map([
      ["a", "5"],
      ["b", "10"],
      ["c", "3"],
    ]);
    expect(selectInputHoldings(holdings, "4")).toEqual(["a"]);
  });

  it("treats an exactly-equal holding as covering", () => {
    const holdings = new Map([["a", "10.0000000000"]]);
    expect(selectInputHoldings(holdings, "10.0000000000")).toEqual(["a"]);
  });

  it("accumulates largest-first when no single holding covers the amount", () => {
    const holdings = new Map([
      ["a", "0.9999999999"],
      ["b", "0.9999999999"],
    ]);
    const chosen = selectInputHoldings(holdings, "1.0000000000");
    expect(chosen).toHaveLength(2);
    expect(chosen.sort()).toEqual(["a", "b"]);
  });

  it("selects on exact decimal precision (a Number() compare would mis-pick)", () => {
    // These differ only in the 10th fractional digit and, once scaled to atomic
    // units, exceed Number.MAX_SAFE_INTEGER — float math would collapse them.
    const holdings = new Map([
      ["short", "1234567.8901234560"], // one atomic below target
      ["ok", "1234567.8901234568"], // covers target
    ]);
    expect(selectInputHoldings(holdings, "1234567.8901234565")).toEqual(["ok"]);
  });
});
