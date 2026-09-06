import { describe, it, expect } from "vitest";
import { X402Config, SvmConfig } from "./config";

describe("X402Config Types", () => {
  describe("SvmConfig", () => {
    it("should accept valid SvmConfig with rpcUrl", () => {
      const config: SvmConfig = {
        rpcUrl: "http://localhost:8899",
      };

      expect(config.rpcUrl).toBe("http://localhost:8899");
    });

    it("should accept empty SvmConfig", () => {
      const config: SvmConfig = {};

      expect(config.rpcUrl).toBeUndefined();
    });
  });

  describe("X402Config", () => {
    it("should accept valid X402Config with svmConfig", () => {
      const config: X402Config = {
        svmConfig: {
          rpcUrl: "https://api.mainnet-beta.solana.com",
        },
      };

      expect(config.svmConfig?.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    });

    it("should accept empty X402Config", () => {
      const config: X402Config = {};

      expect(config.svmConfig).toBeUndefined();
    });

    it("should accept X402Config with empty svmConfig", () => {
      const config: X402Config = {
        svmConfig: {},
      };

      expect(config.svmConfig).toBeDefined();
      expect(config.svmConfig?.rpcUrl).toBeUndefined();
    });

    it("should handle optional chaining correctly", () => {
      const config1: X402Config = {};
      const config2: X402Config = { svmConfig: {} };
      const config3: X402Config = { svmConfig: { rpcUrl: "http://localhost:8899" } };

      expect(config1.svmConfig?.rpcUrl).toBeUndefined();
      expect(config2.svmConfig?.rpcUrl).toBeUndefined();
      expect(config3.svmConfig?.rpcUrl).toBe("http://localhost:8899");
    });
  });
});
