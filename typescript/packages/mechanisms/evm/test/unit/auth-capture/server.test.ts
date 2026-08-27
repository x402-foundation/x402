import { describe, it, expect, vi } from "vitest";
import {
  AuthCaptureEvmScheme,
  InMemoryAuthorizedPaymentStorage,
} from "../../../src/auth-capture/server/index";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
  CAPTURE_TYPES_V1_0,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
} from "../../../src/auth-capture/constants";
import type { FacilitatorClient } from "@x402/core/server";
import type { AuthorizedPayment } from "../../../src/auth-capture/server/storage";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("AuthCaptureEvmScheme", () => {
  describe("parsePrice", () => {
    it("should parse dollar amounts with default decimals (6 for USDC)", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should parse amounts without dollar sign", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("0.50", "eip155:84532");

      expect(result.amount).toBe("500000");
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should parse small amounts correctly", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$0.01", "eip155:84532");

      expect(result.amount).toBe("10000");
    });

    it("should parse large amounts correctly", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1000.00", "eip155:84532");

      expect(result.amount).toBe("1000000000");
    });

    it("should reject thousands separators, matching core parseMoney", async () => {
      const scheme = new AuthCaptureEvmScheme();

      await expect(scheme.parsePrice("$1,000.50", "eip155:84532")).rejects.toThrow(
        "Invalid money format",
      );
    });

    it("should resolve a ticker-suffixed price against the network's default assets", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("1.00 USDC", "eip155:84532");

      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
    });

    it("should throw for a ticker with no default asset on the network", async () => {
      const scheme = new AuthCaptureEvmScheme();

      await expect(scheme.parsePrice("1.00 NOPE", "eip155:84532")).rejects.toThrow(
        "No NOPE default asset configured for network eip155:84532",
      );
    });
    it("should handle zero amounts", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$0.00", "eip155:84532");

      expect(result.amount).toBe("0");
    });

    it("should accept numeric price", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice(0.01, "eip155:84532");

      expect(result.amount).toBe("10000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should return extra with name and version for Base mainnet", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:8453");

      expect(result.extra).toEqual({ name: "USD Coin", version: "2" });
    });

    it("should pass through AssetAmount objects with extra", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice(
        { asset: "0xCustomToken", amount: "42000", extra: { name: "Custom", version: "1" } },
        "eip155:84532",
      );

      expect(result.amount).toBe("42000");
      expect(result.asset).toBe("0xCustomToken");
      expect(result.extra).toEqual({ name: "Custom", version: "1" });
    });

    it("should pass through AssetAmount objects without extra", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice(
        { asset: "0xCustomToken", amount: "42000" },
        "eip155:84532",
      );

      expect(result.amount).toBe("42000");
      expect(result.asset).toBe("0xCustomToken");
      expect(result.extra).toEqual({});
    });

    it("should throw when AssetAmount has no asset", async () => {
      const scheme = new AuthCaptureEvmScheme();
      await expect(
        scheme.parsePrice({ asset: "", amount: "42000" }, "eip155:84532"),
      ).rejects.toThrow("Asset address must be specified");
    });

    it("should throw for unsupported network", async () => {
      const scheme = new AuthCaptureEvmScheme();
      await expect(scheme.parsePrice("$1.00", "eip155:99999")).rejects.toThrow(
        "No default asset configured for network",
      );
    });

    it("should propagate assetTransferMethod from default-asset table for permit2 chains", async () => {
      // Mezo testnet defaults to mUSD which uses permit2 and supports EIP-2612,
      // so name/version remain (for the EIP-2612 sig) and assetTransferMethod is propagated.
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:31611");

      expect(result.asset).toBe("0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503");
      expect(result.extra).toMatchObject({
        assetTransferMethod: "permit2",
        name: "Mezo USD",
        version: "1",
      });
    });
  });

  describe("registerMoneyParser", () => {
    it("should use custom parser when it returns a result", async () => {
      const scheme = new AuthCaptureEvmScheme();
      scheme.registerMoneyParser(async (amount, _network) => ({
        asset: "0xCustomToken",
        amount: String(amount * 1e18),
        extra: { name: "Custom", version: "1" },
      }));

      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.asset).toBe("0xCustomToken");
      expect(result.amount).toBe(String(1e18));
      expect(result.extra).toEqual({ name: "Custom", version: "1" });
    });

    it("should fall through to default when custom parser returns null", async () => {
      const scheme = new AuthCaptureEvmScheme();
      scheme.registerMoneyParser(async () => null);

      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.amount).toBe("1000000");
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should try parsers in registration order", async () => {
      const scheme = new AuthCaptureEvmScheme();
      scheme.registerMoneyParser(async () => null);
      scheme.registerMoneyParser(async (amount, _network) => ({
        asset: "0xSecondParser",
        amount: String(amount * 100),
        extra: {},
      }));

      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.asset).toBe("0xSecondParser");
      expect(result.amount).toBe("100");
    });
  });

  describe("enhancePaymentRequirements", () => {
    // A complete `extra` carrying every field `isAuthCaptureExtra` requires.
    // Use this in tests that aren't exercising the fail-fast validation path,
    // so the assertion against missing-field rejection doesn't fire and the
    // test can focus on whatever behavior it's actually trying to cover.
    // Passing `undefined` for a key removes it (vs. spreading, which would
    // leave a `key: undefined` entry that overrides supportedKind on merge).
    const completeExtra = (overrides: Record<string, unknown> = {}) => {
      const out: Record<string, unknown> = {
        captureAuthorizer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        captureDeadlineSeconds: 30 * 86400,
        refundDeadlineSeconds: 60 * 86400,
        feeRecipient: "0x0000000000000000000000000000000000000000",
        minFeeBps: 0,
        maxFeeBps: 100,
        name: "USDC",
        version: "2",
        captureMode: "deferred",
      };
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete out[k];
        else out[k] = v;
      }
      return out;
    };

    const baseRequirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      extra: completeExtra(),
    };

    it("should merge extra fields from supportedKind", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: {
          fromSupported1: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          fromSupported2: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      };

      const result = await scheme.enhancePaymentRequirements(baseRequirements, supportedKind, []);

      expect(result.extra).toMatchObject({
        fromSupported1: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fromSupported2: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
    });

    it("should not mirror facilitator operators allowlist onto 402 extra", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: {
          operators: [{ address: "*", operatorType: "custom" }],
        },
      };

      const result = await scheme.enhancePaymentRequirements(baseRequirements, supportedKind, []);

      expect(result.extra).not.toHaveProperty("operators");
    });

    it("should preserve existing extra fields from requirements", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ customField: "custom-value" }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: { fromSupported: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.extra).toMatchObject({
        fromSupported: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        customField: "custom-value",
      });
    });

    it("should let requirements extra override supportedKind extra", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ sharedKey: "0xcccccccccccccccccccccccccccccccccccccccc" }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: { sharedKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.extra?.sharedKey).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
    });

    it("should copy captureAuthorizer from supportedKind.extra for delegated routes", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureAuthorizer: undefined, operatorType: "delegated" }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: { captureAuthorizer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.extra?.captureAuthorizer).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    });

    it("should throw when delegated captureAuthorizer is missing from route and supportedKind", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureAuthorizer: undefined, operatorType: "delegated" }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureAuthorizer/);
    });

    it("should not inherit facilitator-advertised captureAuthorizer on custom routes", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureAuthorizer: undefined, operatorType: "custom" }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: { captureAuthorizer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      };

      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/extra\.captureAuthorizer/);
    });

    it("should preserve all original requirement fields", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      const result = await scheme.enhancePaymentRequirements(baseRequirements, supportedKind, []);

      expect(result.scheme).toBe("auth-capture");
      expect(result.network).toBe("eip155:84532");
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.payTo).toBe("0x1234567890123456789012345678901234567890");
    });

    it("should convert captureDeadlineSeconds and refundDeadlineSeconds to absolute deadlines, stripping the offset keys", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureDeadlineSeconds: 600,
          refundDeadlineSeconds: 1200,
        }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      const before = Math.floor(Date.now() / 1000);
      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);
      const after = Math.floor(Date.now() / 1000);

      const captureDeadline = result.extra?.captureDeadline as number;
      const refundDeadline = result.extra?.refundDeadline as number;

      expect(captureDeadline).toBeGreaterThanOrEqual(before + 600);
      expect(captureDeadline).toBeLessThanOrEqual(after + 600);
      expect(refundDeadline).toBeGreaterThanOrEqual(before + 1200);
      expect(refundDeadline).toBeLessThanOrEqual(after + 1200);

      expect(result.extra).not.toHaveProperty("captureDeadlineSeconds");
      expect(result.extra).not.toHaveProperty("refundDeadlineSeconds");
    });

    it("should throw when mixing an absolute deadline with a relative offset", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      const reqs = {
        ...baseRequirements,
        extra: completeExtra({
          captureDeadline: 1700000000,
          captureDeadlineSeconds: undefined,
          refundDeadlineSeconds: 60,
        }),
      };
      await expect(scheme.enhancePaymentRequirements(reqs, supportedKind, [])).rejects.toThrow(
        /both absolute deadlines/,
      );
    });

    it("should use absolute captureDeadline / refundDeadline when both are set without offsets", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureDeadlineSeconds: undefined,
          refundDeadlineSeconds: undefined,
          captureDeadline: 1700000000,
          refundDeadline: 1800000000,
        }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.extra?.captureDeadline).toBe(1700000000);
      expect(result.extra?.refundDeadline).toBe(1800000000);
      expect(result.extra).not.toHaveProperty("captureDeadlineSeconds");
      expect(result.extra).not.toHaveProperty("refundDeadlineSeconds");
    });

    it("should produce distinct deadlines across two calls separated in time", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureDeadlineSeconds: 1,
          refundDeadlineSeconds: 2,
        }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      const first = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);
      await new Promise(resolve => setTimeout(resolve, 1100));
      const second = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(second.extra?.captureDeadline).toBeGreaterThan(first.extra?.captureDeadline as number);
      expect(second.extra?.refundDeadline).toBeGreaterThan(first.extra?.refundDeadline as number);
    });

    it("should throw on non-positive captureDeadlineSeconds", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureDeadlineSeconds: 0 }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureDeadlineSeconds/);
    });

    it("should throw on non-positive refundDeadlineSeconds", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ refundDeadlineSeconds: -1 }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/refundDeadlineSeconds/);
    });

    it("should throw on non-finite offset", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureDeadlineSeconds: Number.NaN }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureDeadlineSeconds/);
    });

    it("should throw on non-number offset", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureDeadlineSeconds: "30d" }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
      };

      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureDeadlineSeconds/);
    });

    it("should accept offsets from supportedKind.extra (facilitator-injected) when not set in requirements", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        // Drop the offsets from requirements so supportedKind's offsets are what gets used.
        extra: completeExtra({
          captureDeadlineSeconds: undefined,
          refundDeadlineSeconds: undefined,
        }),
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        extra: {
          captureDeadlineSeconds: 600,
          refundDeadlineSeconds: 1200,
        },
      };

      const before = Math.floor(Date.now() / 1000);
      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);
      const after = Math.floor(Date.now() / 1000);

      const captureDeadline = result.extra?.captureDeadline as number;
      const refundDeadline = result.extra?.refundDeadline as number;

      expect(captureDeadline).toBeGreaterThanOrEqual(before + 600);
      expect(captureDeadline).toBeLessThanOrEqual(after + 600);
      expect(refundDeadline).toBeGreaterThanOrEqual(before + 1200);
      expect(refundDeadline).toBeLessThanOrEqual(after + 1200);
    });
  });

  describe("enhancePaymentRequirements - fail-fast field validation", () => {
    const completeExtra = (overrides: Record<string, unknown> = {}) => {
      const out: Record<string, unknown> = {
        captureAuthorizer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        captureDeadlineSeconds: 30 * 86400,
        refundDeadlineSeconds: 60 * 86400,
        feeRecipient: "0x0000000000000000000000000000000000000000",
        minFeeBps: 0,
        maxFeeBps: 100,
        name: "USDC",
        version: "2",
        captureMode: "deferred",
      };
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete out[k];
        else out[k] = v;
      }
      return out;
    };

    const baseRequirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
    };

    const supportedKind = {
      x402Version: 2,
      scheme: "auth-capture",
      network: "eip155:84532" as const,
    };

    for (const field of ["feeRecipient", "minFeeBps", "maxFeeBps"] as const) {
      it(`should throw when extra.${field} is missing`, async () => {
        const scheme = new AuthCaptureEvmScheme();
        const requirements = {
          ...baseRequirements,
          extra: completeExtra({ [field]: undefined }),
        };
        await expect(
          scheme.enhancePaymentRequirements(requirements, supportedKind, []),
        ).rejects.toThrow(new RegExp(`extra\\.${field}`));
      });
    }

    it("should throw when extra.captureAuthorizer is missing for custom operatorType", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureAuthorizer: undefined, operatorType: "custom" }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/extra\.captureAuthorizer/);
    });

    it("should throw when neither captureDeadlineSeconds nor captureDeadline is provided", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureDeadlineSeconds: undefined,
          refundDeadlineSeconds: undefined,
        }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/extra\.captureDeadline/);
    });

    it("should throw the mix error when only one relative deadline offset is set", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          refundDeadlineSeconds: undefined,
        }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/both absolute deadlines.*both relative offsets/);
    });

    it("should throw when captureAuthorizer is the wrong type", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureAuthorizer: 42 }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureAuthorizer/);
    });

    it("should include the path-to-fix hint in the deadline error message", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureDeadlineSeconds: undefined,
          refundDeadlineSeconds: undefined,
        }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureDeadlineSeconds.*captureDeadline/);
    });

    it("should not fail-fast on missing name (auto-populated by parsePrice for decimal pricing; wire-side rejection for AssetAmount path)", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ name: undefined }),
      };
      // Merchant uses decimal pricing → name is auto-populated by parsePrice → no need to throw here.
      // Merchant uses a custom AssetAmount and forgets name → facilitator catches with invalid_auth_capture_extra.
      // Either way enhance does not throw on missing name.
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).resolves.not.toThrow();
    });

    it("should not fail-fast on missing version (same rationale as name)", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ version: undefined }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).resolves.not.toThrow();
    });

    it("should throw when autoCapture is present", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ autoCapture: true }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/autoCapture/);
    });

    it("should derive receiverAuthorizer from the signer when the route omits it", async () => {
      const signerAddress = "0x1111111111111111111111111111111111111111" as `0x${string}`;
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: { address: signerAddress, signTypedData: vi.fn() },
      });
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureMode: undefined }),
      };
      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(result.extra?.receiverAuthorizer).toBe(signerAddress);
    });

    it("should let the signer win over a facilitator-advertised receiverAuthorizer", async () => {
      const signerAddress = "0x1111111111111111111111111111111111111111" as `0x${string}`;
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: { address: signerAddress, signTypedData: vi.fn() },
      });
      const result = await scheme.enhancePaymentRequirements(
        { ...baseRequirements, extra: completeExtra({ captureMode: "deferred" }) },
        {
          ...supportedKind,
          extra: { receiverAuthorizer: "0x9999999999999999999999999999999999999999" },
        },
        [],
      );
      expect(result.extra?.receiverAuthorizer).toBe(signerAddress);
    });

    it("should throw when the route sets a conflicting non-zero receiverAuthorizer", async () => {
      const signerAddress = "0x1111111111111111111111111111111111111111" as `0x${string}`;
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: { address: signerAddress, signTypedData: vi.fn() },
      });
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureMode: "deferred",
          receiverAuthorizer: "0x9999999999999999999999999999999999999999",
        }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/does not match the scheme's receiverAuthorizerSigner/);
    });

    it("should throw on escrow sync without a receiverAuthorizerSigner", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({
          captureMode: undefined,
          receiverAuthorizer: "0x1111111111111111111111111111111111111111",
        }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/receiverAuthorizerSigner/);
    });

    it("should throw when captureMode is set on an authorization route", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ paymentFlow: "authorization", captureMode: "sync" }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/captureMode/);
    });

    it("should throw on an authorization route without a receiver authorizer", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ paymentFlow: "authorization", captureMode: undefined }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/requires a non-zero receiverAuthorizer/);
    });

    it("should derive the required charge authorizer from the configured signer", async () => {
      const signerAddress = "0x1111111111111111111111111111111111111111" as `0x${string}`;
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: { address: signerAddress, signTypedData: vi.fn() },
      });
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ paymentFlow: "authorization", captureMode: undefined }),
      };
      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(result.extra?.receiverAuthorizer).toBe(signerAddress);
    });

    it("should throw on escrow sync for a custom operator", async () => {
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: {
          address: "0x1111111111111111111111111111111111111111",
          signTypedData: vi.fn(),
        },
      });
      const requirements = {
        ...baseRequirements,
        extra: completeExtra({ captureMode: undefined, operatorType: "custom" }),
      };
      await expect(
        scheme.enhancePaymentRequirements(requirements, supportedKind, []),
      ).rejects.toThrow(/collect-only/);
    });

    it("should allow escrow deferred for a custom operator", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.enhancePaymentRequirements(
        { ...baseRequirements, extra: completeExtra({ operatorType: "custom" }) },
        supportedKind,
        [],
      );
      expect(result.extra?.captureMode).toBe("deferred");
      expect(result.extra?.operatorType).toBe("custom");
    });

    it("should write paymentFlow escrow onto extra for the default route", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.enhancePaymentRequirements(
        { ...baseRequirements, extra: completeExtra() },
        supportedKind,
        [],
      );
      expect(result.extra?.paymentFlow).toBe("escrow");
      expect(result.extra?.captureMode).toBe("deferred");
    });
  });

  describe("scheme property", () => {
    it('should have scheme set to "auth-capture"', () => {
      const scheme = new AuthCaptureEvmScheme();
      expect(scheme.scheme).toBe("auth-capture");
    });
  });

  describe("getters", () => {
    it("should default storage and leave the receiver-authorizer signer unset", () => {
      const scheme = new AuthCaptureEvmScheme();
      expect(scheme.getStorage()).toBeInstanceOf(InMemoryAuthorizedPaymentStorage);
      expect(scheme.getReceiverAuthorizerSigner()).toBeUndefined();
    });

    it("should return the configured storage and signer", () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      const signer = {
        address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        signTypedData: vi.fn(),
      };
      const scheme = new AuthCaptureEvmScheme({
        storage,
        receiverAuthorizerSigner: signer,
      });
      expect(scheme.getStorage()).toBe(storage);
      expect(scheme.getReceiverAuthorizerSigner()).toBe(signer);
    });
  });

  describe("payment flow declaration", () => {
    it("should default to eip3009 and declare escrow (default) plus authorization for both collectors", () => {
      const scheme = new AuthCaptureEvmScheme();

      expect(scheme.defaultAssetTransferMethod).toBe("eip3009");
      expect(scheme.paymentFlows).toEqual({
        eip3009: { supported: ["escrow", "authorization"], default: "escrow" },
        permit2: { supported: ["escrow", "authorization"], default: "escrow" },
      });
    });
  });

  describe("getAssetDecimals", () => {
    it("should return decimals for a known default asset", () => {
      const scheme = new AuthCaptureEvmScheme();

      expect(scheme.getAssetDecimals(BASE_SEPOLIA_USDC, "eip155:84532")).toBe(6);
    });

    it("should return undefined for an unknown asset", () => {
      const scheme = new AuthCaptureEvmScheme();

      expect(
        scheme.getAssetDecimals("0x9999999999999999999999999999999999999999", "eip155:84532"),
      ).toBeUndefined();
    });
  });

  describe("authorized payment storage and helpers", () => {
    const hash = ("0x" + "11".repeat(32)) as `0x${string}`;
    const saltNonce = ("0x" + "22".repeat(32)) as `0x${string}`;
    const receiverAuthorizer = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const payer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

    function sampleRecord(overrides: Partial<AuthorizedPayment> = {}): AuthorizedPayment {
      return {
        paymentInfoHash: hash,
        paymentInfo: {
          operator: "0x1234567890123456789012345678901234567890" as `0x${string}`,
          payer,
          receiver: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
          token: BASE_SEPOLIA_USDC as `0x${string}`,
          maxAmount: "1000000",
          preApprovalExpiry: 1,
          authorizationExpiry: 2,
          refundExpiry: 3,
          minFeeBps: 0,
          maxFeeBps: 0,
          feeReceiver: "0x0000000000000000000000000000000000000000" as `0x${string}`,
          salt: ("0x" + "00".repeat(32)) as `0x${string}`,
        },
        saltNonce,
        receiverAuthorizer,
        policy: "0x0000000000000000000000000000000000000000" as `0x${string}`,
        network: "eip155:84532",
        capturableAmount: "1000000",
        refundableAmount: "0",
        collectTransaction: "0xabc",
        createdAt: Date.now(),
        name: "USDC",
        version: "2",
        paymentFlow: "escrow",
        operatorType: "delegated",
        assetTransferMethod: "eip3009",
        authCaptureEscrow: AUTH_CAPTURE_ESCROW_ADDRESS,
        ...overrides,
      };
    }

    function lifecycleScheme(storage: InMemoryAuthorizedPaymentStorage, settle = vi.fn()) {
      settle.mockResolvedValue({
        success: true,
        transaction: "0xtx",
        network: "eip155:84532",
        payer,
        amount: "500000",
      });
      const authorizerSigner = {
        address: receiverAuthorizer,
        signTypedData: vi.fn().mockResolvedValue("0xsig" as `0x${string}`),
      };
      const facilitator = { settle } as unknown as FacilitatorClient;
      const scheme = new AuthCaptureEvmScheme({
        storage,
        receiverAuthorizerSigner: authorizerSigner,
      });
      return {
        scheme,
        lifecycle: scheme.createLifecycleManager(facilitator),
        settle,
        authorizerSigner,
      };
    }

    it("should persist and list records through InMemoryAuthorizedPaymentStorage", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      const record = sampleRecord();
      await storage.update(hash, () => record);
      expect(await storage.get(hash)).toEqual(record);
      expect(await storage.list()).toHaveLength(1);
    });

    it("should throw when capture is called without a stored record", async () => {
      const { lifecycle } = lifecycleScheme(new InMemoryAuthorizedPaymentStorage());
      await expect(lifecycle.capture(hash)).rejects.toThrow(/no authorized payment/);
    });

    it("should throw when capture is called without a receiverAuthorizerSigner", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      await storage.update(hash, () => sampleRecord());
      const scheme = new AuthCaptureEvmScheme({ storage });
      const lifecycle = scheme.createLifecycleManager({
        settle: vi.fn(),
      } as unknown as FacilitatorClient);
      await expect(lifecycle.capture(hash)).rejects.toThrow(/receiverAuthorizerSigner/);
    });

    it("should capture through the facilitator and write remaining balances", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      await storage.update(hash, () => sampleRecord());
      const { lifecycle, settle } = lifecycleScheme(storage);
      const result = await lifecycle.capture(hash, { amount: "500000" });
      expect(result.success).toBe(true);
      expect(settle).toHaveBeenCalledOnce();
      const payload = settle.mock.calls[0][0].payload;
      expect(payload.type).toBe("capture");
      expect(payload.amount).toBe("500000");
      expect(payload.voidAuthorizerSignature).toBeUndefined();
      const updated = await lifecycle.getAuthorizedPayment(hash);
      expect(updated?.capturableAmount).toBe("500000");
      expect(updated?.refundableAmount).toBe("500000");
    });

    it("should attach voidAuthorizerSignature and zero capturable on voidRemainder", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      await storage.update(hash, () => sampleRecord());
      const { lifecycle, settle } = lifecycleScheme(storage);
      await lifecycle.capture(hash, { amount: "500000", voidRemainder: true });
      const payload = settle.mock.calls[0][0].payload;
      expect(payload.voidAuthorizerSignature).toBe("0xsig");
      const updated = await lifecycle.getAuthorizedPayment(hash);
      expect(updated?.capturableAmount).toBe("0");
      expect(updated?.refundableAmount).toBe("500000");
    });

    it("should void remaining hold through voidPayment", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      await storage.update(hash, () => sampleRecord());
      const { lifecycle, settle } = lifecycleScheme(storage);
      await lifecycle.voidPayment(hash);
      expect(settle.mock.calls[0][0].payload.type).toBe("void");
      const updated = await lifecycle.getAuthorizedPayment(hash);
      expect(updated?.capturableAmount).toBe("0");
    });

    it("should refund captured funds and decrement refundableAmount", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      await storage.update(hash, () =>
        sampleRecord({ capturableAmount: "0", refundableAmount: "1000000" }),
      );
      const { lifecycle, settle } = lifecycleScheme(storage);
      await lifecycle.refund(hash, { amount: "250000" });
      expect(settle.mock.calls[0][0].payload.type).toBe("refund");
      const updated = await lifecycle.getAuthorizedPayment(hash);
      expect(updated?.refundableAmount).toBe("750000");
    });
  });

  describe("schemeHooks — deferred skip and persist", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const extra = {
      captureAuthorizer: "0x1234567890123456789012345678901234567890",
      captureDeadline: future,
      refundDeadline: future + 86400,
      feeRecipient: "0x0000000000000000000000000000000000000000",
      minFeeBps: 0,
      maxFeeBps: 0,
      name: "USDC",
      version: "2",
      paymentFlow: "escrow" as const,
      captureMode: "deferred" as const,
    };
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra,
    };
    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        authorization: {
          from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
          value: "1000000",
          validAfter: "0",
          validBefore: String(future),
          nonce: "0x" + "33".repeat(32),
        },
        signature: "0xabcd",
        salt: "0x" + "44".repeat(32),
      },
    };
    const authorizeResult = {
      success: true,
      transaction: "0xauthorize",
      network: "eip155:84532",
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    it("should skip the after-handler settle and echo the authorize receipt", async () => {
      const scheme = new AuthCaptureEvmScheme();
      await scheme.schemeHooks.onAfterSettle!({
        phase: "before-handler",
        paymentPayload,
        requirements,
        declaredExtensions: {},
        result: authorizeResult,
      } as never);
      const skip = await scheme.schemeHooks.onBeforeSettle!({
        phase: "after-handler",
        paymentPayload,
        requirements,
        declaredExtensions: {},
      } as never);
      expect(skip).toEqual({ skip: true, result: authorizeResult });
    });

    it("should persist an authorized payment after a successful authorize settle", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      const scheme = new AuthCaptureEvmScheme({ storage });
      await scheme.schemeHooks.onAfterSettle!({
        phase: "before-handler",
        paymentPayload,
        requirements,
        declaredExtensions: {},
        result: authorizeResult,
      } as never);
      const listed = await scheme.getStorage().list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.capturableAmount).toBe("1000000");
      expect(listed[0]?.refundableAmount).toBe("0");
      expect(listed[0]?.collectTransaction).toBe("0xauthorize");
      expect(listed[0]?.authCaptureEscrow).toBe(AUTH_CAPTURE_ESCROW_ADDRESS);
    });

    it("should persist a v1.0 escrow pin and reconstruct it on lifecycle capture", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      const authorizerSigner = {
        address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        signTypedData: vi.fn().mockResolvedValue("0xsig" as `0x${string}`),
      };
      const settle = vi.fn().mockResolvedValue({
        success: true,
        transaction: "0xtx",
        network: "eip155:84532",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        amount: "1000000",
      });
      const scheme = new AuthCaptureEvmScheme({
        storage,
        receiverAuthorizerSigner: authorizerSigner,
      });
      const pinnedExtra = {
        ...extra,
        authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
        receiverAuthorizer: authorizerSigner.address,
      };
      const pinnedRequirements = { ...requirements, extra: pinnedExtra };
      const saltNonce = ("0x" + "22".repeat(32)) as `0x${string}`;
      await scheme.schemeHooks.onAfterSettle!({
        phase: "before-handler",
        paymentPayload: {
          ...paymentPayload,
          accepted: pinnedRequirements,
          payload: { ...paymentPayload.payload, saltNonce },
        },
        requirements: pinnedRequirements,
        declaredExtensions: {},
        result: authorizeResult,
      } as never);

      const [stored] = await storage.list();
      expect(stored?.authCaptureEscrow).toBe(AUTH_CAPTURE_ESCROW_V1_0_ADDRESS);

      const lifecycle = scheme.createLifecycleManager({ settle } as unknown as FacilitatorClient);
      await lifecycle.capture(stored!.paymentInfoHash);

      expect(settle).toHaveBeenCalledOnce();
      const settledExtra = settle.mock.calls[0][1].extra as { authCaptureEscrow: string };
      expect(settledExtra.authCaptureEscrow).toBe(AUTH_CAPTURE_ESCROW_V1_0_ADDRESS);
      expect(settle.mock.calls[0][0].payload).toMatchObject({ type: "capture", feeBps: 0 });
      expect(settle.mock.calls[0][0].payload.feeAmount).toBeUndefined();
      expect(authorizerSigner.signTypedData).toHaveBeenCalledWith(
        expect.objectContaining({ types: CAPTURE_TYPES_V1_0, primaryType: "Capture" }),
      );
    });

    it("should leave balances alone when a retried settle persists the same payment", async () => {
      const storage = new InMemoryAuthorizedPaymentStorage();
      const scheme = new AuthCaptureEvmScheme({ storage });
      const persist = () =>
        scheme.schemeHooks.onAfterSettle!({
          phase: "before-handler",
          paymentPayload,
          requirements,
          declaredExtensions: {},
          result: authorizeResult,
        } as never);

      await persist();
      // Stand in for an out-of-band capture that already moved the balances.
      const [stored] = await storage.list();
      await storage.update(stored!.paymentInfoHash, current => ({
        ...current!,
        capturableAmount: "400000",
        refundableAmount: "600000",
      }));

      await persist();

      const listed = await storage.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.capturableAmount).toBe("400000");
      expect(listed[0]?.refundableAmount).toBe("600000");
    });

    it("should not skip after-handler settle for sync escrow", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const syncRequirements = {
        ...requirements,
        extra: {
          ...extra,
          captureMode: "sync" as const,
          receiverAuthorizer: "0x1111111111111111111111111111111111111111",
        },
      };
      await scheme.schemeHooks.onAfterSettle!({
        phase: "before-handler",
        paymentPayload,
        requirements: syncRequirements,
        declaredExtensions: {},
        result: authorizeResult,
      } as never);
      const skip = await scheme.schemeHooks.onBeforeSettle!({
        phase: "after-handler",
        paymentPayload,
        requirements: syncRequirements,
        declaredExtensions: {},
      } as never);
      expect(skip).toBeUndefined();
    });
  });

  describe("enrichSettlementPayload", () => {
    it("should add capture fields without re-emitting saltNonce", async () => {
      const authorizerSigner = {
        address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        signTypedData: vi.fn().mockResolvedValue("0xsig" as `0x${string}`),
      };
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: authorizerSigner,
      });
      const future = Math.floor(Date.now() / 1000) + 86400;
      const extra = {
        captureAuthorizer: "0x1234567890123456789012345678901234567890",
        captureDeadline: future,
        refundDeadline: future + 86400,
        feeRecipient: "0x0000000000000000000000000000000000000000",
        minFeeBps: 0,
        maxFeeBps: 0,
        name: "USDC",
        version: "2",
        paymentFlow: "escrow" as const,
        captureMode: "sync" as const,
        receiverAuthorizer: authorizerSigner.address,
      };
      const requirements = {
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        maxTimeoutSeconds: 300,
        extra,
      };
      const enrichment = await scheme.enrichSettlementPayload({
        phase: "after-handler",
        paymentPayload: {
          x402Version: 2,
          accepted: requirements,
          payload: {
            authorization: {
              from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
              value: "1000000",
              validAfter: "0",
              validBefore: String(future),
              nonce: "0x" + "33".repeat(32),
            },
            signature: "0xabcd",
            salt: "0x" + "44".repeat(32),
            saltNonce: "0x" + "22".repeat(32),
          },
        },
        requirements,
        declaredExtensions: {},
      } as never);
      expect(enrichment).toMatchObject({
        type: "capture",
        amount: "1000000",
        authorizerSignature: "0xsig",
      });
      expect(enrichment).not.toHaveProperty("saltNonce");
    });

    it("should keep authorized maxAmount in capture paymentInfo when settle amount is overridden", async () => {
      const authorizerSigner = {
        address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        signTypedData: vi.fn().mockResolvedValue("0xsig" as `0x${string}`),
      };
      const scheme = new AuthCaptureEvmScheme({
        receiverAuthorizerSigner: authorizerSigner,
      });
      const future = Math.floor(Date.now() / 1000) + 86400;
      const extra = {
        captureAuthorizer: "0x1234567890123456789012345678901234567890",
        captureDeadline: future,
        refundDeadline: future + 86400,
        feeRecipient: "0x0000000000000000000000000000000000000000",
        minFeeBps: 0,
        maxFeeBps: 0,
        name: "USDC",
        version: "2",
        paymentFlow: "escrow" as const,
        captureMode: "sync" as const,
        receiverAuthorizer: authorizerSigner.address,
      };
      const accepted = {
        scheme: "auth-capture",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        maxTimeoutSeconds: 300,
        extra,
      };
      const enrichment = await scheme.enrichSettlementPayload({
        phase: "after-handler",
        paymentPayload: {
          x402Version: 2,
          accepted: {
            ...accepted,
            amount: "1",
            payTo: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
          },
          payload: {
            authorization: {
              from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
              value: "1000000",
              validAfter: "0",
              validBefore: String(future),
              nonce: "0x" + "33".repeat(32),
            },
            signature: "0xabcd",
            salt: "0x" + "44".repeat(32),
            saltNonce: "0x" + "22".repeat(32),
          },
        },
        requirements: { ...accepted, amount: "980000" },
        declaredExtensions: {},
      } as never);
      expect(enrichment).toMatchObject({
        type: "capture",
        amount: "980000",
        expectedCapturableAmount: "1000000",
      });
      expect(
        (enrichment as { paymentInfo: { maxAmount: string; receiver: string } }).paymentInfo,
      ).toEqual(
        expect.objectContaining({
          maxAmount: "1000000",
          receiver: accepted.payTo,
        }),
      );
      expect((enrichment as { paymentInfo: { receiver: string } }).paymentInfo.receiver).not.toBe(
        "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
      );
    });
  });
});
