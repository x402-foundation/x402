import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthCaptureCallerIdentityConflictError,
  InMemoryAuthCaptureDelegatedAuthStorage,
  bindThenBroadcast,
  getDelegatedAuthorizer,
  resolveDelegatedCallerIdentity,
  type AuthCaptureDelegatedAuthRecord,
  type DelegatedAuthorizer,
  type DelegatedSettleContext,
} from "../../../src/auth-capture/facilitator/delegatedAuth";

const AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const NOW_SECONDS = 1_800_000_000;

function record(
  overrides: Partial<AuthCaptureDelegatedAuthRecord> = {},
): AuthCaptureDelegatedAuthRecord {
  return {
    network: "eip155:84532",
    paymentInfoHash: HASH,
    callerIdentity: "caller-1",
    expiresAt: NOW_SECONDS + 3600,
    ...overrides,
  };
}

function delegatedWith(storage: InMemoryAuthCaptureDelegatedAuthStorage): DelegatedAuthorizer {
  return {
    signer: { address: AUTHORIZER, signTypedData: vi.fn() },
    resolveCallerIdentity: vi.fn(),
    storage,
    onStorageError: vi.fn(),
  };
}

describe("InMemoryAuthCaptureDelegatedAuthStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the first writer and returns a revert token", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    const write = await storage.bind(record());
    expect(write.record.callerIdentity).toBe("caller-1");
    expect(write.revertToken).not.toBe("");
    expect(await storage.get("eip155:84532", HASH)).toEqual(record());
  });

  it("keeps the first writer and returns an empty token for a different identity", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    await storage.bind(record());
    const write = await storage.bind(record({ callerIdentity: "caller-2", expiresAt: 1 }));
    expect(write.record).toEqual(record());
    expect(write.revertToken).toBe("");
    expect(await storage.get("eip155:84532", HASH)).toEqual(record());
  });

  it("rotates the token on a same-identity bind so the creator's revert no longer matches", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    const creator = await storage.bind(record());
    const retry = await storage.bind(record());
    expect(retry.revertToken).toBe("");

    await storage.revertBind(creator);
    expect(await storage.get("eip155:84532", HASH)).toBeDefined();
  });

  it("deletes the row on revert only with the matching non-empty token", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    const write = await storage.bind(record());
    await storage.revertBind({ ...write, revertToken: "" });
    expect(await storage.get("eip155:84532", HASH)).toBeDefined();
    await storage.revertBind(write);
    expect(await storage.get("eip155:84532", HASH)).toBeUndefined();
  });

  it("treats an expired row as absent and lets a new identity bind", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    await storage.bind(record({ expiresAt: NOW_SECONDS + 10 }));
    vi.setSystemTime((NOW_SECONDS + 10) * 1000);
    expect(await storage.get("eip155:84532", HASH)).toBeUndefined();

    await storage.bind(record({ expiresAt: NOW_SECONDS + 20 }));
    vi.setSystemTime((NOW_SECONDS + 20) * 1000);
    const write = await storage.bind(
      record({ callerIdentity: "caller-2", expiresAt: NOW_SECONDS + 99 }),
    );
    expect(write.record.callerIdentity).toBe("caller-2");
    expect(write.revertToken).not.toBe("");
  });

  it("scopes rows by network and case-insensitive hash", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    await storage.bind(record());
    expect(await storage.get("eip155:8453", HASH)).toBeUndefined();
    expect(
      await storage.get("eip155:84532", HASH.toUpperCase().replace("0X", "0x") as `0x${string}`),
    ).toBeDefined();
    await storage.delete("eip155:84532", HASH);
    expect(await storage.get("eip155:84532", HASH)).toBeUndefined();
  });
});

describe("getDelegatedAuthorizer", () => {
  const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
  const config = {
    authorizerSigner: { address: AUTHORIZER, signTypedData: vi.fn() },
    resolveCallerIdentity: () => "caller-1",
    delegatedAuthStorage: storage,
    onStorageError: vi.fn(),
  };

  it("returns the wiring only when the receiverAuthorizer is the configured signer", () => {
    expect(getDelegatedAuthorizer(config, AUTHORIZER)?.storage).toBe(storage);
    expect(
      getDelegatedAuthorizer(config, AUTHORIZER.toUpperCase().replace("0X", "0x") as `0x${string}`),
    ).toBeDefined();
    expect(
      getDelegatedAuthorizer(config, "0x2222222222222222222222222222222222222222"),
    ).toBeUndefined();
  });

  it("returns undefined when delegation is not fully configured", () => {
    expect(getDelegatedAuthorizer(undefined, AUTHORIZER)).toBeUndefined();
    expect(
      getDelegatedAuthorizer({ ...config, delegatedAuthStorage: undefined }, AUTHORIZER),
    ).toBeUndefined();
    expect(
      getDelegatedAuthorizer({ ...config, onStorageError: undefined }, AUTHORIZER),
    ).toBeUndefined();
  });
});

describe("resolveDelegatedCallerIdentity", () => {
  const ctx = { step: "capture" } as DelegatedSettleContext;

  async function resolve(result: () => unknown) {
    const delegated = delegatedWith(new InMemoryAuthCaptureDelegatedAuthStorage());
    delegated.resolveCallerIdentity = vi.fn().mockImplementation(async () => result());
    return resolveDelegatedCallerIdentity(delegated, ctx);
  }

  it("returns a non-empty identity", async () => {
    expect(await resolve(() => "caller-1")).toBe("caller-1");
  });

  it.each([[undefined], [""], [42]])("treats %j as unauthenticated", async value => {
    expect(await resolve(() => value)).toBeUndefined();
  });

  it("treats a thrown error as unauthenticated", async () => {
    expect(
      await resolve(() => {
        throw new Error("boom");
      }),
    ).toBeUndefined();
  });
});

describe("bindThenBroadcast", () => {
  it("broadcasts after a successful bind and keeps the row", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    const broadcast = vi.fn().mockResolvedValue({ value: "ok", disposition: "keep" });
    const result = await bindThenBroadcast({
      delegated: delegatedWith(storage),
      record: record(),
      broadcast,
    });
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(await storage.get("eip155:84532", HASH)).toBeDefined();
  });

  it("reverts the created row when the broadcast asks for it", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    const result = await bindThenBroadcast({
      delegated: delegatedWith(storage),
      record: record(),
      broadcast: async () => ({ value: "failed", disposition: "revert" }),
    });
    expect(result).toEqual({ ok: true, value: "failed" });
    expect(await storage.get("eip155:84532", HASH)).toBeUndefined();
  });

  it("reports a failing revert without replacing the broadcast result", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    vi.spyOn(storage, "revertBind").mockRejectedValue(new Error("db down"));
    const delegated = delegatedWith(storage);
    const result = await bindThenBroadcast({
      delegated,
      record: record(),
      broadcast: async () => ({ value: "failed", disposition: "revert" }),
    });
    expect(result).toEqual({ ok: true, value: "failed" });
    expect(delegated.onStorageError).toHaveBeenCalledWith(expect.any(Error), "eip155:84532", HASH);
  });

  it("does not revert when the broadcast throws, because the outcome is unknown", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    await expect(
      bindThenBroadcast({
        delegated: delegatedWith(storage),
        record: record(),
        broadcast: async () => {
          throw new Error("rpc dropped");
        },
      }),
    ).rejects.toThrow("rpc dropped");
    expect(await storage.get("eip155:84532", HASH)).toBeDefined();
  });

  it("fails closed without broadcasting on an identity conflict", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    await storage.bind(record({ callerIdentity: "someone-else" }));
    const broadcast = vi.fn();
    const result = await bindThenBroadcast({
      delegated: delegatedWith(storage),
      record: record(),
      broadcast,
    });
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(!result.ok && result.error).toBeInstanceOf(AuthCaptureCallerIdentityConflictError);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fails closed without broadcasting when the store is unavailable", async () => {
    const storage = new InMemoryAuthCaptureDelegatedAuthStorage();
    vi.spyOn(storage, "bind").mockRejectedValue(new Error("db down"));
    const broadcast = vi.fn();
    const result = await bindThenBroadcast({
      delegated: delegatedWith(storage),
      record: record(),
      broadcast,
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
