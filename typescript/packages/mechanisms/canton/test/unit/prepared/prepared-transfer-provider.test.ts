/**
 * Validator-provided TransferPreapproval: the role-aware provider exception.
 *
 * GROUND TRUTH: two REAL MainNet PreparedTransactions from the integrator (see
 * src/__fixtures__/README.md). Both are expired 60s captures, so every case
 * injects `nowMs` at the capture instant; without that the timing check fires
 * before the check under test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertPreparedTransferMatches } from "../../../src/prepared-transfer.js";

const FX = fileURLToPath(new URL("../../../src/__fixtures__/", import.meta.url));
const read = (n: string): string => readFileSync(join(FX, n), "utf8").trim();
const DISTINCT = read("mainnet-preapproval-distinct-provider.b64");
const SELF = read("mainnet-preapproval-self-provider.b64");

const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const SENDER = "agent::1220ee6e28beea64a00657dc7ccc47f8502d21a2c29a56375456b2c61907758ec45d";
const CANTEX = "Cantex::122090c527c437b93a66a7aa6d44fb641ff7a8386ef95430aed57e59e8e1bba45f53";
const PROVIDER =
  "Cantex-validator-1::122038c015864f106cfed48bb9106b7c89982368d27956ffcdfda6c38328f0909b8c";
const SELF_MERCHANT =
  "caf5e4e35cfd1669::12209e866b13a9428411eb9db7448726ec31cf0bcf027d0d642a0c38653ba72515a5";
const NOW = Date.parse("2026-07-28T12:37:10.000Z");

const base = { amount: "0.0001000000", instrumentId: "Amulet", instrumentAdmin: DSO, nowMs: NOW };

describe("real MainNet fixtures", () => {
  it("ACCEPTS a distinct validator provider (the bug being fixed)", () => {
    expect(() =>
      assertPreparedTransferMatches(DISTINCT, { ...base, sender: SENDER, receiver: CANTEX }),
    ).not.toThrow();
  });

  it("still ACCEPTS the self-provider control (no regression)", () => {
    expect(() =>
      assertPreparedTransferMatches(SELF, { ...base, sender: SENDER, receiver: SELF_MERCHANT }),
    ).not.toThrow();
  });

  it("REJECTS the distinct capture when the caller intended a DIFFERENT receiver", () => {
    // The preapproval is for Cantex; claiming to pay someone else must not
    // silently pass, and the provider role must not be granted either.
    expect(() =>
      assertPreparedTransferMatches(DISTINCT, { ...base, sender: SENDER, receiver: SELF_MERCHANT }),
    ).toThrow(/receiver/);
  });

  it("REJECTS the distinct capture when the trusted DSO is wrong", () => {
    expect(() =>
      assertPreparedTransferMatches(DISTINCT, {
        ...base,
        sender: SENDER,
        receiver: CANTEX,
        instrumentAdmin: "DSO::1220" + "0".repeat(64),
      }),
    ).toThrow(/instrumentId\.admin/);
  });

  it("REJECTS the distinct capture on an amount mismatch", () => {
    expect(() =>
      assertPreparedTransferMatches(DISTINCT, {
        ...base,
        sender: SENDER,
        receiver: CANTEX,
        amount: "0.0002000000",
      }),
    ).toThrow(/amount/);
  });

  it("the provider is NOT silently promoted to an allowed recipient", () => {
    // Paying the provider itself has no preapproval for it, so it must refuse.
    expect(() =>
      assertPreparedTransferMatches(DISTINCT, { ...base, sender: SENDER, receiver: PROVIDER }),
    ).toThrow();
  });

  it("expired bytes still fail closed on timing (fixtures are real captures)", () => {
    expect(() =>
      assertPreparedTransferMatches(DISTINCT, {
        ...base,
        sender: SENDER,
        receiver: CANTEX,
        nowMs: Date.parse("2026-07-29T00:00:00.000Z"),
      }),
    ).toThrow(/past|expired/i);
  });
});
