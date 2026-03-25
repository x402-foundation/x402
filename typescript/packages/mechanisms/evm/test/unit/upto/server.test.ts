import { describe, it, expect } from "vitest";
import { UptoEvmScheme } from "../../../src/upto/server/scheme";
import type { PaymentRequirements } from "@x402/core/types";

const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe";

describe("UptoEvmScheme (Server)", () => {
  const server = new UptoEvmScheme();

  describe("parsePrice", () => {
    describe("Base Sepolia network", () => {
      const network = "eip155:84532";

      it("should parse dollar string prices", async () => {
        const result = await server.parsePrice("$0.10", network);
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
        expect(result.extra).toEqual({
          name: "USDC",
          version: "2",
          assetTransferMethod: "permit2",
        });
      });

      it("should parse simple number string prices", async () => {
        const result = await server.parsePrice("0.10", network);
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
      });

      it("should parse number prices", async () => {
        const result = await server.parsePrice(0.1, network);
        expect(result.amount).toBe("100000");
      });

      it("should handle larger amounts", async () => {
        const result = await server.parsePrice("100.50", network);
        expect(result.amount).toBe("100500000");
      });

      it("should handle whole numbers", async () => {
        const result = await server.parsePrice("1", network);
        expect(result.amount).toBe("1000000");
      });

      it("should avoid floating-point rounding error", async () => {
        const result = await server.parsePrice("$4.02", network);
        expect(result.amount).toBe("4020000");
      });

      it("should always include assetTransferMethod=permit2 in extra", async () => {
        const result = await server.parsePrice("$1.00", network);
        expect(result.extra).toHaveProperty("assetTransferMethod", "permit2");
      });
    });

    describe("Base mainnet network", () => {
      const network = "eip155:8453";

      it("should use Base mainnet USDC address with permit2", async () => {
        const result = await server.parsePrice("1.00", network);
        expect(result.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
        expect(result.amount).toBe("1000000");
        expect(result.extra).toEqual({
          name: "USD Coin",
          version: "2",
          assetTransferMethod: "permit2",
        });
      });
    });

    describe("MegaETH network", () => {
      const network = "eip155:4326";

      it("should parse dollar string for 18-decimal token", async () => {
        const result = await server.parsePrice("$0.10", network);
        expect(result.asset).toBe("0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7");
        expect(result.amount).toBe("100000000000000000");
        expect(result.extra).toEqual({
          name: "MegaUSD",
          version: "1",
          assetTransferMethod: "permit2",
        });
      });
    });

    describe("pre-parsed price objects", () => {
      it("should handle pre-parsed price objects with asset", async () => {
        const result = await server.parsePrice(
          {
            amount: "123456",
            asset: "0x1234567890123456789012345678901234567890",
            extra: { foo: "bar" },
          },
          "eip155:84532",
        );
        expect(result.amount).toBe("123456");
        expect(result.asset).toBe("0x1234567890123456789012345678901234567890");
        expect(result.extra).toEqual({ foo: "bar" });
      });

      it("should throw for price objects without asset", async () => {
        await expect(
          async () => await server.parsePrice({ amount: "123456" } as never, "eip155:84532"),
        ).rejects.toThrow("Asset address must be specified");
      });
    });

    describe("custom money parser", () => {
      it("should use custom parser when it returns a result", async () => {
        const customServer = new UptoEvmScheme();

        customServer.registerMoneyParser(async (amount, network) => {
          if (network === "eip155:84532" && amount > 0) {
            return {
              amount: (amount * 1e18).toString(),
              asset: "0xPermit2OnlyToken123456789012345678901234",
              extra: { assetTransferMethod: "permit2" },
            };
          }
          return null;
        });

        const result = await customServer.parsePrice("1.00", "eip155:84532");
        expect(result.amount).toBe("1000000000000000000");
        expect(result.asset).toBe("0xPermit2OnlyToken123456789012345678901234");
      });

      it("should fall back to default when custom parser returns null", async () => {
        const customServer = new UptoEvmScheme();

        customServer.registerMoneyParser(async (_amount, network) => {
          if (network === "eip155:42161") {
            return { amount: "1", asset: "0xArb", extra: {} };
          }
          return null;
        });

        const result = await customServer.parsePrice("1.00", "eip155:84532");
        expect(result.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
      });
    });

    describe("error cases", () => {
      it("should throw for unsupported networks", async () => {
        await expect(async () => await server.parsePrice("1.00", "eip155:999999")).rejects.toThrow(
          "No default asset configured",
        );
      });

      it("should throw for invalid money formats", async () => {
        await expect(
          async () => await server.parsePrice("not-a-price!", "eip155:84532"),
        ).rejects.toThrow("Invalid money format");
      });
    });
  });

  describe("enhancePaymentRequirements", () => {
    const baseRequirements: PaymentRequirements = {
      scheme: "upto",
      network: "eip155:8453",
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    };

    it("should always set assetTransferMethod=permit2 in extra", async () => {
      const result = await server.enhancePaymentRequirements(
        baseRequirements,
        { x402Version: 2, scheme: "upto", network: "eip155:8453" },
        [],
      );

      expect(result.extra?.assetTransferMethod).toBe("permit2");
    });

    it("should inject facilitatorAddress from supportedKind.extra", async () => {
      const result = await server.enhancePaymentRequirements(
        baseRequirements,
        {
          x402Version: 2,
          scheme: "upto",
          network: "eip155:8453",
          extra: { facilitatorAddress: FACILITATOR_ADDRESS },
        },
        [],
      );

      expect(result.extra?.facilitatorAddress).toBe(FACILITATOR_ADDRESS);
    });

    it("should preserve existing extra fields", async () => {
      const result = await server.enhancePaymentRequirements(
        baseRequirements,
        { x402Version: 2, scheme: "upto", network: "eip155:8453" },
        [],
      );

      expect(result.extra?.name).toBe("USD Coin");
      expect(result.extra?.version).toBe("2");
    });

    it("should not include facilitatorAddress when not provided", async () => {
      const result = await server.enhancePaymentRequirements(
        baseRequirements,
        { x402Version: 2, scheme: "upto", network: "eip155:8453" },
        [],
      );

      expect(result.extra?.facilitatorAddress).toBeUndefined();
    });

    it("should checksum-validate facilitatorAddress via getAddress", async () => {
      const lowercaseAddress = "0xfac11174700123456789012345678901234abcde";
      const result = await server.enhancePaymentRequirements(
        baseRequirements,
        {
          x402Version: 2,
          scheme: "upto",
          network: "eip155:8453",
          extra: { facilitatorAddress: lowercaseAddress },
        },
        [],
      );

      expect(result.extra?.facilitatorAddress).toBe("0xFAC11174700123456789012345678901234aBCDe");
    });

    it("should throw for invalid facilitatorAddress", () => {
      expect(() =>
        server.enhancePaymentRequirements(
          baseRequirements,
          {
            x402Version: 2,
            scheme: "upto",
            network: "eip155:8453",
            extra: { facilitatorAddress: "not-an-address" },
          },
          [],
        ),
      ).toThrow();
    });
  });
});
