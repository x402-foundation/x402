import { describe, it, expect } from "vitest";
import type { SettleResponse } from "@x402/core/types";
import { processSettleResponse, updateChannelAfterRefund } from "../../../src/batch-settlement/client/channel";
import { InMemoryClientChannelStorage } from "../../../src/batch-settlement/client/storage";

const VALID_CHANNEL_ID = "0x" + "ab".repeat(32);

function settleResponse(extra: Record<string, unknown> | undefined): SettleResponse {
  return {
    success: true,
    transaction: "0x" + "11".repeat(32),
    network: "eip155:8453" as SettleResponse["network"],
    extra,
  };
}

describe("processSettleResponse", () => {
  it("updates storage when channelState has a valid channelId", async () => {
    const storage = new InMemoryClientChannelStorage();
    const settle = settleResponse({
      channelState: { channelId: VALID_CHANNEL_ID, balance: "100" },
    });

    await processSettleResponse(storage, settle);

    const stored = await storage.get(VALID_CHANNEL_ID);
    expect(stored?.balance).toBe("100");
  });

  it("is a no-op instead of throwing when channelState has no channelId", async () => {
    // Regression test for #3188: a settle response whose extra.channelState is a
    // well-formed object but omits channelId used to throw
    // "Cannot read properties of undefined (reading 'toLowerCase')" here.
    const storage = new InMemoryClientChannelStorage();
    const settle = settleResponse({ channelState: { balance: "100" } });

    await expect(processSettleResponse(storage, settle)).resolves.toBeUndefined();
  });

  it("is a no-op when channelState.channelId is not a string", async () => {
    const storage = new InMemoryClientChannelStorage();
    const settle = settleResponse({ channelState: { channelId: 12345, balance: "100" } });

    await expect(processSettleResponse(storage, settle)).resolves.toBeUndefined();
  });

  it("is a no-op when channelState.channelId is an empty string", async () => {
    const storage = new InMemoryClientChannelStorage();
    const settle = settleResponse({ channelState: { channelId: "", balance: "100" } });

    await expect(processSettleResponse(storage, settle)).resolves.toBeUndefined();
  });

  it("is a no-op when extra.channelState itself is absent", async () => {
    const storage = new InMemoryClientChannelStorage();
    const settle = settleResponse({});

    await expect(processSettleResponse(storage, settle)).resolves.toBeUndefined();
  });
});

describe("updateChannelAfterRefund", () => {
  it("deletes the channel record instead of throwing when channelState has no channelId", async () => {
    // Same root cause as above (both call readResponseChannelState), covered here too
    // since this function's own signature takes an already-lowercased channelKey rather
    // than reading channelId itself — confirms the shared helper's guard protects both callers.
    const storage = new InMemoryClientChannelStorage();
    await storage.set(VALID_CHANNEL_ID, { balance: "50" });

    await expect(
      updateChannelAfterRefund(storage, VALID_CHANNEL_ID, { channelState: { balance: "0" } }),
    ).resolves.toBeUndefined();

    // Malformed channelState is treated as "absent", same as updateChannelAfterRefund's
    // own explicit "no channelState at all" branch: delete the local record.
    expect(await storage.get(VALID_CHANNEL_ID)).toBeUndefined();
  });
});
