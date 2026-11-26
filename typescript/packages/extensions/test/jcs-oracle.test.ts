/**
 * Differential test: `canonicalize` against an independent RFC 8785 implementation
 * (jcs-admit, a Rust core compiled to WebAssembly) on seeded random inputs.
 * The fixed vectors in offer-receipt.test.ts pin known cases; this covers the space between them.
 */

import { describe, it, expect } from "vitest";
import { admit } from "jcs-admit";

import { canonicalize } from "../src/offer-receipt";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const oracle = (jsonText: string): string => decoder.decode(admit(encoder.encode(jsonText)));

// mulberry32: deterministic, so a failure reproduces from the printed seed.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SEED = 0x8785;

const randomDouble = (next: () => number): number => {
  const view = new DataView(new ArrayBuffer(8));
  for (;;) {
    view.setUint32(0, Math.floor(next() * 2 ** 32));
    view.setUint32(4, Math.floor(next() * 2 ** 32));
    const x = view.getFloat64(0);
    if (Number.isFinite(x)) return x;
  }
};

const POOL = [
  0x00, 0x08, 0x0a, 0x1f, 0x22, 0x2f, 0x41, 0x5c, 0x7f, 0x80, 0xe9, 0x2028, 0x20ac, 0xfb33,
];

const randomString = (next: () => number): string => {
  let s = "";
  const len = Math.floor(next() * 6);
  for (let i = 0; i < len; i++) {
    const r = next();
    if (r < 0.15) s += String.fromCodePoint(0x10000 + Math.floor(next() * 0xfffff));
    else if (r < 0.5) s += String.fromCharCode(POOL[Math.floor(next() * POOL.length)]);
    else s += String.fromCharCode(0x20 + Math.floor(next() * 0x5f));
  }
  return s;
};

const randomValue = (next: () => number, depth: number): unknown => {
  const r = next();
  if (depth > 2 || r < 0.3) return randomDouble(next);
  if (r < 0.5) return randomString(next);
  if (r < 0.6) return [null, true, false][Math.floor(next() * 3)];
  if (r < 0.8)
    return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 1));
  const obj: Record<string, unknown> = {};
  for (let i = Math.floor(next() * 5); i > 0; i--)
    obj[randomString(next)] = randomValue(next, depth + 1);
  return obj;
};

describe("canonicalize matches an independent RFC 8785 implementation", () => {
  it("on the RFC 8785 §3.2.2 input text", () => {
    const input = String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`;
    expect(canonicalize(JSON.parse(input))).toBe(oracle(input));
  });

  it(`on 20000 random finite doubles (seed ${SEED})`, () => {
    const next = rng(SEED);
    for (let i = 0; i < 20000; i++) {
      const x = randomDouble(next);
      // 21 significant digits round-trip every double without using the shortest form under test.
      expect(canonicalize(x), x.toExponential(20)).toBe(oracle(x.toExponential(20)));
    }
  });

  it(`on 2000 random nested values (seed ${SEED})`, () => {
    const next = rng(SEED + 1);
    for (let i = 0; i < 2000; i++) {
      const text = JSON.stringify(randomValue(next, 0));
      expect(canonicalize(JSON.parse(text)), text).toBe(oracle(text));
    }
  });

  it.each(['"\\ud800"', '"a\\udeadb"', '{"\\udead":1}'])("both refuse lone surrogate %s", text => {
    expect(() => canonicalize(JSON.parse(text))).toThrow(/surrogate/i);
    expect(() => oracle(text)).toThrow();
  });
});
