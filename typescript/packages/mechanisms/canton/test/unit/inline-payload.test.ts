/**
 * Inline payload decode: every malformed or over-limit field is refused with
 * the scheme error code the facilitator answers with, and the encoder only
 * produces what the decoder accepts.
 */
import { describe, it, expect } from "vitest";
import {
  decodeInlinePaymentPayload,
  encodeInlinePaymentPayload,
  InlinePayloadError,
} from "../../src/inline-payload.js";

const BYTES = Buffer.from("a prepared transaction");
const valid = () =>
  encodeInlinePaymentPayload({
    preparedTransactionBytes: BYTES,
    preparedTxHash: "ab".repeat(32),
    signatureB64: Buffer.alloc(64, 1).toString("base64"),
  });

/**
 * The error code `decodeInlinePaymentPayload` refuses `payload` with.
 *
 * @param payload - The payload to decode.
 * @param opts - Decode options.
 * @returns The InlinePayloadError code.
 */
function codeOf(payload: unknown, opts = {}): string {
  try {
    decodeInlinePaymentPayload(payload, opts);
  } catch (err) {
    expect(err).toBeInstanceOf(InlinePayloadError);
    return (err as InlinePayloadError).code;
  }
  throw new Error("decoded without error");
}

describe("decodeInlinePaymentPayload", () => {
  it("round-trips what the encoder produces", () => {
    const d = decodeInlinePaymentPayload(valid());
    expect(d.preparedTransactionBytes.equals(BYTES)).toBe(true);
    expect(d.claimedPreparedTxHash).toBe("ab".repeat(32));
    expect(d.hashingSchemeVersion).toBe("HASHING_SCHEME_VERSION_V2");
  });

  it("refuses a payload that is not an object", () => {
    expect(codeOf(null)).toBe("invalid_exact_canton_missing_proof");
    expect(codeOf("x")).toBe("invalid_exact_canton_missing_proof");
  });

  it("refuses missing proof fields", () => {
    for (const field of ["preparedTransaction", "preparedTxHash", "signature"]) {
      const p: Record<string, unknown> = { ...valid() };
      delete p[field];
      expect(codeOf(p)).toBe("invalid_exact_canton_missing_proof");
    }
  });

  it("refuses an over-long preparedTransaction before decoding it", () => {
    expect(codeOf(valid(), { maxPreparedTransactionB64Chars: 4 })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
  });

  it("refuses an over-long signature or hash", () => {
    expect(codeOf({ ...valid(), signature: "A".repeat(10_000) })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
    expect(codeOf({ ...valid(), preparedTxHash: "a".repeat(10_000) })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
  });

  it("refuses a hash that is not lower-case even-length hex", () => {
    expect(codeOf({ ...valid(), preparedTxHash: "AB".repeat(32) })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
    expect(codeOf({ ...valid(), preparedTxHash: "zz" })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
    expect(codeOf({ ...valid(), preparedTxHash: "abc" })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
  });

  it("refuses non-canonical base64", () => {
    expect(codeOf({ ...valid(), signature: "AQ" })).toBe("invalid_exact_canton_malformed_payload");
    expect(codeOf({ ...valid(), preparedTransaction: "!!!!" })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
  });

  it("accepts V2, refuses V1 and unknown hashing schemes", () => {
    expect(
      decodeInlinePaymentPayload({ ...valid(), hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" })
        .hashingSchemeVersion,
    ).toBe("HASHING_SCHEME_VERSION_V2");
    expect(codeOf({ ...valid(), hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
    expect(codeOf({ ...valid(), hashingSchemeVersion: "V9" })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
  });

  it("refuses a preparedTransaction that is not a gzip member", () => {
    const notGzip = Buffer.from("plain bytes").toString("base64");
    expect(codeOf({ ...valid(), preparedTransaction: notGzip })).toBe(
      "invalid_exact_canton_malformed_payload",
    );
  });

  it("refuses a preparedTransaction that decodes to nothing", () => {
    const empty = encodeInlinePaymentPayload({
      preparedTransactionBytes: Buffer.alloc(0),
      preparedTxHash: "ab".repeat(32),
      signatureB64: Buffer.alloc(64, 1).toString("base64"),
    });
    expect(codeOf(empty)).toBe("invalid_exact_canton_malformed_payload");
  });
});

describe("encodeInlinePaymentPayload", () => {
  it("refuses a hash its own decoder would refuse", () => {
    const enc = (preparedTxHash: string) =>
      encodeInlinePaymentPayload({
        preparedTransactionBytes: BYTES,
        preparedTxHash,
        signatureB64: Buffer.alloc(64, 1).toString("base64"),
      });
    expect(() => enc("xyz")).toThrow();
    expect(() => enc("abc")).toThrow();
  });
});
