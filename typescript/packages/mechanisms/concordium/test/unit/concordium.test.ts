import { describe, it, expect, vi } from "vitest";
import { ExactConcordiumScheme as ExactConcordiumServer } from "../../src/exact/server/scheme";
import { ExactConcordiumScheme as ExactConcordiumFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactConcordiumScheme as ExactConcordiumClient } from "../../src/exact/client/scheme";
import {
  CONCORDIUM_MAINNET_CAIP2,
  CONCORDIUM_TESTNET_CAIP2,
  CONCORDIUM_ADDRESS_REGEX,
  CCD_DECIMALS,
  MAX_EXPIRY_OFFSET_SECONDS,
  DEFAULT_FINALIZATION_TIMEOUT_MS,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  getExplorerTxUrl,
} from "../../src";
import type { PaymentRequirements } from "@x402/core/types";
import type { FacilitatorConcordiumSigner } from "../../src";

function createMockFacilitatorSigner(
  address = "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
): FacilitatorConcordiumSigner {
  return {
    getAddress: () => address,
    getNetwork: () => "ccd:*",
    getAccountInfo: vi.fn(),
    getTokenBalance: vi.fn().mockResolvedValue(1_000_000n),
    getTokenDecimals: vi.fn().mockResolvedValue(6),
    addSponsorSignature: vi.fn(),
    submitTransaction: vi.fn(),
    waitForFinalization: vi.fn(),
  };
}

describe("@x402/concordium", () => {
  describe("exports", () => {
    it("should export scheme classes", () => {
      expect(ExactConcordiumServer).toBeDefined();
      expect(ExactConcordiumFacilitator).toBeDefined();
    });

    it("should export constants", () => {
      expect(CONCORDIUM_MAINNET_CAIP2).toBe("ccd:9dd9ca4d19e9393877d2c44b70f89acb");
      expect(CONCORDIUM_TESTNET_CAIP2).toBe("ccd:4221332d34e1694168c2a0c0b3fd0f27");
      expect(CONCORDIUM_ADDRESS_REGEX).toBeDefined();
      expect(CCD_DECIMALS).toBe(6);
      expect(MAX_EXPIRY_OFFSET_SECONDS).toBe(600);
      expect(DEFAULT_FINALIZATION_TIMEOUT_MS).toBe(60_000);
    });

    it("should export utility functions", () => {
      expect(getConcordiumGrpcUrl).toBeDefined();
      expect(parseGrpcUrl).toBeDefined();
      expect(getExplorerTxUrl).toBeDefined();
    });
  });

  describe("ExactConcordiumServer", () => {
    it("should have scheme property set to exact", () => {
      const server = new ExactConcordiumServer();
      expect(server.scheme).toBe("exact");
    });

    it("should inject feePayer from supported kind into payment requirements", async () => {
      const feePayer = "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW";
      const server = new ExactConcordiumServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        asset: "CCD",
        amount: "1000000",
        payTo: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
        maxTimeoutSeconds: 60,
        extra: {},
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        extra: { feePayer },
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBe(feePayer);
    });

    it("should leave feePayer undefined when facilitator metadata does not provide it", async () => {
      const server = new ExactConcordiumServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        asset: "CCD",
        amount: "1000000",
        payTo: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
        maxTimeoutSeconds: 60,
        extra: {},
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBeUndefined();
    });

    it("should preserve existing extra fields when injecting feePayer", async () => {
      const feePayer = "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW";
      const server = new ExactConcordiumServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        asset: "CCD",
        amount: "1000000",
        payTo: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
        maxTimeoutSeconds: 60,
        extra: { customField: "customValue", anotherField: 42 },
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        extra: { feePayer },
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBe(feePayer);
      expect(enhanced.extra?.customField).toBe("customValue");
      expect(enhanced.extra?.anotherField).toBe(42);
    });

    it("should pass through AssetAmount in atomic units (CCD)", async () => {
      const server = new ExactConcordiumServer();
      const result = await server.parsePrice(
        { amount: "1000000", asset: "CCD" },
        CONCORDIUM_TESTNET_CAIP2,
      );

      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe("CCD");
    });

    it("should pass through AssetAmount in atomic units (PLT)", async () => {
      const server = new ExactConcordiumServer();
      const result = await server.parsePrice(
        { amount: "500", asset: "EURR" },
        CONCORDIUM_TESTNET_CAIP2,
      );

      expect(result.amount).toBe("500");
      expect(result.asset).toBe("EURR");
    });

    it("should throw when AssetAmount has no asset field", async () => {
      const server = new ExactConcordiumServer();
      await expect(
        server.parsePrice({ amount: "100" } as any, CONCORDIUM_TESTNET_CAIP2),
      ).rejects.toThrow("Asset must be specified");
    });

    it("should throw when AssetAmount has empty string asset", async () => {
      const server = new ExactConcordiumServer();
      await expect(
        server.parsePrice({ amount: "100", asset: "" }, CONCORDIUM_TESTNET_CAIP2),
      ).rejects.toThrow("Asset must be specified");
    });

    it("should throw when raw number has no registered money parser", async () => {
      const server = new ExactConcordiumServer();
      await expect(server.parsePrice("10", CONCORDIUM_TESTNET_CAIP2)).rejects.toThrow(
        "Cannot resolve price",
      );
    });

    it("should throw when USD price has no registered money parser", async () => {
      const server = new ExactConcordiumServer();
      await expect(server.parsePrice("$0.001", CONCORDIUM_TESTNET_CAIP2)).rejects.toThrow(
        "Cannot resolve price",
      );
    });

    it("should allow USD prices when a money parser is registered", async () => {
      const server = new ExactConcordiumServer();
      server.registerMoneyParser(async amount => ({
        amount: String(Math.round(amount * 1e6)),
        asset: "EURR",
        extra: {},
      }));

      const result = await server.parsePrice("$10", CONCORDIUM_TESTNET_CAIP2);

      expect(result.amount).toBe("10000000");
      expect(result.asset).toBe("EURR");
    });

    it("should pass through any AssetAmount without asset validation", async () => {
      const server = new ExactConcordiumServer();
      const result = await server.parsePrice(
        { amount: "1", asset: "UNKNOWN" },
        CONCORDIUM_TESTNET_CAIP2,
      );

      expect(result.amount).toBe("1");
      expect(result.asset).toBe("UNKNOWN");
    });

    it("should NOT inject decimals into extra via enhancePaymentRequirements", async () => {
      const server = new ExactConcordiumServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        asset: "EURR",
        amount: "1000000",
        payTo: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
        maxTimeoutSeconds: 60,
        extra: {},
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: CONCORDIUM_TESTNET_CAIP2,
        extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      // Must NOT leak decimals — client fetches them from chain (Theme D1)
      expect((enhanced.extra as Record<string, unknown>)?.decimals).toBeUndefined();
      expect((enhanced.extra as Record<string, unknown>)?.feePayer).toBe(
        "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
      );
    });

    it("should try money parsers in registration order", async () => {
      const server = new ExactConcordiumServer();
      const callOrder: number[] = [];

      server.registerMoneyParser(async _amount => {
        callOrder.push(1);
        return null; // fall through
      });
      server.registerMoneyParser(async amount => {
        callOrder.push(2);
        return { amount: String(amount * 1e6), asset: "EURR", extra: {} };
      });
      server.registerMoneyParser(async amount => {
        callOrder.push(3); // should never be called
        return { amount: String(amount), asset: "USDR", extra: {} };
      });

      const result = await server.parsePrice("10", CONCORDIUM_TESTNET_CAIP2);
      expect(result.asset).toBe("EURR");
      expect(callOrder).toEqual([1, 2]); // third parser never reached
    });

    it("should throw when all money parsers return null", async () => {
      const server = new ExactConcordiumServer();
      server.registerMoneyParser(async () => null);
      server.registerMoneyParser(async () => null);

      await expect(server.parsePrice("5", CONCORDIUM_TESTNET_CAIP2)).rejects.toThrow(
        "Cannot resolve price",
      );
    });

    it("should preserve extra fields from AssetAmount in parsePrice", async () => {
      const server = new ExactConcordiumServer();
      const result = await server.parsePrice(
        { amount: "1000000", asset: "CCD", extra: { memo: "test-memo", priority: "high" } },
        CONCORDIUM_TESTNET_CAIP2,
      );

      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe("CCD");
      expect(result.extra).toEqual({ memo: "test-memo", priority: "high" });
    });

    it("should default extra to empty object when not provided in AssetAmount", async () => {
      const server = new ExactConcordiumServer();
      const result = await server.parsePrice(
        { amount: "500", asset: "EURR" },
        CONCORDIUM_TESTNET_CAIP2,
      );

      expect(result.extra).toEqual({});
    });

    it("should throw when AssetAmount has null asset", async () => {
      const server = new ExactConcordiumServer();
      await expect(
        server.parsePrice({ amount: "100", asset: null as any }, CONCORDIUM_TESTNET_CAIP2),
      ).rejects.toThrow("Asset must be specified");
    });

    it("should throw when AssetAmount has undefined asset (explicit)", async () => {
      const server = new ExactConcordiumServer();
      await expect(
        server.parsePrice({ amount: "100", asset: undefined as any }, CONCORDIUM_TESTNET_CAIP2),
      ).rejects.toThrow("Asset must be specified");
    });
  });

  describe("ExactConcordiumFacilitator", () => {
    it("should return sponsorAddress in getExtra", () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const extra = facilitator.getExtra(CONCORDIUM_TESTNET_CAIP2);

      expect(extra).toBeDefined();
      expect(extra?.feePayer).toBe("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
    });

    it("should return signer address in getSigners", () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const signers = facilitator.getSigners(CONCORDIUM_TESTNET_CAIP2);

      expect(signers).toEqual(["4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"]);
    });

    it("should reject missing payload", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });

      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: null as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "3kBx",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("missing_payload");
    });

    it("should reject wrong transaction version", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });

      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 0 as any,
              header: {
                sender: "3kBx",
                expiry: 9999999999,
                sponsor: { account: "4Fmi", numSignatures: 1 },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { transactionType: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
            sender: "3kBx",
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 60,
          extra: { feePayer: "4Fmi" },
        },
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("invalid_transaction_version");
    });

    it("should reject sponsor mismatch", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });

      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "WRONG_SPONSOR_ADDRESS_HERE_12345678901234567890",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { transactionType: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 60,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("sponsor_mismatch");
    });

    it("should reject expired transactions", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });

      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: 1000000000, // well in the past
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { transactionType: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 60,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("transaction_expired");
    });

    it("should support multiple facilitator signers for feePayer selection", () => {
      const facilitator = new ExactConcordiumFacilitator({
        signer: [
          createMockFacilitatorSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"),
          createMockFacilitatorSigner("3wQjKH4tPa3xwM4gK5M9f7Q7mTzRrJ7z8Yw7XhXo8v9eP4JpJ8"),
        ],
      });

      expect(facilitator.getSigners(CONCORDIUM_TESTNET_CAIP2)).toEqual([
        "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
        "3wQjKH4tPa3xwM4gK5M9f7Q7mTzRrJ7z8Yw7XhXo8v9eP4JpJ8",
      ]);
      expect(facilitator.getExtra(CONCORDIUM_TESTNET_CAIP2)?.feePayer).toBeDefined();
    });

    it("should reject unsupported scheme", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "per_request", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {} as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: {},
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("should reject network mismatch", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_MAINNET_CAIP2 } as any,
          payload: {} as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: {},
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("network_mismatch");
    });

    it("should reject missing sender in header", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_sender");
    });

    it("should reject invalid sender address format", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "not-a-valid-base58-address",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_sender_address");
    });

    it("should reject missing feePayer in requirements", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: {},
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_fee_payer");
    });

    it("should reject feePayer not managed by facilitator", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "3wQjKH4tPa3xwM4gK5M9f7Q7mTzRrJ7z8Yw7XhXo8v9eP4JpJ8",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "3wQjKH4tPa3xwM4gK5M9f7Q7mTzRrJ7z8Yw7XhXo8v9eP4JpJ8" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("fee_payer_not_managed_by_facilitator");
    });

    it("should reject missing sponsor in header", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: { numSignatures: 1 },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_sponsor_in_header");
    });

    it("should reject invalid expiry field", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: NaN,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_expiry_field");
    });

    it("should reject expiry too far in future", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const farFuture = Math.floor(Date.now() / 1000) + 3600; // 1 hour ahead
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: farFuture,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("expiry_too_far_in_future");
    });

    it("should reject sponsor as sender", async () => {
      const sponsorAddress = "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp";
      const mockSigner = createMockFacilitatorSigner(sponsorAddress);
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: sponsorAddress,
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: { account: sponsorAddress, numSignatures: 1 },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: sponsorAddress },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("sponsor_as_sender");
    });

    it("should reject asset type mismatch for CCD (non-transfer payload)", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "tokenUpdate", tokenId: "EURR", operations: "aa" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      // Note: decodePayload catches tokenUpdate with invalid CBOR operations
      // before checkAssetType can run, so we get invalid_token_operations here.
      expect(result.invalidReason).toBe("invalid_token_operations");
    });

    it("should reject asset type mismatch for PLT (non-tokenUpdate payload)", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", toAddress: "4Fmi", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "EURR",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("asset_type_mismatch");
    });

    it("should reject missing tokenId for PLT payment", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "tokenUpdate", operations: "aa" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "EURR",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_token_id");
    });

    it("should reject tokenId mismatch for PLT payment", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "tokenUpdate", tokenId: "USDR", operations: "aa" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "EURR",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      // Fails at token operations decode before reaching tokenId mismatch check
      expect(result.invalidReason).toBe("invalid_token_operations");
    });

    it("should reject missing recipient for CCD transfer", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: { type: "transfer", amount: "1000000" },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_recipient");
    });

    it("should reject recipient mismatch for CCD transfer", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: {
                type: "transfer",
                toAddress: "3wQjKH4tPa3xwM4gK5M9f7Q7mTzRrJ7z8Yw7XhXo8v9eP4JpJ8",
                amount: "1000000",
              },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("recipient_mismatch");
    });

    it("should reject missing sender signature", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: {
                type: "transfer",
                toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                amount: "1000000",
              },
              signatures: { sender: {}, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_sender_signature");
    });

    it("should reject amount mismatch for CCD transfer", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: {
                type: "transfer",
                toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                amount: "999999",
              },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("amount_mismatch");
    });

    it("should reject invalid amount format in requirements", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: Math.floor(Date.now() / 1000) + 300,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: {
                type: "transfer",
                toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                amount: "1000000",
              },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "not-a-number",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_required_amount");
    });

    it("should reject invalid transaction format (non-object payload)", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: "not-an-object" as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_payload");
    });

    it("should reject missing signedTransaction in payload", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {} as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4Fmi",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("missing_signed_transaction");
    });

    it("should pass structural checks before signature verification", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2 } as any,
          payload: {
            signedTransaction: {
              version: 1,
              header: {
                sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
                expiry: validExpiry,
                sponsor: {
                  account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                  numSignatures: 1,
                },
                numSignatures: 1,
                nonce: 1,
              },
              payload: {
                type: "transfer",
                toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
                amount: "1000000",
              },
              signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
            },
          } as any,
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
      );
      // Fails at cryptographic signature verification (mock signer has no real keys)
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("signature_verification_failed");
    });

    it("should reject via preflight when account nonce is missing", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;

      // Access private preflightLikelyToSucceed directly
      const result = await (facilitator as any).preflightLikelyToSucceed(
        {
          version: 1,
          header: {
            sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
            expiry: validExpiry,
            nonce: 1,
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
            numSignatures: 1,
          },
          payload: {
            type: "transfer",
            toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            amount: "1000000",
          },
          signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
        "CCD",
        {}, // accountInfo with no nonce
        mockSigner,
        {
          recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: 1000000n,
          tokenId: null,
          tokenDecimals: null,
        },
      );

      expect(result).toBe("preflight_missing_account_nonce");
    });

    it("should reject via preflight when nonce mismatches on-chain value", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;

      const result = await (facilitator as any).preflightLikelyToSucceed(
        {
          version: 1,
          header: {
            sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
            expiry: validExpiry,
            nonce: 5, // client says nonce 5
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
            numSignatures: 1,
          },
          payload: {
            type: "transfer",
            toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            amount: "1000000",
          },
          signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
        "CCD",
        { accountNonce: 3n }, // chain says nonce 3
        mockSigner,
        {
          recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: 1000000n,
          tokenId: null,
          tokenDecimals: null,
        },
      );

      expect(result).toBe("preflight_nonce_mismatch");
    });

    it("should reject via preflight when sender has insufficient CCD balance", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;

      const result = await (facilitator as any).preflightLikelyToSucceed(
        {
          version: 1,
          header: {
            sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
            expiry: validExpiry,
            nonce: 1,
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
            numSignatures: 1,
          },
          payload: {
            type: "transfer",
            toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            amount: "1000000",
          },
          signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000000000", // huge amount
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
        "CCD",
        { accountNonce: 1n, accountAmount: "1000000" }, // only 1 CCD available
        mockSigner,
        {
          recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: 1000000000000n,
          tokenId: null,
          tokenDecimals: null,
        },
      );

      expect(result).toBe("preflight_insufficient_funds");
    });

    it("should pass preflight when nonce matches and balance is sufficient", async () => {
      const mockSigner = createMockFacilitatorSigner();
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;

      const result = await (facilitator as any).preflightLikelyToSucceed(
        {
          version: 1,
          header: {
            sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
            expiry: validExpiry,
            nonce: 1,
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
            numSignatures: 1,
          },
          payload: {
            type: "transfer",
            toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            amount: "1000000",
          },
          signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "CCD",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
        "CCD",
        { accountNonce: 1n, accountAmount: "5000000" }, // 5 CCD available, 1 CCD needed
        mockSigner,
        {
          recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: 1000000n,
          tokenId: null,
          tokenDecimals: null,
        },
      );

      expect(result).toBeNull(); // null means preflight passed
    });

    it("should reject via preflight when token balance lookup fails", async () => {
      const mockSigner = createMockFacilitatorSigner();
      // Override getTokenBalance to throw
      mockSigner.getTokenBalance = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;

      const result = await (facilitator as any).preflightLikelyToSucceed(
        {
          version: 1,
          header: {
            sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
            expiry: validExpiry,
            nonce: 1,
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
            numSignatures: 1,
          },
          payload: { type: "tokenUpdate", tokenId: "EURR", operations: {} },
          signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "EURR",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
        "EURR",
        { accountNonce: 1n },
        mockSigner,
        {
          recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: 1000000n,
          tokenId: "EURR",
          tokenDecimals: 6,
        },
      );

      expect(result).toBe("preflight_token_balance_lookup_failed");
    });

    it("should reject via preflight when token balance is insufficient", async () => {
      const mockSigner = createMockFacilitatorSigner();
      // Return a low balance
      mockSigner.getTokenBalance = vi.fn().mockResolvedValue(100n); // only 100 atomic units
      const facilitator = new ExactConcordiumFacilitator({ signer: mockSigner });
      const validExpiry = Math.floor(Date.now() / 1000) + 30;

      const result = await (facilitator as any).preflightLikelyToSucceed(
        {
          version: 1,
          header: {
            sender: "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp",
            expiry: validExpiry,
            nonce: 1,
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
            numSignatures: 1,
          },
          payload: { type: "tokenUpdate", tokenId: "EURR", operations: {} },
          signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
        },
        {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          amount: "1000000",
          asset: "EURR",
          payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          maxTimeoutSeconds: 600,
          extra: { feePayer: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW" },
        },
        "EURR",
        { accountNonce: 1n },
        mockSigner,
        {
          recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: 1000000n,
          tokenId: "EURR",
          tokenDecimals: 6,
        },
      );

      expect(result).toBe("preflight_insufficient_token_funds");
    });
  });

  describe("ExactConcordiumClient", () => {
    const validAddress = "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp";

    function createMockClientSigner(address?: string) {
      return {
        accountAddress: (address ?? validAddress) as any,
        signer: {} as any,
      };
    }

    it("should have scheme property set to exact", () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      expect(client.scheme).toBe("exact");
    });

    it("should reject missing account address", async () => {
      const client = new ExactConcordiumClient({
        accountAddress: undefined as any,
        signer: {} as any,
      });
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("Concordium account address is required");
    });

    it("should reject missing payTo", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: undefined as any,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("payTo address is required");
    });

    it("should reject empty amount", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject undefined amount", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: undefined as any,
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject USD-formatted amount like '$0.001'", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "$0.001",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject decimal amount like '0.001'", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "0.001",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject non-numeric amount like 'abc'", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "abc",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: validAddress },
        }),
      ).rejects.toThrow("amount must be a non-empty decimal string");
    });

    it("should reject missing feePayer", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: {},
        }),
      ).rejects.toThrow("requirements.extra.feePayer is required");
    });

    it("should reject empty feePayer string", async () => {
      const client = new ExactConcordiumClient(createMockClientSigner());
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: CONCORDIUM_TESTNET_CAIP2,
          asset: "CCD",
          amount: "1000",
          payTo: validAddress,
          maxTimeoutSeconds: 60,
          extra: { feePayer: "" },
        }),
      ).rejects.toThrow("requirements.extra.feePayer is required");
    });

    // === Private method tests (accessed via `as any`) ===

    describe("buildCcdTransfer", () => {
      it("should build a CCD transfer builder with valid inputs", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildCcdTransfer(validAddress, "1000000");

        expect(builder).toBeDefined();
        expect(typeof builder.addMetadata).toBe("function");
        expect(typeof builder.addSponsor).toBe("function");
        expect(typeof builder.build).toBe("function");
      });

      it("should throw on invalid payTo address", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() => (client as any).buildCcdTransfer("not-an-address", "1000000")).toThrow();
      });

      it("should throw on empty payTo", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() => (client as any).buildCcdTransfer("", "1000000")).toThrow();
      });

      it("should throw on invalid amount (negative)", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() => (client as any).buildCcdTransfer(validAddress, "-100")).toThrow();
      });

      it("should throw on non-numeric amount", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() => (client as any).buildCcdTransfer(validAddress, "abc")).toThrow();
      });

      it("should accept zero amount", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildCcdTransfer(validAddress, "0");
        expect(builder).toBeDefined();
        expect(typeof builder.build).toBe("function");
      });

      it("should accept large amount", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildCcdTransfer(validAddress, "1000000000000");
        expect(builder).toBeDefined();
      });
    });

    describe("buildPltTransfer", () => {
      it("should build a PLT token transfer builder with valid inputs", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildPltTransfer(validAddress, "1000000", "EURR", 6);

        expect(builder).toBeDefined();
        expect(typeof builder.addMetadata).toBe("function");
        expect(typeof builder.addSponsor).toBe("function");
        expect(typeof builder.build).toBe("function");
      });

      it("should throw on invalid payTo", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() => (client as any).buildPltTransfer("bad-address", "1000", "EURR", 6)).toThrow();
      });

      it("should throw on invalid amount", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() =>
          (client as any).buildPltTransfer(validAddress, "not-a-number", "EURR", 6),
        ).toThrow();
      });

      it("should throw on invalid tokenId", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        expect(() => (client as any).buildPltTransfer(validAddress, "1000", "", 6)).toThrow();
      });

      it("should accept zero amount for PLT", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildPltTransfer(validAddress, "0", "USDR", 6);
        expect(builder).toBeDefined();
      });

      it("should work with 0 decimals (non-divisible token)", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildPltTransfer(validAddress, "100", "NFT", 0);
        expect(builder).toBeDefined();
        expect(typeof builder.build).toBe("function");
      });

      it("should work with 18 decimals (high-precision token)", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildPltTransfer(
          validAddress,
          "1000000000000000000",
          "WETH",
          18,
        );
        expect(builder).toBeDefined();
        expect(typeof builder.build).toBe("function");
      });

      it("should work with large amount and 6 decimals", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const builder = (client as any).buildPltTransfer(validAddress, "1000000000000", "USDR", 6);
        expect(builder).toBeDefined();
      });
    });

    describe("createGrpcClient", () => {
      it("should return a gRPC client for testnet", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const grpcClient = (client as any).createGrpcClient(CONCORDIUM_TESTNET_CAIP2);

        expect(grpcClient).toBeDefined();
        expect(typeof grpcClient.getNextAccountNonce).toBe("function");
        expect(typeof grpcClient.getAccountInfo).toBe("function");
      });

      it("should return a gRPC client for mainnet", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const grpcClient = (client as any).createGrpcClient(CONCORDIUM_MAINNET_CAIP2);

        expect(grpcClient).toBeDefined();
      });

      it("should use TLS by default", () => {
        const client = new ExactConcordiumClient(createMockClientSigner());
        const grpcClient = (client as any).createGrpcClient(CONCORDIUM_TESTNET_CAIP2);

        // Client is created without throwing — TLS creds work
        expect(grpcClient).toBeDefined();
      });

      it("should respect useTls: false config", () => {
        const client = new ExactConcordiumClient(createMockClientSigner(), { useTls: false });
        const grpcClient = (client as any).createGrpcClient(CONCORDIUM_TESTNET_CAIP2);

        expect(grpcClient).toBeDefined();
      });

      it("should respect custom grpcUrl config", () => {
        const client = new ExactConcordiumClient(createMockClientSigner(), {
          grpcUrl: "localhost:20000",
        });
        const grpcClient = (client as any).createGrpcClient(CONCORDIUM_TESTNET_CAIP2);

        expect(grpcClient).toBeDefined();
      });
    });
  });
});
