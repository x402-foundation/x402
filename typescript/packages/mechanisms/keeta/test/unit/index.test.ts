import { describe, it, expect } from "vitest";
import { ExactKeetaScheme as ExactKeetaClient } from "../../src/exact/client/scheme";
import { ExactKeetaScheme as ExactKeetaFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactKeetaScheme as ExactKeetaServer } from "../../src/exact/server/scheme";
import {
  KEETA_MAINNET_CAIP2,
  KEETA_TESTNET_CAIP2,
  getUsdcAddress,
  networkToKeetaNetwork,
} from "../../src/index";

describe("@x402/keeta", () => {
  describe("exports", () => {
    it("should export main scheme classes", () => {
      expect(ExactKeetaClient).toBeDefined();
      expect(ExactKeetaFacilitator).toBeDefined();
      expect(ExactKeetaServer).toBeDefined();
    });

    it("should export network constants", () => {
      expect(KEETA_MAINNET_CAIP2).toBe("keeta:21378");
      expect(KEETA_TESTNET_CAIP2).toBe("keeta:1413829460");
    });

    it("should export utility functions", () => {
      expect(getUsdcAddress).toBeDefined();
      expect(networkToKeetaNetwork).toBeDefined();
    });
  });
});
