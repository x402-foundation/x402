import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CONTRACT, payer, terms } from "./upto-helpers";
import {
  I128_MAX,
  UPTO_DEPLOYMENTS,
  UPTO_TESTNET_DEPLOYMENT,
  authorityEntry,
  parseAtomicAmount,
  resolveUptoContract,
  termsFromScVal,
  termsToScVal,
  uptoStandardCodes,
  uptoStellarCodes,
} from "../../src/upto";

describe("terms codec", () => {
  it("round-trips, including a maximum above 64 bits and a contract recipient", () => {
    for (const value of [
      terms({ maxAmount: I128_MAX, validAfterLedger: 7 }),
      terms({ recipient: CONTRACT }),
    ]) {
      expect(termsFromScVal(termsToScVal(value))).toEqual(value);
    }
  });

  it("refuses anything that is not the exact encoding", () => {
    const entries = termsToScVal(terms()).map() ?? [];
    const replace = (key: string, val: xdr.ScVal) =>
      xdr.ScVal.scvMap(
        entries.map(e =>
          e.key().sym().toString() === key ? new xdr.ScMapEntry({ key: e.key(), val }) : e,
        ),
      );
    const muxed = StrKey.encodeMed25519PublicKey(
      Buffer.concat([payer.rawPublicKey(), Buffer.alloc(8, 1)]),
    );
    for (const value of [
      xdr.ScVal.scvU32(1),
      xdr.ScVal.scvMap([...entries, entries[0] as xdr.ScMapEntry]),
      xdr.ScVal.scvMap([...entries].reverse()),
      xdr.ScVal.scvMap(entries.slice(1)),
      replace("expiration_ledger", xdr.ScVal.scvU64(xdr.Uint64.fromString("5"))),
      replace("max_amount", nativeToScVal(5n, { type: "u128" })),
      replace("recipient", xdr.ScVal.scvSymbol("GABC")),
      replace("recipient", nativeToScVal(muxed, { type: "address" })),
    ]) {
      expect(termsFromScVal(value)).toBeUndefined();
    }
  });

  it("builds the authority's SOURCE_ACCOUNT entry for settle(payer, terms, amount)", () => {
    const entry = authorityEntry(CONTRACT, payer.publicKey(), terms(), 5n);
    expect(entry.credentials().switch()).toBe(
      xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
    );
    const call = entry.rootInvocation().function().contractFn();
    expect(call.functionName().toString()).toBe("settle");
    expect(call.args().map(arg => arg.switch().name)).toEqual(["scvAddress", "scvMap", "scvI128"]);
  });
});

describe("shared", () => {
  it("parses canonical atomic amounts within i128", () => {
    expect(parseAtomicAmount("0")).toBe(0n);
    expect(parseAtomicAmount(I128_MAX.toString())).toBe(I128_MAX);
    for (const value of [
      "",
      "-1",
      "01",
      "1.5",
      "1e3",
      " 1",
      (I128_MAX + 1n).toString(),
      5,
      undefined,
    ]) {
      expect(parseAtomicAmount(value)).toBeUndefined();
    }
  });

  it("resolves the settlement contract", () => {
    expect(resolveUptoContract("stellar:testnet", { "stellar:testnet": CONTRACT })).toBe(CONTRACT);
    expect(resolveUptoContract("stellar:testnet")).toBe(UPTO_TESTNET_DEPLOYMENT.address);
    expect(resolveUptoContract("stellar:pubnet")).toBe(UPTO_DEPLOYMENTS["stellar:pubnet"]?.address);
  });

  it("names every code once, each with a reason", () => {
    const specific = Object.keys(uptoStellarCodes);
    expect(Object.keys(uptoStandardCodes).filter(code => specific.includes(code))).toEqual([]);
    for (const code of specific) expect(code).toMatch(/^(invalid|settle)_upto_stellar_/);
  });
});
