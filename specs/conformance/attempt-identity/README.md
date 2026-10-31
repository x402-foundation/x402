# Known-answer vectors for section 5.5

Section 5.5 of the v2 specification (Settlement and Refusal Identity Invariant) defines how the request members that enter an attempt identity are canonicalized. These vectors pin the result for eleven raw requests, so an implementation in any language can check itself without a shared checker.

Each input comes as a pair of files:

- `known-answer-<name>.json` records the value the section prescribes. Expected outcome: `PASS`.
- `known-answer-<name>-wrong.json` records a plausible wrong value for the same input. Expected outcome: `FAIL` with `CANONICAL_MEMBER_MISMATCH`.

An implementation passes a file when it canonicalizes `input.known_answers[].raw` and compares the result to `observed` the way `expected` says: equal gives `PASS`, different gives `FAIL`.

| Input | Pins |
| --- | --- |
| `query-uppercase-hex-and-arrival-order` | percent-encoding with uppercase hex, pairs stay in the order they arrived |
| `query-repeated-keys-keep-order` | repeated names keep the order of their values |
| `query-plus-stays-plus` | a literal `+` is not read as a space |
| `query-bare-name-stays-bare` | a name without `=` is not the same as a name with an empty value |
| `query-semicolon-is-not-a-separator` | only `&` separates pairs, `;` is part of the value |
| `query-decode-then-encode` | an encoded unreserved character becomes the plain character |
| `query-invalid-utf8-stays-octets` | percent-decoding works on octets, an invalid UTF-8 byte stays that octet |
| `body-json-rfc8785` | JSON body canonicalized with RFC 8785, then SHA-256 |
| `body-gzip-then-rfc8785` | `Content-Encoding` reversed before canonicalization |
| `body-iso-8859-1-is-latin1` | each byte of an ISO-8859-1 body is the code point of the same number |
| `body-duplicate-keys-hashed-as-bytes` | duplicate object keys (also after unescaping): the decoded bytes are hashed, no canonicalization |

The query string and body fields in `raw` are the wire form: `query` is the raw query string, `bodyBase64` the body as received, `contentEncoding` and `contentType` the headers.

The negative control for a handler that reads the first value is `query-repeated-keys-keep-order`: `q=caf%c3%a9&q=a` must give `q=caf%C3%A9&q=a`, and the sorted form `q=a&q=caf%C3%A9` must be rejected, so that `q=a&q=b` and `q=b&q=a` can never share an identity.

## Provenance

The right values were computed by two implementations written separately, one in JavaScript and one in Python using only its standard library. They share no code and agree on all eleven inputs. A third implementation, written by ruiruii, agrees on all eleven right values and rejects all eleven wrong ones (https://github.com/x402-foundation/x402/pull/3958#issuecomment-6424707421). The files are copied byte for byte from `vectors/attempt-identity/` in https://github.com/holistis/agent-receipt-verify at commit `a295fe9` (npm 0.2.22), which also holds the vectors that record what an implementation did rather than pin a value. All files carry their own `provenance` and `limits` fields. The query rule behind them was measured against 18 libraries and frameworks, none of which treats `?q=a&q=b` and `?q=b&q=a` as equal (https://github.com/holistis/agent-receipt-verify/tree/main/research/repeated-query-matrix).

## Limits

- These vectors pin canonical members, not a whole identity. They say nothing about how the members are combined or hashed into one.
- One point of the text of 5.5 is not pinned here: a `%` that is not followed by two hex digits.
