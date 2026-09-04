import { describe, it, expect } from "vitest";
import { hash } from "starknet";
import {
  assertExactTransfer,
  containsExactTransfer,
  type EventLike,
} from "../../src/exact/facilitator/simulate";

const ASSET = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
const PAYER = "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const OTHER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
const TRANSFER = hash.getSelectorFromName("Transfer");
const AMOUNT = 10000n;

// Cairo-1 keyed Transfer: keys = [selector, from, to], data = [low, high]
function transferEvent(from: string, to: string, amount: bigint, emitter = ASSET): EventLike {
  const low = amount & ((1n << 128n) - 1n);
  const high = amount >> 128n;
  return {
    from_address: emitter,
    keys: [TRANSFER, from, to],
    data: ["0x" + low.toString(16), "0x" + high.toString(16)],
  };
}

describe("assertExactTransfer (settle-time receipt / verify-time trace)", () => {
  it("accepts exactly one matching Transfer", () => {
    const r = assertExactTransfer(
      [transferEvent(PAYER, PAY_TO, AMOUNT)],
      ASSET,
      PAYER,
      PAY_TO,
      AMOUNT,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects when no Transfer is present (SUCCEEDED but no payment)", () => {
    const r = assertExactTransfer([], ASSET, PAYER, PAY_TO, AMOUNT);
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong amount", () => {
    const r = assertExactTransfer(
      [transferEvent(PAYER, PAY_TO, AMOUNT - 1n)],
      ASSET,
      PAYER,
      PAY_TO,
      AMOUNT,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong recipient", () => {
    const r = assertExactTransfer(
      [transferEvent(PAYER, OTHER, AMOUNT)],
      ASSET,
      PAYER,
      PAY_TO,
      AMOUNT,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a Transfer emitted by a different contract than the asset", () => {
    const r = assertExactTransfer(
      [transferEvent(PAYER, PAY_TO, AMOUNT, OTHER)],
      ASSET,
      PAYER,
      PAY_TO,
      AMOUNT,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects more than one Transfer", () => {
    const r = assertExactTransfer(
      [transferEvent(PAYER, PAY_TO, AMOUNT), transferEvent(PAYER, OTHER, 1n)],
      ASSET,
      PAYER,
      PAY_TO,
      AMOUNT,
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a trace event attributed via emitter when from_address is absent", () => {
    const e: EventLike = {
      emitter: ASSET,
      keys: [TRANSFER, PAYER, PAY_TO],
      data: ["0x2710", "0x0"],
    };
    expect(assertExactTransfer([e], ASSET, PAYER, PAY_TO, AMOUNT).ok).toBe(true);
  });

  it("rejects an event with no attributable emitter (fail closed)", () => {
    const e: EventLike = { keys: [TRANSFER, PAYER, PAY_TO], data: ["0x2710", "0x0"] };
    expect(assertExactTransfer([e], ASSET, PAYER, PAY_TO, AMOUNT).ok).toBe(false);
  });

  it("accepts the legacy unkeyed layout (keys=[selector], data=[from,to,low,high])", () => {
    const e: EventLike = {
      from_address: ASSET,
      keys: [TRANSFER],
      data: [PAYER, PAY_TO, "0x2710", "0x0"],
    };
    expect(assertExactTransfer([e], ASSET, PAYER, PAY_TO, AMOUNT).ok).toBe(true);
  });

  it("fails closed on a matching-key event fitting neither exact layout", () => {
    // keyed layout with a stray extra key
    const fourKeys: EventLike = {
      from_address: ASSET,
      keys: [TRANSFER, PAYER, PAY_TO, "0x1"],
      data: ["0x2710", "0x0"],
    };
    expect(assertExactTransfer([fourKeys], ASSET, PAYER, PAY_TO, AMOUNT).ok).toBe(false);
    // legacy layout with a stray extra data felt
    const fiveData: EventLike = {
      from_address: ASSET,
      keys: [TRANSFER],
      data: [PAYER, PAY_TO, "0x2710", "0x0", "0x1"],
    };
    expect(assertExactTransfer([fiveData], ASSET, PAYER, PAY_TO, AMOUNT).ok).toBe(false);
  });
});

describe("assertExactTransfer - neither-layout events fail closed", () => {
  const KEY = hash.getSelectorFromName("Transfer");
  const good = { from_address: ASSET, keys: [KEY, PAYER, PAY_TO], data: ["0x2710", "0x0"] };

  // Spec rule 8: "MUST fail closed on a matching-key event that fits neither
  // layout". Skipping it would let an unreadable event hide a second movement
  // of the payer's tokens.
  it("fails closed when the asset emits a Transfer fitting neither layout", () => {
    const malformed = { from_address: ASSET, keys: [KEY, PAYER], data: ["0x1"] };
    const result = assertExactTransfer([good, malformed], ASSET, PAYER, PAY_TO, 10000n);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("neither standard layout");
  });

  // The fee-token case: when `asset` is also the v3 fee token the receipt
  // carries the executor's fee Transfer too, which must not break the payment.
  it("ignores a non-payer Transfer on the same asset", () => {
    const executorFee = {
      from_address: ASSET,
      keys: [KEY, "0x0999", "0x0888"],
      data: ["0x5", "0x0"],
    };
    expect(assertExactTransfer([good, executorFee], ASSET, PAYER, PAY_TO, 10000n).ok).toBe(true);
  });

  it("still rejects a second Transfer sent by the payer", () => {
    const second = { from_address: ASSET, keys: [KEY, PAYER, "0x0777"], data: ["0x1", "0x0"] };
    expect(assertExactTransfer([good, second], ASSET, PAYER, PAY_TO, 10000n).ok).toBe(false);
  });
});

// containsExactTransfer is the settle-path counterpart to assertExactTransfer:
// containment rather than exactly-one, because a rescued transaction was
// submitted outside this settlement attempt and its other contents are not
// under the facilitator's control. It is the ONLY proof that a rescued
// transaction actually paid payTo the full amount on the right asset, so each
// of its three predicates needs a negative case.
describe("containsExactTransfer (rescue-path payment proof)", () => {
  it("accepts a matching Transfer among unrelated events", () => {
    const noise = { from_address: OTHER, keys: ["0x1234"], data: ["0x9"] };
    expect(
      containsExactTransfer(
        [noise, transferEvent(PAYER, PAY_TO, AMOUNT)],
        ASSET,
        PAYER,
        PAY_TO,
        AMOUNT,
      ),
    ).toBe(true);
  });

  it("rejects a Transfer emitted by a different token contract", () => {
    const foreign = transferEvent(PAYER, PAY_TO, AMOUNT, OTHER);
    expect(containsExactTransfer([foreign], ASSET, PAYER, PAY_TO, AMOUNT)).toBe(false);
  });

  it("rejects a Transfer to a different recipient", () => {
    expect(
      containsExactTransfer([transferEvent(PAYER, OTHER, AMOUNT)], ASSET, PAYER, PAY_TO, AMOUNT),
    ).toBe(false);
  });

  it("rejects an underpaying Transfer", () => {
    expect(
      containsExactTransfer(
        [transferEvent(PAYER, PAY_TO, AMOUNT - 1n)],
        ASSET,
        PAYER,
        PAY_TO,
        AMOUNT,
      ),
    ).toBe(false);
  });

  it("rejects an overpaying Transfer (the amount is exact, not a floor)", () => {
    expect(
      containsExactTransfer(
        [transferEvent(PAYER, PAY_TO, AMOUNT + 1n)],
        ASSET,
        PAYER,
        PAY_TO,
        AMOUNT,
      ),
    ).toBe(false);
  });

  it("rejects a Transfer sent by someone other than the payer", () => {
    expect(
      containsExactTransfer([transferEvent(OTHER, PAY_TO, AMOUNT)], ASSET, PAYER, PAY_TO, AMOUNT),
    ).toBe(false);
  });

  it("applies the same predicates to the legacy unkeyed layout", () => {
    const legacy = (from: string, to: string, amount: bigint, emitter = ASSET): EventLike => ({
      from_address: emitter,
      keys: [TRANSFER],
      data: [from, to, "0x" + amount.toString(16), "0x0"],
    });
    expect(
      containsExactTransfer([legacy(PAYER, PAY_TO, AMOUNT)], ASSET, PAYER, PAY_TO, AMOUNT),
    ).toBe(true);
    expect(
      containsExactTransfer([legacy(PAYER, OTHER, AMOUNT)], ASSET, PAYER, PAY_TO, AMOUNT),
    ).toBe(false);
    expect(
      containsExactTransfer([legacy(PAYER, PAY_TO, AMOUNT - 1n)], ASSET, PAYER, PAY_TO, AMOUNT),
    ).toBe(false);
    expect(
      containsExactTransfer([legacy(PAYER, PAY_TO, AMOUNT, OTHER)], ASSET, PAYER, PAY_TO, AMOUNT),
    ).toBe(false);
  });
});
