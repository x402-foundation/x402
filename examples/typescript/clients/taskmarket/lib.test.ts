import { describe, it, expect } from "vitest";
import {
  usdToAtomicUnits,
  atomicUnitsToUsd,
  assertWithinSpendingLimit,
  SpendingLimitExceededError,
  buildTaskListParams,
  buildCreateTaskBody,
  createIdempotencyKey,
  buildCreateTaskHeaders,
  IDEMPOTENCY_KEY_HEADER,
} from "./lib";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("usdToAtomicUnits()", () => {
  it("converts a whole-dollar amount", () => {
    expect(usdToAtomicUnits("2")).toBe("2000000");
  });

  it("converts a fractional amount", () => {
    expect(usdToAtomicUnits("2.50")).toBe("2500000");
  });

  it("converts the smallest unit", () => {
    expect(usdToAtomicUnits("0.000001")).toBe("1");
  });

  it("rejects malformed input", () => {
    expect(() => usdToAtomicUnits("abc")).toThrow(/Invalid USD amount/);
    expect(() => usdToAtomicUnits("1.2345678")).toThrow(/Invalid USD amount/);
    expect(() => usdToAtomicUnits("-1")).toThrow(/Invalid USD amount/);
  });
});

describe("atomicUnitsToUsd()", () => {
  it("round-trips atomic amounts back through usdToAtomicUnits", () => {
    const atomic = "5250000";
    expect(usdToAtomicUnits(atomicUnitsToUsd(atomic))).toBe(atomic);
  });

  it("formats a whole-dollar amount at full precision", () => {
    expect(atomicUnitsToUsd("5250000")).toBe("5.250000");
  });

  it("formats a value smaller than one dollar", () => {
    expect(atomicUnitsToUsd("500")).toBe("0.000500");
  });

  it("rejects non-numeric input", () => {
    expect(() => atomicUnitsToUsd("12.5")).toThrow(/Invalid atomic amount/);
  });
});

describe("assertWithinSpendingLimit()", () => {
  it("allows a reward equal to the cap", () => {
    expect(() => assertWithinSpendingLimit("1000000", "1000000")).not.toThrow();
  });

  it("allows a reward under the cap", () => {
    expect(() => assertWithinSpendingLimit("500000", "1000000")).not.toThrow();
  });

  it("blocks a reward over the cap", () => {
    expect(() => assertWithinSpendingLimit("2000000", "1000000")).toThrow(
      SpendingLimitExceededError,
    );
  });

  it("fails closed when the cap is zero", () => {
    expect(() => assertWithinSpendingLimit("1", "0")).toThrow(SpendingLimitExceededError);
  });

  it("includes human-readable USD amounts in the error", () => {
    try {
      assertWithinSpendingLimit("5000000", "1000000");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("5.000000 USDC");
      expect((error as Error).message).toContain("1.000000 USDC");
    }
  });
});

describe("buildTaskListParams()", () => {
  it("omits unset filters", () => {
    expect(buildTaskListParams({}).toString()).toBe("");
  });

  it("includes every provided filter", () => {
    const params = buildTaskListParams({
      mode: "bounty",
      status: "open",
      minReward: "1000000",
      maxReward: "5000000",
      tags: ["code", "rust"],
      limit: 10,
      sort: "reward_desc",
    });
    expect(params.get("mode")).toBe("bounty");
    expect(params.get("status")).toBe("open");
    expect(params.get("minReward")).toBe("1000000");
    expect(params.get("maxReward")).toBe("5000000");
    expect(params.get("tags")).toBe("code,rust");
    expect(params.get("limit")).toBe("10");
    expect(params.get("sort")).toBe("reward_desc");
  });
});

describe("buildCreateTaskBody()", () => {
  const valid = {
    description: "Fix the flaky login test",
    rewardAtomic: "2000000",
    durationSeconds: 3600,
    tags: ["bugfix"],
  };

  it("builds a valid bounty task body", () => {
    expect(buildCreateTaskBody(valid)).toEqual({
      description: "Fix the flaky login test",
      reward: "2000000",
      duration: 3600,
      tags: ["bugfix"],
      mode: "bounty",
    });
  });

  it("rejects an empty description", () => {
    expect(() => buildCreateTaskBody({ ...valid, description: "  " })).toThrow(/description/);
  });

  it("rejects no tags", () => {
    expect(() => buildCreateTaskBody({ ...valid, tags: [] })).toThrow(/tag/);
  });

  it("rejects a non-positive duration", () => {
    expect(() => buildCreateTaskBody({ ...valid, durationSeconds: 0 })).toThrow(/duration/);
  });

  it("rejects a zero reward", () => {
    expect(() => buildCreateTaskBody({ ...valid, rewardAtomic: "0" })).toThrow(/reward/);
  });

  it("rejects a non-integer reward string", () => {
    expect(() => buildCreateTaskBody({ ...valid, rewardAtomic: "1.5" })).toThrow(/reward/);
  });
});

describe("createIdempotencyKey()", () => {
  it("returns a valid v4 UUID", () => {
    expect(createIdempotencyKey()).toMatch(UUID_V4_PATTERN);
  });

  it("returns a different value on each call", () => {
    expect(createIdempotencyKey()).not.toBe(createIdempotencyKey());
  });
});

describe("buildCreateTaskHeaders()", () => {
  it("sends the idempotency key TaskMarket requires on POST /tasks", () => {
    const key = createIdempotencyKey();
    const headers = buildCreateTaskHeaders(key);
    expect(headers[IDEMPOTENCY_KEY_HEADER]).toBe(key);
  });

  it("still sets Content-Type", () => {
    const headers = buildCreateTaskHeaders(createIdempotencyKey());
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
