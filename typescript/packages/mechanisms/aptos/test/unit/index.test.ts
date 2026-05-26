import { describe, it, expect, vi } from "vitest";
import { ExactAptosScheme as ExactAptosClient } from "../../src/exact/client/scheme";
import { ExactAptosScheme as ExactAptosFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactAptosScheme as ExactAptosServer } from "../../src/exact/server/scheme";
import {
  APTOS_MAINNET_CAIP2,
  APTOS_TESTNET_CAIP2,
  APTOS_ADDRESS_REGEX,
  TRANSFER_FUNCTION,
  MAX_GAS_AMOUNT,
  getAptosNetwork,
  getAptosRpcUrl,
  getAptosChainId,
} from "../../src/index";
import type { PaymentRequirements } from "@x402/core/types";

describe("@x402/aptos", () => {
  describe("exports", () => {
    it("should export main scheme classes", () => {
      expect(ExactAptosClient).toBeDefined();
      expect(ExactAptosFacilitator).toBeDefined();
      expect(ExactAptosServer).toBeDefined();
    });

    it("should export constants", () => {
      expect(APTOS_MAINNET_CAIP2).toBe("aptos:1");
      expect(APTOS_TESTNET_CAIP2).toBe("aptos:2");
      expect(APTOS_ADDRESS_REGEX).toBeDefined();
      expect(TRANSFER_FUNCTION).toBe("0x1::primary_fungible_store::transfer");
      expect(MAX_GAS_AMOUNT).toBe(500000n);
    });

    it("should export utility functions", () => {
      expect(getAptosNetwork).toBeDefined();
      expect(getAptosRpcUrl).toBeDefined();
      expect(getAptosChainId).toBeDefined();
    });
  });

  describe("ExactAptosServer", () => {
    it("should have scheme property set to exact", () => {
      const server = new ExactAptosServer();
      expect(server.scheme).toBe("exact");
    });
  });

  describe("ExactAptosFacilitator", () => {
    it("should return feePayer in getExtra for sponsored transactions", () => {
      const mockSigner = {
        getAddresses: () => ["0x123"],
        signAndSubmitAsFeePayer: vi.fn(),
        submitTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        waitForTransaction: vi.fn(),
      };
      const facilitator = new ExactAptosFacilitator(mockSigner);
      const extra = facilitator.getExtra("aptos:2");
      expect(extra).toBeDefined();
      expect(extra?.feePayer).toBe("0x123");
    });

    it("should return all signer addresses in getSigners", () => {
      const mockSigner = {
        getAddresses: () => ["0x123", "0x456"],
        signAndSubmitAsFeePayer: vi.fn(),
        submitTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        waitForTransaction: vi.fn(),
      };
      const facilitator = new ExactAptosFacilitator(mockSigner);
      const signers = facilitator.getSigners("aptos:2");
      expect(signers).toEqual(["0x123", "0x456"]);
    });
  });

  describe("ExactAptosServer enhancePaymentRequirements", () => {
    it("should add feePayer from supportedKind.extra when sponsored", async () => {
      const server = new ExactAptosServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "aptos:2",
        asset: "0x123",
        amount: "1000",
        payTo: "0x456",
        maxTimeoutSeconds: 3600,
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: "aptos:2" as const,
        extra: { feePayer: "0x789" },
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBe("0x789");
    });

    it("should not add feePayer when supportedKind.extra has no feePayer (non-sponsored)", async () => {
      const server = new ExactAptosServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "aptos:2",
        asset: "0x123",
        amount: "1000",
        payTo: "0x456",
        maxTimeoutSeconds: 3600,
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: "aptos:2" as const,
        extra: {},
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBeUndefined();
    });
  });
});
