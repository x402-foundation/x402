/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Both Masumi digests (`inputHash` and `termsDigest`) are taken over
 * `JCS(value)`, so client, resource server and facilitator only agree when they
 * serialize identically. The rules that matter here:
 *
 * - object members are sorted by the UTF-16 code units of their names, which is
 *   exactly JavaScript's default string ordering;
 * - numbers use the ECMAScript `Number::toString` form, which is what
 *   `JSON.stringify` emits;
 * - strings use JSON escaping with the short forms for `\b \t \n \f \r`.
 *
 * A member whose value is `undefined` is omitted (it is absent from the JSON
 * document), matching `JSON.stringify`. Values JSON cannot represent — `NaN`,
 * `Infinity`, functions, symbols, `bigint` — are rejected rather than silently
 * coerced, because a silent coercion would produce a digest the counterparty
 * cannot reproduce.
 */

/**
 * Serializes a string with JSON escaping, refusing invalid Unicode.
 *
 * RFC 8785 requires canonicalization to fail on data that is not valid Unicode.
 * `JSON.stringify` instead escapes an unpaired UTF-16 surrogate into `\udXXX`,
 * so a JavaScript peer would happily produce a digest that a conforming
 * implementation in another language refuses to compute — a silent
 * disagreement on `inputHash` and `termsDigest`.
 *
 * @param value - The string to serialize.
 * @returns The JSON-escaped string.
 * @throws When the string contains an unpaired surrogate.
 */
function serializeString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const isHighSurrogate = code <= 0xdbff;
    const next = isHighSurrogate ? value.charCodeAt(i + 1) : Number.NaN;
    if (!isHighSurrogate || !(next >= 0xdc00 && next <= 0xdfff)) {
      throw new Error("JCS cannot serialize a string containing an unpaired surrogate");
    }
    i++;
  }
  return JSON.stringify(value);
}

/**
 * Canonicalizes a JSON value per RFC 8785.
 *
 * @param value - An RFC 8785-compatible JSON value.
 * @returns The canonical JSON text.
 * @throws When the value contains something JSON cannot represent.
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`JCS cannot serialize the non-finite number ${value}`);
      }
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new Error(`JCS cannot serialize a value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => jcs(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${serializeString(key)}:${jcs(record[key])}`);
  return `{${members.join(",")}}`;
}

/**
 * UTF-8 bytes of the canonical form of a JSON value.
 *
 * @param value - An RFC 8785-compatible JSON value.
 * @returns The canonical UTF-8 bytes.
 */
export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcs(value));
}
