import { describe, it, expect } from "vitest";
import { ExactKeetaScheme as ExactKeetaClient } from "../../src/exact/client/scheme";
import { ExactKeetaScheme as ExactKeetaFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactKeetaScheme as ExactKeetaServer } from "../../src/exact/server/scheme";
import { getUsdcAddress, networkToKeetaNetwork } from "../../src/index";

describe("@x402/keeta", () => {
  describe("exports", () => {
    it("should export main scheme classes", () => {
      expect(ExactKeetaClient).toBeDefined();
      expect(ExactKeetaFacilitator).toBeDefined();
      expect(ExactKeetaServer).toBeDefined();
    });

    it("should export utility functions", () => {
      expect(getUsdcAddress).toBeDefined();
      expect(networkToKeetaNetwork).toBeDefined();
    });

    it("should export default asset helpers", async () => {
      const { findDefaultAsset, getDefaultAsset, DEFAULT_ASSETS } = await import("../../src/index");
      expect(findDefaultAsset).toBeDefined();
      expect(getDefaultAsset).toBeDefined();
      expect(DEFAULT_ASSETS).toBeDefined();
    });
  });
});
