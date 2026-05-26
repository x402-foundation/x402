import { describe, it, expect } from "vitest";
import { ExactEvmScheme } from "../../src/exact/server/scheme";
import { MoneyParser } from "@x402/core/types";

// Base mainnet USDC address
const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Base Sepolia USDC address
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("ExactEvmScheme (Server) - registerMoneyParser", () => {
  describe("Single custom parser", () => {
    it("should use custom parser for Money values", async () => {
      const server = new ExactEvmScheme();

      const customParser: MoneyParser = async (amount, _network) => {
        // Custom logic: use DAI for large amounts
        if (amount > 100) {
          return {
            amount: (amount * 1e18).toString(),
            asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
            extra: { token: "DAI", tier: "large" },
          };
        }
        return null; // Use default for small amounts
      };

      server.registerMoneyParser(customParser);

      // Large amount should use custom parser (DAI)
      const result1 = await server.parsePrice(150, "eip155:8453");
      expect(result1.asset).toBe("0x6B175474E89094C44Da98b954EedeAC495271d0F");
      expect(result1.extra?.token).toBe("DAI");
      expect(result1.amount).toBe((150 * 1e18).toString());

      // Small amount should fall back to default (USDC)
      const result2 = await server.parsePrice(50, "eip155:8453");
      expect(result2.asset).toBe(BASE_MAINNET_USDC);
      expect(result2.amount).toBe("50000000"); // 50 * 1e6
    });

    it("should receive decimal number, not raw string", async () => {
      const server = new ExactEvmScheme();
      let receivedAmount: number | null = null;
      let receivedNetwork: string | null = null;

      server.registerMoneyParser(async (amount, network) => {
        receivedAmount = amount;
        receivedNetwork = network;
        return null; // Use default
      });

      await server.parsePrice("$1.50", "eip155:8453");
      expect(receivedAmount).toBe(1.5);
      expect(receivedNetwork).toBe("eip155:8453");

      await server.parsePrice("5.25", "eip155:8453");
      expect(receivedAmount).toBe(5.25);

      await server.parsePrice(10.99, "eip155:8453");
      expect(receivedAmount).toBe(10.99);
    });

    it("should handle $ prefix removal before parsing", async () => {
      const server = new ExactEvmScheme();
      let receivedAmount: number | null = null;

      server.registerMoneyParser(async amount => {
        receivedAmount = amount;
        return null;
      });

      await server.parsePrice("$25.50", "eip155:8453");
      expect(receivedAmount).toBe(25.5); // $ removed
    });

    it("should not call parser for AssetAmount (pass-through)", async () => {
      const server = new ExactEvmScheme();
      let parserCalled = false;

      server.registerMoneyParser(async (_amount, _network) => {
        parserCalled = true;
        return null;
      });

      const assetAmount = {
        amount: "100000",
        asset: "0xCustomToken123",
        extra: { custom: true },
      };

      const result = await server.parsePrice(assetAmount, "eip155:8453");

      expect(parserCalled).toBe(false); // Parser not called for AssetAmount
      expect(result).toEqual(assetAmount);
    });

    it("should support async parsers with API calls", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async (amount, _network) => {
        // Simulate async operation (e.g., fetching exchange rate)
        await new Promise(resolve => setTimeout(resolve, 5));

        return {
          amount: (amount * 1e6).toString(),
          asset: BASE_MAINNET_USDC,
          extra: { async: true, timestamp: Date.now() },
        };
      });

      const result = await server.parsePrice(5, "eip155:8453");

      expect(result.asset).toBe(BASE_MAINNET_USDC);
      expect(result.extra?.async).toBe(true);
      expect(result.extra?.timestamp).toBeGreaterThan(0);
    });

    it("should fall back to default if parser returns null", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async _amount => {
        return null; // Always delegate
      });

      const result = await server.parsePrice(1, "eip155:8453");

      // Should use default Base USDC conversion
      expect(result.asset).toBe(BASE_MAINNET_USDC);
      expect(result.amount).toBe("1000000"); // 1 * 1e6
    });

    it("should avoid floating-point rounding error when fall back to default", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async _amount => {
        return null; // Always delegate
      });

      const result = await server.parsePrice(4.02, "eip155:8453");

      // Should use default Base USDC conversion
      expect(result.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      expect(result.amount).toBe("4020000"); // 4.02* 1e6
    });

    it("should correctly convert sub-microsecond prices for 18-decimal tokens", async () => {
      const server = new ExactEvmScheme();
      // MegaETH MegaUSD has 18 decimals: $0.0000001 = 1e-7 * 1e18 = 100000000000 atomic units
      const result = await server.parsePrice("$0.0000001", "eip155:4326");
      expect(result.amount).toBe("100000000000");
      expect(result.asset).toBe("0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7");
    });

    it("should throw when price is too small to represent in the token's precision", async () => {
      const server = new ExactEvmScheme();
      // USDC has 6 decimals: $0.00000001 = 1e-8 * 1e6 = 0.01 → rounds to 0 → must throw
      await expect(server.parsePrice("$0.00000001", "eip155:8453")).rejects.toThrow("too small");
      // Also throws when passed as a number
      await expect(server.parsePrice(0.00000001, "eip155:8453")).rejects.toThrow("too small");
    });
  });

  describe("Multiple parsers - chain of responsibility", () => {
    it("should try parsers in registration order", async () => {
      const server = new ExactEvmScheme();
      const executionOrder: number[] = [];

      server
        .registerMoneyParser(async amount => {
          executionOrder.push(1);
          if (amount > 1000) return { amount: "1", asset: "Parser1", extra: {} };
          return null;
        })
        .registerMoneyParser(async amount => {
          executionOrder.push(2);
          if (amount > 100) return { amount: "2", asset: "Parser2", extra: {} };
          return null;
        })
        .registerMoneyParser(async _amount => {
          executionOrder.push(3);
          return { amount: "3", asset: "Parser3", extra: {} };
        });

      await server.parsePrice(50, "eip155:8453");

      expect(executionOrder).toEqual([1, 2, 3]); // All tried
    });

    it("should stop at first non-null result", async () => {
      const server = new ExactEvmScheme();
      const executionOrder: number[] = [];

      server
        .registerMoneyParser(async _amount => {
          executionOrder.push(1);
          return null;
        })
        .registerMoneyParser(async _amount => {
          executionOrder.push(2);
          return { amount: "match", asset: "0xParser2", extra: {} }; // This one wins
        })
        .registerMoneyParser(async _amount => {
          executionOrder.push(3); // Should not execute
          return { amount: "3", asset: "0xParser3", extra: {} };
        });

      const result = await server.parsePrice(50, "eip155:8453");

      expect(executionOrder).toEqual([1, 2]); // Stopped after parser 2
      expect(result.asset).toBe("0xParser2");
    });

    it("should fall back to default if all parsers return null", async () => {
      const server = new ExactEvmScheme();

      server
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => null);

      const result = await server.parsePrice(1, "eip155:8453");

      // Should use default Base USDC conversion
      expect(result.asset).toBe(BASE_MAINNET_USDC);
      expect(result.amount).toBe("1000000"); // 1 USDC = 1,000,000 smallest units
    });

    it("should handle mix of sync and async parsers", async () => {
      const server = new ExactEvmScheme();

      server
        .registerMoneyParser(async amount => {
          // Async parser
          await Promise.resolve();
          if (amount > 1000) return { amount: "async", asset: "0xAsync", extra: {} };
          return null;
        })
        .registerMoneyParser(async amount => {
          // Also async (all parsers are Promise-based)
          if (amount > 100) return { amount: "sync", asset: "0xSync", extra: {} };
          return null;
        });

      const result1 = await server.parsePrice(1500, "eip155:8453");
      expect(result1.asset).toBe("0xAsync");

      const result2 = await server.parsePrice(500, "eip155:8453");
      expect(result2.asset).toBe("0xSync");
    });
  });

  describe("Error handling", () => {
    it("should propagate errors from parser", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async _amount => {
        throw new Error("Parser error: amount too large");
      });

      await expect(async () => await server.parsePrice(50, "eip155:8453")).rejects.toThrow(
        "Parser error: amount too large",
      );
    });

    it("should throw for invalid money format", async () => {
      const server = new ExactEvmScheme();

      await expect(
        async () => await server.parsePrice("not-a-number", "eip155:8453"),
      ).rejects.toThrow("Invalid money format");
    });

    it("should throw for NaN values", async () => {
      const server = new ExactEvmScheme();

      await expect(async () => await server.parsePrice("abc123", "eip155:8453")).rejects.toThrow(
        "Invalid money format",
      );
    });

    it("should throw from second parser if first returns null", async () => {
      const server = new ExactEvmScheme();

      server
        .registerMoneyParser(async () => null) // Skip
        .registerMoneyParser(async () => {
          throw new Error("Second parser error");
        });

      await expect(async () => await server.parsePrice(50, "eip155:8453")).rejects.toThrow(
        "Second parser error",
      );
    });

    it("should not catch errors - they should propagate", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async amount => {
        if (amount < 0) {
          throw new Error("Negative amounts not allowed");
        }
        return { amount: "1", asset: "0xTest", extra: {} };
      });

      await expect(async () => await server.parsePrice(-5, "eip155:8453")).rejects.toThrow(
        "Negative amounts not allowed",
      );
    });
  });

  describe("Real-world use cases", () => {
    it("should support tiered pricing by amount", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async (amount, _network) => {
        if (amount > 10000) {
          // VIP tier: use DAI (18 decimals)
          return {
            amount: (amount * 1e18).toString(),
            asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            extra: { tier: "vip", token: "DAI" },
          };
        }
        if (amount > 1000) {
          // Premium tier: use custom token
          return {
            amount: (amount * 1e6).toString(),
            asset: "0xPremiumToken",
            extra: { tier: "premium", token: "PREMIUM" },
          };
        }
        return null; // Standard tier: use default (network-specific USDC)
      });

      const vipResult = await server.parsePrice(15000, "eip155:8453");
      expect(vipResult.extra?.tier).toBe("vip");
      expect(vipResult.extra?.token).toBe("DAI");
      expect(vipResult.asset).toBe("0x6B175474E89094C44Da98b954EedeAC495271d0F");

      const premiumResult = await server.parsePrice(5000, "eip155:8453");
      expect(premiumResult.extra?.tier).toBe("premium");
      expect(premiumResult.extra?.token).toBe("PREMIUM");

      const standardResult = await server.parsePrice(500, "eip155:8453");
      expect(standardResult.asset).toBe(BASE_MAINNET_USDC); // Base USDC (default)
      expect(standardResult.amount).toBe("500000000"); // 500 * 1e6
    });

    it("should support dynamic exchange rates", async () => {
      const server = new ExactEvmScheme();

      // Mock exchange rate API response
      const mockExchangeRate = 1.02; // 1 USD = 1.02 USDC

      server.registerMoneyParser(async (amount, _network) => {
        const usdcAmount = amount * mockExchangeRate;
        return {
          amount: Math.floor(usdcAmount * 1e6).toString(),
          asset: BASE_MAINNET_USDC,
          extra: {
            exchangeRate: mockExchangeRate,
            originalAmount: amount,
            convertedAmount: usdcAmount,
          },
        };
      });

      const result = await server.parsePrice(100, "eip155:8453");

      // 100 USD * 1.02 = 102 USDC
      expect(result.amount).toBe("102000000"); // 102 * 1e6
      expect(result.extra?.exchangeRate).toBe(1.02);
      expect(result.extra?.originalAmount).toBe(100);
      expect(result.extra?.convertedAmount).toBe(102);
    });

    it("should support custom token selection based on amount", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async (amount, _network) => {
        // Micro-payments: use WETH
        if (amount > 0.001 && amount < 1) {
          return {
            amount: (amount * 1e18).toString(),
            asset: "0x4200000000000000000000000000000000000006", // WETH on Base
            extra: { token: "WETH", category: "micro" },
          };
        }
        // Everything else: use USDC
        if (amount >= 1) {
          return {
            amount: (amount * 1e6).toString(),
            asset: BASE_MAINNET_USDC,
            extra: { token: "USDC", category: "standard" },
          };
        }
        return null; // Very small amounts use default
      });

      const wethResult = await server.parsePrice(0.5, "eip155:8453");
      expect(wethResult.extra?.token).toBe("WETH");
      expect(wethResult.extra?.category).toBe("micro");

      const usdcResult = await server.parsePrice(100, "eip155:8453");
      expect(usdcResult.extra?.token).toBe("USDC");
      expect(usdcResult.extra?.category).toBe("standard");
    });

    it("should support network-specific logic in parser", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async (amount, network) => {
        // Use different tokens based on network
        if (network === "eip155:84532") {
          // Base Sepolia: use testnet USDC
          return {
            amount: (amount * 1e6).toString(),
            asset: BASE_SEPOLIA_USDC,
            extra: { network: "base-sepolia", token: "USDC-TEST" },
          };
        }

        // Base mainnet: use mainnet USDC
        if (network === "eip155:8453") {
          return {
            amount: (amount * 1e6).toString(),
            asset: BASE_MAINNET_USDC,
            extra: { network: "base", token: "USDC" },
          };
        }

        return null; // Other networks use default
      });

      const sepoliaResult = await server.parsePrice(10, "eip155:84532");
      expect(sepoliaResult.extra?.network).toBe("base-sepolia");
      expect(sepoliaResult.extra?.token).toBe("USDC-TEST");

      const baseResult = await server.parsePrice(10, "eip155:8453");
      expect(baseResult.extra?.network).toBe("base");
      expect(baseResult.extra?.token).toBe("USDC");
    });
  });

  describe("Multiple parsers - chain priority", () => {
    it("should execute parsers in registration order", async () => {
      const server = new ExactEvmScheme();
      const executionOrder: number[] = [];

      server
        .registerMoneyParser(async amount => {
          executionOrder.push(1);
          if (amount > 1000) return { amount: "1", asset: "0xParser1", extra: {} };
          return null;
        })
        .registerMoneyParser(async amount => {
          executionOrder.push(2);
          if (amount > 100) return { amount: "2", asset: "0xParser2", extra: {} };
          return null;
        })
        .registerMoneyParser(async _amount => {
          executionOrder.push(3);
          return { amount: "3", asset: "0xParser3", extra: {} };
        });

      await server.parsePrice(50, "eip155:8453");

      expect(executionOrder).toEqual([1, 2, 3]); // All tried until one succeeds
    });

    it("should stop at first non-null result", async () => {
      const server = new ExactEvmScheme();
      const executionOrder: number[] = [];

      server
        .registerMoneyParser(async _amount => {
          executionOrder.push(1);
          return null;
        })
        .registerMoneyParser(async _amount => {
          executionOrder.push(2);
          return { amount: "winner", asset: "0xWinner", extra: {} }; // This one wins
        })
        .registerMoneyParser(async _amount => {
          executionOrder.push(3); // Should not execute
          return { amount: "3", asset: "0xParser3", extra: {} };
        });

      const result = await server.parsePrice(50, "eip155:8453");

      expect(executionOrder).toEqual([1, 2]); // Stopped after parser 2
      expect(result.asset).toBe("0xWinner");
    });

    it("should use default if all parsers return null", async () => {
      const server = new ExactEvmScheme();

      server
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => null);

      const result = await server.parsePrice(1, "eip155:84532");

      // Should use default Base Sepolia USDC
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.amount).toBe("1000000");
    });

    it("should support complex multi-tier logic", async () => {
      const server = new ExactEvmScheme();

      server
        // Tier 1: Very large amounts (>$10k) → DAI
        .registerMoneyParser(async amount => {
          if (amount > 10000) {
            return {
              amount: (amount * 1e18).toString(),
              asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
              extra: { tier: 1, token: "DAI" },
            };
          }
          return null;
        })
        // Tier 2: Large amounts ($1k-$10k) → USDT
        .registerMoneyParser(async amount => {
          if (amount >= 1000 && amount <= 10000) {
            return {
              amount: (amount * 1e6).toString(),
              asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              extra: { tier: 2, token: "USDT" },
            };
          }
          return null;
        })
        // Tier 3: Medium amounts ($100-$1k) → USDC
        .registerMoneyParser(async amount => {
          if (amount >= 100 && amount < 1000) {
            return {
              amount: (amount * 1e6).toString(),
              asset: BASE_MAINNET_USDC,
              extra: { tier: 3, token: "USDC" },
            };
          }
          return null;
        });
      // Tier 4: Small amounts (<$100) → default

      const tier1 = await server.parsePrice(15000, "eip155:8453");
      expect(tier1.extra?.tier).toBe(1);
      expect(tier1.extra?.token).toBe("DAI");

      const tier2 = await server.parsePrice(5000, "eip155:8453");
      expect(tier2.extra?.tier).toBe(2);
      expect(tier2.extra?.token).toBe("USDT");

      const tier3 = await server.parsePrice(500, "eip155:8453");
      expect(tier3.extra?.tier).toBe(3);
      expect(tier3.extra?.token).toBe("USDC");

      const tier4 = await server.parsePrice(50, "eip155:8453");
      expect(tier4.asset).toBe(BASE_MAINNET_USDC); // Default
    });
  });

  describe("Chaining and fluent API", () => {
    it("should return this for chaining", () => {
      const server = new ExactEvmScheme();

      const parser1: MoneyParser = async () => null;
      const parser2: MoneyParser = async () => null;

      const result = server.registerMoneyParser(parser1).registerMoneyParser(parser2);

      expect(result).toBe(server);
    });

    it("should allow chaining with multiple registrations", () => {
      const server = new ExactEvmScheme();

      const result = server
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => null);

      expect(result).toBe(server);
    });
  });

  describe("Integration with parsePrice flow", () => {
    it("should work with AssetAmount pass-through", async () => {
      const server = new ExactEvmScheme();

      // Register parser (should not be called for AssetAmount)
      server.registerMoneyParser(async () => {
        throw new Error("Should not be called for AssetAmount");
      });

      const assetAmount = {
        amount: "500000",
        asset: "0xCustomAsset",
        extra: { foo: "bar" },
      };

      const result = await server.parsePrice(assetAmount, "eip155:8453");

      expect(result).toEqual(assetAmount);
    });

    it("should work with all Money formats", async () => {
      const server = new ExactEvmScheme();
      const callLog: Array<{ amount: number; format: string }> = [];

      server.registerMoneyParser(async amount => {
        callLog.push({ amount, format: typeof amount });
        return null; // Use default
      });

      await server.parsePrice("$10.50", "eip155:8453");
      await server.parsePrice("25.75", "eip155:8453");
      await server.parsePrice(42.25, "eip155:8453");

      expect(callLog).toHaveLength(3);
      expect(callLog[0].amount).toBe(10.5);
      expect(callLog[1].amount).toBe(25.75);
      expect(callLog[2].amount).toBe(42.25);
      // All should be numbers
      callLog.forEach(log => expect(log.format).toBe("number"));
    });
  });

  describe("Edge cases", () => {
    it("should handle zero amounts", async () => {
      const server = new ExactEvmScheme();
      let receivedAmount: number | null = null;

      server.registerMoneyParser(async amount => {
        receivedAmount = amount;
        return null;
      });

      await server.parsePrice(0, "eip155:8453");
      expect(receivedAmount).toBe(0);
    });

    it("should handle very small decimal amounts", async () => {
      const server = new ExactEvmScheme();
      let receivedAmount: number | null = null;

      server.registerMoneyParser(async amount => {
        receivedAmount = amount;
        return null;
      });

      await server.parsePrice(0.000001, "eip155:8453");
      expect(receivedAmount).toBe(0.000001);
    });

    it("should handle very large amounts", async () => {
      const server = new ExactEvmScheme();
      let receivedAmount: number | null = null;

      server.registerMoneyParser(async amount => {
        receivedAmount = amount;
        return null;
      });

      await server.parsePrice(999999999.99, "eip155:8453");
      expect(receivedAmount).toBe(999999999.99);
    });

    it("should handle decimal precision correctly", async () => {
      const server = new ExactEvmScheme();

      server.registerMoneyParser(async amount => {
        // Return amount with high precision
        return {
          amount: Math.floor(amount * 1e6).toString(),
          asset: "0xTest",
          extra: { originalDecimal: amount },
        };
      });

      const result = await server.parsePrice(1.123456789, "eip155:8453");
      expect(result.extra?.originalDecimal).toBe(1.123456789);
      expect(result.amount).toBe("1123456"); // Floored to 6 decimals
    });
  });
});
