# Extension: `response-provenance`

## Summary

The `response-provenance` extension lets a paid response carry a hash that **anyone can re-derive
offline** — upgrading "you paid for this URL" into "and here is proof of what came back." A resource
server attaches `responseHash = sha256(jcs(fixedPoint))`, a SHA-256 over the RFC 8785 (JCS) canonical
form of the closed fixed point `{endpoint, inputs, result, method, dataVintage}`. A buyer, auditor,
or indexer re-derives it with any off-the-shelf JCS library: no key exchange, no callback to the
issuer, no resolver, no trust in any party.

Scope of the claim: the extension proves the response is **reproducible** always, and **unaltered**
when the hash is bound inside a signed receipt (a bare extension block on an unsigned response can be
stripped or forged in transit and re-hashed — see [Signed carriage](#signed-carriage) and
[Security considerations](#security-considerations)). It deliberately does **not** prove the response
is *correct* — correctness is established only by reproduction against published golden vectors.
Keeping those claims separate is the design's load-bearing rule.

Proposed and reviewed in [issue #3234](https://github.com/x402-foundation/x402/issues/3234) (see
[Status](#status-and-prior-art)). **This file is normative.** Where any external document — including
the upstream fixed-point specification this design derives from — diverges from this file, this file
governs for x402 purposes.

---

## Motivation

A settlement receipt binds `resourceUrl`, `payer`, `network`, and `txHash` — it proves payment
settled, not what the server returned. Today sellers fill that gap with incompatible private
spellings (EIP-712 body attestations, bespoke `record_hash` / `verdict_hash` members, "SHA-256
fingerprint" prose). One shared, re-derivable field lets every relying party check every seller
identically — and lets the evidence outlive the seller, since verification requires nothing from
them.

---

## The fixed point

The hashed object is exactly five members — a **closed set**:

| Member | Meaning |
|---|---|
| `endpoint` | the resource path the buyer called (binds the *question*, not just the answer) |
| `inputs` | the request inputs, per the [request mapping](#request--inputs-mapping) |
| `result` | the substantive answer object |
| `method` | human-readable statement of the computation performed |
| `dataVintage` | the vintage of the data the result was computed from |

All five members are REQUIRED and no other member is permitted in the hashed object. A verifier
always recomputes over the five members, so an issuer cannot shrink the fixed point (e.g. drop
`inputs`) and remain internally consistent.

`fixedPointVersion` names the frozen rule set and travels **beside** the hash, never inside it —
including the hash, or any value derived from it, inside the hashed octets is a self-reference cycle
and is prohibited. Two versions exist; both hash the same five members identically:

- **`GVP-FixedPoint/1`** — the base rule set, frozen; a different member set would be a new
  identifier.
- **`GVP-FixedPoint/2`** — identical hashing; additionally, `dataVintage` MUST be an ISO 8601
  calendar date at reduced precision, exactly one of `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` (regex
  `^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$`, and a real calendar date at the stated precision). Precision
  is significant — `"2026"`, `"2026-07"`, and `"2026-07-01"` are three different vintages and hash
  differently. No time component, no timezone. Under this grammar, lexical comparison equals
  chronological comparison. A `/2` verifier MUST reject a fixed point whose `dataVintage` does not
  match the grammar (outcome: `unverifiable`).

### Agreement semantics (normative)

This extension compares `inputs` and `result` as the JSON values declared, under RFC 8785, with **no
normalization of any kind**: no Unicode normalization, no case folding, no numeric coercion, no
timestamp or whitespace reformatting, no key aliasing. Two inputs that a human would call the same
question but that differ in shape (`"2026-07-01"` vs `"2026-07-01T00:00:00Z"`, `"Café"` in NFC vs NFD,
`42` vs `"42"`) are **two different questions** and hash differently; a re-derivation across them is
`contradicted`, not a silent match. `fixedPointVersion` is the record's declaration of this semantics:
every `GVP-FixedPoint/*` rule set is byte-exact after JCS (pinned-class), and a rule set that
normalized any field would be a new identifier, never a reinterpretation of an existing one. A
verifier MUST NOT normalize any member before canonicalizing; an implementation that does is
non-conformant even when its hashes happen to agree.

### Member carriage — where a verifier finds each member

An issuer emitting this extension MUST make every fixed-point member recoverable as follows:

| Member | Carriage |
|---|---|
| `endpoint` | the request path as served (path only; see [Security considerations](#security-considerations) for issuer scoping) — also RECOMMENDED as a top-level response-body member `endpoint` |
| `inputs` | derived from the request per the [request mapping](#request--inputs-mapping) |
| `result` | per `resultCarriage` (below): `"member"` (default) — REQUIRED top-level response-body member `result`; `"body"` — the response body object itself with its top-level `extensions` member removed |
| `method` | REQUIRED member `method` of the extension object |
| `dataVintage` | REQUIRED member `dataVintage` of the extension object |

Carrying `method` and `dataVintage` in the extension object (beside the hash, not inside the hashed
octets) is permitted and required precisely because the self-reference prohibition covers only the
hash and values derived from it — hashed members restated outside the hashed object are inputs to
re-derivation, not cycles.

#### `resultCarriage` — declaring where `result` lives

Existing REST APIs overwhelmingly put the answer's fields at the root of the response body; requiring
a `result` wrapper would force every such seller into a breaking change or a duplicated payload. The
extension object therefore declares how `result` is carried, with an OPTIONAL member
`resultCarriage` whose absence means `"member"`:

| `resultCarriage` | `result` is recovered as |
|---|---|
| `"member"` (default) | the value of the top-level response-body member `result`, which MUST be present |
| `"body"` | the response body as parsed, which MUST be a JSON object, with its top-level `extensions` member removed and **nothing else** removed, added, or reordered (order is immaterial under JCS). Any other top-level member — including one named `result` — is part of `result` like any other |

This is a **wire-recovery declaration**, not a mode flag: the fixed point, the closure rule, the hash
definition, and the single claim `responseHash` carries are unchanged, and the same fixed point
produces the same hash under either carriage (the [worked vector](#worked-vector-normative) is
reproduced by both examples in [Envelope](#envelope)). A verifier reads `resultCarriage` before
recovering `result`; an unrecognised value, `"member"` with no `result` member, or `"body"` on a
non-object body is `unverifiable` (see [Verification outcomes](#verification-outcomes-normative)).
Under [signed carriage](#signed-carriage) a non-default `resultCarriage` SHOULD be inside the signed
payload for the same reason `fixedPointVersion` is.

*Informative.* Under `"body"`, the [closure rule](#issuer-requirements) and `dataVintage`
completeness apply to **every** top-level member of the body, seller metadata included: a
consultation timestamp, an age or a window computed at request time, a freshness phrase. Such a
member is a hidden input to `result`. A seller whose envelope carries one removes it from the
route, makes its input explicit, or uses `"member"`. This already follows from "nothing else
removed"; it is stated because a reviewer found three such members on a real catalogue of routes
that were closure-safe by handler code, and the next seller should not have to discover it.

### Request → `inputs` mapping

Two honest implementations must not disagree on what `inputs` is. The normative default mapping:

- **Request with a JSON body** (typically POST/PUT): `inputs` is the parsed JSON body, as a JSON
  value. The body MUST be [I-JSON](https://www.rfc-editor.org/rfc/rfc7493) (see
  [Numbers](#numbers-i-json)).
- **Request without a body** (typically GET): `inputs` is a JSON object built from the URL query
  string. The decode grammar is the `application/x-www-form-urlencoded` parser of the
  [WHATWG URL Standard](https://url.spec.whatwg.org/#urlencoded-parsing) (§5.1), applied to the
  query component (after `?`, before any `#`): pairs split on `&`; each pair splits on its first
  `=` (a pair with no `=` has the value `""`); `+` decodes to U+0020 before percent-decoding; names
  and values are percent-decoded to bytes and then decoded as UTF-8. Two tightenings apply where
  that parser is lenient, and a query violating either is **malformed**: a `%` not followed by two
  hex digits MUST be rejected (the parser would pass it through literally), and a decoded byte
  sequence that is not valid UTF-8 MUST be rejected (the parser would substitute U+FFFD). An issuer
  MUST NOT attach the extension to a response to a malformed query (whether the route serves the
  request without the extension or refuses it is route policy); a verifier that encounters one
  reports **`unverifiable`**. **Values remain strings** (`"42"`, never `42` — no type coercion); a
  name occurring more than once maps to an array of its values in order of appearance; name order
  is irrelevant (JCS sorts). An empty query yields `{}`.

Query-string examples (normative):

| Query | `inputs` |
|---|---|
| `?q=a+b` | `{"q":"a b"}` |
| `?q=a%2Bb` | `{"q":"a+b"}` |
| `?q=a%20b` | `{"q":"a b"}` |
| `?flag` | `{"flag":""}` |
| `?a=1&a=2` | `{"a":["1","2"]}` |
| `?x=%ZZ` | malformed — no claim issued; `unverifiable` if one is present |
| `?x=%FF` | malformed — no claim issued; `unverifiable` if one is present |

A seller whose route needs a different mapping MUST use a JSON body instead. No other mapping is
conformant under this extension.

### Canonicalization

Canonical JSON **is [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785)**. This extension
defines no bespoke serialization. Implementations use any verified JCS library (RFC 8785 Appendix G
lists several). Three additional restrictions apply, and a fixed point violating any of them is
**`unverifiable`** (see [Verification outcomes](#verification-outcomes-normative)): non-finite
numbers (NaN, ±Infinity) MUST be rejected, object member names MUST be unique, and nesting depth
SHOULD be bounded (reference implementations reject depth > 100).

### Numbers (I-JSON)

RFC 8785 serializes numbers per IEEE-754 double precision. Fixed-point values MUST conform to
I-JSON ([RFC 7493](https://www.rfc-editor.org/rfc/rfc7493)): integers outside the exact-double range
(beyond ±2^53−1) — raw wei-denominated values being the obvious case in this ecosystem — MUST be
carried as strings, not JSON numbers, or precision is silently lost at the parse step the whole
design depends on.

### Worked vector (normative)

A conforming implementation MUST reproduce this vector byte-for-byte. Fixed point:

```json
{
  "endpoint": "/v1/echo-sum",
  "inputs": { "a": 2, "b": 3 },
  "result": { "sum": 5 },
  "method": "sum = a + b, integer addition",
  "dataVintage": "2026-07"
}
```

JCS canonical form (134 bytes, one line):

```
{"dataVintage":"2026-07","endpoint":"/v1/echo-sum","inputs":{"a":2,"b":3},"method":"sum = a + b, integer addition","result":{"sum":5}}
```

`responseHash`:

```
sha256:81ea1f2227fd9df5b868954e6d26d091810352f148dade483b260844788ede03
```

---

## Envelope

On a paid response body:

```json
{
  "result": { "sum": 5 },
  "extensions": {
    "response-provenance": {
      "responseHash": "sha256:81ea1f2227fd9df5b868954e6d26d091810352f148dade483b260844788ede03",
      "fixedPointVersion": "GVP-FixedPoint/2",
      "method": "sum = a + b, integer addition",
      "dataVintage": "2026-07",
      "spec": "https://github.com/SolomonisBlack/golden-vector-provenance"
    }
  }
}
```

- `responseHash` (REQUIRED): `"sha256:" + lowercase-hex` SHA-256 of the JCS bytes of the fixed point.
- `fixedPointVersion` (REQUIRED): `"GVP-FixedPoint/1"` or `"GVP-FixedPoint/2"`.
- `method` (REQUIRED), `dataVintage` (REQUIRED): the fixed-point members, restated for carriage.
- `resultCarriage` (OPTIONAL, default `"member"`): where `result` lives, per
  [`resultCarriage`](#resultcarriage--declaring-where-result-lives).
- `spec` (OPTIONAL): URL of the upstream fixed-point specification (informative; this file governs).

The same claim on an existing root-level API, without wrapping or duplicating the answer:

```json
{
  "sum": 5,
  "extensions": {
    "response-provenance": {
      "responseHash": "sha256:81ea1f2227fd9df5b868954e6d26d091810352f148dade483b260844788ede03",
      "fixedPointVersion": "GVP-FixedPoint/2",
      "resultCarriage": "body",
      "method": "sum = a + b, integer addition",
      "dataVintage": "2026-07"
    }
  }
}
```

Under `"body"`, `result` is `{ "sum": 5 }` (the body with `extensions` removed), so the fixed point
and the hash are identical to the first example and to the worked vector.

Because the hash is computed over the canonical form of the parsed JSON value, transport-layer
transformations (gzip, brotli, chunking, insignificant whitespace) do not affect it. The party that
**produces the result** computes the hash; an intermediary that did not produce the bytes cannot
honestly attest them.

### Signed carriage

When the seller also emits a signed receipt (e.g. the `offer-and-receipt` extension), the signed
payload SHOULD include **both** `responseHash` **and** `fixedPointVersion`, and `resultCarriage`
whenever it is non-default. Signing only the hash leaves the version rewritable: an intermediary
that alters `result` could also rewrite `fixedPointVersion` to an unimplemented value, steering the
verification outcome from `contradicted` to `unverifiable` — choosing which negative state its
tampering produces. An unsigned `resultCarriage` is rewritable the same way (flipping `"body"` to
`"member"` on a root-level body yields `unverifiable` instead of `contradicted`).

The same reasoning applies one layer up, to how the signature itself is checked. Whatever signature
format carries the provenance members, a verifier MUST take the **algorithm from the resolved key,
never from the receipt** (RFC 8725 §3.1). For `offer-and-receipt` that means the algorithm pinned to
the key that `kid` resolves to, with the JWS `alg` header required to match it. A verifier MUST also
resolve the key from context it already holds, meaning the origin it paid (for `offer-and-receipt`, the
`did:web` document or other binding for the `resourceUrl` domain), never from a receipt field. Every
field is unauthenticated until the signature checks, so a `did:web` `kid` whose domain is not the
`resourceUrl` domain is `contradicted`, not something to go and fetch. The outcome then splits so that
a rewritten `kid`, `alg` or key cannot let an intermediary choose `unverifiable`:

- **`unverifiable`**: the paid origin's key list (or DID document) cannot be fetched and no kept key
  covers the `kid`, or the resolved key's algorithm is one the verifier does not implement.
- **`contradicted`**: the key list was fetched and does not contain `kid`, and no kept key holds it; or the signed `alg` differs
  from the key's algorithm, including an unknown string; or a `did:web` `kid` names a domain other
  than the `resourceUrl` domain; or the signature does not verify.

A missing `kid` is a contradiction, not a lookup failure, because an issuer signing under this
extension MUST keep every key it has signed with resolvable for the life of its receipts (Issuer
requirement 4); it cannot legitimately sign under a key missing from its own published list. A
verifier holding a cached list refetches once before
reporting a missing `kid`. Refetches MUST be coalesced per origin and SHOULD be gated by a minimum
freshness floor (RECOMMENDED: 60 seconds) with a conditional request (`If-None-Match`) where supported.
Inside the floor the cached list is the fresh read; a refetch that fails is `unverifiable`. Without
this bound, an intermediary injecting random `kid` values could force a key fetch per response. A
post-quantum signature (ML-DSA-65: 3,309 bytes) does not fit a header-carried `PAYMENT-RESPONSE` once
encoded; such receipts SHOULD travel in the body or as a detached receipt object, with the key by
`kid`.

**Kept keys (last-known-good).** A published binding never changes (Issuer requirement 4), so a
verifier MAY keep the keys it has resolved from an origin, first binding per `kid` winning, and keep
using them after the origin stops resolving. A kept key proves presence, never absence. While the
origin is unreachable, a `kid` the verifier holds is evaluated against the kept key; any other `kid`
stays `unverifiable`. A fetched binding that drops or rebinds a kept `kid` breaks Issuer requirement 4:
the kept key governs that `kid`, and the verifier MUST report the discontinuity, which shows that two
fetches disagree, not which one was honest. A result that rests on a kept key MUST be reported with the
time that key was last confirmed by a fetch. Kept keys are the
verifier's own state, built only from its own fetches from the paid origin. Without them, an origin
that stops resolving leaves its signed receipts `unverifiable`, and one that changes hands and
publishes different keys leaves them `contradicted`; re-deriving `responseHash` never
depended on the origin and keeps working.

None of this touches the hash: `responseHash`, the fixed point and the worked vector are unchanged.
The upstream specification implements these rules for its own signed payload as
`GVP-Attestation/3`, with outcome-vector sets covering the key-list, `kid` and `alg` cases above
(`vectors/attestation-outcomes.json`) and kept keys (`vectors/attestation-kept.json`).

---

## Issuer requirements

1. **Closure (normative).** An issuer MUST NOT emit a `responseHash` for a response whose `result`
   depends on any input not present in the fixed point. Cached model-derived answers, live-merge
   feeds, and routes with unenumerable sources MUST emit nothing rather than a hash that cannot be
   re-derived. Emitting no claim is the *compliant* output for such routes.
2. **`dataVintage` completeness (normative).** `dataVintage` MUST characterise **all** sources that
   contributed to `result`. Where contributing sources carry different vintages, the value MUST be
   the **oldest**, stated at its own precision. A seller who cannot enumerate the contributing
   sources MUST NOT emit a `responseHash` at all — an unenumerable source is a hidden input, and the
   closure rule already forbids issuing over one.
3. **No mode flags.** `responseHash` carries exactly one claim: re-derivable by anyone. An
   integrity-only claim for non-re-derivable content (e.g. "unaltered relative to what the issuer
   stored") is a different claim and MUST NOT be emitted under this field name.
4. **Keys stay resolvable (normative, signed carriage).** An issuer that signs the provenance members
   MUST keep every key it has signed with resolvable from the paid origin for the life of its receipts,
   including after rotation, and a `kid`, once published, MUST stay bound to the same key and
   algorithm. A binding that reflects only current keys (e.g. a `did:web` document that drops a
   rotated-out key) is not sufficient on its own. [Signed carriage](#signed-carriage) reports a
   `kid` missing from the published keys, and not kept, as `contradicted` and depends on this rule.

---

## Verification outcomes (normative)

Evaluating a response against this extension terminates in exactly one of **four** states.
Implementations MUST report which state obtained and MUST NOT collapse them:

1. **`verified`** — the member is present and the hash re-derives byte-for-byte. `verified` means
   *re-derives*, never *correct*.
2. **`no_claim`** — the extension member is absent. This is NOT a failure state and MUST NOT be
   scored as one: under the closure rule, absence is sometimes the *required* output. Treating
   absence as a defect pressures sellers of non-closed routes to emit hashes nobody can re-derive —
   manufacturing the false confidence this extension exists to remove.
3. **`unverifiable`** — the member is present but cannot be evaluated: unparseable, wrong shape, a
   `fixedPointVersion` the verifier does not implement, a `/2` `dataVintage` failing the grammar, a
   fixed point rejected under the canonicalization restrictions (non-finite numbers, duplicate
   member names, excessive depth), a body-less request whose query string is malformed under the
   [decode grammar](#request--inputs-mapping), or a `result` that cannot be recovered under the
   declared [`resultCarriage`](#resultcarriage--declaring-where-result-lives) (unrecognised value,
   `"member"` with no `result` member, `"body"` on a non-object body). Under
   [signed carriage](#signed-carriage), also: the paid origin's key list cannot be fetched and no kept
   key covers the `kid`, or the resolved key's algorithm is one the verifier does not implement.
4. **`contradicted`** — re-derivation ran and the hash does not match. This finding is a
   **three-branch disjunction**: *the artifact was altered, or it was issued in violation of the
   closure rule, or the verifier's own implementation is defective on this input.* Before reporting
   it, a verifier MUST have reproduced the published conformance vectors (including this file's
   worked vector) with its own implementation. Self-proof shrinks the third branch but cannot
   eliminate it — vectors do not cover every input — so reports SHOULD state vector coverage and
   SHOULD NOT attribute a branch they cannot see. Under [signed carriage](#signed-carriage), a
   signature that fails the key-first rules there is also `contradicted`; that finding is about the
   signature, not the re-derivation, and reports SHOULD say which.

What a relying application **does** with a terminal state — complete, withhold, reconcile, dispute —
is caller policy, owned above this extension. The extension's contract ends at naming the state
precisely.

### Verifier roles

- A **requesting verifier** (the buyer re-checking its own paid response) MUST recompute over the
  `inputs` it actually sent, never over a server echo.
- A **non-requesting verifier** (auditor, indexer, dispute desk) holds only recorded artifacts. It
  verifies over the inputs **as recorded**, and MUST disclose that in its scope limit (e.g. "the
  artifact and inputs as given to us; we did not observe the original request"). Recorded inputs
  bind the verdict to a *claimed* question, not a witnessed one — that residual is inherent to the
  role, not a defect in the verdict.

### Consumable external verdicts

Local re-verification is the trust model: the check is one JCS pass and one SHA-256 over bytes the
relying party already holds, fully offline. A third-party verifier's `verified`, consumed without
re-running, replaces that model with trust in the verifier. Negative verdicts (`contradicted`,
`unverifiable`) are safe to consume conservatively; a consumed `verified` is a deliberate trust
shift. A verifier that publishes verdicts for consumption by others MUST:

1. **Be vector-proven and versioned** — publish its reproduction of the conformance vectors; each
   verdict cites verifier version and vector-set version.
2. **Bind the artifact, not a description.** For member-present outcomes (`verified`,
   `unverifiable`, `contradicted`): the verdict embeds the exact `responseHash` and
   `fixedPointVersion` evaluated. For `no_claim`, where no hash exists to bind: the verdict embeds a
   SHA-256 over the JCS form of the evaluated response body together with the recorded request
   identity (`endpoint`, `inputs`), so the absence claim is still about one specific artifact.
3. **Be auditable by the mechanism it reports on** — verdict documents are signed under a pinned,
   published key and carry their own fixed point and `responseHash`.
4. **Use the bounded vocabulary** — the four outcomes above, with the disjunction and scope-limit
   duties of the `contradicted` state and the role disclosure of [Verifier roles](#verifier-roles).

---

## Companion encodings (informative)

- **`responseArtifactId` (DID).** The generative method `did:artifact` (OMA3; listed in the W3C DID
  Extensions registry — the method spec itself is an unofficial draft) canonicalizes JSON artifacts
  with the same RFC 8785 and hashes with SHA-256: the CIDv1 multihash inside such a DID carries the
  byte-identical digest, verified concretely in the proposal thread. A `responseArtifactId` MAY sit
  beside `responseHash` as an optional companion; because the method is generative, any party can
  mint it from the fixed point after the fact. It is an encoding of the same primitive, not a new
  one.
- **Byte-exact attestation.** JCS re-derivation binds the parsed JSON *value* across heterogeneous
  runtimes. Sellers who need wire-level attestation of the exact bytes served (raw binary, payloads
  with non-canonical number spellings) may emit a raw-byte signature alongside `responseHash` as a
  complementary — and different — claim. Where the served text equals the ES6 serialization of the
  parsed value, the two claims agree on the payload's formatting; their scopes remain distinct — a
  raw-byte signature binds the served body, while `responseHash` binds the five-member fixed point,
  including `endpoint` and `inputs`, which the body may not contain.

---

## Conformance

This file is self-sufficient for implementation: the fixed-point definition, member carriage,
request mapping, canonicalization restrictions, `/2` grammar, and a complete worked vector are
normative above. The upstream project
[golden-vector-provenance](https://github.com/SolomonisBlack/golden-vector-provenance) provides
additional conformance vectors, JSON Schema, JS + Python reference implementations, and a
byte-equivalence gate against an independent RFC 8785 implementation — pinned exactly:

- Release **v0.7.0**, tag commit `91c12c101a30a2cfa8eb756fc83fa20130677d88`; normative spec file
  `spec/gvp-0.2.md` at that commit, SHA-256
  `c48f3272ad2a39d15c70ec2eaa0f40fae20d4c0241ef4353943b2da133301551` (28,426 raw bytes as
  published, LF line endings — hash the blob as served, not a checkout that may have rewritten line
  endings).

On any divergence between that project and this file, **this file governs** for x402 purposes.

## Security considerations

- The hash binds the **question and the answer** (`endpoint` + `inputs` are required members), so
  *within a single issuer's namespace* a response cannot be replayed as the answer to a different
  question without changing the hash. `endpoint` is a path and does not bind the origin: identical
  path + inputs served by two different hosts re-derive identically. Cross-issuer identity is bound
  at the signature layer — the signed receipt names the issuer — not by the hash alone.
- The extension is payment-rail-agnostic and adds no network surface to re-derivation: it is
  offline, so there is no resolver, callback, or fetch to attack. The only fetch is under signed
  carriage: the signer's key list, from the origin the verifier paid, coalesced and floored as
  [Signed carriage](#signed-carriage) requires.
- A bare (unsigned) response's extension block can be stripped, or altered and **re-hashed** — a
  forger who changes `result` can recompute a consistent `responseHash`. The unaltered claim
  therefore holds only under signed carriage, with `fixedPointVersion` inside the signed payload
  (see [Signed carriage](#signed-carriage)).
- The hash proves nothing about correctness. Sellers remain able to compute wrong answers
  reproducibly; golden vectors and reproduction are the correctness mechanism, and consumers MUST
  NOT present `verified` as an accuracy claim.

## Status and prior art

Shaped by public review on [#3234](https://github.com/x402-foundation/x402/issues/3234) (opened
2026-08-09; reviewed through 2026-10-21). Adoption and implementation evidence — independent vector
reproductions, a production conformance consumer, sellers evaluating pending this text — is
maintained with dates and links in the PR body and the thread rather than in this file, where it
would rot. **Affiliation disclosure:** the live reference issuer (x402toll.com) and the upstream
conformance repository are operated by this extension's author.

Reviewer-driven normative rules in this text credit: **whawk46** (standalone-vs-receipt layering,
JCS cross-check; key-first dispatch and the bounded key-list refetch in Signed carriage),
**0xsims / TenPrint** (`alg` under the signature; the post-quantum carriage sizes), **giskard09** (anchored preimages; the never-collapse failure-mode discipline; the dead-origin
case behind kept keys),
**kopko13 / Sirenic** (`dataVintage` completeness — "a freshness field naming three of four sources
reads as complete"; the two-claims/no-flag resolution —
[sirenic-eu/sirenic-examples#2](https://github.com/sirenic-eu/sirenic-examples/issues/2)),
**cv-scvd / SCVD** (production verdict shape: finding-not-policy, the mismatch disjunction),
**0rkz / PayPerByte** (byte-exact attestation as a distinct complementary claim; the
implementability review that produced the carriage, request-mapping, I-JSON, four-state, role-split,
and authority rules in this revision), **alftom / OMA3** (`did:artifact` companion encoding),
**postdvk** (the terminal-states question the outcomes section answers).
