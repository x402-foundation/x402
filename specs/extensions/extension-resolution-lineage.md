
# Application-layer composition profile: `resolution-lineage`

## Summary

`resolution-lineage` is an optional application-layer composition profile for recording how independently verifiable evidence changes an operative conclusion over time.

This proposal adopts the executable semantics of **RLP-1 (Resolution Lineage Profile)** while leaving x402-native payment, delivery, settlement, verifier, and dispute semantics in their existing layers.

It does not define a new payment receipt, delivery proof, verifier verdict format, operation binding, settlement mechanism, dispute mechanism, anchoring mechanism, or reputation system.

The profile preserves four properties:

1. independently verifiable artifacts remain separately addressable and keep their native semantics;
2. the target, required checks, and evidence supporting each resolved check are explicit;
3. the operative resolution state is derived from those required checks rather than freely asserted; and
4. corrections append hash-linked successor records instead of mutating earlier conclusions.

## Scope

This profile operates above existing x402 evidence.

A resolution implementation MAY consume artifacts including:

- operation-bound evidence such as an `operationDigest`;
- signed Offer/Receipt artifacts;
- delivery-receipt artifacts;
- SAR or other independently verifiable verifier receipts;
- settlement evidence;
- CI, test, review, or application evidence defined elsewhere.

Those native artifacts remain authoritative for their own semantics.

A `resolution-lineage` implementation MUST NOT reinterpret a foreign artifact as valid without first verifying it according to that artifact's native verification rules.

A foreign artifact that proves only transport presence, settlement, artifact integrity, delivery, or verifier key control MUST NOT be promoted into a stronger claim merely because it is referenced by a resolution record.

## Non-goals

This profile does not define:

- native verifier verdict vocabularies (for example SAR `PASS`, `FAIL`, and `INDETERMINATE`); RLP-1 defines separate resolution-layer check outcomes `PASS`, `FAIL`, and `UNRESOLVED`, not native verifier verdicts;
- delivery success or failure semantics;
- settlement verification;
- request or response hashing;
- signer authorization;
- evidence anchoring;
- generic dispute submission or counter-evidence;
- verifier selection or trust policy;
- completeness of an evidence set;
- payment, reward, eligibility, or reputation.

## RLP-1 resolution record

A resolution record is a signed object of kind `resolution-state` whose payload has the following logical shape:

```json
{
  "subject": "x402:operation:sha256:...",
  "original_target": "the paid operation satisfied requirement R",
  "effective_target": "the paid operation satisfied the narrower requirement R1",
  "evidence": {
    "sar-a": {
      "kind": "sar/0.1",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "uri": null
    },
    "review": {
      "kind": "review",
      "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "uri": null
    }
  },
  "checks": [
    {
      "id": "native-verification",
      "requirement": "the accepted verifier artifact verifies under its native format",
      "required": true,
      "outcome": "PASS",
      "evidence": ["sar-a"]
    },
    {
      "id": "scope",
      "requirement": "the accepted evidence supports only the narrower effective target",
      "required": true,
      "outcome": "PASS",
      "evidence": ["review"]
    }
  ],
  "state": "NARROWED",
  "previous": "sha256:...",
  "revision_reason": "new evidence preserved the result but narrowed its scope"
}
```

The signed envelope identifies the resolver that made the resolution claim. This profile does not infer that the resolver had institutional, legal, or economic authority; consumers decide which resolver identities or external authorities they trust.

### Signed envelope and deterministic bytes

The pinned RLP-1 reference uses a domain-separated **Ed25519 signed JSON object**. It does not use JWS, COSE, or EIP-712. The envelope MUST contain exactly `kind`, `payload`, `protocol`, `signature`, and `signer`:

- `kind` MUST equal `resolution-state`.
- `protocol` MUST equal `resolution-receipt/0.1`.
- `signer` MUST be an Ed25519 `did:key` whose public key verifies the signature.
- `signature` MUST be the unpadded base64url representation of the 64-byte Ed25519 signature.
- `payload` MUST satisfy the RLP-1 payload requirements in this document.

The signed message is exactly:

```python
b"resolution-receipt/signed-object/v1\n" + b"resolution-state\n" + canonical_json_bytes(payload)
```

`canonical_json_bytes(value)` is UTF-8 encoding of JSON with lexicographically sorted object keys, compact separators (`,` and `:`), `ensure_ascii=False`, and no whitespace outside strings. It MUST reject duplicate JSON keys, floating-point or nonfinite numbers, integers outside the interoperable range `[-9007199254740991, 9007199254740991]`, invalid Unicode surrogates, and non-JSON values. No Unicode normalization is performed. Strings are compared exactly and case-sensitively.

`sha256:<64 lowercase hex>` denotes SHA-256 of the specified bytes. The `previous` field binds `canonical_json_bytes(prior_signed_envelope)`, including its `kind`, `payload`, `protocol`, `signature`, and `signer` fields. It does NOT hash raw transport bytes or a reserialized foreign artifact.

A verifier MUST validate the envelope, the evidence descriptors, and every check before deriving `state`; unknown check outcomes or checks that cite undefined evidence identifiers MUST invalidate the record. Declared evidence objects not referenced by any check MAY remain present, but do not contribute to the resolution state.

## Evidence objects

Evidence is protocol-neutral:

```json
{
  "kind": "sar/0.1 | delivery-receipt | x402-receipt | ci-run | test-output | review | other",
  "digest": "sha256:<64 lowercase hex>",
  "uri": "optional locator"
}
```

The digest identifies the exact bytes or canonical foreign object selected by the evidence producer. The producer MUST identify the chosen representation according to the foreign artifact's native format. A digest match alone does not prove that the underlying artifact is valid or that the selected representation is authoritative.

Implementations MUST NOT silently reserialize another protocol and then treat the new bytes as the original artifact.

A resolved (`PASS` or `FAIL`) check MUST cite at least one named evidence object.

An `UNRESOLVED` check MAY cite no evidence when missing evidence is the reason resolution cannot be collapsed.

## State is derived, not freely chosen

Only required checks determine the resolution state. Every valid record MUST contain at least one check with `required: true`. A record with no required checks (including one containing only optional checks) MUST be rejected; it MUST NOT derive `SURVIVED`.

| Required-check condition | Derived state |
| --- | --- |
| at least one required `FAIL` | `FAILED` |
| otherwise, at least one required `UNRESOLVED` | `UNRESOLVED` |
| all required checks `PASS`, and `effective_target` differs by exact string equality from `original_target` | `NARROWED` |
| all required checks `PASS`, and `effective_target` exactly equals `original_target` | `SURVIVED` |

A verifier MUST recompute the state from the required checks.

A signed object declaring `SURVIVED` while a required check is `FAIL` or `UNRESOLVED` is invalid under this profile even if the signature itself is valid.

### `SURVIVED`

All required checks MUST have outcome `PASS`, and `effective_target` MUST exactly equal `original_target` using case-sensitive string equality without normalization. These conditions derive `SURVIVED`.

`SURVIVED` is not equivalent to a native verifier `PASS`. It describes the resolution state after the accepted evidence and required checks are evaluated.

### `UNRESOLVED`

No required check has failed, but at least one required check remains unresolved.

Conflicting independently verifiable artifacts are one possible cause. Missing evidence is another.

The underlying artifacts MUST remain separately addressable. The resolution layer MUST NOT replace them with only a synthetic conflict verdict.

### `NARROWED`

All required checks MUST have outcome `PASS`, and `effective_target` MUST differ from `original_target` by exact, case-sensitive string equality. These structural conditions derive `NARROWED`. Mere string inequality does not prove semantic narrowing; the applicable required checks and their evidence must substantiate any assertion that the effective target is narrower.

The original target remains in the record so the narrower successor does not rewrite what was previously claimed.

### `FAILED`

At least one required check fails.

`FAILED` describes the resolution state of the target. It does not alter the verdict or semantics contained in any underlying native artifact.

## Disagreement

Two verifier artifacts constitute disagreement for this profile only when:

1. both artifacts verify successfully under their native formats;
2. they address the same subject;
3. they are attributable to distinct verifier identities under those native formats; and
4. their native conclusions materially conflict.

The resolution layer MUST NOT manufacture independence merely because two artifact objects exist.

A disagreement does not automatically imply `UNRESOLVED`; the required-check policy determines whether the conflict leaves a required check unresolved, narrows the target, or establishes failure.

## Append-only correction

The first record MUST contain both `previous: null` and `revision_reason: null`; neither field may be omitted.

Every later record MUST contain:

- `previous`: the SHA-256 of the canonical JSON bytes of the complete prior signed resolution envelope, as defined above; and
- a non-empty `revision_reason`.

A lineage verifier MUST reject a supplied history if:

- a prior signed record was rewritten;
- a `previous` link points at the wrong hash;
- the `subject` changes; or
- the `original_target` changes.

The `effective_target` MAY change. This is how a broad claim can become `NARROWED` without rewriting the original claim.

A later record MAY become `FAILED` or `UNRESOLVED` after an earlier `SURVIVED` or `NARROWED` state. New evidence is allowed to overturn an earlier conclusion; the earlier record remains inspectable history.

## Example lineage

Given a subject `S` and a native verifier artifact that passes its own verification rules:

```text
required checks all PASS; target unchanged
  -> SURVIVED
```

If later independently verifiable evidence creates an unresolved required conflict:

```text
previous: hash(SURVIVED record)
required conflict check: UNRESOLVED
  -> UNRESOLVED
```

If later evidence supports only a narrower target `S'`:

```text
previous: hash(UNRESOLVED record)
all required checks PASS
effective_target = S'
  -> NARROWED
```

The earlier `SURVIVED` and `UNRESOLVED` records remain addressable and unmodified.

## Relationship to existing x402 work

This profile is intended to compose with, rather than replace:

- Offer/Receipt;
- operation binding discussed in #1921;
- Settlement Attestation Receipt (SAR) in #1195;
- delivery-receipt work in #2833;
- correctness/dispute work in #2887.

The profile deliberately leaves payment, delivery, verifier, and dispute semantics in those respective layers.

Its only concern is the bounded resolution claim drawn above those evidence artifacts and the append-only lineage of how that claim changes.

## Reference implementations

Pinned public RLP-1 semantics, schema, signing helpers, and lineage tests:

https://github.com/chugarchugarr/x402/tree/befa52c7e3f18c8e5c5a3b7df4ad6f6a293adbc6/rlp1-reference

The RLP-1 implementation provides deterministic state derivation, signed `resolution-state` objects, hash-linked lineage verification, evidence-reference enforcement, and tests covering all four states plus history-rewrite rejection.

The reference fixtures use independent test keys. They are not production x402 verifier or resolver identities.

## Security considerations

A valid RLP-1 record proves only bounded structural properties:

- the signed object was not modified;
- the signer controlled the signing key;
- every resolved required check cites named evidence;
- the declared state follows from the declared required-check outcomes; and
- a supplied lineage is append-only and hash-linked.

It does not prove:

- that a check outcome was stated truthfully;
- that the resolver had authority to decide;
- that the evidence set is complete;
- real-world identity;
- uniqueness or Sybil resistance;
- usefulness, payment, rewards, eligibility, or reputation;
- that a URI will remain available;
- that a foreign evidence format means more than that format itself claims.

A resolver can omit evidence unless an external completeness mechanism prevents or exposes omission.

Distinct signatures do not automatically establish institutional or economic independence. Independence must be established through native verifier identities and the trust policy applied by the consumer.

Append-only lineage preserves the history of conclusions. It does not make those conclusions objectively correct.
