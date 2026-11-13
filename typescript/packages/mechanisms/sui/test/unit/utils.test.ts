import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import { SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";
import {
  createSuiClientResolver,
  getSuiNetworkName,
  matchExactPayment,
  matchPaymentLegs,
  parseBase64Bytes,
  pureInputsBase64,
  transactionCarriesNonce,
} from "../../src/utils";
import { buildTestTransaction, payer, payTo } from "./helpers";

describe("getSuiNetworkName", () => {
  it("maps CAIP-2 ids and throws on unsupported", () => {
    expect(getSuiNetworkName(SUI_MAINNET_CAIP2)).toBe("mainnet");
    expect(getSuiNetworkName(SUI_TESTNET_CAIP2)).toBe("testnet");
    expect(() => getSuiNetworkName("eip155:1")).toThrow("Unsupported Sui network");
  });
});

describe("createSuiClientResolver", () => {
  it("returns overrides and caches defaults", () => {
    const override = { core: {} } as never;
    const resolve = createSuiClientResolver({ [SUI_TESTNET_CAIP2]: override });
    expect(resolve(SUI_TESTNET_CAIP2)).toBe(override);
    const bare = createSuiClientResolver();
    expect(bare(SUI_MAINNET_CAIP2)).toBe(bare(SUI_MAINNET_CAIP2));
  });
});

describe("parseBase64Bytes", () => {
  it("decodes valid Base64 and rejects malformed / empty", () => {
    expect(parseBase64Bytes("q6urq6urq6s=")).toEqual(new Uint8Array(8).fill(0xab));
    expect(parseBase64Bytes(undefined)).toBeNull();
    expect(parseBase64Bytes("")).toBeNull();
    expect(parseBase64Bytes("!!!not base64!!!")).toBeNull();
  });

  it("accepts a nonce longer than 32 bytes (no size cap)", () => {
    const big = toBase64(new Uint8Array(40).fill(0xab));
    expect(parseBase64Bytes(big)).toEqual(new Uint8Array(40).fill(0xab));
  });
});

describe("nonce Pure input", () => {
  const NONCE = "q6urq6urq6s="; // 8 bytes of 0xab, Base64
  const OTHER = "zc3Nzc3Nzc0="; // 8 bytes of 0xcd, Base64

  it("matches a declared nonce carried as an unused Pure input", async () => {
    const bytes = fromBase64(await buildTestTransaction({ nonce: NONCE }));
    const data = Transaction.from(bytes).getData();
    expect(pureInputsBase64(data)).toContain(NONCE);
    expect(transactionCarriesNonce(data, NONCE)).toBe(true);
  });

  it("matches a declared nonce carried as a USED Pure input (referenced by a command)", async () => {
    const bytes = fromBase64(await buildTestTransaction({ nonce: NONCE, nonceUsed: true }));
    const data = Transaction.from(bytes).getData();
    expect(pureInputsBase64(data)).toContain(NONCE);
    expect(transactionCarriesNonce(data, NONCE)).toBe(true);
  });

  it("does not match a nonce the transaction does not carry", async () => {
    const bytes = fromBase64(await buildTestTransaction({ nonce: NONCE }));
    const data = Transaction.from(bytes).getData();
    expect(transactionCarriesNonce(data, OTHER)).toBe(false);
  });

  it("does not carry a nonce when none is embedded", async () => {
    const bytes = fromBase64(await buildTestTransaction());
    const data = Transaction.from(bytes).getData();
    expect(transactionCarriesNonce(data, NONCE)).toBe(false);
  });
});

describe("matchExactPayment", () => {
  const single = [
    { coinType: USDC_TESTNET, address: payer, amount: "-10000" },
    { coinType: USDC_TESTNET, address: payTo, amount: "10000" },
  ];

  it("sums every entry for the recipient", () => {
    const split = [
      { coinType: USDC_TESTNET, address: payTo, amount: "4000" },
      { coinType: USDC_TESTNET, address: payTo, amount: "6000" },
    ];
    expect(matchExactPayment(split, USDC_TESTNET, payTo, "10000")).toBeNull();
    expect(matchExactPayment(split, USDC_TESTNET, payTo, "4000")).not.toBeNull();
  });

  it("accepts an exact single payment", () => {
    expect(matchExactPayment(single, USDC_TESTNET, payTo, "10000")).toBeNull();
  });

  it("rejects under/overpayment", () => {
    expect(matchExactPayment(single, USDC_TESTNET, payTo, "9999")).toContain("expected");
  });

  it("ignores other coin types", () => {
    const changes = [...single, { coinType: "0x2::sui::SUI", address: payTo, amount: "5" }];
    expect(matchExactPayment(changes, USDC_TESTNET, payTo, "10000")).toBeNull();
  });

  it("is composable: recipient-credit-only, unconstrained sourcing and extra credits", () => {
    // The payer nets ~0 (a swap-sourced payment: an external inflow funds the
    // outgoing transfer) AND an extra, undeclared address is also credited the
    // asset. As long as the declared recipient nets exactly its amount, verify.
    const changes = [
      { coinType: USDC_TESTNET, address: payer, amount: "5000" }, // net inflow, not -amount
      { coinType: USDC_TESTNET, address: "0xsource", amount: "-15000" },
      { coinType: USDC_TESTNET, address: payTo, amount: "10000" },
      { coinType: USDC_TESTNET, address: "0xother", amount: "3000" }, // undeclared credit
    ];
    expect(matchExactPayment(changes, USDC_TESTNET, payTo, "10000")).toBeNull();
  });
});

describe("matchPaymentLegs", () => {
  const A = `0x${"aa".repeat(32)}`;
  const legs = [
    { payTo, amount: 9500n },
    { payTo: A, amount: 500n },
  ];
  const changes = (payToAmount: string, aAmount: string) => [
    { coinType: USDC_TESTNET, address: payer, amount: "-10000" },
    { coinType: USDC_TESTNET, address: payTo, amount: payToAmount },
    { coinType: USDC_TESTNET, address: A, amount: aAmount },
  ];

  it("matches when every recipient nets exactly its share", () => {
    expect(matchPaymentLegs(changes("9500", "500"), USDC_TESTNET, legs)).toBeNull();
  });

  it("sums several entries for one recipient", () => {
    const split = [
      ...changes("9000", "500"),
      { coinType: USDC_TESTNET, address: payTo, amount: "500" },
    ];
    expect(matchPaymentLegs(split, USDC_TESTNET, legs)).toBeNull();
  });

  it("names a missing leg", () => {
    const missing = changes("9500", "500").filter(c => c.address !== A);
    expect(matchPaymentLegs(missing, USDC_TESTNET, legs)).toBe(
      `recipient ${A} credited 0, expected exactly 500`,
    );
  });

  it("rejects a wrong share on any leg", () => {
    expect(matchPaymentLegs(changes("9400", "600"), USDC_TESTNET, legs)).toContain(
      "credited 9400, expected exactly 9500",
    );
    expect(matchPaymentLegs(changes("9500", "501"), USDC_TESTNET, legs)).toContain(
      "credited 501, expected exactly 500",
    );
  });

  it("rejects an old client that pays the total to payTo", () => {
    const old = [
      { coinType: USDC_TESTNET, address: payer, amount: "-10000" },
      { coinType: USDC_TESTNET, address: payTo, amount: "10000" },
    ];
    expect(matchPaymentLegs(old, USDC_TESTNET, legs)).toContain("expected exactly 9500");
  });

  it("ignores credits to other addresses and other coin types", () => {
    const extra = [
      ...changes("9500", "500"),
      { coinType: USDC_TESTNET, address: `0x${"cc".repeat(32)}`, amount: "1" },
      { coinType: "0x2::sui::SUI", address: A, amount: "7" },
    ];
    expect(matchPaymentLegs(extra, USDC_TESTNET, legs)).toBeNull();
  });

  it("normalizes addresses", () => {
    const short = [
      { coinType: USDC_TESTNET, address: payTo, amount: "9500" },
      { coinType: USDC_TESTNET, address: `0x${"0".repeat(63)}2`, amount: "500" },
    ];
    expect(
      matchPaymentLegs(short, USDC_TESTNET, [
        { payTo, amount: 9500n },
        { payTo: "0x2", amount: 500n },
      ]),
    ).toBeNull();
  });

  it("cannot match when the payer is a recipient", () => {
    // The payer's credit nets against its debit.
    const self = [
      { coinType: USDC_TESTNET, address: payer, amount: "-9500" },
      { coinType: USDC_TESTNET, address: payTo, amount: "9500" },
    ];
    expect(
      matchPaymentLegs(self, USDC_TESTNET, [
        { payTo, amount: 9500n },
        { payTo: payer, amount: 500n },
      ]),
    ).toContain(`recipient ${payer} credited -9500`);
  });
});
