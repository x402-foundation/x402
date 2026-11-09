import { describe, expect, it } from "vitest";
import type { SolanaTransactionVersion } from "@solana/wallet-standard-features";
import { getClientTransactionVersions } from "./transactionVersions";

describe("getClientTransactionVersions", () => {
  it("keeps version 0 when the wallet does not declare its versions", () => {
    expect(getClientTransactionVersions(undefined)).toEqual([0]);
  });

  it("keeps version 0 for a wallet that lists legacy and version 0", () => {
    expect(getClientTransactionVersions(["legacy", 0])).toEqual([0]);
  });

  it("keeps version 0 for a wallet that lists neither version 0 nor 1", () => {
    expect(getClientTransactionVersions(["legacy"])).toEqual([0]);
    expect(getClientTransactionVersions([])).toEqual([0]);
  });

  it("offers version 1 when the wallet lists it", () => {
    expect(getClientTransactionVersions(["legacy", 0, 1])).toEqual([0, 1]);
    expect(getClientTransactionVersions([0, 1])).toEqual([0, 1]);
  });

  it("keeps version 0 as a fallback for a wallet that lists only version 1", () => {
    expect(getClientTransactionVersions([1])).toEqual([0, 1]);
  });

  it("ignores the string '1', which is not a declared version", () => {
    const declared = ["legacy", 0, "1"] as unknown as SolanaTransactionVersion[];
    expect(getClientTransactionVersions(declared)).toEqual([0]);
  });
});
