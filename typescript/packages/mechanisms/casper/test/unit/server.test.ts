import { describe, expect, it } from "vitest";
import { ExactCasperScheme } from "../../src/exact/server/scheme";
import {
  CASPER_TESTNET_CAIP2,
  CSPR_USDC_DECIMALS,
  CSPR_USDC_NAME,
  CSPR_USDC_TESTNET_ASSET,
} from "../../src";

const testPayTo = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const customAsset = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";

function buildRequirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: CASPER_TESTNET_CAIP2,
    asset: CSPR_USDC_TESTNET_ASSET,
    amount: "1000000",
    payTo: testPayTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: CSPR_USDC_NAME,
      version: "1",
    },
    ...overrides,
  };
}

const supportedKind = {
  x402Version: 2,
  scheme: "exact",
  network: CASPER_TESTNET_CAIP2,
  extra: {},
};

describe("ExactCasperScheme server", () => {
  it("should parse dollar string prices", async () => {
    const scheme = new ExactCasperScheme();
    const result = await scheme.parsePrice("$0.10", CASPER_TESTNET_CAIP2);
    expect(result.amount).toBe("100000"); // 0.10 USDC = 100000 smallest units
    expect(result.asset).toBe(CSPR_USDC_TESTNET_ASSET);
    expect(result.extra).toEqual({ name: CSPR_USDC_NAME, version: "1" });
    expect(result.extra).not.toHaveProperty("assetTransferMethod");
  });

  it("should parse simple number string prices", async () => {
    const scheme = new ExactCasperScheme();
    const result = await scheme.parsePrice("0.10", CASPER_TESTNET_CAIP2);
    expect(result.amount).toBe("100000");
    expect(result.asset).toBe(CSPR_USDC_TESTNET_ASSET);
  });

  it("should parse number prices", async () => {
    const scheme = new ExactCasperScheme();
    const result = await scheme.parsePrice(100.053, CASPER_TESTNET_CAIP2);
    expect(result.amount).toBe("100053000");
    expect(result.asset).toBe(CSPR_USDC_TESTNET_ASSET);
    expect(result.extra).toEqual({ name: CSPR_USDC_NAME, version: "1" });
  });

  it("returns explicit AssetAmount with extra preserved", async () => {
    const scheme = new ExactCasperScheme();
    const result = await scheme.parsePrice(
      {
        amount: "1000000",
        asset: CSPR_USDC_TESTNET_ASSET,
        extra: { name: "MyToken", version: "1" },
      },
      CASPER_TESTNET_CAIP2,
    );

    expect(result).toEqual({
      amount: "1000000",
      asset: CSPR_USDC_TESTNET_ASSET,
      extra: { name: "MyToken", version: "1" },
    });
  });

  it("returns explicit AssetAmount with empty extra when none is provided", async () => {
    const scheme = new ExactCasperScheme();

    await expect(
      scheme.parsePrice(
        {
          amount: "1000000",
          asset: CSPR_USDC_TESTNET_ASSET,
        },
        CASPER_TESTNET_CAIP2,
      ),
    ).resolves.toEqual({
      amount: "1000000",
      asset: CSPR_USDC_TESTNET_ASSET,
      extra: {},
    });
  });

  it("rejects explicit AssetAmount prices with invalid assets", async () => {
    const scheme = new ExactCasperScheme();

    await expect(
      scheme.parsePrice(
        {
          amount: "1000000",
          asset: "bad",
        },
        CASPER_TESTNET_CAIP2,
      ),
    ).rejects.toThrow("invalid_exact_casper_server_invalid_asset: bad");
  });

  it("uses custom money parsers for money prices", async () => {
    const scheme = new ExactCasperScheme();
    scheme.registerMoneyParser(async () => ({
      amount: "9999",
      asset: customAsset,
      extra: { name: "Custom", version: "2" },
    }));

    expect(await scheme.parsePrice(1.0, CASPER_TESTNET_CAIP2)).toEqual({
      amount: "9999",
      asset: customAsset,
      extra: { name: "Custom", version: "2" },
    });
  });

  it("enhances and validates payment requirements", async () => {
    const scheme = new ExactCasperScheme();

    const enhanced = await scheme.enhancePaymentRequirements(
      buildRequirements({ amount: "1500000" }),
      supportedKind,
      [],
    );

    expect(enhanced.amount).toBe("1500000");
    expect(enhanced.extra).toMatchObject({
      name: CSPR_USDC_NAME,
      version: "1",
    });
  });

  it("copies supported extension extras when enhancement keys request them", async () => {
    const scheme = new ExactCasperScheme();

    const enhanced = await scheme.enhancePaymentRequirements(
      buildRequirements({ extra: { name: CSPR_USDC_NAME, version: "1", untouched: "local" } }),
      {
        ...supportedKind,
        extra: {
          resource: "premium",
          ignored: "not requested",
        },
      },
      ["resource"],
    );

    expect(enhanced.extra).toEqual({
      name: CSPR_USDC_NAME,
      version: "1",
      untouched: "local",
      resource: "premium",
    });
  });

  it("rejects invalid server requirements", async () => {
    const scheme = new ExactCasperScheme();

    await expect(
      scheme.enhancePaymentRequirements(buildRequirements({ asset: "bad" }), supportedKind, []),
    ).rejects.toThrow("invalid_exact_casper_server_invalid_asset");
    await expect(
      scheme.enhancePaymentRequirements(buildRequirements({ payTo: "bad" }), supportedKind, []),
    ).rejects.toThrow("invalid_exact_casper_server_invalid_payto");
    await expect(
      scheme.enhancePaymentRequirements(
        buildRequirements({ extra: { version: "1" } }),
        supportedKind,
        [],
      ),
    ).rejects.toThrow("invalid_exact_casper_server_missing_token_name");
    await expect(
      scheme.enhancePaymentRequirements(
        buildRequirements({ extra: { name: CSPR_USDC_NAME } }),
        supportedKind,
        [],
      ),
    ).rejects.toThrow("invalid_exact_casper_server_missing_token_version");
  });

  it("returns registered or default decimals", () => {
    const scheme = new ExactCasperScheme();

    expect(scheme.getAssetDecimals(CSPR_USDC_TESTNET_ASSET, CASPER_TESTNET_CAIP2)).toBe(
      CSPR_USDC_DECIMALS,
    );
    expect(scheme.getAssetDecimals("unknown", CASPER_TESTNET_CAIP2)).toBe(undefined);
  });
});
