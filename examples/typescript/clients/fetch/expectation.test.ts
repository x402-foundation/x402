import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { expectationFromEnv, refusalReason, sameAddress } from "./expectation";

const BASE = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const OTHER = "0x2222222222222222222222222222222222222222";
// Two Solana addresses that differ only in the case of their last letter; both decode to 32 bytes.
const SOL_KEY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_KEY_CASE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1V";

const offer = { network: BASE, amount: "10000", payTo: SELLER, asset: USDC_BASE };

test("amount is a maximum: lower and equal prices sign, a higher one is refused", () => {
  const expected = { maxAmountAtomic: "10000" };
  assert.equal(refusalReason({ ...offer, amount: "5000" }, expected), undefined);
  assert.equal(refusalReason({ ...offer, amount: "10000" }, expected), undefined);
  assert.match(refusalReason({ ...offer, amount: "10001" }, expected) ?? "", /expected at most/);
});

test("an amount that is not a whole number of atomic units is refused, not skipped", () => {
  const expected = { maxAmountAtomic: "10000" };
  for (const amount of ["0.01", "1e4", "", " 10000", "-1", "0x2710"]) {
    assert.match(refusalReason({ ...offer, amount }, expected) ?? "", /whole number/, amount);
  }
});

test("EVM: a checksum-case variant of the pinned recipient and asset signs", () => {
  const expected = { network: BASE, payTo: SELLER.toLowerCase(), asset: USDC_BASE.toUpperCase() };
  // toUpperCase also capitalises the 0x prefix, which is not an address; restore it.
  expected.asset = "0x" + expected.asset.slice(2);
  assert.equal(refusalReason(offer, expected), undefined);
});

test("EVM: another recipient is refused", () => {
  const expected = { network: BASE, payTo: SELLER };
  assert.match(refusalReason({ ...offer, payTo: OTHER }, expected) ?? "", /payTo/);
});

test("Solana: addresses that differ only in case are different accounts", () => {
  const a = base58.decode(SOL_KEY);
  const b = base58.decode(SOL_KEY_CASE);
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.notDeepEqual(a, b);
  assert.equal(sameAddress(SOLANA, SOL_KEY, SOL_KEY), true);
  assert.equal(sameAddress(SOLANA, SOL_KEY, SOL_KEY_CASE), false);

  const sol = { network: SOLANA, amount: "10000", payTo: SOL_KEY, asset: SOL_KEY };
  const pinned = { network: SOLANA, payTo: SOL_KEY, asset: SOL_KEY };
  assert.equal(refusalReason(sol, pinned), undefined);
  assert.match(refusalReason({ ...sol, payTo: SOL_KEY_CASE }, pinned) ?? "", /payTo/);
  assert.match(refusalReason({ ...sol, asset: SOL_KEY_CASE }, pinned) ?? "", /asset/);
});

test("the same recipient text on another network is refused", () => {
  const expected = { network: BASE, payTo: SELLER, asset: USDC_BASE };
  assert.match(refusalReason({ ...offer, network: BASE_SEPOLIA }, expected) ?? "", /network/);
});

test("a pinned recipient fails closed on a namespace without address rules here", () => {
  const expected = { network: "stellar:pubnet", payTo: SELLER };
  const reason = refusalReason({ ...offer, network: "stellar:pubnet" }, expected);
  assert.match(reason ?? "", /payTo/);
});

test("a recipient or asset pin without a network pin is a configuration error", () => {
  assert.throws(() => expectationFromEnv({ EXPECTED_PAY_TO: SELLER }), /EXPECTED_NETWORK/);
  assert.throws(() => expectationFromEnv({ EXPECTED_ASSET: USDC_BASE }), /EXPECTED_NETWORK/);
  assert.throws(() => expectationFromEnv({ EXPECTED_AMOUNT_ATOMIC: "0.01" }), /whole number/);
  assert.deepEqual(expectationFromEnv({ EXPECTED_NETWORK: BASE, EXPECTED_PAY_TO: SELLER }), {
    maxAmountAtomic: undefined,
    network: BASE,
    payTo: SELLER,
    asset: undefined,
  });
});

test("nothing pinned: every offer passes to the client's own spend controls", () => {
  assert.equal(refusalReason({ ...offer, amount: "999999999", payTo: OTHER }, {}), undefined);
});
