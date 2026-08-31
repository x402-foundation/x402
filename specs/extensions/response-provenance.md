# Extension: `response-provenance`

## Summary

The `response-provenance` extension lets a paid response carry a hash that **anyone can re-derive
offline** — upgrading "you paid for this URL" into "and here is proof of what came back." A resource
server attaches `responseHash = sha256(jcs(fixedPoint))`, a SHA-256 over the RFC 8785 (JCS) canonical
form of the closed fixed point `{endpoint, inputs, result, method, dataVintage}`. A buyer, auditor,
or indexer re-derives it with any off-the-shelf JCS library: no key exchange, no callback to the
issuer, no resolver, no trust in any party.

The extension proves the response is **unaltered and reproducible**. It deliberately does **not**
prove the response is *correct* — correctness is established only by reproduction against published
golden vectors. Keeping those two claims separate is the design's load-bearing rule.

Proposed and reviewed in [issue #3234](https://github.com/x402-foundation/x402/issues/3234). At the
time of this PR the shape has three independent implementations reproducing the published
conformance vectors byte-for-byte, one production conformance desk consuming it, and two additional
sellers evaluating adoption pending this text — PayPerByte
([in-thread](https://github.com/x402-foundation/x402/issues/3234)) and Sirenic
([sirenic-eu/sirenic-examples#2](https://github.com/sirenic-eu/sirenic-examples/issues/2)). See
[Status](#status-and-prior-art).

---

## Motivation

A settlement receipt binds `resourceUrl`, `payer`, `network`, and `txHash` — it proves payment
settled, not what the server returned. Today sellers fill that gap with incompatible private
spellings (`record_hash`, `verdict_hash`, EIP-712 body attestations, "SHA-256 fingerprint" prose): a
survey of listed x402 services found more than a dozen distinct response-hash dialects, none
mutually verifiable. One shared, re-derivable field lets every relying party check every seller
identically — and lets the evidence outlive the seller, since verification requires nothing from
them.

---

## The fixed point

The hashed object is exactly five members — a **closed set**, `GVP-FixedPoint/1`:

| Member | Meaning |
|---|---|
| `endpoint` | the resource path the buyer called (binds the *question*, not just the answer) |
| `inputs` | the request inputs, as the buyer sent them |
| `result` | the substantive answer object |
| `method` | human-readable statement of the computation performed |
| `dataVintage` | the vintage of the data the result was computed from |

All five members are REQUIRED and no other member is permitted in the hashed object. A verifier
always recomputes over the five spec members, so an issuer cannot shrink the fixed point (e.g. drop
`inputs`) and remain internally consistent. Verifiers use the `inputs` from **their own request**,
never a server echo.

`fixedPointVersion` names the frozen rule set and travels **beside** the hash, never inside it.
`GVP-FixedPoint/1` will never change; a different member set would be a new identifier.
`GVP-FixedPoint/2` has the same five members and identical hashing; it additionally constrains the
`dataVintage` lexical grammar to ISO 8601 reduced precision so vintages are machine-comparable.

### Canonicalization

Canonical JSON **is [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785)**. This extension
defines no bespoke serialization. Implementations use any verified JCS library (RFC 8785 Appendix G
lists several). Three additional restrictions apply: non-finite numbers (NaN, ±Infinity) MUST be
rejected, object member names MUST be unique, and nesting depth SHOULD be bounded (reference
implementations reject depth > 100).

---

## Envelope

On a paid response body:

```json
{
  "extensions": {
    "response-provenance": {
      "responseHash": "sha256:33907ce0528475a75e5ab406f00cd1a1e612a762263ca98c1b7597f4fe2a6d49",
      "fixedPointVersion": "GVP-FixedPoint/1",
      "spec": "https://github.com/SolomonisBlack/golden-vector-provenance"
    }
  }
}
```

- `responseHash` (REQUIRED): `"sha256:" + lowercase-hex` SHA-256 of the JCS bytes of the fixed point.
- `fixedPointVersion` (REQUIRED): `"GVP-FixedPoint/1"` or `"GVP-FixedPoint/2"`.
- `spec` (OPTIONAL): URL of the fixed-point specification.

When the seller also emits a signed receipt (e.g. the `offer-and-receipt` extension), the
`responseHash` member SHOULD be carried inside the signed payload, binding content proof to payment
proof under one signature. The identifier and any envelope of the hash sit **beside** the hashed
object, never inside it — including the hash (or any identifier derived from it) inside the hashed
octets is a self-reference cycle and is prohibited.

Because the hash is computed over the canonical form of the parsed JSON value, transport-layer
transformations (gzip, brotli, chunking, insignificant whitespace) do not affect it. The party that
**produces the result** computes the hash; an intermediary that did not produce the bytes cannot
honestly attest them.

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

Evaluating a response against this extension terminates in exactly one of three states.
Implementations MUST report which state obtained and MUST NOT collapse them:

1. **`no_claim`** — the extension member is absent. This is NOT a failure state and MUST NOT be
   scored as one: under the closure rule, absence is sometimes the *required* output. Treating
   absence as a defect pressures sellers of non-closed routes to emit hashes nobody can re-derive —
   manufacturing the false confidence this extension exists to remove.
2. **`unverifiable`** — the member is present but cannot be evaluated: unparseable, wrong shape, or
   a `fixedPointVersion` the verifier does not implement.
3. **`contradicted`** — re-derivation ran and the hash does not match. Before reporting this state a
   verifier MUST have reproduced the published conformance vectors with its own implementation — a
   mismatch report from a canonicalizer that cannot reproduce the golden vectors is noise, and the
   most common cause of a mismatch in practice is a verifier-side bug, not tampering. A
   `contradicted` finding is a disjunction — *the artifact was altered, or it was issued in
   violation of the closure rule* — and reports SHOULD NOT attribute a branch they cannot see.

(`verified` — the hash re-derives — is the fourth outcome; it means *re-derives*, never *correct*.)

What a relying application **does** with a terminal state — complete, withhold, reconcile, dispute —
is caller policy, owned above this extension. The extension's contract ends at naming the state
precisely.

### Consumable external verdicts

Local re-verification is the trust model: the check is one JCS pass and one SHA-256 over bytes the
relying party already holds, fully offline. A third-party verifier's `verified`, consumed without
re-running, replaces that model with trust in the verifier. Negative verdicts (`contradicted`,
`unverifiable`) are safe to consume conservatively; a consumed `verified` is a deliberate trust
shift. A verifier that publishes verdicts for consumption by others MUST:

1. **Be vector-proven and versioned** — publish its reproduction of the conformance vectors; each
   verdict cites verifier version and vector-set version.
2. **Bind the artifact, not a description** — each verdict embeds the exact `responseHash` and
   `fixedPointVersion` evaluated.
3. **Be auditable by the mechanism it reports on** — verdict documents are signed under a pinned,
   published key and carry their own fixed point and `responseHash`.
4. **Use the bounded vocabulary** — the four outcomes above, with `verified` meaning re-derives and
   `contradicted` stated as the disjunction with an explicit falsification path and scope limit
   (e.g. "the artifact as given to us; we did not fetch it from the issuer origin").

---

## Companion encodings (informative)

- **`responseArtifactId` (DID).** The W3C-registered generative method `did:artifact` (OMA3)
  canonicalizes JSON artifacts with the same RFC 8785 and hashes with SHA-256: the CIDv1 multihash
  inside such a DID carries the byte-identical digest, verified concretely in the proposal thread.
  A `responseArtifactId` MAY sit beside `responseHash` as an optional companion; because the method
  is generative, any party can mint it from the fixed point after the fact. It is an encoding of the
  same primitive, not a new one.
- **Byte-exact attestation.** JCS re-derivation binds the parsed JSON *value* across heterogeneous
  runtimes. Sellers who need wire-level attestation of the exact bytes served (raw binary, payloads
  with non-canonical number spellings) may emit a raw-byte signature alongside `responseHash` as a
  complementary — and different — claim. Migrating sellers should know which claim they are making;
  where the served text equals the ES6 serialization of the parsed value, the two coincide.

---

## Conformance

The fixed-point specification, JSON Schema, JS + Python reference implementations, published
conformance vectors, and a byte-equivalence gate against an independent RFC 8785 implementation are
maintained at [golden-vector-provenance](https://github.com/SolomonisBlack/golden-vector-provenance)
(spec CC-BY-4.0, code Apache-2.0), pinned releases from
[`v0.7.0`](https://github.com/SolomonisBlack/golden-vector-provenance/releases/tag/v0.7.0). An
implementation conforms when it reproduces the published vectors byte-for-byte.

## Security considerations

- The hash binds the **question and the answer** (`endpoint` + `inputs` are required members), so a
  response cannot be replayed as the answer to a different question without changing the hash.
- The extension is payment-rail-agnostic and adds no network surface at verify time: re-derivation
  is offline, so there is no resolver, callback, or fetch to attack.
- A bare (unsigned) response's extension block can be stripped or forged in transit; binding it
  inside a signed receipt (see [Envelope](#envelope)) makes stripping or forging fail the signature.
- The hash proves nothing about correctness. Sellers remain able to compute wrong answers
  reproducibly; golden vectors and reproduction are the correctness mechanism, and consumers MUST
  NOT present `verified` as an accuracy claim.

## Status and prior art

Shaped by five rounds of public review on
[#3234](https://github.com/x402-foundation/x402/issues/3234). Independent implementations
reproducing the published vectors with their own code:
[whawk46/x402-jcs-crosscheck](https://github.com/whawk46/x402-jcs-crosscheck) (24/24),
[giskard09/argentum-core](https://github.com/giskard09/argentum-core) (7 preimages, one anchored on
Base mainnet before it was checked), and the [SCVD conformance desk](https://scvd.store) — an
independent evidence observatory whose production `/api/conformance/v1` surface consumes this
extension today. Live issuer: [x402toll.com](https://x402toll.com) (59 endpoints; free re-check at
`POST /v1/verify-hash`; free golden vectors at `GET /v1/golden/:id`).

Reviewer-driven normative rules in this text credit: **whawk46** (standalone-vs-receipt layering,
JCS cross-check), **giskard09** (anchored preimages; the never-collapse failure-mode discipline),
**kopko13 / Sirenic** (`dataVintage` completeness — "a freshness field naming three of four sources
reads as complete"; the two-claims/no-flag resolution; adoption-pending-this-text stated in
[sirenic-eu/sirenic-examples#2](https://github.com/sirenic-eu/sirenic-examples/issues/2)), **cv-scvd / SCVD** (production verdict
shape: finding-not-policy, the mismatch disjunction), **0rkz / PayPerByte** (byte-exact attestation
as a distinct complementary claim), **alftom / OMA3** (`did:artifact` companion encoding),
**postdvk** (the terminal-states question this text's outcomes section answers).
