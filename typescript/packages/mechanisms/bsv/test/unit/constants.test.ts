import { describe, it, expect } from "vitest";
import {
  BRC29_PROTOCOL_ID,
  BSV_ASSET_IDENTIFIER,
  BSV_DECIMALS,
  BSV_MAINNET_CAIP2,
  BSV_TESTNET_CAIP2,
  BSV_TTN_CAIP2,
  BSV_TSTN_CAIP2,
  BSV_WILDCARD_CAIP2,
  BSV_NETWORKS,
  COMPRESSED_PUBKEY_REGEX,
  DEFAULT_PAYMENT_WINDOW_MS,
  MAX_SATOSHIS,
  MIN_DERIVATION_PREFIX_BYTES,
  getExplorerTxUrl,
  isBsvNetwork,
  toBsvWalletNetwork,
} from "../../src/constants";

describe("constants", () => {
  it("defines CAIP-2 style identifiers in the bsv namespace", () => {
    expect(BSV_MAINNET_CAIP2).toBe("bsv:mainnet");
    expect(BSV_TESTNET_CAIP2).toBe("bsv:testnet");
    expect(BSV_TTN_CAIP2).toBe("bsv:ttn");
    expect(BSV_TSTN_CAIP2).toBe("bsv:tstn");
    expect(BSV_WILDCARD_CAIP2).toBe("bsv:*");
    expect(BSV_NETWORKS).toEqual(["bsv:mainnet", "bsv:testnet", "bsv:ttn", "bsv:tstn"]);
  });

  it("uses the BRC-29 protocol ID for key derivation", () => {
    expect(BRC29_PROTOCOL_ID).toEqual([2, "3241645161d8"]);
  });

  it("uses native satoshis with 8 decimals", () => {
    expect(BSV_ASSET_IDENTIFIER).toBe("BSV");
    expect(BSV_DECIMALS).toBe(8);
    expect(MAX_SATOSHIS).toBe(2_100_000_000_000_000);
  });

  it("defaults the BRC-121 payment window to 30 seconds", () => {
    expect(DEFAULT_PAYMENT_WINDOW_MS).toBe(30_000);
  });

  it("requires the BRC-29 derivation prefix to be at least 8 bytes", () => {
    expect(MIN_DERIVATION_PREFIX_BYTES).toBe(8);
  });

  it("recognizes only registered BSV networks and refuses ambiguous Bitcoin-family ids", () => {
    expect(isBsvNetwork(BSV_MAINNET_CAIP2)).toBe(true);
    expect(isBsvNetwork(BSV_TESTNET_CAIP2)).toBe(true);
    expect(isBsvNetwork(BSV_TTN_CAIP2)).toBe(true);
    expect(isBsvNetwork(BSV_TSTN_CAIP2)).toBe(true);
    expect(isBsvNetwork("eip155:8453")).toBe(false);
    expect(isBsvNetwork("bsv:other")).toBe(false);
    // Shared genesis is BTC/BCH/BSV-ambiguous — must not be treated as BSV
    expect(isBsvNetwork("bip122:000000000019d6689c085ae165831e93")).toBe(false);
  });

  it("maps CAIP-2 ids to BRC-100 wallet network names", () => {
    expect(toBsvWalletNetwork(BSV_MAINNET_CAIP2)).toBe("mainnet");
    expect(toBsvWalletNetwork(BSV_TESTNET_CAIP2)).toBe("testnet");
    expect(toBsvWalletNetwork(BSV_TTN_CAIP2)).toBe("ttn");
    expect(toBsvWalletNetwork(BSV_TSTN_CAIP2)).toBe("tstn");
    expect(toBsvWalletNetwork("bip122:000000000019d6689c085ae165831e93")).toBeUndefined();
  });

  it("matches compressed public keys", () => {
    expect(COMPRESSED_PUBKEY_REGEX.test("02" + "ab".repeat(32))).toBe(true);
    expect(COMPRESSED_PUBKEY_REGEX.test("03" + "AB".repeat(32))).toBe(true);
    expect(COMPRESSED_PUBKEY_REGEX.test("04" + "ab".repeat(32))).toBe(false);
    expect(COMPRESSED_PUBKEY_REGEX.test("02" + "ab".repeat(31))).toBe(false);
  });

  it("builds explorer URLs per network when a public explorer exists", () => {
    const txid = "ab".repeat(32);
    expect(getExplorerTxUrl(BSV_MAINNET_CAIP2, txid)).toBe(`https://whatsonchain.com/tx/${txid}`);
    expect(getExplorerTxUrl(BSV_TESTNET_CAIP2, txid)).toBe(
      `https://test.whatsonchain.com/tx/${txid}`,
    );
    expect(getExplorerTxUrl(BSV_TTN_CAIP2, txid)).toBe(
      `https://woc-ttn.bsvblockchain.tech/tx/${txid}`,
    );
    expect(getExplorerTxUrl(BSV_TSTN_CAIP2, txid)).toBeUndefined();
    expect(getExplorerTxUrl("eip155:8453", txid)).toBeUndefined();
  });
});
