import { describe, it, expect } from "vitest";
import {
  ExactSvmScheme,
  validateSvmAddress,
  normalizeNetwork,
  getUsdcAddress,
  getStablecoinAddress,
  getStablecoinSymbol,
  getStablecoinTokenProgram,
  SVM_ADDRESS_REGEX,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MAINNET_ADDRESS,
  USDC_DEVNET_ADDRESS,
  getDefaultAsset,
} from "../../src/index";
import type { FacilitatorSvmSigner } from "../../src/signer";
import { UptoSvmScheme } from "../../src/upto/facilitator/scheme";
import { UptoSvmRentCleanupManager } from "../../src/upto/facilitator/rentCleanupManager";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { ExactSvmScheme as ServerExactSvmScheme } from "../../src/exact/server/scheme";

describe("@x402/svm", () => {
  it("should export main classes", () => {
    expect(ExactSvmScheme).toBeDefined();
    expect(ExactSvmScheme).toBeDefined();
    expect(ExactSvmScheme).toBeDefined();
  });

  describe("validateSvmAddress", () => {
    it("should validate correct Solana addresses", () => {
      expect(validateSvmAddress(USDC_MAINNET_ADDRESS)).toBe(true);
      expect(validateSvmAddress(USDC_DEVNET_ADDRESS)).toBe(true);
      expect(validateSvmAddress("11111111111111111111111111111111")).toBe(true);
    });

    it("should reject invalid addresses", () => {
      expect(validateSvmAddress("")).toBe(false);
      expect(validateSvmAddress("invalid")).toBe(false);
      expect(validateSvmAddress("0x1234567890abcdef")).toBe(false);
      expect(validateSvmAddress("too-short")).toBe(false);
    });

    it("should reject base58 that does not decode to 32 bytes", () => {
      // Passes the charset/length regex but decodes short, so no Solana runtime
      // (nor the Go SDK's decoder) would accept it as a public key.
      expect(validateSvmAddress("NotAMint11111111111111111111111111111")).toBe(false);
      expect(validateSvmAddress("OtherReceiver111111111111111111111111")).toBe(false);
    });

    it("should reject addresses with invalid characters", () => {
      expect(validateSvmAddress("0000000000000000000000000000000O")).toBe(false); // 'O' not allowed
      expect(validateSvmAddress("0000000000000000000000000000000I")).toBe(false); // 'I' not allowed
      expect(validateSvmAddress("0000000000000000000000000000000l")).toBe(false); // 'l' not allowed
    });
  });

  describe("normalizeNetwork", () => {
    it("should return CAIP-2 format as-is", () => {
      expect(normalizeNetwork(SOLANA_MAINNET_CAIP2)).toBe(SOLANA_MAINNET_CAIP2);
      expect(normalizeNetwork(SOLANA_DEVNET_CAIP2)).toBe(SOLANA_DEVNET_CAIP2);
      expect(normalizeNetwork(SOLANA_TESTNET_CAIP2)).toBe(SOLANA_TESTNET_CAIP2);
    });

    it("should convert V1 network names to CAIP-2", () => {
      expect(normalizeNetwork("solana" as never)).toBe(SOLANA_MAINNET_CAIP2);
      expect(normalizeNetwork("solana-devnet" as never)).toBe(SOLANA_DEVNET_CAIP2);
      expect(normalizeNetwork("solana-testnet" as never)).toBe(SOLANA_TESTNET_CAIP2);
    });

    it("should throw for unsupported networks", () => {
      expect(() => normalizeNetwork("solana:unknown" as never)).toThrow("Unsupported SVM network");
      expect(() => normalizeNetwork("ethereum:1" as never)).toThrow("Unsupported SVM network");
      expect(() => normalizeNetwork("unknown-network" as never)).toThrow("Unsupported SVM network");
    });
  });

  describe("getUsdcAddress", () => {
    it("should return mainnet USDC address", () => {
      expect(getUsdcAddress(SOLANA_MAINNET_CAIP2)).toBe(USDC_MAINNET_ADDRESS);
    });

    it("should return devnet USDC address", () => {
      expect(getUsdcAddress(SOLANA_DEVNET_CAIP2)).toBe(USDC_DEVNET_ADDRESS);
    });

    it("should return testnet USDC address", () => {
      expect(getUsdcAddress(SOLANA_TESTNET_CAIP2)).toBe(USDC_DEVNET_ADDRESS);
    });

    it("should throw for unsupported networks", () => {
      expect(() => getUsdcAddress("solana:unknown" as never)).toThrow("Unsupported SVM network");
    });
  });

  describe("stablecoin helpers", () => {
    it("should return stablecoin addresses by network", () => {
      expect(getStablecoinAddress("USDT", SOLANA_MAINNET_CAIP2)).toBe(
        getDefaultAsset(SOLANA_MAINNET_CAIP2, "USDT").asset,
      );
      expect(getStablecoinAddress("USDG", SOLANA_MAINNET_CAIP2)).toBe(
        getDefaultAsset(SOLANA_MAINNET_CAIP2, "USDG").asset,
      );
      expect(getStablecoinAddress("USDG", SOLANA_DEVNET_CAIP2)).toBe(
        getDefaultAsset(SOLANA_DEVNET_CAIP2, "USDG").asset,
      );
      expect(getStablecoinAddress("PYUSD", SOLANA_MAINNET_CAIP2)).toBe(
        getDefaultAsset(SOLANA_MAINNET_CAIP2, "PYUSD").asset,
      );
      expect(getStablecoinAddress("PYUSD", SOLANA_DEVNET_CAIP2)).toBe(
        getDefaultAsset(SOLANA_DEVNET_CAIP2, "PYUSD").asset,
      );
      expect(getStablecoinAddress("CASH", SOLANA_MAINNET_CAIP2)).toBe(
        getDefaultAsset(SOLANA_MAINNET_CAIP2, "CASH").asset,
      );
      expect(() => getStablecoinAddress("CASH", SOLANA_DEVNET_CAIP2)).toThrow(
        /No CASH default asset configured for network/,
      );
    });

    it("should identify stablecoin symbols from symbols and known mints", () => {
      expect(getStablecoinSymbol("USDG")).toBe("USDG");
      expect(getStablecoinSymbol(getDefaultAsset(SOLANA_MAINNET_CAIP2, "USDG").asset)).toBe("USDG");
      expect(getStablecoinSymbol("CustomMint111111111111111111111111111111")).toBeUndefined();
    });

    it("should categorize stablecoins by token program", () => {
      expect(getStablecoinTokenProgram("USDC", SOLANA_MAINNET_CAIP2)).toBe(TOKEN_PROGRAM_ADDRESS);
      expect(getStablecoinTokenProgram("USDT", SOLANA_MAINNET_CAIP2)).toBe(TOKEN_PROGRAM_ADDRESS);
      expect(getStablecoinTokenProgram("PYUSD", SOLANA_DEVNET_CAIP2)).toBe(
        TOKEN_2022_PROGRAM_ADDRESS,
      );
      expect(getStablecoinTokenProgram("USDG", SOLANA_DEVNET_CAIP2)).toBe(
        TOKEN_2022_PROGRAM_ADDRESS,
      );
      expect(getStablecoinTokenProgram("CASH", SOLANA_MAINNET_CAIP2)).toBe(
        TOKEN_2022_PROGRAM_ADDRESS,
      );
    });
  });

  describe("FacilitatorSvmSigner", () => {
    const exactOnlySigner: FacilitatorSvmSigner = {
      getAddresses: () => ["11111111111111111111111111111111" as never],
      signTransaction: async () => "tx",
      simulateTransaction: async () => {},
      sendTransaction: async () => "sig",
      confirmTransaction: async () => {},
    };

    it("allows exact-only signers without getSigner", () => {
      expect(exactOnlySigner.getAddresses()).toHaveLength(1);
      expect(exactOnlySigner.getSigner).toBeUndefined();
    });

    it("accepts exact-only signers for ExactSvmScheme", () => {
      expect(() => new ExactSvmScheme(exactOnlySigner)).not.toThrow();
    });

    it("accepts exact-only signers for UptoSvmScheme at compile time but rejects missing getSigner at runtime", () => {
      expect(() => new UptoSvmScheme(exactOnlySigner)).toThrow(
        "UptoSvmScheme requires getSigner on the signer",
      );
    });

    it("rejects exact-only signers for UptoSvmRentCleanupManager at runtime", () => {
      expect(
        () =>
          new UptoSvmRentCleanupManager({
            signer: exactOnlySigner,
            storage: {
              upsert: async () => {},
              get: async () => undefined,
              list: async () => [],
              delete: async () => {},
            },
            network: SOLANA_DEVNET_CAIP2,
          }),
      ).toThrow("UptoSvmRentCleanupManager requires getSigner on the signer");
    });
  });

  describe("ExactSvmScheme (Server)", () => {
    const server = new ServerExactSvmScheme();

    describe("parsePrice", () => {
      it("should parse dollar string prices", async () => {
        const result = await server.parsePrice("$0.1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        expect(result.amount).toBe("100000"); // 4.02 USDC = 4020000 smallest units
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should parse simple number string prices", async () => {
        const result = await server.parsePrice("0.10", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should parse explicit USDC prices", async () => {
        const result = await server.parsePrice(
          "0.10 USDC",
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        );
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should parse USD as USDC", async () => {
        const result = await server.parsePrice(
          "0.10 USD",
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        );
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should parse supported stablecoin suffixes", async () => {
        const network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
        await expect(server.parsePrice("0.10 USDT", network)).resolves.toMatchObject({
          amount: "100000",
          asset: getDefaultAsset(network, "USDT").asset,
        });
        await expect(server.parsePrice("0.10 USDG", network)).resolves.toMatchObject({
          amount: "100000",
          asset: getDefaultAsset(network, "USDG").asset,
        });
        await expect(server.parsePrice("0.10 PYUSD", network)).resolves.toMatchObject({
          amount: "100000",
          asset: getDefaultAsset(network, "PYUSD").asset,
        });
        await expect(server.parsePrice("0.10 CASH", network)).resolves.toMatchObject({
          amount: "100000",
          asset: getDefaultAsset(network, "CASH").asset,
        });
      });

      it("should parse number prices", async () => {
        const result = await server.parsePrice(0.1, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should use devnet USDC for devnet network", async () => {
        const result = await server.parsePrice("1.00", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
        expect(result.amount).toBe("1000000");
        expect(result.asset).toBe(USDC_DEVNET_ADDRESS);
      });

      it("should handle pre-parsed price objects", async () => {
        const result = await server.parsePrice(
          { amount: "123456", asset: "custom_token_address", extra: {} },
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        );
        expect(result.amount).toBe("123456");
        expect(result.asset).toBe("custom_token_address");
      });

      it("should throw for invalid price formats", async () => {
        await expect(
          async () =>
            await server.parsePrice("not-a-price!", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
        ).rejects.toThrow("Invalid money format");
      });

      it("should throw for price objects without asset", async () => {
        await expect(
          async () =>
            await server.parsePrice(
              { amount: "123456" } as never,
              "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            ),
        ).rejects.toThrow("Asset address must be specified");
      });

      it("should avoid floating-point rounding error", async () => {
        const result = await server.parsePrice("$4.02", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
        expect(result.amount).toBe("4020000"); // 4.02 USDC
      });
    });

    describe("enhancePaymentRequirements", () => {
      it("should add feePayer to payment requirements", async () => {
        const requirements = {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: USDC_MAINNET_ADDRESS,
          amount: "100000",
          payTo: "11111111111111111111111111111111",
          maxTimeoutSeconds: 3600,
        };

        const facilitatorAddress = "FacilitatorAddress111111111111111111111";
        const result = await server.enhancePaymentRequirements(
          requirements as never,
          {
            x402Version: 2,
            scheme: "exact",
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            extra: { feePayer: facilitatorAddress },
          },
          [],
        );

        expect(result).toEqual({
          ...requirements,
          extra: { feePayer: facilitatorAddress },
        });
      });
    });
  });

  describe("Constants", () => {
    it("should export correct USDC addresses", () => {
      expect(USDC_MAINNET_ADDRESS).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(USDC_DEVNET_ADDRESS).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    });

    it("should have valid address regex", () => {
      expect(SVM_ADDRESS_REGEX).toBeInstanceOf(RegExp);
      expect(SVM_ADDRESS_REGEX.test(USDC_MAINNET_ADDRESS)).toBe(true);
    });
  });

  describe("ExactSvmScheme (Server) - additional coverage", () => {
    const server = new ServerExactSvmScheme();

    it("should have scheme set to 'exact'", () => {
      expect(server.scheme).toBe("exact");
    });

    it("should register custom money parser and use it", async () => {
      const customServer = new ServerExactSvmScheme();
      const customParser = async (amount: string | number, _network: string) => {
        if (Number(amount) === 42) {
          return { amount: "42000000", asset: "custom_asset_address", extra: {} };
        }
        return null;
      };
      customServer.registerMoneyParser(customParser);

      const result = await customServer.parsePrice(42, SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("42000000");
      expect(result.asset).toBe("custom_asset_address");
    });

    it("should fall back to default when custom parser returns null", async () => {
      const customServer = new ServerExactSvmScheme();
      const nullParser = async () => null;
      customServer.registerMoneyParser(nullParser);

      const result = await customServer.parsePrice(1.0, SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
    });

    it("should chain registerMoneyParser calls", () => {
      const customServer = new ServerExactSvmScheme();
      const parser1 = async () => null;
      const parser2 = async () => null;
      const result = customServer.registerMoneyParser(parser1).registerMoneyParser(parser2);
      expect(result).toBe(customServer);
    });

    it("should try custom parsers in registration order", async () => {
      const customServer = new ServerExactSvmScheme();
      const firstParser = async (amount: string | number) => {
        if (Number(amount) > 0) return { amount: "first", asset: "first_asset", extra: {} };
        return null;
      };
      const secondParser = async (amount: string | number) => {
        if (Number(amount) > 0) return { amount: "second", asset: "second_asset", extra: {} };
        return null;
      };
      customServer.registerMoneyParser(firstParser).registerMoneyParser(secondParser);

      const result = await customServer.parsePrice(1, SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("first");
    });

    it("should preserve existing extra fields in enhancePaymentRequirements", async () => {
      const requirements = {
        scheme: "exact",
        network: SOLANA_MAINNET_CAIP2,
        asset: USDC_MAINNET_ADDRESS,
        amount: "100000",
        payTo: "11111111111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { existingField: "keep_me" },
      };

      const result = await server.enhancePaymentRequirements(
        requirements as never,
        {
          x402Version: 2,
          scheme: "exact",
          network: SOLANA_MAINNET_CAIP2,
          extra: { feePayer: "FacilitatorAddr111111111111111111111" },
        },
        [],
      );

      expect(result.extra?.existingField).toBe("keep_me");
      expect(result.extra?.feePayer).toBe("FacilitatorAddr111111111111111111111");
    });

    it("should handle enhancePaymentRequirements without feePayer", async () => {
      const requirements = {
        scheme: "exact",
        network: SOLANA_MAINNET_CAIP2,
        asset: USDC_MAINNET_ADDRESS,
        amount: "100000",
        payTo: "11111111111111111111111111111111",
        maxTimeoutSeconds: 3600,
      };

      const result = await server.enhancePaymentRequirements(
        requirements as never,
        {
          x402Version: 2,
          scheme: "exact",
          network: SOLANA_MAINNET_CAIP2,
        },
        [],
      );

      expect(result.extra?.feePayer).toBeUndefined();
    });

    it("should parse price with zero amount", async () => {
      const result = await server.parsePrice(0, SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("0");
      expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
    });

    it("should parse price with large amount", async () => {
      const result = await server.parsePrice(1000000, SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("1000000000000");
      expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
    });

    it("should handle pre-parsed AssetAmount with extra data", async () => {
      const result = await server.parsePrice(
        { amount: "500", asset: "custom_token", extra: { memo: "test" } },
        SOLANA_MAINNET_CAIP2,
      );
      expect(result.amount).toBe("500");
      expect(result.asset).toBe("custom_token");
      expect(result.extra).toEqual({ memo: "test" });
    });
  });
});
