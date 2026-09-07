/**
 * Inline gzip codec — the pre-validation attack surface (attacker-controlled
 * compressed bytes reach the facilitator before anything else runs). One happy
 * roundtrip, then one negative per documented guard: both size caps, the header
 * shape (magic / method / disallowed optional fields), and the single-member
 * rule (trailing bytes, a tampered body, and two identical members).
 */
import { describe, it, expect } from "vitest";
import {
  encodeInlinePayload,
  decodeInlinePayload,
  InlineCodecError,
} from "../../src/inline-codec.js";

const RAW = Buffer.from("a prepared-transaction stand-in — πλλά bytes", "utf8");

describe("inline-codec", () => {
  it("roundtrips: decode(encode(x)) === x", () => {
    const out = decodeInlinePayload(encodeInlinePayload(RAW));
    expect(out.equals(RAW)).toBe(true);
  });

  it("rejects a member over the compressed-size cap before doing any work", () => {
    const g = encodeInlinePayload(RAW);
    expect(() => decodeInlinePayload(g, { maxCompressedBytes: g.length - 1 })).toThrow(
      InlineCodecError,
    );
  });

  it("rejects a decompression bomb at the decompressed-size cap", () => {
    // ~100 KiB of zeros compresses to a tiny member but blows the output cap.
    const g = encodeInlinePayload(Buffer.alloc(100_000, 0));
    expect(() => decodeInlinePayload(g, { maxDecompressedBytes: 1024 })).toThrow(
      /decompressed size exceeds/,
    );
  });

  it("rejects input too short to be a gzip member", () => {
    expect(() => decodeInlinePayload(Buffer.alloc(4))).toThrow(InlineCodecError);
  });

  it("rejects bad gzip magic", () => {
    const bad = Buffer.from(encodeInlinePayload(RAW));
    bad[0] = 0x00;
    expect(() => decodeInlinePayload(bad)).toThrow(/bad magic/);
  });

  it("rejects a header carrying disallowed optional fields (FNAME)", () => {
    const bad = Buffer.from(encodeInlinePayload(RAW));
    bad[3] = (bad[3] as number) | 0x08; // set FNAME
    expect(() => decodeInlinePayload(bad)).toThrow(/disallowed optional fields/);
  });

  it("rejects trailing bytes appended after the member", () => {
    const bad = Buffer.concat([encodeInlinePayload(RAW), Buffer.from([0x00])]);
    expect(() => decodeInlinePayload(bad)).toThrow(InlineCodecError);
  });

  it("rejects a tampered body (trailer no longer agrees)", () => {
    const bad = Buffer.from(encodeInlinePayload(RAW));
    bad[12] = (bad[12] as number) ^ 0xff; // flip a byte inside the deflate body
    expect(() => decodeInlinePayload(bad)).toThrow(InlineCodecError);
  });

  it("rejects two identical concatenated members (the seam the trailer cannot catch)", () => {
    const g = encodeInlinePayload(Buffer.from("hi", "utf8"));
    expect(() => decodeInlinePayload(Buffer.concat([g, g]))).toThrow(InlineCodecError);
  });
});
