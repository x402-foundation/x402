import { describe, expect, it } from "vitest";
import {
  CARDANO_ADDRESS_REGEX,
  CARDANO_ASSET_REGEX,
  CARDANO_MAINNET_CAIP2,
  CARDANO_MAINNET_CIP34,
  CARDANO_NETWORKS,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREPROD_CIP34,
  CARDANO_PREVIEW_CAIP2,
  CARDANO_PREVIEW_CIP34,
  CARDANO_UTXO_REF_REGEX,
  ERR_NETWORK_MISMATCH,
  getCardanoNetworkId,
  isCardanoNetwork,
  normalizeCardanoNetwork,
  SCHEME_EXACT,
  USDM_MAINNET_ASSET,
  USDM_MAINNET_POLICY_ID,
} from "../../src/constants";

describe("Cardano Constants", () => {
  it("declares the spec network identifiers verbatim", () => {
    expect(CARDANO_MAINNET_CAIP2).toBe("cardano:mainnet");
    expect(CARDANO_PREPROD_CAIP2).toBe("cardano:preprod");
    expect(CARDANO_PREVIEW_CAIP2).toBe("cardano:preview");
    expect(CARDANO_NETWORKS).toEqual([
      CARDANO_MAINNET_CAIP2,
      CARDANO_PREPROD_CAIP2,
      CARDANO_PREVIEW_CAIP2,
    ]);
  });

  it("uses 'exact' as the scheme identifier", () => {
    expect(SCHEME_EXACT).toBe("exact");
  });

  it("provides USDM defaults that match the spec example", () => {
    expect(USDM_MAINNET_POLICY_ID).toHaveLength(56);
    expect(USDM_MAINNET_ASSET).toBe(
      "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d",
    );
  });

  it("maps networks to Cardano network ids", () => {
    expect(getCardanoNetworkId(CARDANO_MAINNET_CAIP2)).toBe(1);
    expect(getCardanoNetworkId(CARDANO_PREPROD_CAIP2)).toBe(0);
    expect(getCardanoNetworkId(CARDANO_PREVIEW_CAIP2)).toBe(0);
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

  it("exposes a stable network mismatch error code", () => {
    expect(ERR_NETWORK_MISMATCH).toBe("network_mismatch");
  });
});

describe("CIP-34 network aliases", () => {
  it("declares the CIP-34 identifiers verbatim", () => {
    expect(CARDANO_MAINNET_CIP34).toBe("cip34:1-764824073");
    expect(CARDANO_PREPROD_CIP34).toBe("cip34:0-1");
    expect(CARDANO_PREVIEW_CIP34).toBe("cip34:0-2");
  });

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

  it("maps CIP-34 aliases to the correct Cardano network id", () => {
    expect(getCardanoNetworkId(CARDANO_MAINNET_CIP34)).toBe(1);
    expect(getCardanoNetworkId(CARDANO_PREPROD_CIP34)).toBe(0);
    expect(getCardanoNetworkId(CARDANO_PREVIEW_CIP34)).toBe(0);
  });
});
