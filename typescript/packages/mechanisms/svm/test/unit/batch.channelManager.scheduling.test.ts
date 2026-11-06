import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";

const requirements: PaymentRequirements = {
  amount: "1000",
  asset: USDC_DEVNET_ADDRESS,
  extra: {},
  maxTimeoutSeconds: 300,
  network: SOLANA_DEVNET_CAIP2,
  payTo: USDC_DEVNET_ADDRESS,
  scheme: "batch-settlement",
};
const emptyResult = { claimed: [], distributed: [], sealed: [] };

describe("batch-settlement redemption scheduling", () => {
  const releases: (() => void)[] = [];
  const managers: BatchChannelManager[] = [];

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
  }

  function fixture() {
    const store = new MemoryChannelStore();
    const list = vi.spyOn(store, "list");
    const onError = vi.fn();
    const settle = vi.fn(async () => {
      throw new Error("An empty store must not submit a settlement");
    });
    const manager = new BatchChannelManager({ onError, requirements, settle, store });
    managers.push(manager);
    return { manager, list, onError, settle };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.clearAllTimers();
    releases.splice(0).forEach(release => release());
    await Promise.all(managers.splice(0).map(manager => manager.stop()));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skips automatic ticks while a pass is blocked instead of draining them on stop", async () => {
    const { manager, list, settle } = fixture();
    const blocked = deferred();
    list.mockImplementationOnce(async () => {
      await blocked.promise;
      return [];
    });
    manager.start(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = manager.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    blocked.resolve();
    await stop;
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(settle).not.toHaveBeenCalled();
  });

  it("adds exactly one explicit final pass when flushing a slow automatic pass", async () => {
    const { manager, list } = fixture();
    const blocked = deferred();
    list.mockImplementationOnce(async () => {
      await blocked.promise;
      return [];
    });
    manager.start(1);
    await vi.advanceTimersByTimeAsync(5000);
    const stop = manager.stop({ flush: true });
    blocked.resolve();
    await stop;
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("preserves every explicit manual redemption", async () => {
    const { manager, list } = fixture();
    const blocked = deferred();
    list.mockImplementationOnce(async () => {
      await blocked.promise;
      return [];
    });
    const passes = [manager.redeem(), manager.redeem(), manager.redeem()];
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    blocked.resolve();
    expect(await Promise.all(passes)).toEqual([emptyResult, emptyResult, emptyResult]);
    expect(list).toHaveBeenCalledTimes(6);
  });

  it("preserves a manual caller's rejection without poisoning later callers", async () => {
    const { manager, list } = fixture();
    const blocked = deferred();
    const error = new Error("store unavailable");
    list.mockImplementation(async () => {
      if (list.mock.calls.length === 1) await blocked.promise;
      if (list.mock.calls.length === 3) throw error;
      return [];
    });
    const first = manager.redeem();
    const second = manager.redeem();
    const rejected = expect(second).rejects.toBe(error);
    const third = manager.redeem();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    blocked.resolve();
    expect(await first).toEqual(emptyResult);
    await rejected;
    expect(await third).toEqual(emptyResult);
    expect(list).toHaveBeenCalledTimes(5);
  });

  it("discards an automatic pass queued behind manual work when stopped", async () => {
    const { manager, list } = fixture();
    const blocked = deferred();
    list.mockImplementationOnce(async () => {
      await blocked.promise;
      return [];
    });
    const manual = manager.redeem();
    await vi.advanceTimersByTimeAsync(0);
    manager.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    const stop = manager.stop();
    blocked.resolve();
    await Promise.all([manual, stop]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not revive an old queued tick after restart or release a newer tick's gate", async () => {
    const { manager, list } = fixture();
    const oldPass = deferred();
    const newPass = deferred();
    list.mockImplementation(async () => {
      if (list.mock.calls.length === 1) await oldPass.promise;
      if (list.mock.calls.length === 3) await newPass.promise;
      return [];
    });
    const manual = manager.redeem();
    await vi.advanceTimersByTimeAsync(0);
    manager.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    const oldStop = manager.stop();
    manager.start(1);
    await vi.advanceTimersByTimeAsync(3000);
    oldPass.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    await Promise.all([manual, oldStop]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(list).toHaveBeenCalledTimes(3);
    const stop = manager.stop();
    newPass.resolve();
    await stop;
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("reports an automatic pass rejection and resumes on a later tick", async () => {
    const { manager, list, onError } = fixture();
    const error = new Error("store unavailable");
    list.mockRejectedValueOnce(error);
    manager.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(3);
    await manager.stop();
  });

  it("keeps a captured stop boundary when a later manual pass is still blocked", async () => {
    const { manager, list } = fixture();
    const firstPass = deferred();
    const laterPass = deferred();
    list.mockImplementation(async () => {
      if (list.mock.calls.length === 1) await firstPass.promise;
      if (list.mock.calls.length === 3) await laterPass.promise;
      return [];
    });
    const first = manager.redeem();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = manager.stop().then(() => {
      stopped = true;
    });
    const later = manager.redeem();
    firstPass.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    expect(stopped).toBe(true);
    laterPass.resolve();
    await Promise.all([first, later, stop]);
  });

  it("finishes an old flush without waiting for a restarted automatic pass", async () => {
    const { manager, list } = fixture();
    const firstPass = deferred();
    const flushPass = deferred();
    const restartedPass = deferred();
    list.mockImplementation(async () => {
      if (list.mock.calls.length === 1) await firstPass.promise;
      if (list.mock.calls.length === 3) await flushPass.promise;
      if (list.mock.calls.length === 5) await restartedPass.promise;
      return [];
    });
    manager.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    const oldStop = manager.stop({ flush: true }).then(() => {
      stopped = true;
    });
    manager.start(1);
    firstPass.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    flushPass.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(5);
    expect(stopped).toBe(true);
    const stop = manager.stop();
    restartedPass.resolve();
    await Promise.all([stop, oldStop]);
  });

  it("runs one final pass for each explicit flush request", async () => {
    const { manager, list } = fixture();
    const blocked = deferred();
    list.mockImplementationOnce(async () => {
      await blocked.promise;
      return [];
    });
    const manual = manager.redeem();
    await vi.advanceTimersByTimeAsync(0);
    const firstStop = manager.stop({ flush: true });
    const secondStop = manager.stop({ flush: true });
    blocked.resolve();
    await Promise.all([manual, firstStop, secondStop]);
    expect(list).toHaveBeenCalledTimes(6);
  });

  it("starts only one interval and can restart after stopping", async () => {
    const { manager, list } = fixture();
    manager.start(1);
    manager.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(2);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(list).toHaveBeenCalledTimes(2);
    manager.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(4);
    await manager.stop();
  });
});
