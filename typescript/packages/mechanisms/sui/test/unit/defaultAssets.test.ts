import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactSuiScheme as ExactSuiServer } from "../../src/exact/server/scheme";
import { ExactSuiScheme as ExactSuiClient } from "../../src/exact/client/scheme";
import { SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2, USDC_MAINNET } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[SUI_MAINNET_CAIP2]![0]!;

describe("defaultAssets (Sui)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured coin type after normalization", () => {
      expect(findDefaultAsset(USDC_MAINNET, SUI_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      const [address, ...rest] = USDC_MAINNET.split("::");
      expect(
        findDefaultAsset(
          [address!.toUpperCase().replace("0X", "0x"), ...rest].join("::"),
          SUI_MAINNET_CAIP2,
        ),
      ).toEqual(MAINNET_USDC);
    });

    it("returns undefined for another network, coin, or a malformed coin type", () => {
      expect(findDefaultAsset(USDC_MAINNET, SUI_TESTNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset(USDC_MAINNET, "sui:devnet")).toBeUndefined();
      expect(findDefaultAsset("0x2::sui::SUI", SUI_MAINNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset("not-a-coin", SUI_MAINNET_CAIP2)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(SUI_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(getDefaultAsset(SUI_MAINNET_CAIP2, "usdc")).toEqual(MAINNET_USDC);
    });

    it("throws for an unknown network or ticker", () => {
      expect(() => getDefaultAsset("sui:devnet")).toThrow(
        /No default asset configured for network sui:devnet/,
      );
      expect(() => getDefaultAsset(SUI_MAINNET_CAIP2, "USDT")).toThrow(/No USDT default asset/);
    });
  });

  it("server parsePrice has no fallback for a network without a default", async () => {
    await expect(new ExactSuiServer().parsePrice("$0.10", "sui:devnet")).rejects.toThrow(
      /No default asset configured for network sui:devnet/,
    );
  });

  it("client exposes findDefaultAsset so x402Client spend controls accept Sui USDC", async () => {
    const client = new ExactSuiClient({ toSuiAddress: () => "0x1" } as never);
    expect(client.findDefaultAsset(USDC_MAINNET, SUI_MAINNET_CAIP2)).toEqual(MAINNET_USDC);

    const x402 = new x402Client().register("sui:*", client);
    const requirement: PaymentRequirements = {
      scheme: "exact",
      network: SUI_MAINNET_CAIP2,
      asset: USDC_MAINNET,
      amount: "2000000",
      payTo: "0x" + "ab".repeat(32),
      maxTimeoutSeconds: 60,
      extra: {},
    };
    // Default $1 cap: a $2 USDC requirement is rejected by the cap, not as an unknown asset.
    await expect(
      x402.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.com", description: "", mimeType: "" },
        accepts: [requirement],
      }),
    ).rejects.toThrow(/maxAmountPerPayment/);
  });
});
