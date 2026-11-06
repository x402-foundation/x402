import { describe, expect, it } from "vitest";
import * as root from "../../src";
import * as client from "../../src/exact/client";
import * as facilitator from "../../src/exact/facilitator";
import * as server from "../../src/exact/server";

describe("package entry points", () => {
  it("export the public API", () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        "ASSET",
        "ASSET_TRANSFER_METHOD",
        "BINDING_DOMAIN_PREFIX",
        "CAIP_FAMILY",
        "DEFAULT_CLOCK_SKEW_SECONDS",
        "DYNAMIC_EXTRA_FIELDS",
        "Errors",
        "ExactLnbtcScheme",
        "HTTP_PROFILE",
        "InMemoryReplayStore",
        "LNBTC_MAINNET",
        "LNBTC_NETWORKS",
        "LNBTC_TESTNET",
        "LnbtcError",
        "MCP_PROFILE",
        "PAYMENT_FLOW",
        "REPLAY_RETENTION_SECONDS",
        "SCHEME",
        "bindingsEqual",
        "canonicalize",
        "decodeInvoice",
        "httpRequestBinding",
        "mcpToolCallBinding",
        "parseBindingExtra",
      ].sort(),
    );
    expect(root.ExactLnbtcScheme).toBe(client.ExactLnbtcScheme);
    expect(typeof facilitator.ExactLnbtcScheme).toBe("function");
    expect(Object.keys(server).sort()).toEqual([
      "ExactLnbtcScheme",
      "httpTransportBinding",
      "mcpTransportBinding",
    ]);
  });
});
