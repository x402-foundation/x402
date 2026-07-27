import { describe, expect, it } from "vitest";
import { ExactCasperScheme } from "../../src/exact/server/scheme";

const testAsset = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const testPayTo = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788";
const testNetwork = "casper:casper-test";

function buildRequirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: testNetwork,
    asset: testAsset,
    amount: "1000000",
    payTo: testPayTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "TestToken",
      version: "1",
    },
    ...overrides,
  };
}

const supportedKind = {
  x402Version: 2,
  scheme: "exact",
  network: testNetwork,
  extra: {},
};

describe("ExactCasperScheme server", () => {
  it("returns explicit AssetAmount with extra preserved", async () => {
    const scheme = new ExactCasperScheme();
    const result = await scheme.parsePrice(
      { amount: "1000000", asset: testAsset, extra: { name: "MyToken", version: "1" } },
      testNetwork,
    );

    expect(result).toEqual({
      amount: "1000000",
      asset: testAsset,
      extra: { name: "MyToken", version: "1" },
    });
  });

  it("uses custom money parsers for money prices", async () => {
    const scheme = new ExactCasperScheme();
    scheme.registerMoneyParser(async () => ({
      amount: "9999",
      asset: testAsset,
      extra: { name: "Custom", version: "2" },
    }));

    await expect(new ExactCasperScheme().parsePrice("1.00", testNetwork)).rejects.toThrow(
      "invalid_exact_casper_server_no_default_asset",
    );
    expect(await scheme.parsePrice(1.0, testNetwork)).toEqual({
      amount: "9999",
      asset: testAsset,
      extra: { name: "Custom", version: "2" },
    });
  });

  it("enhances and validates payment requirements", async () => {
    const scheme = new ExactCasperScheme();
    scheme.registerAsset(testNetwork, testAsset, 6);

    const enhanced = await scheme.enhancePaymentRequirements(
      buildRequirements({ amount: "1.5" }),
      supportedKind,
      [],
    );

    expect(enhanced.amount).toBe("1500000");
    expect(enhanced.extra).toMatchObject({
      name: "TestToken",
      version: "1",
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
        buildRequirements({ extra: { name: "TestToken" } }),
        supportedKind,
        [],
      ),
    ).rejects.toThrow("invalid_exact_casper_server_missing_token_version");
  });

  it("returns registered or default decimals", () => {
    const scheme = new ExactCasperScheme();
    scheme.registerAsset(testNetwork, testAsset, 9);

    expect(scheme.getAssetDecimals(testAsset, testNetwork)).toBe(9);
    expect(scheme.getAssetDecimals("unknown", testNetwork)).toBe(9);
  });
});
