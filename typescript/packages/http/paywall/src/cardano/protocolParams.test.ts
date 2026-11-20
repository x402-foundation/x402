import { Client, preprod } from "@evolution-sdk/evolution";
import {
  assertCip30ProtocolParametersInBounds,
  CARDANO_MAINNET_CAIP2,
  CARDANO_MAINNET_CIP34,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREPROD_CIP34,
  CARDANO_PREVIEW_CAIP2,
  CARDANO_PREVIEW_CIP34,
  CIP30_PROTOCOL_PARAMETER_BOUNDS,
} from "@x402/cardano";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/koios-epoch-params-preprod.json";
import { toCip30ProtocolParameters } from "./params";
import {
  canonicalCardanoNetwork,
  CARDANO_CIP34_ALIASES,
  INJECTED_PARAMETER_BOUNDS,
  KoiosProtocolParamsCache,
  mapKoiosEpochParams,
} from "./protocolParams";

const ROW = fixture[0] as Record<string, unknown>;

/**
 * A fetch stub answering Koios with the given body.
 *
 * @param body - JSON body or a function computing it.
 * @param status - HTTP status.
 * @returns Mock fetch.
 */
function koiosFetch(body: unknown = fixture, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mapKoiosEpochParams", () => {
  it("maps a real Koios row exactly like the Evolution SDK's Koios provider", async () => {
    vi.stubGlobal("fetch", koiosFetch());
    const evolution = await Client.make(preprod)
      .withKoios({ baseUrl: "https://koios.test/api/v1" })
      .getProtocolParameters();
    const mapped = mapKoiosEpochParams(ROW, 1);
    expect(mapped).toBeDefined();
    expect(toCip30ProtocolParameters(mapped!)).toEqual(evolution);
  });

  it("produces parameters the CIP-30 signer accepts", () => {
    const mapped = mapKoiosEpochParams(ROW, 1)!;
    expect(() =>
      assertCip30ProtocolParametersInBounds(toCip30ProtocolParameters(mapped)),
    ).not.toThrow();
    expect(mapped.epochNo).toBe(ROW.epoch_no);
  });

  it.each([
    ["a missing field", { min_fee_a: undefined }],
    ["a non-numeric field", { coins_per_utxo_size: "lots" }],
    ["a missing cost model", { cost_models: { PlutusV1: [1], PlutusV2: [1] } }],
    [
      "a non-integer cost model",
      { cost_models: { PlutusV1: [1.5], PlutusV2: [1], PlutusV3: [1] } },
    ],
    ["an inflated coins_per_utxo_size", { coins_per_utxo_size: "400000" }],
    ["an inflated min_fee_a", { min_fee_a: 4400 }],
    ["a negative price", { price_mem: -1 }],
  ])("rejects a row with %s", (_label, patch) => {
    expect(mapKoiosEpochParams({ ...ROW, ...patch }, 1)).toBeUndefined();
  });

  it("rejects non-objects", () => {
    expect(mapKoiosEpochParams(null, 1)).toBeUndefined();
    expect(mapKoiosEpochParams("row", 1)).toBeUndefined();
  });

  it("keeps its bounds identical to the signer's", () => {
    expect(INJECTED_PARAMETER_BOUNDS).toEqual(CIP30_PROTOCOL_PARAMETER_BOUNDS);
  });
});

describe("canonicalCardanoNetwork", () => {
  it("accepts canonical ids and the same CIP-34 aliases as @x402/cardano", () => {
    expect(CARDANO_CIP34_ALIASES).toEqual({
      [CARDANO_MAINNET_CIP34]: CARDANO_MAINNET_CAIP2,
      [CARDANO_PREPROD_CIP34]: CARDANO_PREPROD_CAIP2,
      [CARDANO_PREVIEW_CIP34]: CARDANO_PREVIEW_CAIP2,
    });
    expect(canonicalCardanoNetwork("cardano:preprod")).toBe("cardano:preprod");
    expect(canonicalCardanoNetwork("CIP34:0-1")).toBe("cardano:preprod");
    expect(canonicalCardanoNetwork("cardano:testnet")).toBeUndefined();
    expect(canonicalCardanoNetwork("eip155:8453")).toBeUndefined();
  });
});

describe("KoiosProtocolParamsCache", () => {
  it("returns null while cold, fetches once, then serves the cached value", async () => {
    const fetch = koiosFetch();
    const cache = new KoiosProtocolParamsCache({ fetch, now: () => 1_000 });
    expect(cache.get("cardano:preprod")).toBeNull();
    expect(cache.get("cip34:0-1")).toBeNull();
    await cache.prefetch(["cardano:preprod"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://preprod.koios.rest/api/v1/epoch_params?limit=1&order=epoch_no.desc",
    );
    expect(cache.get("cardano:preprod")?.minFeeA).toBe(44);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves a stale value while refreshing, and drops it after the maximum age", async () => {
    let now = 0;
    const fetch = koiosFetch();
    const cache = new KoiosProtocolParamsCache({
      fetch,
      now: () => now,
      cacheTtlMs: 100,
      maxStaleMs: 1_000,
    });
    await cache.prefetch(["cardano:preprod"]);
    now = 500;
    fetch.mockImplementationOnce(async () => new Response("oops", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cache.get("cardano:preprod")).not.toBeNull();
    await cache.prefetch(["cardano:preprod"]);
    now = 1_200;
    fetch.mockImplementation(async () => new Response("oops", { status: 503 }));
    expect(cache.get("cardano:preprod")).toBeNull();
  });

  it("does not inject malformed or out-of-bounds Koios data", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new KoiosProtocolParamsCache({
      fetch: koiosFetch([{ ...ROW, coins_per_utxo_size: "400000" }]),
    });
    await cache.prefetch(["cardano:preprod"]);
    expect(cache.get("cardano:preprod")).toBeNull();
    const empty = new KoiosProtocolParamsCache({ fetch: koiosFetch([]) });
    await empty.prefetch(["cardano:preprod"]);
    expect(empty.get("cardano:preprod")).toBeNull();
  });

  it("de-duplicates concurrent refreshes and logs a failure once per TTL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response("down", { status: 500 }));
    const cache = new KoiosProtocolParamsCache({ fetch, now: () => 0 });
    await Promise.all([cache.prefetch(["cardano:preprod"]), cache.prefetch(["cip34:0-1"])]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.prefetch(["cardano:preprod"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses configured base URLs and sends the token only to Koios", async () => {
    const fetch = koiosFetch();
    const cache = new KoiosProtocolParamsCache({
      fetch,
      koiosBaseUrls: { "cardano:preview": "https://my-koios.example/api/v1" },
      koiosToken: "secret-token",
    });
    await cache.prefetch(["cardano:preview"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith("https://my-koios.example/api/v1/epoch_params")).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(init.signal).toBeDefined();
  });

  it("prefetches all three networks by default and ignores unknown ones", async () => {
    const fetch = koiosFetch();
    const cache = new KoiosProtocolParamsCache({ fetch });
    await cache.prefetch();
    await cache.prefetch(["cardano:unknown"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.get("cardano:unknown")).toBeNull();
  });

  it("falls back to the global fetch", async () => {
    const fetch = koiosFetch();
    vi.stubGlobal("fetch", fetch);
    await new KoiosProtocolParamsCache().prefetch(["cardano:mainnet"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
