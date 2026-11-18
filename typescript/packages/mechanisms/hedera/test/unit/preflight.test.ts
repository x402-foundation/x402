import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHederaPreflightTransfer } from "../../src/preflight";

const BASE = "https://mirror.test";
const HBAR = "0.0.0";
const TOKEN = "0.0.6001";
const PAYER = "0.0.9001";
const PAY_TO = "0.0.7001";

function mockFetch(handler: (url: string) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = handler(url);
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function preflight(params: { payer?: string; payTo?: string; asset: string; amount: string }) {
  return createHederaPreflightTransfer({ mirrorNodeUrl: BASE })({
    payer: params.payer ?? PAYER,
    payTo: params.payTo ?? PAY_TO,
    asset: params.asset,
    amount: params.amount,
    network: "hedera:testnet",
  });
}

describe("createHederaPreflightTransfer (Mirror Node)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HBAR: ok when payer balance >= amount", async () => {
    const fetchFn = mockFetch(url =>
      url.endsWith(`/accounts/${PAYER}`)
        ? { balance: { balance: 5000 }, max_automatic_token_associations: 0 }
        : undefined,
    );
    const r = await preflight({ asset: HBAR, amount: "1000" });
    expect(r).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/api/v1/accounts/${PAYER}`);
  });

  it("HBAR: insufficient_balance when payer short", async () => {
    mockFetch(url =>
      url.endsWith(`/accounts/${PAYER}`)
        ? { balance: { balance: 500 }, max_automatic_token_associations: 0 }
        : undefined,
    );
    const r = await preflight({ asset: HBAR, amount: "1000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_balance");
    expect(r.message).toContain("500");
  });

  it("HTS: insufficient token balance", async () => {
    mockFetch(url =>
      url.includes(`/accounts/${PAYER}/tokens`)
        ? {
            tokens: [{ token_id: TOKEN, balance: 100, automatic_association: false }],
            links: { next: null },
          }
        : undefined,
    );
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_balance");
  });

  it("HTS: insufficient_balance when payer holds none of the token", async () => {
    mockFetch(url =>
      url.includes(`/accounts/${PAYER}/tokens`) ? { tokens: [], links: { next: null } } : undefined,
    );
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_balance");
  });

  it("HTS: ok when payTo already associated", async () => {
    mockFetch(url => {
      if (url.includes(`/accounts/${PAYER}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 5000, automatic_association: false }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 0, automatic_association: false }],
          links: { next: null },
        };
      }
      return undefined;
    });
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r).toEqual({ ok: true });
  });

  it("HTS: ok when payTo has unlimited auto-association (-1)", async () => {
    mockFetch(url => {
      if (url.includes(`/accounts/${PAYER}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 5000, automatic_association: false }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens`)) {
        return { tokens: [], links: { next: null } };
      }
      if (url.endsWith(`/accounts/${PAY_TO}`)) {
        return { balance: { balance: 0 }, max_automatic_token_associations: -1 };
      }
      return undefined;
    });
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r).toEqual({ ok: true });
  });

  it("HTS: ok when payTo has an available auto-association slot", async () => {
    mockFetch(url => {
      if (url.includes(`/accounts/${PAYER}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 5000, automatic_association: false }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens?token.id=`)) {
        return { tokens: [], links: { next: null } };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens`)) {
        return {
          tokens: [{ token_id: "0.0.1", balance: 1, automatic_association: true }],
          links: { next: null },
        };
      }
      if (url.endsWith(`/accounts/${PAY_TO}`)) {
        return { balance: { balance: 0 }, max_automatic_token_associations: 3 };
      }
      return undefined;
    });
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r).toEqual({ ok: true });
  });

  it("HTS: pay_to_not_associated when no association and no slots", async () => {
    mockFetch(url => {
      if (url.includes(`/accounts/${PAYER}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 5000, automatic_association: false }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens`)) {
        return { tokens: [], links: { next: null } };
      }
      if (url.endsWith(`/accounts/${PAY_TO}`)) {
        return { balance: { balance: 0 }, max_automatic_token_associations: 0 };
      }
      return undefined;
    });
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("pay_to_not_associated");
  });

  it("HTS: pay_to_not_associated when auto slots fully consumed", async () => {
    mockFetch(url => {
      if (url.includes(`/accounts/${PAYER}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 5000, automatic_association: false }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens?token.id=`)) {
        return { tokens: [], links: { next: null } };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens`)) {
        return {
          tokens: [
            { token_id: "0.0.1", balance: 1, automatic_association: true },
            { token_id: "0.0.2", balance: 1, automatic_association: true },
          ],
          links: { next: null },
        };
      }
      if (url.endsWith(`/accounts/${PAY_TO}`)) {
        return { balance: { balance: 0 }, max_automatic_token_associations: 2 };
      }
      return undefined;
    });
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("pay_to_not_associated");
  });

  it("HTS: follows links.next when counting consumed auto-association slots", async () => {
    const fetchFn = mockFetch(url => {
      if (url.includes(`/accounts/${PAYER}/tokens`)) {
        return {
          tokens: [{ token_id: TOKEN, balance: 5000, automatic_association: false }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens?token.id=`)) {
        return { tokens: [], links: { next: null } };
      }
      if (url.includes("page=2")) {
        return {
          tokens: [{ token_id: "0.0.3", balance: 1, automatic_association: true }],
          links: { next: null },
        };
      }
      if (url.includes(`/accounts/${PAY_TO}/tokens`)) {
        return {
          tokens: [
            { token_id: "0.0.1", balance: 1, automatic_association: true },
            { token_id: "0.0.2", balance: 1, automatic_association: true },
          ],
          links: { next: `/api/v1/accounts/${PAY_TO}/tokens?page=2` },
        };
      }
      if (url.endsWith(`/accounts/${PAY_TO}`)) {
        return { balance: { balance: 0 }, max_automatic_token_associations: 5 };
      }
      return undefined;
    });
    const r = await preflight({ asset: TOKEN, amount: "1000" });
    expect(r).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/api/v1/accounts/${PAY_TO}/tokens?page=2`);
  });

  it("encodes interpolated path segments before hitting the Mirror Node", async () => {
    const weirdAsset = "0.0.6001 evil/path";
    const fetchFn = mockFetch(url =>
      url.includes("/tokens")
        ? {
            tokens: [{ token_id: weirdAsset, balance: 5000, automatic_association: false }],
            links: { next: null },
          }
        : undefined,
    );
    await preflight({ asset: weirdAsset, amount: "1000" });
    const requestedUrl = String(fetchFn.mock.calls[0][0]);
    expect(requestedUrl).toContain(`token.id=${encodeURIComponent(weirdAsset)}`);
    expect(requestedUrl).not.toContain(" ");
  });

  it("throws when the Mirror Node returns a non-2xx status", async () => {
    mockFetch(() => undefined);
    await expect(preflight({ asset: HBAR, amount: "1000" })).rejects.toThrow(
      "Mirror Node request failed",
    );
  });
});
