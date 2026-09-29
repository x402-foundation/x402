import { describe, expect, it } from "vitest";
import {
  CASPER_CAIP2_FAMILY,
  CASPER_MAINNET_CAIP2,
  CASPER_TESTNET_CAIP2,
  NetworkConfigs,
  SCHEME_EXACT,
} from "../../src/constants";

describe("Casper constants", () => {
  it("exports Casper network identifiers", () => {
    expect(CASPER_MAINNET_CAIP2).toBe("casper:casper");
    expect(CASPER_TESTNET_CAIP2).toBe("casper:casper-test");
    expect(CASPER_CAIP2_FAMILY).toBe("casper:*");
    expect(SCHEME_EXACT).toBe("exact");
  });

  it("exports default network configs", () => {
    expect(NetworkConfigs[CASPER_MAINNET_CAIP2]).toMatchObject({
      chainName: "casper",
      rpcUrl: "https://node.mainnet.casper.network/rpc",
    });
    expect(NetworkConfigs[CASPER_TESTNET_CAIP2]).toMatchObject({
      chainName: "casper-test",
      rpcUrl: "https://node.testnet.casper.network/rpc",
    });
  });
});
