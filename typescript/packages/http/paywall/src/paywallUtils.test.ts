import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import {
  choosePaymentRequirement,
  getNetworkDisplayName,
  isEvmNetwork,
  isSvmNetwork,
  normalizePaymentRequirements,
  isTestnetNetwork,
} from "./paywallUtils";

const baseRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  maxAmountRequired: "1000",
  resource: "https://example.com/protected",
  description: "Base resource",
  mimeType: "application/json",
  payTo: "0x0000000000000000000000000000000000000001",
  maxTimeoutSeconds: 60,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  extra: {
    feePayer: "0x0000000000000000000000000000000000000003",
  },
};

const baseSepoliaRequirement: PaymentRequirements = {
  ...baseRequirement,
  network: "eip155:84532",
  description: "Base Sepolia resource",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const solanaRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  maxAmountRequired: "1000",
  resource: "https://example.com/solana",
  description: "Solana resource",
  mimeType: "application/json",
  payTo: "2Zt8RZ8kW1nWcJ6YyqHq9kTjY8QpM2R2t1xXUQ1e1VQa",
  maxTimeoutSeconds: 60,
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  extra: {
    feePayer: "3d9yxXikBVYjgvPbJF4dPSt31Z87Nb5fV9jXYzQ3QAtc",
  },
};

describe("paywallUtils", () => {
  describe("normalizePaymentRequirements", () => {
    it("normalizes single payment requirement into an array", () => {
      const normalized = normalizePaymentRequirements(baseRequirement);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toBe(baseRequirement);
    });

    it("returns array as-is when already an array", () => {
      const requirements = [baseRequirement, solanaRequirement];
      const normalized = normalizePaymentRequirements(requirements);
      expect(normalized).toBe(requirements);
      expect(normalized).toHaveLength(2);
    });
  });

  describe("choosePaymentRequirement", () => {
    it("selects base payment on mainnet preference", () => {
      const selected = choosePaymentRequirement([solanaRequirement, baseRequirement], false);
      expect(selected.network).toBe("eip155:8453");
    });

    it("selects base sepolia payment on testnet preference", () => {
      const selected = choosePaymentRequirement([solanaRequirement, baseSepoliaRequirement], true);
      expect(selected.network).toBe("eip155:84532");
    });

    it("falls back to solana when no evm networks exist", () => {
      const selected = choosePaymentRequirement([solanaRequirement], false);
      expect(selected.network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    });

    it("returns first requirement when no preferred networks match", () => {
      const customRequirement = { ...baseRequirement, network: "eip155:137" };
      const selected = choosePaymentRequirement([customRequirement], true);
      expect(selected).toBe(customRequirement);
    });
  });

  describe("getNetworkDisplayName", () => {
    it("returns display names for CAIP-2 EVM networks using viem", () => {
      expect(getNetworkDisplayName("eip155:8453")).toBe("Base");
      expect(getNetworkDisplayName("eip155:84532")).toBe("Base Sepolia");
      expect(getNetworkDisplayName("eip155:1")).toBe("Ethereum");
      expect(getNetworkDisplayName("eip155:137")).toBe("Polygon");
    });

    it("returns display names for CAIP-2 Solana networks", () => {
      expect(getNetworkDisplayName("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(
        "Solana Mainnet",
      );
      expect(getNetworkDisplayName("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe(
        "Solana Devnet",
      );
    });

    it("returns fallback for unknown chain IDs", () => {
      expect(getNetworkDisplayName("eip155:999999")).toBe("Chain 999999");
    });

    it("returns network as-is for unknown formats", () => {
      expect(getNetworkDisplayName("unknown")).toBe("unknown");
    });
  });

  describe("isEvmNetwork", () => {
    it("identifies CAIP-2 EVM networks", () => {
      expect(isEvmNetwork("eip155:8453")).toBe(true);
      expect(isEvmNetwork("eip155:84532")).toBe(true);
      expect(isEvmNetwork("eip155:1")).toBe(true);
      expect(isEvmNetwork("eip155:137")).toBe(true);
    });

    it("rejects non-EVM networks", () => {
      expect(isEvmNetwork("solana:5eykt")).toBe(false);
      expect(isEvmNetwork("base")).toBe(false);
      expect(isEvmNetwork("unknown")).toBe(false);
    });
  });

  describe("isSvmNetwork", () => {
    it("identifies CAIP-2 Solana networks", () => {
      expect(isSvmNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(true);
      expect(isSvmNetwork("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe(true);
    });

    it("rejects non-Solana networks", () => {
      expect(isSvmNetwork("eip155:8453")).toBe(false);
      expect(isSvmNetwork("base")).toBe(false);
      expect(isSvmNetwork("unknown")).toBe(false);
    });
  });

  describe("isTestnetNetwork", () => {
    it("identifies EVM testnets using viem metadata", () => {
      expect(isTestnetNetwork("eip155:84532")).toBe(true);
      expect(isTestnetNetwork("eip155:80002")).toBe(true);
    });

    it("identifies Solana testnets", () => {
      expect(isTestnetNetwork("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe(true);
    });

    it("rejects mainnets", () => {
      expect(isTestnetNetwork("eip155:8453")).toBe(false);
      expect(isTestnetNetwork("eip155:1")).toBe(false);
      expect(isTestnetNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(false);
    });
  });
});
