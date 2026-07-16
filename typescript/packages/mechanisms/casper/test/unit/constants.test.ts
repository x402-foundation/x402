import { describe, expect, it } from "vitest";
import {
  CASPER_CAIP2_FAMILY,
  NETWORK_CASPER_MAINNET,
  NETWORK_CASPER_TESTNET,
  NetworkConfigs,
  SCHEME_EXACT,
} from "../../src/constants";

describe("Casper constants", () => {
  it("exports Casper network identifiers", () => {
    expect(NETWORK_CASPER_MAINNET).toBe("casper:casper");
    expect(NETWORK_CASPER_TESTNET).toBe("casper:casper-test");
    expect(CASPER_CAIP2_FAMILY).toBe("casper:*");
    expect(SCHEME_EXACT).toBe("exact");
  });

  it("exports default network configs", () => {
    expect(NetworkConfigs[NETWORK_CASPER_MAINNET]).toMatchObject({
      chainName: "casper",
      rpcUrl: "https://node.mainnet.casper.network/rpc",
    });
    expect(NetworkConfigs[NETWORK_CASPER_TESTNET]).toMatchObject({
      chainName: "casper-test",
      rpcUrl: "https://node.testnet.casper.network/rpc",
    });
  });
});
