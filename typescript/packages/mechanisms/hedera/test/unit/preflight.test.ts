import { beforeEach, describe, expect, it, vi } from "vitest";

const balanceExecute = vi.fn();
const infoExecute = vi.fn();
const setBalanceAccountId = vi.fn(function (this: unknown) {
  return this;
});
const setInfoAccountId = vi.fn(function (this: unknown) {
  return this;
});

vi.mock("@hiero-ledger/sdk", async () => {
  const actual = await vi.importActual<typeof import("@hiero-ledger/sdk")>("@hiero-ledger/sdk");
  class AccountBalanceQuery {
    setAccountId = setBalanceAccountId;
    execute = balanceExecute;
  }
  class AccountInfoQuery {
    setAccountId = setInfoAccountId;
    execute = infoExecute;
  }
  return { ...actual, AccountBalanceQuery, AccountInfoQuery };
});

// Import after mock is registered.
import { createHederaPreflightTransfer } from "../../src/preflight";

const HBAR = "0.0.0";
const TOKEN = "0.0.6001";

function fakeClient() {
  return { close: vi.fn() } as unknown as import("@hiero-ledger/sdk").Client;
}

function hbarBalance(tinybars: bigint) {
  return {
    hbars: { toTinybars: () => ({ toString: () => tinybars.toString() }) },
    tokens: undefined,
  };
}

function tokenBalance(tokenId: string, amount: bigint) {
  return {
    hbars: { toTinybars: () => ({ toString: () => "0" }) },
    tokens: {
      get: (tid: { toString(): string }) =>
        tid.toString() === tokenId ? { toString: () => amount.toString() } : undefined,
    },
  };
}

function accountInfo(opts: { tokens?: Array<{ id: string; auto: boolean }>; maxAuto?: number }) {
  const entries = opts.tokens ?? [];
  const relationships = new Map<string, { automaticAssociation: boolean }>();
  for (const e of entries) {
    relationships.set(e.id, { automaticAssociation: e.auto });
  }
  return {
    // Real SDK uses Map<TokenId, TokenRelationship>; we key by string and
    // normalize TokenId via toString() on lookups from the helper.
    tokenRelationships: {
      get: (tid: { toString(): string }) => relationships.get(tid.toString()),
      values: () => relationships.values(),
    },
    maxAutomaticTokenAssociations: { toNumber: () => opts.maxAuto ?? 0 },
  };
}

describe("createHederaPreflightTransfer", () => {
  let client: ReturnType<typeof fakeClient>;
  let build: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    balanceExecute.mockReset();
    infoExecute.mockReset();
    setBalanceAccountId.mockClear();
    setInfoAccountId.mockClear();
    client = fakeClient();
    build = vi.fn(() => client);
  });

  it("HBAR: ok when payer balance >= amount", async () => {
    balanceExecute.mockResolvedValue(hbarBalance(5000n));
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: HBAR,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r).toEqual({ ok: true });
    expect((client as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it("HBAR: insufficient_balance when payer short", async () => {
    balanceExecute.mockResolvedValue(hbarBalance(500n));
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: HBAR,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_balance");
    expect(r.message).toContain("500");
  });

  it("HTS: insufficient token balance", async () => {
    balanceExecute.mockResolvedValue(tokenBalance(TOKEN, 100n));
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_balance");
  });

  it("HTS: ok when payTo already associated", async () => {
    balanceExecute.mockResolvedValue(tokenBalance(TOKEN, 5000n));
    infoExecute.mockResolvedValue(
      accountInfo({ tokens: [{ id: TOKEN, auto: false }], maxAuto: 0 }),
    );
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r).toEqual({ ok: true });
  });

  it("HTS: ok when payTo has unlimited auto-association (-1)", async () => {
    balanceExecute.mockResolvedValue(tokenBalance(TOKEN, 5000n));
    infoExecute.mockResolvedValue(accountInfo({ tokens: [], maxAuto: -1 }));
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r).toEqual({ ok: true });
  });

  it("HTS: ok when payTo has available auto-association slot", async () => {
    balanceExecute.mockResolvedValue(tokenBalance(TOKEN, 5000n));
    infoExecute.mockResolvedValue(
      accountInfo({ tokens: [{ id: "0.0.9999", auto: true }], maxAuto: 3 }),
    );
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r).toEqual({ ok: true });
  });

  it("HTS: pay_to_not_associated when no association and no slots", async () => {
    balanceExecute.mockResolvedValue(tokenBalance(TOKEN, 5000n));
    infoExecute.mockResolvedValue(accountInfo({ tokens: [], maxAuto: 0 }));
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("pay_to_not_associated");
  });

  it("HTS: pay_to_not_associated when auto slots fully consumed", async () => {
    balanceExecute.mockResolvedValue(tokenBalance(TOKEN, 5000n));
    infoExecute.mockResolvedValue(
      accountInfo({
        tokens: [
          { id: "0.0.1", auto: true },
          { id: "0.0.2", auto: true },
        ],
        maxAuto: 2,
      }),
    );
    const preflight = createHederaPreflightTransfer(build);
    const r = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("pay_to_not_associated");
  });

  it("closes the client even when a query throws", async () => {
    balanceExecute.mockRejectedValue(new Error("mirror down"));
    const preflight = createHederaPreflightTransfer(build);
    await expect(
      preflight({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        asset: HBAR,
        amount: "1000",
        network: "hedera:testnet",
      }),
    ).rejects.toThrow("mirror down");
    expect((client as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });
});
