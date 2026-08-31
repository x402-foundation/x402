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

### Member carriage — where a verifier finds each member

An issuer emitting this extension MUST make every fixed-point member recoverable as follows:

| Member | Carriage |
|---|---|
| `endpoint` | the request path as served (path only; see [Security considerations](#security-considerations) for issuer scoping) — also RECOMMENDED as a top-level response-body member `endpoint` |
| `inputs` | derived from the request per the [request mapping](#request--inputs-mapping) |
| `result` | REQUIRED top-level response-body member `result` |
| `method` | REQUIRED member `method` of the extension object |
| `dataVintage` | REQUIRED member `dataVintage` of the extension object |

Carrying `method` and `dataVintage` in the extension object (beside the hash, not inside the hashed
octets) is permitted and required precisely because the self-reference prohibition covers only the
hash and values derived from it — hashed members restated outside the hashed object are inputs to
re-derivation, not cycles.

### Request → `inputs` mapping

Two honest implementations must not disagree on what `inputs` is. The normative default mapping:

- **Request with a JSON body** (typically POST/PUT): `inputs` is the parsed JSON body, as a JSON
  value. The body MUST be [I-JSON](https://www.rfc-editor.org/rfc/rfc7493) (see
  [Numbers](#numbers-i-json)).
- **Request without a body** (typically GET): `inputs` is a JSON object built from the URL query
  string: each key and value percent-decoded as UTF-8; **values remain strings** (`"42"`, never
  `42` — no type coercion); a key occurring more than once maps to an array of its values in order
  of appearance; key order is irrelevant (JCS sorts). An empty query yields `{}`.

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
- `spec` (OPTIONAL): URL of the upstream fixed-point specification (informative; this file governs).

Because the hash is computed over the canonical form of the parsed JSON value, transport-layer
transformations (gzip, brotli, chunking, insignificant whitespace) do not affect it. The party that
**produces the result** computes the hash; an intermediary that did not produce the bytes cannot
honestly attest them.

### Signed carriage

When the seller also emits a signed receipt (e.g. the `offer-and-receipt` extension), the signed
payload SHOULD include **both** `responseHash` **and** `fixedPointVersion`. Signing only the hash
leaves the version rewritable: an intermediary that alters `result` could also rewrite
`fixedPointVersion` to an unimplemented value, steering the verification outcome from `contradicted`
to `unverifiable` — choosing which negative state its tampering produces.

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
   `fixedPointVersion` the verifier does not implement, a `/2` `dataVintage` failing the grammar, or
   a fixed point rejected under the canonicalization restrictions (non-finite numbers, duplicate
   member names, excessive depth).
4. **`contradicted`** — re-derivation ran and the hash does not match. This finding is a
   **three-branch disjunction**: *the artifact was altered, or it was issued in violation of the
   closure rule, or the verifier's own implementation is defective on this input.* Before reporting
   it, a verifier MUST have reproduced the published conformance vectors (including this file's
   worked vector) with its own implementation. Self-proof shrinks the third branch but cannot
   eliminate it — vectors do not cover every input — so reports SHOULD state vector coverage and
   SHOULD NOT attribute a branch they cannot see.

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
- The extension is payment-rail-agnostic and adds no network surface at verify time: re-derivation
  is offline, so there is no resolver, callback, or fetch to attack.
- A bare (unsigned) response's extension block can be stripped, or altered and **re-hashed** — a
  forger who changes `result` can recompute a consistent `responseHash`. The unaltered claim
  therefore holds only under signed carriage, with `fixedPointVersion` inside the signed payload
  (see [Signed carriage](#signed-carriage)).
- The hash proves nothing about correctness. Sellers remain able to compute wrong answers
  reproducibly; golden vectors and reproduction are the correctness mechanism, and consumers MUST
  NOT present `verified` as an accuracy claim.

## Status and prior art

Shaped by public review on [#3234](https://github.com/x402-foundation/x402/issues/3234) (opened
2026-08-09; reviewed through 2026-08-31). Adoption and implementation evidence — independent vector
reproductions, a production conformance consumer, sellers evaluating pending this text — is
maintained with dates and links in the PR body and the thread rather than in this file, where it
would rot. **Affiliation disclosure:** the live reference issuer (x402toll.com) and the upstream
conformance repository are operated by this extension's author.

Reviewer-driven normative rules in this text credit: **whawk46** (standalone-vs-receipt layering,
JCS cross-check), **giskard09** (anchored preimages; the never-collapse failure-mode discipline),
**kopko13 / Sirenic** (`dataVintage` completeness — "a freshness field naming three of four sources
reads as complete"; the two-claims/no-flag resolution —
[sirenic-eu/sirenic-examples#2](https://github.com/sirenic-eu/sirenic-examples/issues/2)),
**cv-scvd / SCVD** (production verdict shape: finding-not-policy, the mismatch disjunction),
**0rkz / PayPerByte** (byte-exact attestation as a distinct complementary claim; the
implementability review that produced the carriage, request-mapping, I-JSON, four-state, role-split,
and authority rules in this revision), **alftom / OMA3** (`did:artifact` companion encoding),
**postdvk** (the terminal-states question the outcomes section answers).
