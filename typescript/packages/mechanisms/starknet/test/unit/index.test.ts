import { describe, it, expect } from "vitest";
import { ExactStarknetScheme } from "../../src/index";
import * as pkg from "../../src/index";
import { ExactStarknetScheme as ExactStarknetClient } from "../../src/exact/client/scheme";
import { ExactStarknetScheme as ExactStarknetServer } from "../../src/exact/server/scheme";
import { ExactStarknetScheme as ExactStarknetFacilitator } from "../../src/exact/facilitator/scheme";

// Only the barrel re-export surface is this file's concern; each symbol's
// behavior is owned by the dedicated deep-import suites.
describe("@x402/starknet barrel exports", () => {
  // Like the sibling mechanisms, the root barrel carries the client scheme;
  // the server and facilitator schemes ship on their deep-import entry points.
  it("re-exports the client scheme from the root and the others from their entry points", () => {
    expect(ExactStarknetScheme).toBe(ExactStarknetClient);
    expect(ExactStarknetServer).not.toBe(ExactStarknetClient);
    expect(ExactStarknetFacilitator).not.toBe(ExactStarknetClient);
    expect(typeof ExactStarknetServer).toBe("function");
    expect(typeof ExactStarknetFacilitator).toBe("function");
  });

  it("re-exports the public constants, helpers, and typed-data functions", () => {
    for (const name of [
      "STARKNET_MAINNET_CAIP2",
      "STARKNET_SEPOLIA_CAIP2",
      "STARKNET_ADDRESS_REGEX",
      "CHAIN_IDS",
      "USDC_MAINNET",
      "USDC_SEPOLIA",
      "DEFAULT_ASSETS",
      "getDefaultAsset",
      "findDefaultAsset",
      "ANY_CALLER",
      "STARKNET_ERROR_REASONS",
      "getStarknetChainId",
      "getStarknetRpcUrl",
      "feltEquals",
      "parseU256",
      "isValidStarknetAddress",
      "parseAmount",
      "amountStringEquals",
      "chainIdSafeToFelt",
      "parseOutsideExecution",
      "buildCanonicalOutsideExecutionTypedData",
      "buildTransferCall",
      "chainIdToFelt",
    ]) {
      expect(pkg[name as keyof typeof pkg]).toBeDefined();
    }
  });
});
