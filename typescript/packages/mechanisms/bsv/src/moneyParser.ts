import type { MoneyParser, Network } from "@x402/core/types";
import {
  BSV_ASSET_IDENTIFIER,
  BSV_DECIMALS,
  BSV_TESTNET_CAIP2,
  MAX_SATOSHIS,
  WOC_MAINNET_EXCHANGE_RATE_URL,
  WOC_TESTNET_EXCHANGE_RATE_URL,
  isBsvNetwork,
} from "./constants";

export interface WhatsOnChainMoneyParserOptions {
  /**
   * Exchange-rate endpoint used for every network, overriding the default
   * per-network WhatsOnChain URLs. Must return WhatsOnChain's response
   * shape: `{ "rate": number, "time": number, "currency": "USD" }`.
   */
  url?: string;

  /**
   * How long a fetched rate is served without refreshing.
   *
   * @default 60000
   */
  cacheTtlMs?: number;

  /**
   * When a refresh fails, a previously fetched rate is still used if it is
   * younger than this. Beyond it the parser throws instead of pricing off
   * a stale rate.
   *
   * @default 600000
   */
  maxStaleMs?: number;

  /** Fetch implementation override (testing / custom agents) */
  fetchFn?: typeof fetch;
}

interface CachedRate {
  usdPerBsv: number;
  fetchedAt: number;
}

/**
 * Creates a {@link MoneyParser} that converts USD prices to satoshis using
 * the WhatsOnChain exchange-rate API.
 *
 * Register it on the BSV server scheme to accept dollar-denominated route
 * prices (`price: "$0.001"`) like other chains:
 *
 * ```typescript
 * import { createWhatsOnChainMoneyParser } from "@x402/bsv";
 * import { ExactBsvScheme } from "@x402/bsv/exact/server";
 *
 * const scheme = new ExactBsvScheme().registerMoneyParser(
 *   createWhatsOnChainMoneyParser(),
 * );
 * ```
 *
 * Rates are cached per endpoint (default 60 s) with a bounded stale
 * fallback so a transient rate-feed outage does not take pricing down.
 * Because the x402 `exact` scheme pins the satoshi amount at
 * challenge time, the client pays the rate in effect when the 402 was
 * issued — rate movement between challenge and settlement is borne by the
 * operator, which is why small per-request prices are the intended use.
 *
 * @param options - Endpoint, cache, and fetch overrides
 * @returns A money parser for `ExactBsvScheme.registerMoneyParser`
 */
export function createWhatsOnChainMoneyParser(
  options: WhatsOnChainMoneyParserOptions = {},
): MoneyParser {
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const maxStaleMs = options.maxStaleMs ?? 600_000;
  const fetchFn = options.fetchFn ?? fetch;

  const cache = new Map<string, CachedRate>();
  const inflight = new Map<string, Promise<number>>();

  /**
   * Fetches and validates the USD/BSV rate from the endpoint.
   *
   * @param url - Exchange-rate endpoint
   * @returns USD per BSV
   */
  async function fetchRate(url: string): Promise<number> {
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`BSV exchange rate request failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { rate?: unknown; currency?: unknown };
    if (typeof body.currency === "string" && body.currency.toUpperCase() !== "USD") {
      throw new Error(`BSV exchange rate feed returned currency "${body.currency}", expected USD`);
    }
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`BSV exchange rate feed returned an invalid rate: ${String(body.rate)}`);
    }
    return rate;
  }

  /**
   * Returns the cached rate, refreshing it when expired. Falls back to a
   * bounded-stale cached rate when the refresh fails.
   *
   * @param url - Exchange-rate endpoint
   * @returns USD per BSV
   */
  async function getRate(url: string): Promise<number> {
    const cached = cache.get(url);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= cacheTtlMs) {
      return cached.usdPerBsv;
    }

    let pending = inflight.get(url);
    if (!pending) {
      pending = fetchRate(url).finally(() => inflight.delete(url));
      inflight.set(url, pending);
    }

    try {
      const usdPerBsv = await pending;
      cache.set(url, { usdPerBsv, fetchedAt: Date.now() });
      return usdPerBsv;
    } catch (err) {
      if (cached && Date.now() - cached.fetchedAt <= maxStaleMs) {
        return cached.usdPerBsv;
      }
      throw new Error(
        `BSV exchange rate unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return async (amount: string | number, network: Network) => {
    if (!isBsvNetwork(network)) {
      return null;
    }

    const usd = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error(`Price amount must be a positive number of dollars, got ${String(amount)}`);
    }

    const url =
      options.url ??
      (network === BSV_TESTNET_CAIP2
        ? WOC_TESTNET_EXCHANGE_RATE_URL
        : WOC_MAINNET_EXCHANGE_RATE_URL);

    const usdPerBsv = await getRate(url);

    // Satoshis, clamped to a 1-satoshi floor so sub-dust dollar prices
    // still produce a payable amount. This uses IEEE-754 float arithmetic,
    // which is exact enough for the per-request micro-payments x402 targets;
    // for large fiat amounts a fixed-point conversion would be preferable.
    const satoshis = Math.max(1, Math.round((usd / usdPerBsv) * 10 ** BSV_DECIMALS));
    if (satoshis > MAX_SATOSHIS) {
      throw new Error(`Price ${usd} USD exceeds the maximum representable satoshi amount`);
    }

    return { amount: String(satoshis), asset: BSV_ASSET_IDENTIFIER, extra: {} };
  };
}
