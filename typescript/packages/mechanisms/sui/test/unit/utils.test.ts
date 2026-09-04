import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import { SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";
import {
  createSuiClientResolver,
  getSuiNetworkName,
  matchExactPayment,
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
