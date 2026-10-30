import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "../../../src/http";

const decoders = {
  "PAYMENT-REQUIRED": decodePaymentRequiredHeader,
  "PAYMENT-SIGNATURE": decodePaymentSignatureHeader,
  "PAYMENT-RESPONSE": decodePaymentResponseHeader,
};

interface DecodeCase {
  id: string;
  note: string;
  headers: (keyof typeof decoders)[];
  value: string;
  expect: { json: object } | { reject: true };
}

// Cross-SDK vectors; the format is in the README next to the file.
const vectors: { fixture_version: number; decode: DecodeCase[] } = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../../../specs/transports-v2/vectors/http_headers.json", import.meta.url),
    ),
    "utf8",
  ),
);

describe("shared HTTP header vectors", () => {
  it("targets fixture version 1", () => {
    expect(vectors.fixture_version).toBe(1);
  });

  it("has well-formed cases", () => {
    const ids = vectors.decode.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of vectors.decode) {
      expect(c.headers.length).toBeGreaterThan(0);
      expect("json" in c.expect || c.expect.reject === true).toBe(true);
    }
  });

  const runs = vectors.decode.flatMap(c => c.headers.map(header => [c.id, header, c] as const));

  it.each(runs)("%s (%s)", (_id, header, c) => {
    const decode = decoders[header];
    expect(decode).toBeTypeOf("function");
    if ("reject" in c.expect) {
      expect(() => decode(c.value)).toThrow();
    } else {
      expect(decode(c.value)).toEqual(c.expect.json);
    }
  });
});
