# Composite trust-query (normative, shared)

> **Status**: v0 — drafted by Vauban Pay, tabled for coalition co-sign-off
> (AlgoVoi + nobulex + risk-check spec track).
>
> Extensions producing or consuming a multi-emitter evidence envelope MUST
> cite this section by version. Current version: `composite-trust-query-v0`.
>
> This section depends on the shared canonicalisation discipline
> (`specs/canonicalisation.md`, `jcs-rfc8785-v1`, PR #2436). All digests
> below are derived under that discipline.

A composite trust-query is the response shape for a query keyed on a payment
event. One query against a `(payment_hash, action_ref)` anchor returns an
ordered set of emitter rows, each from a distinct emitter surface, each
independently signed, each declaring its own evidence class and framework.

The composite envelope is the assembly-and-binding layer. It does not produce
evidence; it assembles evidence rows that other extensions produce
(payment receipts, work-receipt bindings, compliance attestations,
hybrid-PQC receipt cores) and binds them to a single auditable anchor.

## Envelope structure

```
CompositeTrustQuery {
  composite_schema : "axis4-composite-trust-query-v0"   // pinned
  canon_version    : "jcs-rfc8785-v1"                   // per specs/canonicalisation.md
  anchor           : Anchor
  emitter_rows     : EmitterRow[]                       // 1 or more
  composite_hash   : "sha256:" <64 lowercase hex>       // derived, see below
}

Anchor {
  payment_hash : "sha256:" <64 lowercase hex>           // the settled payment
  action_ref   : <64 lowercase hex>                     // 32-byte work-receipt digest
}

EmitterRow {
  source_id      : string         // "<emitter-surface>", the sort key; see below
  evidence_type  : "behavioral" | "cryptographic" | "observational" | "regulatory"
  framework      : string[]       // declared frameworks, MAY be empty
  anchor         : Anchor         // MUST equal the envelope anchor
  verdict        : string         // evidence-class verdict (ALLOW/DENY/REFER/...)
  evidence_ref   : string         // resolvable pointer to the underlying attestation
  sig            : string         // per-row signature; EXCLUDED from the composite preimage
}
```

## Emitter rows

Each row is independently verifiable. The emitter identity, evidence type,
declared framework, and signed receipt are per-row. A composite policy
evaluator MAY apply a strict strategy (any FAIL aborts) or a weighted strategy
(per-row override) at the hook layer; the envelope itself is policy-neutral.

`source_id` identifies an emitter SURFACE, not an organisation. One
organisation MAY operate multiple emitter surfaces (for example a behavioral
reputation accumulator and a point-in-time compliance screen are distinct
surfaces with distinct `source_id` values). `source_id` values SHOULD use the
form `<org>.<surface>` and MUST be stable across revisions of the emitting
service. `source_id` is the canonical sort key (see Composite preimage).

For `evidence_type: behavioral`, the structural rule
`anchor_chains ⊆ contributing_chains` is REQUIRED: a behavioral emitter MUST
NOT anchor receipts on a chain it has not observed. For `evidence_type:
cryptographic`, `regulatory`, or `observational`, the anchor chain is an
independent infrastructure choice and the subset rule does not apply.

## Anchor binding

Every emitter row MUST carry an `anchor` field equal, field-for-field, to the
envelope `anchor`. A verifier MUST reject any envelope in which a row's
`anchor` differs from the envelope `anchor`; a divergent row anchor means the
row attests about a different payment event and MUST NOT be assembled into
this composite.

The `(payment_hash, action_ref)` pair is the join key that makes the composite
meaningful. It binds every row to the same payment event. A supervisor
re-verifying at year 5 confirms every retained row resolves to one anchor.
Mutating one byte of `action_ref` breaks every row independently: a STARK
receipt fails verification, a compliance attestation index keys on the wrong
`action_ref`, and a signature over the row preimage no longer verifies. N
independent emitters, one shared anchor, zero shared trust.

## Composite preimage

The `composite_hash` is derived as follows. The algorithm is the contribution
of AlgoVoi (x402 issue #2322).

1. For each row, construct `row_preimage` by removing the `sig` field. Per-row
   signatures are verification metadata, not content; the composite digest
   signs the SET OF ROWS, not the set of signatures.
2. Sort the `row_preimage` objects by their `source_id` value, lexicographic
   byte order, ascending.
3. Construct the preimage array: `[sorted row_preimage objects]`.
4. `composite_hash = "sha256:" + lowercase_hex( SHA-256( JCS( preimage_array ) ) )`.

JCS canonicalisation is applied per `specs/canonicalisation.md`. The array of
rows is canonicalised as a whole; JCS preserves array element order, so the
sort in step 2 is the normative ordering and MUST be applied before
canonicalisation.

## Row ordering is set semantics

Emitter rows are a SET, not a transmission sequence. The contribution of
nobulex (x402 issue #2322): two envelopes carrying the same rows in a
different `emitter_rows` array order produce the SAME `composite_hash`, because
the preimage algorithm sorts by `source_id` before canonicalisation. The
conformance fixture demonstrates this with a row-rotation pair (vectors
`0001` and `0002`) that share one `composite_hash`.

A verifier MUST NOT treat `emitter_rows` transmission order as significant.
A verifier MUST recompute the sort independently before checking
`composite_hash`.

## Partial response and absent rows

A composite query MAY return fewer rows than the emitter set declared for a
payment event. The contribution of nobulex (x402 issue #2322): an absent row
is simply NOT PRESENT in `emitter_rows`. A producer MUST NOT emit a
null-placeholder row for an emitter that has not produced evidence.

`composite_hash` is computed over the rows that ARE present. The
`(payment_hash, action_ref)` anchor binds the partial composite cleanly: a
two-row composite is as well-anchored as a three-row composite.

A composite policy evaluator receiving a partial response MUST classify each
declared-but-absent emitter as `PENDING` or `UNKNOWN` at the evaluator layer.
It MUST NOT fail the query solely because a row is absent; absence and a
negative verdict are distinct facts and the evaluator policy decides their
weight.

## Session-scoped amortisation

Where an emitter surface incurs a per-screen or per-attestation cost
(for example an AML/sanctions screen), the protocol RECOMMENDS session-scope
as the default amortisation unit. One screen covering a payer session worth N
micropayments is emitted once and referenced by every payment in that session;
the composite for each payment cites the same session-scoped
`evidence_ref`. Per-call amortisation is NOT the default; it destroys
micropayment unit economics without improving screening depth.

## Versioning

This section is versioned independently of the core x402 specification and of
`specs/canonicalisation.md`. A revision that changes any normative rule above
MUST increment the `composite_schema` version suffix. Downstream extensions
referencing this section MUST cite a specific version. The current version is
`composite-trust-query-v0`.

## Conformance vectors

Conformance vectors are published in `fixtures/composite-trust-query/v0/` in
this repository:

| Vector | Rows | Demonstrates |
|---|---|---|
| `0001-tri-full` | 3 | Full three-row composite; canonical `composite_hash` |
| `0002-tri-rotated` | 3 | Same rows, rotated transmission order; identical `composite_hash` (set semantics) |
| `0003-partial-absent-row` | 2 | Cryptographic row absent; anchor still binds the partial composite |

The three emitter surfaces exercised by the v0 vectors:

| `source_id` | `evidence_type` | Underlying fixture |
|---|---|---|
| `algovoi.compliance-screening` | regulatory | `fixtures/risk-check-attestation-sample/v0/` (PR #2434) |
| `nobulex.verascore-evidence-schema-v0.1` | observational | nobulex `fixtures/bilateral-receipt/v0/` |
| `vauban.stark-proof-of-payment-conditions` | cryptographic | `fixtures/bounded-spend-authorization-sample/v0/` (PR #2432) |

The AlgoVoi compliance screen is a single emitter surface. The
`/compliance/screen` endpoint and the risk-check attestation are one
production service and its receipt format, not two emitters; the composite is
tri-party. A sanctions and AML compliance screen is `regulatory` evidence: its
frameworks are statute (`UK MLR 2017`, `UK POCA 2002 s.330`) and sanctions
regimes (`OFSI`, `OFAC`, `EU/UN`). It is NOT `behavioral`; the
`anchor_chains ⊆ contributing_chains` rule does not apply to a screen that
checks a payer identity against sanctions lists rather than observing chains.

`composite_hash` values are reproducible with any RFC 8785 implementation
listed in `specs/canonicalisation.md`.

## Cross-protocol applicability

The composite envelope is protocol-neutral above the canonicalisation layer.
The same envelope assembles x402 payment receipts, AP2 mandate receipts, and
work-receipt bindings, provided each row cites the shared canonicalisation
discipline and carries a conforming `anchor`.

## URI

Extensions referencing this section SHOULD use the stable URI:

```
urn:x402:composite-trust-query:v0
```

## IETF track

The composite trust-query and its anchor binding are documented in the
Internet-Draft `draft-vauban-x402-stark-receipts-00`
(https://datatracker.ietf.org/doc/draft-vauban-x402-stark-receipts/), an
Independent Submission posted 2026-05-21. The I-D `action_ref` work-receipt
binding field is the same 32-byte digest used in the `Anchor` above.

---

*Section drafted by Vauban Pay (@seritalien). Composite preimage algorithm
(source-id lexicographic sort, per-row `sig` exclusion) contributed by AlgoVoi
(@chopmob-cloud). Set-semantics row ordering and absent-row partial-response
semantics contributed by nobulex (@arian-gogani). Pull requests to revise any
normative rule, bump the version, or extend the conformance set MUST tag all
three contributors plus the risk-check spec track (@AlexanderLawson17).*
