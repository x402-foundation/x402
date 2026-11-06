# Shared test vectors

Machine-readable vectors for decoding the payment headers of the
[HTTP transport](../http.md): `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
`PAYMENT-RESPONSE`. They are an implementation aid: when this file and the
specification disagree, the specification governs. Where the specification is
silent, a case follows the RFC cited here or in its note.

The TypeScript SDK runs [`http_headers.json`](http_headers.json) in
`typescript/packages/core/test/unit/http/headerVectors.test.ts`. Other SDKs can
load the same file.

## Scope

A case decodes one header value: base64, then UTF-8, then JSON. The result must
be a JSON object, because each header carries a base64-encoded object (the
Header Summary table in http.md).

http.md does not name a base64 variant. The cases read it as
[RFC 4648 section 4](https://www.rfc-editor.org/rfc/rfc4648#section-4), which
section 5 makes the default: "Unless clarified otherwise, "base64" refers to the
base 64 in the previous section." Under that reading, RFC 4648 section 3.3
requires a decoder to reject data containing characters outside the base64
alphabet, unless the referring specification explicitly states otherwise, and
http.md does not. The `alphabet-*` cases test this.

## Layout

- `fixture_version`: see Versioning.
- `spec`: the specification the cases test, as a path from the repository root.
- `decode`: a list of cases.

Each case has:

- `id`, and a `note` saying how the value was made.
- `headers`: the headers the case applies to. A loader runs the case once per
  listed header, through that SDK's decoder for the header.
- `value`: the header field value.
- `expect`: `{ json }` when decoding succeeds and gives this JSON value, or
  `{ reject: true }` when it fails. Values are compared as parsed JSON, so
  member order and whitespace do not matter. An SDK whose decoder returns a
  typed object compares that object's JSON form.

The four `spec-*` cases are the examples in http.md, unchanged.

## Not covered

- Whether a decoder must reject base64 whose `=` padding is missing. RFC 4648
  section 3.2 requires pad characters at the end of encoded data, but gives no
  rule for a decoder that receives none.
- Bytes under the base64 that are not valid UTF-8, or that start with a byte
  order mark (RFC 8259 section 8.1 lets a parser ignore one).
- Duplicate member names in the decoded object (RFC 8259 section 4).
- The schema check of the decoded object, and dispatch between v1 and v2.
- Header size limits.
- The status code and body a server returns when decoding fails.

## Versioning

`fixture_version` increases whenever an expectation changes or a case is
removed. Adding a case does not change it. SDK loaders check the version they
target, so a changed expectation cannot pass unnoticed.
