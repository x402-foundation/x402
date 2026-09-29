import { describe, expect, it } from "vitest";

import { MemoryBatchOperationStore } from "../../src/batch-settlement/server/operationStore";

describe("MemoryBatchOperationStore", () => {
  it("atomically reserves one operation per request id", async () => {
    const store = new MemoryBatchOperationStore();
    const [first, second] = await Promise.all([
      store.reserve("channel", "request", 1_000n),
      store.reserve("channel", "request", 1_000n),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    await expect(store.reserve("channel", "request", 999n)).rejects.toThrow("ceiling changed");
  });

  it("permanently rejects failed and completed request ids", async () => {
    const store = new MemoryBatchOperationStore();
    await store.reserve("channel", "request", 1_000n);
    await store.release("channel", "request");
    expect((await store.reserve("channel", "request", 1_000n)).created).toBe(false);

    const completedStore = new MemoryBatchOperationStore();
    await completedStore.reserve("channel", "request", 1_000n);
    await completedStore.complete({
      actual: 500n,
      ceiling: 1_000n,
      channelId: "channel",
      cumulative: 500n,
      requestId: "request",
      status: "completed",
    });
    const replay = await completedStore.reserve("channel", "request", 1_000n);
    expect(replay).toMatchObject({ created: false, operation: { status: "completed" } });
    await completedStore.release("channel", "request");
    expect((await completedStore.get("channel", "request"))?.status).toBe("completed");
  });
});
