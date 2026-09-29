import { describe, expect, it } from "vitest";

import type { PaymentRequirements } from "../../types/verify";
import {
  choosePaymentRequirement,
  getNetworkDisplayName,
  isEvmNetwork,
  isSvmNetwork,
  normalizePaymentRequirements,
} from "./paywallUtils";

const baseRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "base",
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
  network: "base-sepolia",
  description: "Base Sepolia resource",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const solanaRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "solana",
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
  it("normalizes single payment requirement into an array", () => {
    const normalized = normalizePaymentRequirements(baseRequirement);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toBe(baseRequirement);
  });

  it("selects first available payment from preferred networks on mainnet", () => {
    const selected = choosePaymentRequirement([baseRequirement, solanaRequirement], false);
    expect(["base", "solana"]).toContain(selected.network);
  });

  it("selects first available payment from preferred networks on testnet", () => {
    const selected = choosePaymentRequirement([baseSepoliaRequirement, solanaRequirement], true);
    expect(["base-sepolia", "solana-devnet"]).toContain(selected.network);
  });

  it("falls back to solana when no evm networks exist", () => {
    const selected = choosePaymentRequirement([solanaRequirement], false);
    expect(selected.network).toBe("solana");
  });

  it("returns display names for known networks", () => {
    expect(getNetworkDisplayName("base")).toBe("Base");
    expect(getNetworkDisplayName("solana-devnet")).toBe("Solana Devnet");
  });

  it("identifies supported network families", () => {
    expect(isEvmNetwork("base")).toBe(true);
    expect(isEvmNetwork("solana")).toBe(false);
    expect(isSvmNetwork("solana")).toBe(true);
    expect(isSvmNetwork("base")).toBe(false);
  });
});
