import { describe, it, expect } from "vitest";
import { ShieldedEvmServer } from "../../../src/shielded/server/scheme.js";
import type { PaymentRequirements, Network } from "@x402/core/types";

const POOL_CONTRACT = "0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("ShieldedEvmServer", () => {
  const server = new ShieldedEvmServer({
    poolContracts: { 8453: [POOL_CONTRACT] },
  });

  describe("parsePrice", () => {
    it("converts dollar amount to USDC atomic units", async () => {
      const result = await server.parsePrice("$1.00", "eip155:8453" as Network);
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(USDC);
    });

    it("converts numeric price", async () => {
      const result = await server.parsePrice(0.5, "eip155:8453" as Network);
      expect(result.amount).toBe("500000");
    });

    it("passes through AssetAmount objects", async () => {
      const result = await server.parsePrice(
        { amount: "2000000", asset: USDC, extra: {} },
        "eip155:8453" as Network,
      );
      expect(result.amount).toBe("2000000");
      expect(result.asset).toBe(USDC);
    });
  });

  describe("getAssetDecimals", () => {
    it("returns 6 for USDC", () => {
      expect(server.getAssetDecimals(USDC, "eip155:8453" as Network)).toBe(6);
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("adds shielded method and pool contracts", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453" as `${string}:${string}`,
        asset: USDC,
        amount: "1000000",
        payTo: "0xSomeAddress",
        maxTimeoutSeconds: 120,
        extra: {},
      };

      const enhanced = await server.enhancePaymentRequirements(
        requirements,
        { x402Version: 2, scheme: "exact", network: "eip155:8453" as Network },
        [],
      );

      expect(enhanced.extra.assetTransferMethod).toBe("shielded");
      expect(enhanced.extra.poolContracts).toEqual([POOL_CONTRACT]);
    });
  });

  describe("scheme", () => {
    it("is exact", () => {
      expect(server.scheme).toBe("exact");
    });
  });
});
