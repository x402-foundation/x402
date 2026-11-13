import { describe, expect, it } from "vitest";
import {
  CARDANO_ADDRESS_REGEX,
  CARDANO_ASSET_REGEX,
  CARDANO_MAINNET_CAIP2,
  CARDANO_MAINNET_CIP34,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREPROD_CIP34,
  CARDANO_PREVIEW_CAIP2,
  CARDANO_PREVIEW_CIP34,
  CARDANO_UTXO_REF_REGEX,
  getCardanoNetworkId,
  isCardanoNetwork,
  normalizeCardanoNetwork,
  USDM_MAINNET_ASSET,
} from "../../src/constants";

describe("Cardano Constants", () => {
  it("rejects non-Cardano networks", () => {
    expect(() => getCardanoNetworkId("ethereum:1")).toThrow(/Unsupported Cardano network/);
  });

  it("recognises Cardano networks via isCardanoNetwork", () => {
    expect(isCardanoNetwork("cardano:mainnet")).toBe(true);
    expect(isCardanoNetwork("cardano:preprod")).toBe(true);
    expect(isCardanoNetwork("cardano:preview")).toBe(true);
    expect(isCardanoNetwork("cardano:mainnet-foo")).toBe(false);
    expect(isCardanoNetwork("ethereum:1")).toBe(false);
  });

  it("validates Cardano asset units", () => {
    expect(CARDANO_ASSET_REGEX.test(USDM_MAINNET_ASSET)).toBe(true);
    expect(CARDANO_ASSET_REGEX.test("lovelace")).toBe(true);
    expect(
      CARDANO_ASSET_REGEX.test("c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad."),
    ).toBe(true);
    expect(CARDANO_ASSET_REGEX.test("notapolicy.0014df105553444d")).toBe(false);
    expect(
      CARDANO_ASSET_REGEX.test("c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad"),
    ).toBe(false);
  });

  it("validates Cardano payment addresses", () => {
    expect(CARDANO_ADDRESS_REGEX.test("addr1qxabcdefghijklmnpqrstuvwxyz0123456789")).toBe(true);
    expect(CARDANO_ADDRESS_REGEX.test("addr_test1qxabc1234567890")).toBe(true);
    expect(CARDANO_ADDRESS_REGEX.test("Ae2tdPwUPEZ123")).toBe(false);
    expect(CARDANO_ADDRESS_REGEX.test("0xabc")).toBe(false);
  });

  it("validates UTXO references", () => {
    const validRef = `${"a".repeat(64)}#0`;
    expect(CARDANO_UTXO_REF_REGEX.test(validRef)).toBe(true);
    expect(CARDANO_UTXO_REF_REGEX.test(`${"a".repeat(63)}#0`)).toBe(false);
    expect(CARDANO_UTXO_REF_REGEX.test(`${"a".repeat(64)}#`)).toBe(false);
    expect(CARDANO_UTXO_REF_REGEX.test(`${"a".repeat(64)}#-1`)).toBe(false);
  });
});

describe("CIP-34 network aliases", () => {
  it("normalizes CIP-34 aliases to the canonical id", () => {
    expect(normalizeCardanoNetwork(CARDANO_MAINNET_CIP34)).toBe(CARDANO_MAINNET_CAIP2);
    expect(normalizeCardanoNetwork(CARDANO_PREPROD_CIP34)).toBe(CARDANO_PREPROD_CAIP2);
    expect(normalizeCardanoNetwork(CARDANO_PREVIEW_CIP34)).toBe(CARDANO_PREVIEW_CAIP2);
  });

  it("passes canonical and unknown networks through unchanged", () => {
    expect(normalizeCardanoNetwork(CARDANO_MAINNET_CAIP2)).toBe(CARDANO_MAINNET_CAIP2);
    expect(normalizeCardanoNetwork("ethereum:1")).toBe("ethereum:1");
    expect(normalizeCardanoNetwork("cip34:9-9")).toBe("cip34:9-9");
  });

  it("accepts CIP-34 aliases via isCardanoNetwork but rejects unknown cip34 forms", () => {
    expect(isCardanoNetwork(CARDANO_MAINNET_CIP34)).toBe(true);
    expect(isCardanoNetwork(CARDANO_PREPROD_CIP34)).toBe(true);
    expect(isCardanoNetwork(CARDANO_PREVIEW_CIP34)).toBe(true);
    expect(isCardanoNetwork("cip34:9-9")).toBe(false);
  });
});
