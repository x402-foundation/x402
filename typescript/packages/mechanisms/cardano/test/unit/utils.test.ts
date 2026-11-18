import { describe, expect, it } from "vitest";
import {
  decodeCardanoPayload,
  decodeCardanoTransactionBytes,
  minUtxoLovelace,
  parseAssetUnit,
  parseUtxoRef,
} from "../../src/utils";
import { MAX_CARDANO_TRANSACTION_BYTES } from "../../src/limits";

const ASSET = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d";
const TX_HASH = "a".repeat(64);

describe("Cardano Utils", () => {
  it("parses asset units", () => {
    expect(parseAssetUnit(ASSET)).toEqual({
      policyId: "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad",
      assetNameHex: "0014df105553444d",
    });
    expect(() => parseAssetUnit("not-an-asset")).toThrow();
  });

  it("parses UTXO refs", () => {
    expect(parseUtxoRef(`${TX_HASH}#3`)).toEqual({ txHash: TX_HASH, index: 3 });
    expect(() => parseUtxoRef(`${TX_HASH}#-1`)).toThrow();
  });

  it("decodes payloads and rejects malformed ones", () => {
    const decoded = decodeCardanoPayload({ transaction: "tx", nonce: `${TX_HASH}#0` });
    expect(decoded).toEqual({ transaction: "tx", nonce: `${TX_HASH}#0` });
    expect(() => decodeCardanoPayload({})).toThrow();
    expect(() => decodeCardanoPayload({ transaction: "tx" })).toThrow();
  });

  it("parses the lovelace asset unit", () => {
    expect(parseAssetUnit("lovelace")).toEqual({ policyId: "", assetNameHex: "" });
  });

  it("computes min-UTXO lovelace as (160 + size) * coinsPerUtxoByte", () => {
    expect(minUtxoLovelace(0, 4310n)).toBe(160n * 4310n);
    expect(minUtxoLovelace(64, 4310n)).toBe(224n * 4310n);
  });

  it("strictly bounds and canonicalizes transaction base64", () => {
    expect(decodeCardanoTransactionBytes(Buffer.from([1, 2, 3]).toString("base64"))).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    expect(() => decodeCardanoTransactionBytes("AQID!ignored")).toThrow(/canonical padded base64/);
    expect(() =>
      decodeCardanoPayload({
        transaction: "A".repeat(Math.ceil(MAX_CARDANO_TRANSACTION_BYTES / 3) * 4 + 4),
        nonce: `${TX_HASH}#0`,
      }),
    ).toThrow(/decode limit/);
  });
});
