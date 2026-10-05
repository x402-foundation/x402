/**
 * Verify-before-sign on a real MainNet prepared-transfer fixture. This is the
 * client-side funds-safety gate: it must accept the honest capture and refuse to
 * sign any transfer whose sender / receiver / amount / pinned synchronizer does
 * not match caller intent. Plus the two decode primitives it rests on
 * (canonicalAmount, decodePrepared).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  canonicalAmount,
  decodePrepared,
  PreparedDecodeError,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "../../src/prepared-transfer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const CC_RAW = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();
const CC = JSON.parse(readFileSync(FIX + "mainnet-0.1.21.json", "utf8")).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};
const SYNC = "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

// A wall-clock inside the fixture's ledger window, so the timing sanity checks accept it.
const NOW = Number((decodePrepared(CC_RAW).preparationTime ?? 0n) / 1000n) + 1000;

const intent = (over: Partial<PreparedTransferExpectation> = {}): PreparedTransferExpectation => ({
  sender: CC.sender,
  receiver: CC.receiver,
  amount: CC.amount,
  instrumentId: CC.instrumentId.id,
  // Pin the independently-trusted DSO so the foreign-party backstop admits it.
  instrumentAdmin: CC.instrumentId.admin,
  nowMs: NOW,
  ...over,
});

describe("assertPreparedTransferMatches", () => {
  it("accepts the honest capture with matching intent", () => {
    expect(() => assertPreparedTransferMatches(CC_RAW, intent())).not.toThrow();
  });

  it("accepts when the pinned synchronizer matches the signed domain", () => {
    expect(() =>
      assertPreparedTransferMatches(CC_RAW, intent({ synchronizerId: SYNC })),
    ).not.toThrow();
  });

  it("refuses a redirected receiver", () => {
    expect(() =>
      assertPreparedTransferMatches(
        CC_RAW,
        intent({ receiver: "attacker::1220" + "aa".repeat(32) }),
      ),
    ).toThrow(PreparedTransferMismatchError);
  });

  it("refuses an inflated amount", () => {
    expect(() => assertPreparedTransferMatches(CC_RAW, intent({ amount: "0.02" }))).toThrow(
      PreparedTransferMismatchError,
    );
  });

  it("refuses a sender that is not the agent", () => {
    expect(() =>
      assertPreparedTransferMatches(CC_RAW, intent({ sender: "notme::1220" + "bb".repeat(32) })),
    ).toThrow(PreparedTransferMismatchError);
  });

  it("refuses a synchronizer other than the pinned one", () => {
    expect(() =>
      assertPreparedTransferMatches(
        CC_RAW,
        intent({ synchronizerId: "wrong::1220" + "cc".repeat(32) }),
      ),
    ).toThrow(PreparedTransferMismatchError);
  });
});

describe("canonicalAmount", () => {
  it("pads a short fraction to the 10-decimal canon", () => {
    expect(canonicalAmount("0.02")).toBe("0.0200000000");
    expect(canonicalAmount("1")).toBe("1.0000000000");
  });

  it("leaves an already-canonical amount unchanged", () => {
    expect(canonicalAmount("0.0100000000")).toBe("0.0100000000");
  });

  it("never truncates extra precision (keeps a >10-digit fraction verbatim so it still mismatches)", () => {
    expect(canonicalAmount("1.00000000001")).toBe("1.00000000001");
  });

  it("returns a non-numeric input as-is (fail-closed: still mismatches)", () => {
    expect(canonicalAmount("abc")).toBe("abc");
  });
});

describe("decodePrepared", () => {
  it("decodes a real prepared transaction", () => {
    expect(decodePrepared(CC_RAW).preparationTime).toBeGreaterThan(0n);
  });

  it("throws PreparedDecodeError on non-decodable bytes", () => {
    expect(() => decodePrepared(Buffer.from("not a prepared tx").toString("base64"))).toThrow(
      PreparedDecodeError,
    );
  });
});
