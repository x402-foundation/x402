import { afterEach, describe, expect, it, vi } from "vitest";
import { HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS } from "../../src/constants";
import { InFlightGuard } from "../../src/exact/facilitator/inFlightGuard";

const KEY = "key";

afterEach(() => {
  vi.useRealTimers();
});

describe("InFlightGuard.holdPending", () => {
  it("marks its own hold pending, for a retry to take", () => {
    const guard = new InFlightGuard<string>();
    const hold = guard.tryAcquire(KEY)!;

    guard.holdPending(hold, "pending");

    expect(guard.takePending(KEY, () => true)).toEqual({ hold, pending: "pending" });
  });

  it("takes the key again for a hold that lost it to expiry", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const guard = new InFlightGuard<string>();
    const hold = guard.tryAcquire(KEY)!;
    vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS);

    guard.holdPending(hold, "pending");

    expect(guard.tryAcquire(KEY)).toBeUndefined();
    expect(guard.takePending(KEY, () => true)).toEqual({ hold, pending: "pending" });
  });

  it("leaves a key another settle took after expiry untouched", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const guard = new InFlightGuard<string>();
    const earlier = guard.tryAcquire(KEY)!;
    vi.advanceTimersByTime(HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS);
    const later = guard.tryAcquire(KEY)!;

    guard.holdPending(earlier, "earlier's pending");

    expect(later).toBeDefined();
    expect(guard.takePending(KEY, () => true)).toBeUndefined();
    expect(guard.isHeld(KEY)).toBe(true);
    guard.release(later);
    expect(guard.tryAcquire(KEY)).toBeDefined();
  });
});
