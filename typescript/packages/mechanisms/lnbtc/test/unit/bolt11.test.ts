import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bech32, bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";
import { decodeInvoice } from "../../src/bolt11";
import { BOLT11_INVALID, BOLT11_PAYEE, BOLT11_VALID } from "./bolt11-vectors";
import {
  HTTP_A_HASH,
  OTHER_KEY,
  RECEIVER_PUBKEY,
  SPEC_INVOICE,
  SPEC_TIME,
  makeInvoice,
} from "./helpers";

const hashWords = (byte: number) => bech32.toWords(sha256(Uint8Array.of(byte)));
const otherPubkeyWords = bech32.toWords(secp256k1.getPublicKey(OTHER_KEY, true));

describe("decodeInvoice", () => {
  it("decodes the specification vector", () => {
    expect(decodeInvoice(SPEC_INVOICE)).toEqual({
      currency: "bc",
      amountMsat: 25_000n,
      timestamp: SPEC_TIME,
      expirySeconds: 300,
      paymentHash: "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e",
      descriptionHashes: [HTTP_A_HASH],
      inlineDescriptionCount: 0,
      payee: RECEIVER_PUBKEY,
      hasPayeeField: false,
    });
  });

  it("reproduces the specification vector from its inputs", () => {
    expect(makeInvoice().invoice).toBe(SPEC_INVOICE);
  });

  it("accepts an uppercase invoice", () => {
    expect(decodeInvoice(SPEC_INVOICE.toUpperCase())).toEqual(decodeInvoice(SPEC_INVOICE));
  });

  it.each([
    [1n, "1 msat (pico)"],
    [1_000n, "1 sat"],
    [21_000n, "21 sats"],
    [100_000_000_000n, "1 BTC (no multiplier)"],
    [150_000_000n, "milli"],
    [100_000n, "micro"],
    [2_100_000_000_000_000_000n, "21M BTC"],
  ])("decodes amount %s (%s)", amount => {
    expect(decodeInvoice(makeInvoice({ amountMsat: amount }).invoice).amountMsat).toBe(amount);
  });

  it.each([
    ["lnbc1", 100_000_000_000n],
    ["lnbc10p", 1n],
    ["lnbc2500u", 250_000_000n],
    ["lnbc99999999999999999999", BigInt("9".repeat(20)) * 100_000_000_000n],
  ])("decodes the non-shortest amount spelling %s exactly", (hrp, amount) => {
    expect(decodeInvoice(makeInvoice({ hrp }).invoice).amountMsat).toBe(amount);
  });

  it("verifies against an explicit payee field", () => {
    const decoded = decodeInvoice(makeInvoice({ payeeField: true }).invoice);
    expect(decoded.payee).toBe(RECEIVER_PUBKEY);
    expect(decoded.hasPayeeField).toBe(true);
  });

  it("reports description fields, default expiry, and skips unknown fields", () => {
    const inline = decodeInvoice(makeInvoice({ description: "hi", descriptionHash: null }).invoice);
    expect(inline.descriptionHashes).toEqual([]);
    expect(inline.inlineDescriptionCount).toBe(1);
    const both = decodeInvoice(makeInvoice({ rawFields: [[23, hashWords(1)]] }).invoice);
    expect(both.descriptionHashes).toHaveLength(2);
    expect(decodeInvoice(makeInvoice({ expiry: null }).invoice).expirySeconds).toBe(3600);
    expect(decodeInvoice(makeInvoice({ expiryWords: [] }).invoice).expirySeconds).toBe(0);
    expect(decodeInvoice(makeInvoice({ unknownField: true }).invoice).paymentHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("decodes the maximum 35-bit timestamp and a long invoice", () => {
    expect(decodeInvoice(makeInvoice({ timestamp: 2 ** 35 - 1 }).invoice).timestamp).toBe(
      2 ** 35 - 1,
    );
    const filler = new Array(1023).fill(0);
    const long = makeInvoice({
      rawFields: [
        [31, filler],
        [30, filler],
      ],
    }).invoice;
    expect(long.length).toBeGreaterThan(2046);
    expect(decodeInvoice(long).paymentHash).toBe(decodeInvoice(SPEC_INVOICE).paymentHash);
  });

  it("recovers a different key when the recovery id is flipped", () => {
    expect(decodeInvoice(makeInvoice({ recovery: 0 }).invoice).payee).not.toBe(
      decodeInvoice(makeInvoice({ recovery: 1 }).invoice).payee,
    );
  });

  it("recovers the signer from either S form without an n field", () => {
    expect(makeInvoice({ highS: true }).invoice).not.toBe(SPEC_INVOICE);
    expect(decodeInvoice(makeInvoice({ highS: true }).invoice).payee).toBe(RECEIVER_PUBKEY);
    expect(decodeInvoice(makeInvoice({ key: OTHER_KEY }).invoice).payee).not.toBe(RECEIVER_PUBKEY);
  });

  // Flips one signed data word and re-encodes with a valid checksum.
  const tamper = (invoice: string) => {
    const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, false);
    const flipped = [...words];
    flipped[3] ^= 1;
    return bech32.encode(prefix, flipped, false);
  };

  it("recovers a different payee from tampered data, and rejects it against an n field", () => {
    expect(decodeInvoice(tamper(SPEC_INVOICE)).payee).not.toBe(RECEIVER_PUBKEY);
    const withPayee = makeInvoice({ payeeField: true }).invoice;
    expect(() => decodeInvoice(tamper(withPayee))).toThrow("invalid invoice signature");
  });

  const pPadded = hashWords(5);
  pPadded[51] |= 1; // the low 4 bits of the last word are padding

  it.each([
    ["empty", "", "empty invoice"],
    ["non-string", 42 as unknown as string, "empty invoice"],
    ["lightning: prefix", `lightning:${SPEC_INVOICE}`, "Invalid checksum"],
    [
      "mixed case",
      SPEC_INVOICE.slice(0, 10).toUpperCase() + SPEC_INVOICE.slice(10),
      "String must be lowercase or uppercase",
    ],
    ["bad checksum", SPEC_INVOICE.slice(0, -1) + "q", "Invalid checksum"],
    ["bech32m checksum", bech32ToBech32m(SPEC_INVOICE), "Invalid checksum"],
    ["no amount", makeInvoice({ amountMsat: null }).invoice, "invoice has no amount"],
    ["multiplier without digits", makeInvoice({ hrp: "lnbcn" }).invoice, "invoice has no amount"],
    ["leading zero", makeInvoice({ hrp: "lnbc0250n" }).invoice, "amount has leading zeros"],
    ["zero amount", makeInvoice({ hrp: "lnbc0n" }).invoice, "invoice amount is zero"],
    ["sub-msat", makeInvoice({ hrp: "lnbc1p" }).invoice, "amount is not an integral millisatoshi"],
    [
      "sub-msat with a large amount",
      makeInvoice({ hrp: "lnbc2500000001p" }).invoice,
      "amount is not an integral millisatoshi",
    ],
    ["unknown multiplier", makeInvoice({ hrp: "lnbc250x" }).invoice, "invalid invoice prefix"],
    ["decimal amount", makeInvoice({ hrp: "lnbc2.5m" }).invoice, "invalid invoice prefix"],
    ["not a lightning prefix", makeInvoice({ hrp: "lxbc250n" }).invoice, "invalid invoice prefix"],
    ["no currency", makeInvoice({ hrp: "ln250n" }).invoice, "invalid invoice prefix"],
    [
      "no payment hash",
      makeInvoice({ paymentHashWords: null }).invoice,
      "invoice has no payment hash",
    ],
    [
      "two payment hashes",
      makeInvoice({ extraPaymentHash: true }).invoice,
      "duplicate tagged field",
    ],
    [
      "no payment secret",
      makeInvoice({ omitPaymentSecret: true }).invoice,
      "invoice has no payment secret",
    ],
    [
      "two payment secrets",
      makeInvoice({ rawFields: [[16, hashWords(2)]] }).invoice,
      "duplicate tagged field",
    ],
    [
      "two payee fields",
      makeInvoice({ payeeField: true, rawFields: [[19, otherPubkeyWords]] }).invoice,
      "duplicate tagged field",
    ],
    [
      "two expiry fields",
      makeInvoice({ rawFields: [[6, [10]]] }).invoice,
      "duplicate tagged field",
    ],
    ["two CLTV fields", makeInvoice({ rawFields: [[24, [10]]] }).invoice, "duplicate tagged field"],
    [
      "two feature fields",
      makeInvoice({ featureWords: [1], rawFields: [[5, [1]]] }).invoice,
      "duplicate tagged field",
    ],
    [
      "short payment hash",
      makeInvoice({ rawFields: [[1, hashWords(3).slice(0, 51)]] }).invoice,
      "tagged field has the wrong length",
    ],
    [
      "long payment hash",
      makeInvoice({ rawFields: [[1, [...hashWords(3), 0]]] }).invoice,
      "tagged field has the wrong length",
    ],
    [
      "short secret",
      makeInvoice({ rawFields: [[16, hashWords(3).slice(0, 51)]] }).invoice,
      "tagged field has the wrong length",
    ],
    [
      "long description hash",
      makeInvoice({ rawFields: [[23, [...hashWords(3), 0]]] }).invoice,
      "tagged field has the wrong length",
    ],
    [
      "short payee",
      makeInvoice({ rawFields: [[19, otherPubkeyWords.slice(0, 52)]] }).invoice,
      "tagged field has the wrong length",
    ],
    ["padded payment hash", makeInvoice({ paymentHashWords: pPadded }).invoice, "Non-zero padding"],
    [
      "padded secret",
      makeInvoice({ omitPaymentSecret: true, rawFields: [[16, pPadded]] }).invoice,
      "Non-zero padding",
    ],
    [
      "padded description hash",
      makeInvoice({ descriptionHash: null, rawFields: [[23, pPadded]] }).invoice,
      "Non-zero padding",
    ],
    [
      "padded payee",
      makeInvoice({ rawFields: [[19, otherPubkeyWords.map((w, i) => (i === 52 ? w | 1 : w))]] })
        .invoice,
      "Non-zero padding",
    ],
    [
      "non-minimal expiry",
      makeInvoice({ expiryWords: [0, 9, 12] }).invoice,
      "non-minimal integer field",
    ],
    [
      "non-minimal CLTV",
      makeInvoice({ minFinalCltvWords: [0, 18] }).invoice,
      "non-minimal integer field",
    ],
    [
      "non-minimal features",
      makeInvoice({ featureWords: [0, 1] }).invoice,
      "non-minimal integer field",
    ],
    [
      "expiry beyond 2^53",
      makeInvoice({ expiryWords: new Array(11).fill(31) }).invoice,
      "integer field too large",
    ],
    [
      "truncated field header",
      makeInvoice({ trailingWords: [31, 0] }).invoice,
      "truncated tagged field",
    ],
    [
      "truncated field data",
      makeInvoice({ trailingWords: [31, 0, 5, 1, 1] }).invoice,
      "truncated tagged field",
    ],
    ["too short", bech32.encode("lnbc250n", new Array(110).fill(0), false), "invoice too short"],
    ["recovery id 4", makeInvoice({ recovery: 4 }).invoice, "invalid recovery id"],
    ["wrong recovery id", makeInvoice({ recovery: 2 }).invoice, "recovery id 2 or 3 invalid"],
    [
      "high-S signature with an n field",
      makeInvoice({ highS: true, payeeField: true }).invoice,
      "invalid invoice signature",
    ],
    [
      "n field naming another key",
      makeInvoice({ rawFields: [[19, otherPubkeyWords]] }).invoice,
      "invalid invoice signature",
    ],
    [
      "n field off the curve",
      makeInvoice({
        rawFields: [[19, bech32.toWords(Uint8Array.of(2, ...new Array(32).fill(0xff)))]],
      }).invoice,
      "invalid invoice signature",
    ],
  ] as [string, string, string][])("rejects %s", (_name, invoice, message) => {
    expect(() => decodeInvoice(invoice)).toThrow(message);
  });
});

describe("BOLT11 examples", () => {
  const amountless = (invoice: string) => /^ln[a-z]+1p/i.test(invoice);
  const IGNORED_FIELDS = "Same, but including fields which must be ignored.";
  const withAmount = BOLT11_VALID.filter(
    ([name, invoice]) => !amountless(invoice) && name !== IGNORED_FIELDS,
  );

  it.each(withAmount)("decodes the valid example: %s", (_name, invoice) => {
    const decoded = decodeInvoice(invoice);
    expect(decoded.payee).toBe(BOLT11_PAYEE);
    expect(decoded.paymentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("decodes the 0.00967878534 BTC pico amount exactly", () => {
    const pico = BOLT11_VALID.find(([, invoice]) => invoice.startsWith("lnbc9678785340p"));
    expect(decodeInvoice(pico![1]).amountMsat).toBe(967_878_534n);
  });

  it("rejects the amountless examples, which cannot carry an exact price", () => {
    const examples = BOLT11_VALID.filter(([, invoice]) => amountless(invoice));
    expect(examples).toHaveLength(2);
    for (const [, invoice] of examples) {
      expect(() => decodeInvoice(invoice)).toThrow("invoice has no amount");
    }
  });

  it("rejects wrong-length fixed fields that an older example still lists as ignored", () => {
    // The BOLT11 reader requirements now say a reader MUST fail on a `p`, `h`,
    // `s`, or `n` field of the wrong length; this example predates that rule.
    const [, invoice] = BOLT11_VALID.find(([name]) => name === IGNORED_FIELDS)!;
    expect(() => decodeInvoice(invoice)).toThrow("tagged field has the wrong length");
  });

  it.each(BOLT11_INVALID.filter(([name]) => !name.includes("unknown feature")))(
    "rejects the invalid example: %s",
    (_name, invoice) => {
      expect(() => decodeInvoice(invoice)).toThrow();
    },
  );

  it("leaves feature-bit negotiation to the payer node", () => {
    // Unknown even feature bits make an invoice unpayable, which the payer node
    // enforces. Rejecting them here could refuse a proof for an invoice that was
    // actually paid, so the decoder deliberately ignores the features field.
    const [, invoice] = BOLT11_INVALID.find(([name]) => name.includes("unknown feature"))!;
    expect(decodeInvoice(invoice).payee).toBe(BOLT11_PAYEE);
  });
});

/**
 * Re-encodes an invoice with a bech32m checksum.
 *
 * @param invoice - bech32 invoice
 * @returns The same data with a bech32m checksum
 */
function bech32ToBech32m(invoice: string): string {
  const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, false);
  return bech32m.encode(prefix, words, false);
}
