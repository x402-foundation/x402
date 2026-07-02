import { describe, it, expect } from "vitest";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactSuiScheme as ExactSuiServer } from "../../src/exact/server/scheme";
import {
  convertToTokenAmount,
  coinTypesEqual,
  validateSuiAddress,
  outputsOf,
  matchBalanceChanges,
  suiNetworkRef,
} from "../../src/utils";
import { USDC_TESTNET, USDC_MAINNET } from "../../src/constants";
import {
  VALID_SINGLE_BALANCE_CHANGES,
  VALID_SPLIT_BALANCE_CHANGES,
  PAYER,
  RECIPIENT_1,
  RECIPIENT_2,
  ASSET,
} from "../fixtures/fixtures";

const TESTNET: Network = "sui:testnet";

describe("@x402/sui server scheme — parsePrice", () => {
  let server: ExactSuiServer;

  it("converts dollar/decimal/number money to atomic USDC (6 dp)", async () => {
    server = new ExactSuiServer();
    for (const [input, expected] of [
      ["$1.00", "1000000"],
      ["1.50", "1500000"],
      [2.5, "2500000"],
      ["$4.02", "4020000"], // float-rounding guard
    ] as const) {
      const r = await server.parsePrice(input, TESTNET);
      expect(r.amount).toBe(expected);
      expect(r.asset).toBe(USDC_TESTNET);
    }
  });

  it("passes an AssetAmount straight through", async () => {
    server = new ExactSuiServer();
    const r = await server.parsePrice(
      { amount: "5000000", asset: "0xabc::t::T", extra: { foo: "bar" } },
      TESTNET,
    );
    expect(r.amount).toBe("5000000");
    expect(r.asset).toBe("0xabc::t::T");
    expect(r.extra?.foo).toBe("bar");
  });

  it("uses the mainnet USDC default on mainnet", async () => {
    server = new ExactSuiServer();
    const r = await server.parsePrice("$0.10", "sui:mainnet");
    expect(r.asset).toBe(USDC_MAINNET);
    expect(r.amount).toBe("100000");
  });

  it("rejects a price string on devnet (no default asset)", async () => {
    server = new ExactSuiServer();
    await expect(server.parsePrice("$1.00", "sui:devnet")).rejects.toThrow("No default USDC");
  });

  it("runs custom money parsers before the USDC fallback", async () => {
    server = new ExactSuiServer();
    server.registerMoneyParser(async amount => {
      if (amount > 100) return { amount: String(amount), asset: "0xbig::t::T", extra: {} };
      return null;
    });
    expect((await server.parsePrice(150, TESTNET)).asset).toBe("0xbig::t::T");
    expect((await server.parsePrice(50, TESTNET)).asset).toBe(USDC_TESTNET);
  });

  it("reports asset decimals as 6", () => {
    server = new ExactSuiServer();
    expect(server.getAssetDecimals(USDC_TESTNET, TESTNET)).toBe(6);
  });
});

describe("@x402/sui server scheme — enhancePaymentRequirements", () => {
  const base: PaymentRequirements = {
    scheme: "exact",
    network: TESTNET,
    asset: USDC_TESTNET,
    amount: "10000",
    payTo: RECIPIENT_1,
    maxTimeoutSeconds: 60,
    extra: {},
  };
  const kind = { x402Version: 2, scheme: "exact", network: TESTNET };

  it("passes facilitator extras through (e.g. buildUrl)", async () => {
    const server = new ExactSuiServer();
    const r = await server.enhancePaymentRequirements(
      base,
      { ...kind, extra: { buildUrl: "https://f.example/build" } },
      [],
    );
    expect(r.extra.buildUrl).toBe("https://f.example/build");
  });

  it("accepts declared outputs that sum to amount", async () => {
    const server = new ExactSuiServer();
    const withOutputs: PaymentRequirements = {
      ...base,
      extra: {
        outputs: [
          { to: RECIPIENT_1, amount: "9800" },
          { to: RECIPIENT_2, amount: "200" },
        ],
      },
    };
    const r = await server.enhancePaymentRequirements(withOutputs, kind, []);
    expect((r.extra.outputs as unknown[]).length).toBe(2);
  });

  it("rejects declared outputs that do NOT sum to amount", async () => {
    const server = new ExactSuiServer();
    const bad: PaymentRequirements = {
      ...base,
      extra: { outputs: [{ to: RECIPIENT_1, amount: "9000" }] }, // sums to 9000 ≠ 10000
    };
    await expect(server.enhancePaymentRequirements(bad, kind, [])).rejects.toThrow(
      "invalid_payment_requirements",
    );
  });
});

describe("@x402/sui utils", () => {
  it("convertToTokenAmount avoids scientific notation and rejects negatives", () => {
    expect(convertToTokenAmount("0.0000001", 6)).toBe("0"); // truncates below 1 unit
    expect(convertToTokenAmount("0.1", 6)).toBe("100000");
    expect(() => convertToTokenAmount("-1", 6)).toThrow("Negative");
  });

  it("coinTypesEqual normalizes leading zeros", () => {
    expect(
      coinTypesEqual(
        "0x2::sui::SUI",
        "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      ),
    ).toBe(true);
  });

  it("validateSuiAddress requires the full 64-hex form", () => {
    expect(validateSuiAddress(PAYER)).toBe(true);
    expect(validateSuiAddress("0x2")).toBe(false);
  });

  it("suiNetworkRef maps CAIP-2 to the SDK ref and throws otherwise", () => {
    expect(suiNetworkRef(TESTNET)).toBe("testnet");
    expect(suiNetworkRef("sui:mainnet")).toBe("mainnet");
    expect(() => suiNetworkRef("eip155:1")).toThrow("Unsupported");
  });

  it("outputsOf defaults to a single payTo output when extra.outputs is absent", () => {
    const reqs: PaymentRequirements = {
      scheme: "exact",
      network: TESTNET,
      asset: USDC_TESTNET,
      amount: "10000",
      payTo: RECIPIENT_1,
      maxTimeoutSeconds: 60,
      extra: {},
    };
    expect(outputsOf(reqs)).toEqual([{ to: RECIPIENT_1, amount: "10000" }]);
  });

  it("outputsOf returns the declared split when present", () => {
    const reqs: PaymentRequirements = {
      scheme: "exact",
      network: TESTNET,
      asset: USDC_TESTNET,
      amount: "10000",
      payTo: RECIPIENT_1,
      maxTimeoutSeconds: 60,
      extra: {
        outputs: [
          { to: RECIPIENT_1, amount: "9800" },
          { to: RECIPIENT_2, amount: "200" },
        ],
      },
    };
    expect(outputsOf(reqs)).toHaveLength(2);
  });
});

describe("@x402/sui matchBalanceChanges (the exact-fee matcher, on real fixtures)", () => {
  it("accepts the single-output fixture against its declared output", () => {
    const problems = matchBalanceChanges(
      VALID_SINGLE_BALANCE_CHANGES,
      ASSET,
      [{ to: RECIPIENT_1, amount: "10000" }],
      PAYER,
    );
    expect(problems).toEqual([]);
  });

  it("accepts the two-output split fixture against its declared outputs", () => {
    const problems = matchBalanceChanges(
      VALID_SPLIT_BALANCE_CHANGES,
      ASSET,
      [
        { to: RECIPIENT_1, amount: "9800" },
        { to: RECIPIENT_2, amount: "200" },
      ],
      PAYER,
    );
    expect(problems).toEqual([]);
  });

  it("flags an output credited the wrong amount", () => {
    const problems = matchBalanceChanges(
      VALID_SINGLE_BALANCE_CHANGES,
      ASSET,
      [{ to: RECIPIENT_1, amount: "9999" }],
      PAYER,
    );
    expect(problems.join(";")).toMatch(/expected \+9999 got 10000/);
  });

  it("flags an undeclared recipient (the skim cheat-vector)", () => {
    // Declare only RECIPIENT_1 against the SPLIT changes — RECIPIENT_2 is undeclared.
    const problems = matchBalanceChanges(
      VALID_SPLIT_BALANCE_CHANGES,
      ASSET,
      [{ to: RECIPIENT_1, amount: "9800" }],
      PAYER,
    );
    expect(problems.join(";")).toMatch(/undeclared recipient/);
  });

  it("flags a payer-debit mismatch", () => {
    const problems = matchBalanceChanges(
      VALID_SINGLE_BALANCE_CHANGES,
      ASSET,
      // Declared total 5000 but the payer was debited 10000 on-chain.
      [{ to: RECIPIENT_1, amount: "5000" }],
      PAYER,
    );
    expect(problems.join(";")).toMatch(/payer expected -5000 got -10000/);
  });

  it("ignores balance changes of a different asset", () => {
    const problems = matchBalanceChanges(
      VALID_SINGLE_BALANCE_CHANGES,
      "0xdeadbeef::other::OTHER",
      [{ to: RECIPIENT_1, amount: "10000" }],
      PAYER,
    );
    // No matching-asset credit → output short + payer debit short.
    expect(problems.length).toBeGreaterThan(0);
  });
});
