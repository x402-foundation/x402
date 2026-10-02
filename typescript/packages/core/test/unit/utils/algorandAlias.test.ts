import { describe, expect, it } from "vitest";
import { findByNetworkAndScheme, type NetworkEquivalents } from "../../../src/utils";
import { Network } from "../../../src/types";

const TESTNET_CAIP = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" as Network;
const TESTNET_LEGACY = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as Network;
const MAINNET_CAIP = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k" as Network;

const aliases: NetworkEquivalents = network => {
  const pairs = [
    [TESTNET_CAIP, TESTNET_LEGACY],
    [MAINNET_CAIP, "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="],
  ];
  for (const pair of pairs) {
    if (network === pair[0] || network === pair[1]) return pair;
  }
  return [network];
};

function schemeMap(entries: Array<[string, string]>) {
  const map = new Map<string, Map<string, string>>();
  for (const [network, value] of entries) {
    map.set(network, new Map([["exact", value]]));
  }
  return map;
}

describe("findByNetworkAndScheme aliases", () => {
  it("keeps identity lookup when no hook is supplied", () => {
    const map = schemeMap([[TESTNET_LEGACY, "legacy"]]);
    expect(findByNetworkAndScheme(map, "exact", TESTNET_CAIP)).toBeUndefined();
    expect(findByNetworkAndScheme(map, "exact", TESTNET_LEGACY)).toBe("legacy");
  });

  it("resolves the other published form and keeps the requested key when both exist", () => {
    const legacyOnly = schemeMap([[TESTNET_LEGACY, "legacy"]]);
    expect(findByNetworkAndScheme(legacyOnly, "exact", TESTNET_CAIP, aliases)).toBe("legacy");
    const both = schemeMap([
      [TESTNET_CAIP, "canonical"],
      [TESTNET_LEGACY, "legacy"],
    ]);
    expect(findByNetworkAndScheme(both, "exact", TESTNET_CAIP, aliases)).toBe("canonical");
    expect(findByNetworkAndScheme(both, "exact", TESTNET_LEGACY, aliases)).toBe("legacy");
  });

  it("fails closed on two different alias maps and leaves other networks alone", () => {
    const map = schemeMap([
      ["algorand:one", "a"],
      ["algorand:two", "b"],
      ["eip155:8453", "base"],
    ]);
    const ambiguous: NetworkEquivalents = () => ["algorand:one", "algorand:two"];
    expect(
      findByNetworkAndScheme(map, "exact", "algorand:missing" as Network, ambiguous),
    ).toBeUndefined();
    expect(findByNetworkAndScheme(map, "exact", "eip155:8453" as Network, aliases)).toBe("base");
    expect(findByNetworkAndScheme(map, "exact", "eip155:999" as Network, aliases)).toBeUndefined();
    const wildcard = schemeMap([["eip155:*", "any-evm"]]);
    expect(findByNetworkAndScheme(wildcard, "exact", "eip155:8453" as Network, aliases)).toBe(
      "any-evm",
    );
    expect(
      findByNetworkAndScheme(
        schemeMap([[TESTNET_LEGACY, "legacy"]]),
        "exact",
        "algorand:not-a-published-tail" as Network,
        aliases,
      ),
    ).toBeUndefined();
  });
});
