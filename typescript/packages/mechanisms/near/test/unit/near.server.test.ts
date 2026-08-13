import type { Network, SupportedKind } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSET_BY_NETWORK,
  NEAR_MAINNET_CAIP2,
  NEAR_TESTNET_CAIP2,
} from "../../src/constants";
import { ExactNearScheme } from "../../src/exact/server/scheme";

describe("near server scheme", () => {
  it("parses dollar money into atomic units with the official Circle testnet USDC asset", async () => {
    const scheme = new ExactNearScheme();
    const parsed = await scheme.parsePrice("$1.00", NEAR_TESTNET_CAIP2);
    expect(parsed.amount).toBe("1000000");
    expect(parsed.asset).toBe(DEFAULT_ASSET_BY_NETWORK[NEAR_TESTNET_CAIP2]);
  });

  it("uses the official Circle mainnet USDC asset by default", async () => {
    const scheme = new ExactNearScheme();
    const parsed = await scheme.parsePrice("0.50", NEAR_MAINNET_CAIP2);
    expect(parsed.amount).toBe("500000");
    expect(parsed.asset).toBe(DEFAULT_ASSET_BY_NETWORK[NEAR_MAINNET_CAIP2]);
  });

  it("passes through explicit amount/asset", async () => {
    const scheme = new ExactNearScheme();
    const parsed = await scheme.parsePrice(
      { amount: "500", asset: "usdc.testnet" },
      "near:mainnet",
    );
    expect(parsed.amount).toBe("500");
    expect(parsed.asset).toBe("usdc.testnet");
  });

  it("rejects a non-NEAR network", async () => {
    const scheme = new ExactNearScheme();
    await expect(scheme.parsePrice("$1.00", "eip155:8453" as Network)).rejects.toThrow(
      /Unsupported NEAR network/,
    );
  });

  it("rejects invalid money strings via core money parsing", async () => {
    const scheme = new ExactNearScheme();
    await expect(scheme.parsePrice("1e-6", "near:testnet")).rejects.toThrow(/Invalid money format/);
  });

  it("does not inject a relayer into client-facing requirements (spec §3)", async () => {
    const scheme = new ExactNearScheme();
    const requirements = {
      scheme: "exact",
      network: "near:testnet" as Network,
      asset: "usdc.testnet",
      payTo: "merchant.testnet",
      amount: "1000000",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const supportedKind = {
      x402Version: 2,
      scheme: "exact",
      network: "near:testnet" as Network,
      extra: { relayerId: "relayer.testnet" },
    } as SupportedKind;

    const enhanced = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);
    expect(enhanced.extra?.relayerId).toBeUndefined();
    expect(enhanced).toEqual(requirements);
  });
});
