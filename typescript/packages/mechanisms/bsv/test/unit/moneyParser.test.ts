import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWhatsOnChainMoneyParser } from "../../src/moneyParser";
import {
  BSV_MAINNET_CAIP2,
  BSV_TESTNET_CAIP2,
  WOC_MAINNET_EXCHANGE_RATE_URL,
  WOC_TESTNET_EXCHANGE_RATE_URL,
} from "../../src/constants";
import { ExactBsvScheme } from "../../src/exact/server/scheme";

const NOW = 1_700_000_000_000;

/**
 * Builds a mock fetch returning a WhatsOnChain exchange-rate response.
 *
 * @param rate - USD per BSV
 * @param overrides - Response body overrides
 * @returns A vitest mock compatible with fetch
 */
function mockFetch(rate: number, overrides: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate, time: Math.floor(NOW / 1000), currency: "USD", ...overrides }),
  });
}

describe("createWhatsOnChainMoneyParser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts USD to satoshis at the fetched rate", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    // $0.001 at $20/BSV = 5000 satoshis
    const result = await parser(0.001, BSV_MAINNET_CAIP2);
    expect(result).toEqual({ amount: "5000", asset: "BSV", extra: {} });
  });

  it("rounds to the nearest satoshi", async () => {
    const fetchFn = mockFetch(13.44);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    // 0.001 / 13.44 * 1e8 = 7440.47…
    const result = await parser(0.001, BSV_MAINNET_CAIP2);
    expect(result?.amount).toBe("7440");
  });

  it("clamps dust prices to 1 satoshi", async () => {
    const fetchFn = mockFetch(100);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    const result = await parser(0.0000001, BSV_MAINNET_CAIP2);
    expect(result?.amount).toBe("1");
  });

  it("returns null for non-BSV networks without fetching", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    const result = await parser(1, "eip155:8453");
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("selects the endpoint by network", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    await parser(1, BSV_MAINNET_CAIP2);
    expect(fetchFn).toHaveBeenLastCalledWith(WOC_MAINNET_EXCHANGE_RATE_URL, expect.anything());
    await parser(1, BSV_TESTNET_CAIP2);
    expect(fetchFn).toHaveBeenLastCalledWith(WOC_TESTNET_EXCHANGE_RATE_URL, expect.anything());
  });

  it("honors a custom endpoint URL for all networks", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn, url: "https://rates.example/bsvusd" });
    await parser(1, BSV_TESTNET_CAIP2);
    expect(fetchFn).toHaveBeenCalledWith("https://rates.example/bsvusd", expect.anything());
  });

  it("caches the rate within the TTL", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    await parser(1, BSV_MAINNET_CAIP2);
    vi.advanceTimersByTime(30_000);
    await parser(2, BSV_MAINNET_CAIP2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn, cacheTtlMs: 60_000 });
    await parser(1, BSV_MAINNET_CAIP2);
    vi.advanceTimersByTime(60_001);
    await parser(1, BSV_MAINNET_CAIP2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caches per endpoint, not globally", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    await parser(1, BSV_MAINNET_CAIP2);
    await parser(1, BSV_TESTNET_CAIP2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent fetches", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    const [a, b] = await Promise.all([
      parser(0.001, BSV_MAINNET_CAIP2),
      parser(0.002, BSV_MAINNET_CAIP2),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a?.amount).toBe("5000");
    expect(b?.amount).toBe("10000");
  });

  it("falls back to a stale rate when the refresh fails", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn, cacheTtlMs: 60_000 });
    await parser(1, BSV_MAINNET_CAIP2);
    vi.advanceTimersByTime(120_000);
    fetchFn.mockRejectedValueOnce(new Error("network down"));
    const result = await parser(0.001, BSV_MAINNET_CAIP2);
    expect(result?.amount).toBe("5000");
  });

  it("throws when the refresh fails and the cached rate is too stale", async () => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({
      fetchFn,
      cacheTtlMs: 60_000,
      maxStaleMs: 300_000,
    });
    await parser(1, BSV_MAINNET_CAIP2);
    vi.advanceTimersByTime(300_001);
    fetchFn.mockRejectedValue(new Error("network down"));
    await expect(parser(1, BSV_MAINNET_CAIP2)).rejects.toThrow(/exchange rate/i);
  });

  it("throws when the endpoint fails and nothing is cached", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    await expect(parser(1, BSV_MAINNET_CAIP2)).rejects.toThrow(/exchange rate/i);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid rate %s",
    async rate => {
      const fetchFn = mockFetch(rate as number);
      const parser = createWhatsOnChainMoneyParser({ fetchFn });
      await expect(parser(1, BSV_MAINNET_CAIP2)).rejects.toThrow(/exchange rate/i);
    },
  );

  it("rejects a non-USD rate feed", async () => {
    const fetchFn = mockFetch(20, { currency: "EUR" });
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    await expect(parser(1, BSV_MAINNET_CAIP2)).rejects.toThrow(/USD/);
  });

  it.each([0, -1, Number.NaN])("rejects a non-positive USD amount %s", async usd => {
    const fetchFn = mockFetch(20);
    const parser = createWhatsOnChainMoneyParser({ fetchFn });
    await expect(parser(usd as number, BSV_MAINNET_CAIP2)).rejects.toThrow(/amount/i);
  });

  it("plugs into the server scheme for dollar prices", async () => {
    const fetchFn = mockFetch(20);
    const scheme = new ExactBsvScheme().registerMoneyParser(
      createWhatsOnChainMoneyParser({ fetchFn }),
    );
    const result = await scheme.parsePrice("$0.001", BSV_MAINNET_CAIP2);
    expect(result).toEqual({ amount: "5000", asset: "BSV", extra: {} });
  });
});
