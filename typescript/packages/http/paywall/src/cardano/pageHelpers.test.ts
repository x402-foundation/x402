import { CBOR } from "@evolution-sdk/evolution";
import {
  ERR_FEE_BELOW_MINIMUM,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_TTL_EXPIRED,
  ERR_TTL_TOO_FAR,
  USDM_PREPROD_ASSET,
} from "@x402/cardano";
import { describe, expect, it, vi } from "vitest";

import { createAnchoredClock } from "./clock";
import {
  cardanoNetworkName,
  decodeWalletBalance,
  describeAsset,
  estimateExtraLovelace,
  explorerTxUrl,
  formatAmount,
  formatAmountParts,
  isCardanoTestnet,
  lacksFunds,
  summarizeBalance,
} from "./format";
import { rejectionMessage, signingErrorMessage } from "./messages";
import { mapKoiosEpochParams } from "./protocolParams";
import { toCip30ProtocolParameters } from "./params";
import { discoverCip30Wallets, waitForCip30Wallets } from "./wallets";
import fixture from "./fixtures/koios-epoch-params-preprod.json";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("createAnchoredClock", () => {
  it("advances the server time by monotonic elapsed time", () => {
    let perf = 100;
    const clock = createAnchoredClock({
      serverTimeMs: 1_000_000,
      perfNow: () => perf,
      wallNow: () => 5,
    });
    perf = 2_600;
    expect(clock.now()).toBe(1_002_500);
  });

  it("reports ok, stale, drift and a server clock far ahead of the device", () => {
    let perf = 0;
    let wall = 1_000_000;
    const ok = createAnchoredClock({
      serverTimeMs: 1_000_000,
      perfNow: () => perf,
      wallNow: () => wall,
    });
    expect(ok.health()).toBe("ok");
    perf = 31 * 60_000;
    wall += perf;
    expect(ok.health()).toBe("stale");

    perf = 0;
    wall = 1_000_000;
    const drift = createAnchoredClock({
      serverTimeMs: 1_000_000,
      perfNow: () => perf,
      wallNow: () => wall,
    });
    wall += 31_000;
    expect(drift.health()).toBe("drift");

    const ahead = createAnchoredClock({
      serverTimeMs: 1_000_000 + 360_000,
      perfNow: () => 0,
      wallNow: () => 1_000_000,
    });
    expect(ahead.health()).toBe("server_ahead");
  });

  it("defaults to performance.now and Date.now", () => {
    const clock = createAnchoredClock({ serverTimeMs: Date.now() });
    expect(clock.health()).toBe("ok");
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1_000);
  });
});

describe("format", () => {
  it("names networks, testnets and explorers", () => {
    expect(cardanoNetworkName("cardano:preview")).toBe("Cardano Preview");
    expect(cardanoNetworkName("cardano:x")).toBe("cardano:x");
    expect(isCardanoTestnet("cardano:preprod")).toBe(true);
    expect(isCardanoTestnet("cardano:mainnet")).toBe(false);
    expect(explorerTxUrl("cardano:preprod", "AB".repeat(32))).toBe(
      `https://explorer.cardano.org/preprod/tx/${"ab".repeat(32)}`,
    );
    expect(explorerTxUrl("cardano:preprod", "../evil")).toBeUndefined();
    expect(explorerTxUrl("cardano:x", "ab".repeat(32))).toBeUndefined();
  });

  it("labels ADA, known USDM and unknown tokens without guessing decimals", () => {
    expect(describeAsset("lovelace", "cardano:preprod")).toEqual({ symbol: "ADA", decimals: 6 });
    expect(describeAsset(USDM_PREPROD_ASSET, "cardano:preprod")).toEqual({
      symbol: "USDM",
      decimals: 6,
    });
    const unknown = describeAsset(`${"ab".repeat(28)}.00`, "cardano:preprod");
    expect(unknown.decimals).toBeUndefined();
    expect(unknown.symbol).toBe("token abababab…");
  });

  it("formats amounts", () => {
    expect(formatAmount(1_500_000n, { symbol: "USDM", decimals: 6 })).toBe("1.50 USDM");
    expect(formatAmount(2_000_000n, { symbol: "ADA", decimals: 6 })).toBe("2 ADA");
    expect(formatAmount(1_234_567n, { symbol: "ADA", decimals: 6 })).toBe("1.234567 ADA");
    expect(formatAmount(1_500n, { symbol: "token x" })).toBe("1500 units of token x");
    expect(formatAmountParts(1_500_000n, { symbol: "USDM", decimals: 6 })).toEqual({
      value: "1.50",
      unit: "USDM",
    });
    expect(formatAmountParts(1_500n, { symbol: "token x" })).toEqual({
      value: "1500",
      unit: "units of token x",
    });
  });

  it("decodes CIP-30 balances", () => {
    expect(decodeWalletBalance(hex(CBOR.toCBORBytes(5_000_000n)))).toEqual({
      lovelace: 5_000_000n,
      assets: {},
    });
    const policy = new Uint8Array(28).fill(0xab);
    const name = new Uint8Array([0x55, 0x53]);
    const names = new Map([
      [name, 42n],
      [new Uint8Array([0x00, 0x0f]), 3n],
      [new Uint8Array(0), 1n],
    ]);
    const value = [7n, new Map([[policy, names]])];
    expect(decodeWalletBalance(hex(CBOR.toCBORBytes(value)))).toEqual({
      lovelace: 7n,
      assets: {
        [`${"ab".repeat(28)}.5553`]: 42n,
        [`${"ab".repeat(28)}.000f`]: 3n,
        [`${"ab".repeat(28)}.`]: 1n,
      },
    });
    expect(decodeWalletBalance("zz")).toBeUndefined();
    expect(decodeWalletBalance(hex(CBOR.toCBORBytes(["x"])))).toBeUndefined();
    expect(decodeWalletBalance(hex(CBOR.toCBORBytes([7n, new Map([[1n, 2n]])])))).toBeUndefined();
    expect(
      decodeWalletBalance(hex(CBOR.toCBORBytes([7n, new Map([[policy, new Map([[1n, 2n]])]])]))),
    ).toBeUndefined();
  });

  it("summarises balances and spots missing funds", () => {
    const ada = { symbol: "ADA", decimals: 6 };
    const usdm = { symbol: "USDM", decimals: 6 };
    const balance = { lovelace: 3_000_000n, assets: { [USDM_PREPROD_ASSET]: 2_000_000n } };
    expect(summarizeBalance(undefined, "lovelace", ada, ada)).toBe("–");
    expect(summarizeBalance(balance, "lovelace", ada, ada)).toBe("3 ADA");
    expect(summarizeBalance(balance, USDM_PREPROD_ASSET, usdm, ada)).toBe("2 USDM · 3 ADA");
    expect(summarizeBalance(balance, `${"ab".repeat(28)}.00`, usdm, ada)).toBe("0 USDM · 3 ADA");
    expect(lacksFunds(undefined, "lovelace", 1n, 1n)).toBe(false);
    expect(lacksFunds(balance, "lovelace", 1n, undefined)).toBe(false);
    expect(lacksFunds(balance, "lovelace", 2_800_000n, 200_000n)).toBe(false);
    expect(lacksFunds(balance, "lovelace", 2_800_001n, 200_000n)).toBe(true);
    expect(lacksFunds(balance, USDM_PREPROD_ASSET, 2_000_000n, 3_000_000n)).toBe(false);
    expect(lacksFunds(balance, USDM_PREPROD_ASSET, 2_000_001n, 1n)).toBe(true);
    expect(lacksFunds(balance, USDM_PREPROD_ASSET, 1n, 3_000_001n)).toBe(true);
  });

  it("estimates the extra ADA for ADA and token payments", () => {
    const params = toCip30ProtocolParameters(mapKoiosEpochParams(fixture[0], 0)!);
    const ada = estimateExtraLovelace(false, params);
    const token = estimateExtraLovelace(true, params);
    expect(ada).toBeGreaterThan(150_000n);
    expect(ada).toBeLessThan(300_000n);
    expect(token - ada).toBe(250n * 4310n);
  });
});

describe("wallet discovery", () => {
  const provider = (name?: string, icon?: string) => ({ name, icon, enable: vi.fn() });

  it("orders preferred wallets first, skips non-wallets and duplicate names", () => {
    const wallets = discoverCip30Wallets({
      zeta: provider("Zeta"),
      eternl: provider("Eternl", "data:image/png;base64,AA"),
      ccvault: provider("Eternl"),
      lace: provider("Lace", "https://evil.example/icon.png"),
      nami: provider(" "),
      broken: { name: "Broken" },
      flag: true,
    });
    expect(wallets.map(w => w.key)).toEqual(["lace", "eternl", "nami", "zeta"]);
    expect(wallets[0].icon).toBeUndefined();
    expect(wallets[1].icon).toBe("data:image/png;base64,AA");
    expect(wallets[2].name).toBe("nami");
    expect(discoverCip30Wallets(undefined)).toEqual([]);
  });

  it("waits for late wallet injection and gives up after the timeout", async () => {
    const sleep = vi.fn(async () => {});
    let cardano: unknown = undefined;
    let polls = 0;
    const found = await waitForCip30Wallets(
      () => {
        polls += 1;
        if (polls === 3) cardano = { lace: provider("Lace") };
        return cardano;
      },
      { sleep },
    );
    expect(found.map(w => w.key)).toEqual(["lace"]);
    expect(
      await waitForCip30Wallets(() => undefined, { sleep, timeoutMs: 400, intervalMs: 200 }),
    ).toEqual([]);
  });

  it("uses a real timer by default", async () => {
    expect(await waitForCip30Wallets(() => undefined, { timeoutMs: 0 })).toEqual([]);
  });
});

describe("messages", () => {
  it("explains pre-broadcast rejections", () => {
    expect(rejectionMessage(ERR_NONCE_NOT_ON_CHAIN, "Cardano Preprod")).toMatch(/Cardano Preprod/);
    expect(rejectionMessage(ERR_FEE_BELOW_MINIMUM, "x")).toMatch(/Reload the page/);
    expect(rejectionMessage(ERR_TTL_EXPIRED, "x")).toMatch(/payment window/);
    expect(rejectionMessage(ERR_TTL_TOO_FAR, "x")).toMatch(/clock does not match/);
    expect(rejectionMessage("weird", "x")).toMatch(/\(weird\)/);
    expect(rejectionMessage(undefined, "x")).toMatch(/Nothing was charged/);
  });

  it("explains signing errors by guard code and wallet refusals", () => {
    const err = (code: string) => Object.assign(new Error("detail"), { code });
    expect(signingErrorMessage(err("protocol_parameters_out_of_bounds"), "Lace")).toMatch(
      /outside the range/,
    );
    expect(signingErrorMessage(err("protocol_parameters_invalid"), "Lace")).toMatch(
      /outside the range/,
    );
    expect(signingErrorMessage(err("fee_drain"), "Lace")).toMatch(/Consolidate/);
    expect(signingErrorMessage(err("amount_below_min_utxo"), "Lace")).toMatch(
      /below the minimum ADA/,
    );
    expect(signingErrorMessage(err("no_spendable_utxo"), "Lace")).toMatch(/^Lace has no plain ADA/);
    expect(signingErrorMessage(err("payment_window_too_short"), "Lace")).toMatch(/240/);
    expect(signingErrorMessage(err("payment_window_expired"), "Lace")).toMatch(/sign again/);
    expect(signingErrorMessage(err("transfer_method_unsupported"), "Lace")).toMatch(
      /smart-contract/,
    );
    expect(signingErrorMessage(err("fee_too_high"), "Lace")).toMatch(
      /refused before signing: detail/,
    );
    expect(signingErrorMessage(err("wallet_declined"), "Lace")).toBe(
      "You declined the request in Lace.",
    );
    expect(signingErrorMessage(err("wallet_sign_failed"), "Lace")).toBe(
      "Lace could not sign this payment: detail",
    );
    expect(signingErrorMessage({ code: -3, info: "user refused" }, "Lace")).toBe(
      "You declined the request in Lace.",
    );
    expect(signingErrorMessage({ code: -2, info: "internal wallet error" }, "Lace")).toBe(
      "internal wallet error",
    );
    expect(signingErrorMessage(new Error("User declined to sign"), "Lace")).toBe(
      "You declined the request in Lace.",
    );
    expect(signingErrorMessage(new Error("boom"), "Lace")).toBe("boom");
    expect(signingErrorMessage("plain", "Lace")).toBe("plain");
    expect(signingErrorMessage(new Error(""), "Lace")).toBe("Payment failed.");
  });
});
