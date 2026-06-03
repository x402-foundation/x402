import { describe, expect, it } from "vitest";
import { ExactHederaScheme } from "../../src/exact/server/scheme";

describe("ExactHedera server money parsing", () => {
  it("uses configured HTS default asset conversion", async () => {
    const scheme = new ExactHederaScheme({
      defaultAssets: {
        "hedera:testnet": {
          asset: "0.0.5555",
          decimals: 6,
        },
      },
    });

    const parsed = await scheme.parsePrice("$1.25", "hedera:testnet");
    expect(parsed.asset).toBe("0.0.5555");
    expect(parsed.amount).toBe("1250000");
  });

  it("uses custom parser before default conversion", async () => {
    const scheme = new ExactHederaScheme({
      defaultAssets: {
        "hedera:testnet": {
          asset: "0.0.5555",
          decimals: 6,
        },
      },
    });
    scheme.registerMoneyParser(async amount => {
      if (amount > 100) {
        return { amount: "1", asset: "0.0.9999", extra: { tier: "large" } };
      }
      return null;
    });

    const parsed = await scheme.parsePrice(200, "hedera:testnet");
    expect(parsed.asset).toBe("0.0.9999");
    expect(parsed.extra?.tier).toBe("large");
  });

  it("falls back to USDC when no default asset is configured", async () => {
    const scheme = new ExactHederaScheme();
    const parsed = await scheme.parsePrice("$1.00", "hedera:testnet");
    expect(parsed.asset).toBe("0.0.429274"); // Hedera testnet USDC
    expect(parsed.amount).toBe("1000000"); // 1.00 with 6 decimals
  });

  it("falls back to mainnet USDC when no default asset is configured", async () => {
    const scheme = new ExactHederaScheme();
    const parsed = await scheme.parsePrice("$0.01", "hedera:mainnet");
    expect(parsed.asset).toBe("0.0.456858"); // Hedera mainnet USDC (Circle issued)
    expect(parsed.amount).toBe("10000"); // 0.01 USDC at 6 decimals
  });

  it("throws if default asset is not configured for unknown network", async () => {
    const scheme = new ExactHederaScheme();
    await expect(scheme.parsePrice("$1.00", "hedera:unknown")).rejects.toThrow(
      "Unsupported Hedera network",
    );
  });

  it("throws on invalid money string", async () => {
    const scheme = new ExactHederaScheme({
      defaultAssets: {
        "hedera:testnet": {
          asset: "0.0.5555",
          decimals: 6,
        },
      },
    });
    await expect(scheme.parsePrice("$abc", "hedera:testnet")).rejects.toThrow(
      "Invalid money format",
    );
  });

  it("throws when default asset is configured as HBAR", async () => {
    const scheme = new ExactHederaScheme({
      defaultAssets: {
        "hedera:testnet": {
          asset: "0.0.0",
          decimals: 8,
        },
      },
    });
    await expect(scheme.parsePrice("$1.00", "hedera:testnet")).rejects.toThrow(
      "Default Hedera asset must be an HTS fungible token ID",
    );
  });
});
