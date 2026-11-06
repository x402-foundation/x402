# Recovery Extension

**1. Overview**

The Recovery Extension adds two guarantees to x402 that today live only in the imagination of
caller-side retry logic:

1. **Evidence bundle**: every paid response carries re-checkable hashes — of the canonical
   request and of the response body under a declared *projection* (a fixed set of keys that
   MUST be excluded before hashing).
2. **Settled-response recovery**: if a caller paid and the response was lost in transport,
   a retry with the same idempotency key returns the SAME verdict, free of a second charge —
   and the extension mandates the safety property that makes this honest:

   > **Replayable recovery records MUST be gated on confirmed settlement.** A failed, aborted,
   > or pending settlement MUST never leave a replayable free result (fail-closed).

This extension supports downstream use cases including:

- elimination of double-charges for network-loss retries (the common agent failure mode),
- auditors recomputing exactly what the service claims, without trusting its word,
- dispute evidence: the hashes bind an answer to a request and a block, on or off chain.

The artifacts are **x402 version-agnostic**: they are plain JSON in the settlement response
body (v1 pattern) or placed in `extensions` (v2 pattern); the header used for the key is
declarable. No new cryptography is introduced — the extension standardizes behavior that a
responsible service must implement anyway, so callers can *detect* its presence instead of
guessing.

**2. Status, Evolution, and Forward Compatibility**

This extension is specified as an optional, composable addition to x402. It introduces no
new transport fields inside `accepts[]` payment terms and does not alter settlement itself.

- **Wire shape and field placement are not considered stable** and may change to align with
  x402 canonical extension architecture.
- **Behavioral requirements are stable**: the projection recipe, the settlement-gating rule,
  the replay semantics, and the tombstone signal in this document are normative.

**3. Extension Declaration**

A server that implements this extension declares it in the `extensions` field of the
payment requirements response:

```
extensions["recovery"].info
```

| Field                  | Type     | Required | Description                                                          |
| ---------------------- | -------- | -------- | -------------------------------------------------------------------- |
| `header`               | string   | No       | Request header carrying the caller's operation key. Default `"x-idempotency-key"`. Support for the conventional `idempotency-key` fallback is RECOMMENDED. |
| `ttlSeconds`           | number   | Yes      | Replay window length, measured from settlement confirmation.          |
| `maxReplays`           | number   | Yes      | Maximum free replays per operation.                                   |
| `stageTimeoutSeconds`  | number   | No       | Maximum time an unconfirmed (staged) record may exist before it is silently discarded. Aged staged records MUST NOT leave tombstones. |
| `excludedKeys`         | string[] | Yes      | Body keys excluded from the response projection before hashing.       |
| `contentCompanion`     | boolean  | No       | Whether the server also records verdicts under a canonical-request-content companion key. See §3.2. |
| `reference`            | string   | No       | URL of an implementation's recovery contract documentation.           |

Example (x402 v2):

```json
{
  "extensions": {
    "recovery": {
      "info": {
        "header": "x-idempotency-key",
        "ttlSeconds": 600,
        "maxReplays": 3,
        "stageTimeoutSeconds": 300,
        "excludedKeys": ["recovery", "evidence_bundle", "cache", "elapsedMs"],
        "contentCompanion": true,
        "reference": "https://example.com/recovery"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "header": { "type": "string" },
          "ttlSeconds": { "type": "integer" },
          "maxReplays": { "type": "integer" },
          "stageTimeoutSeconds": { "type": "integer" },
          "excludedKeys": { "type": "array", "items": { "type": "string" } },
          "contentCompanion": { "type": "boolean" },
          "reference": { "type": "string" }
        },
        "required": ["ttlSeconds", "maxReplays", "excludedKeys"]
      }
    }
  }
}
```

**3.1 Callers: one key per operation**

Callers SHOULD send the declared header on the FIRST call of an operation and reuse the SAME
value on retries of that operation. A caller that mints a fresh id per retry loses protection
unless the server also implements the content companion (§3.2).

The idempotency key is the **caller's secret**: whoever presents it can replay the verdict
free within the window. Callers MUST NOT log it publicly. Callers SHOULD prefer presenting
it only to the service that issued the protected resource.

A key is bound to ONE operation: the canonical request fingerprint plus, where the rail
exposes it, the payer's authorization scope. Spectators cannot recover another caller's
result by guessing a key, and the key cannot be replayed across a different payer (see §5.2).
Response bodies that participate in recovery additionally carry a server-generated
`operationId` under an excluded key (the reference implementation uses `recovery.operationId`)
so the settlement hook can promote the exact operation whose payment settled (§5.1).

**3.2 Content companion (optional, with stated limits)**

If `contentCompanion` is declared, the server additionally records the verdict under a
companion key derived from the canonical request content, so a retry that cannot reuse the
caller's id (fresh id per retry, process restart) still replays free inside the window.
Two different asks that canonicalize identically share one verdict — this is determinism,
not cache leakage.

Limits, made part of the spec rather than a footnote:

- **Equal content is not permission.** The companion is a recovery alias for the SAME
  operation and the SAME authorization scope, never a public cache. A server MUST NOT return
  a companion hit to a caller whose authorization scope does not match the scope recorded at
  staging (when the payment rail exposes a payer identity). Presenting a body that
  canonicalizes to the same bytes does not establish the right to see another caller's
  result.
- **One replay budget per operation.** Implementations supporting the companion MUST share
  ONE replay budget across all aliases of an operation (the cap is per operation, not per
  alias).
- **Bound to the operation identity.** A companion alias is only promotable through the same
  settlement gating as the primary key (§5.1): the operation's own settlement, matched by
  operation identity, never by content bytes alone.

The companion MAY additionally record a **content-keyed tombstone** to signal that a verdict
once existed. Such a tombstone proves only that a verdict existed; it MUST NOT be treated as
evidence that THIS caller paid for it, and it MUST NOT unlock any replay.

**4. Evidence Bundle**

Every paid response of a protected resource implementing this extension carries:

```json
{
  "evidence_bundle": {
    "spec": "<implementation>/<bundle>@<version>",
    "route": "/example",
    "requestHash": "<sha256 hex>",
    "responseHash": "<sha256 hex>",
    "pinnedBlock": 26220878,
    "mode": "testnet",
    "createdAt": "2026-10-18T17:00:00.000Z",
    "payment": { "protocol": "x402", "scheme": "exact" },
    "recompute": "<one-sentence recipe>"
  }
}
```

- `requestHash` covers the canonical form of `{ route, body }`.
- `responseHash` covers the canonical form of the response body with **every key listed in
  `excludedKeys` removed**, recursively sorted keys, no whitespace. The exclusion set is
  fixed per route by the declaration. Transport-volatile fields (timing, block cache
  markers) and the bundle/recovery envelopes MUST be in the exclusion set.
- The recipe sentence in `recompute` MUST describe exactly this procedure so a receiver can
  recompute both hashes without reading source code.

The projection MUST be identical across: the first paid response, any free replay, and any
internal record keeping. One projection, one number everywhere. Evidence-bundle fields other
than the hashes are informational.

**5. Recovery Semantics (Normative)**

**5.1 Stage-then-promote**

When a paid request computes a result and the caller supplied a key:

- the server MAY stage the result immediately for recovery;
- every operation MUST receive a **server-generated, unguessable operation identity**
  (`operationId`). It MUST be carried in the response body under a key that is itself in the
  projection exclusion set (the reference implementation uses `recovery.operationId`), so it
  never perturbs the response hash;
- the result MUST NOT become replayable until **settlement confirmation** — the point at
  which the payment rail (facilitator or chain view) reports the settle as successful and
  the response bytes are final;
- promotion MUST be keyed on the operation identity, MUST require a confirmed settlement
  carrying a **settlement reference** (a transaction identifier), and MUST additionally
  verify that the projection hash of the bytes transmittable to the caller still matches the
  staged record. Implementations SHOULD use the settlement lifecycle hook of their framework
  for this (for the reference Express implementation: register an `onAfterSettle` handler
  that passes `transportContext.responseBody` plus the settle result to the promotion step).

> **Output equality does not identify an operation.** The projection hash is an additional
> integrity check, never the primary key. Two distinct operations can legitimately produce
> byte-identical output (e.g. two requests that both resolve to `{"verdict":"no_match"}`);
> settling one MUST NOT promote the other.

The following are normative consequences:

1. **Failed or pending settlement promotes nothing.** A 402 outcome from settle failure
   leaves staged state that cannot serve a free replay. A keyed retry after a failed
   settlement hits the payment wall again; it does not receive the still-computed verdict
   for free. Promotion MUST be refused unless the settle result reports success AND carries
   a non-empty settlement reference.
2. **Settle-cancellation promotes nothing.** Handler failures and after-verify cancellations
   are the same class.
3. **Authorization scope is part of the operation.** If the payment rail exposes a payer
   identity at staging time, only an identity the rail has **verified** becomes an
   authorization scope. Promotion MUST refuse a settlement whose payer does not match the
   recorded verified scope. An unknown scope may still PAY; it may never replay or promote on
   behalf of a known one.
4. **Staged records are inert and age out silently.** A staged record that is never
   promoted MUST be discarded after `stageTimeoutSeconds` and MUST NOT leave a tombstone:
   an unsettled verdict is not a lost verdict, so no typed signal is owed.
5. **Save-failure policy is fail-closed.** If the promotion step itself errors, the entry
   stays staged. Implementations SHOULD log the error; they MUST NOT silently promote.

> **Two mechanisms satisfy §5.1; the architecture chooses.** The stage-then-promote pattern
> above is required when settlement confirmation is *asynchronous* — it can only arrive via a
> lifecycle hook after the response has already been built. Where settlement confirmation is
> *synchronous* with response construction (a runtime that settles inline before headers are
> sent), a strictly simpler mechanism satisfies the same rule with no intermediate state:
> never write the recovery record speculatively — write it only past two gates, a confirmed
> settlement *and* a delivered (sub-3xx) response. That yields no staged record, no
> `stageTimeoutSeconds`, and no promotion-hook-failure case; fail-closed falls out of "don't
> write until the outcome is already known." Implementations SHOULD state which mechanism they
> use. (Production corroboration: scvd.store, `x402-foundation/x402#3847`.)

**5.2 Replay and conflict**

If a request presents the key (or a companion alias, when enabled) of an operation whose
record is (a) promoted, (b) within `ttlSeconds` of its settlement, and (c) under
`maxReplays`, the server returns the recorded response **without requiring payment** and
MUST append:

```json
{
  "recovery": {
    "replayed": true,
    "responseHash": "<sha256 hex>",
    "replays": 2,
    "ttlMinutes": 10,
    "maxReplays": 3
  }
}
```

`replays` counts replays of the operation, shared across aliases when companions are enabled.
The replayed body MUST hash to `recovery.responseHash` under the declared projection.

**Conflict: a key is bound to one operation.** Because a key identifies an operation, not a
slot in a cache, reusing it for a *different* operation is an error, not a hit:

- If a key arrives with **changed request content** (the canonical request fingerprint
  differs from the one recorded), the server MUST reject the request before payment and
  before replay — it MUST NOT return the other operation's verdict and MUST NOT charge.
- If the same key arrives under a **different verified authorization scope** (a different
  verified payer identity on a rail that exposes one), the server MUST likewise reject
  before payment and before replay.
- The rejection SHOULD be a typed `4xx` (the reference implementation uses `409` with
  `error: "recovery_conflict"` and a machine-readable `conflict` field such as
  `request_mismatch` or `scope_mismatch`). A caller that encounters a conflict either
  chooses a new key for the new operation or is charged normally for the fresh call.

A key whose recorded request fingerprint and scope both match the incoming request is
recoverable exactly as in the first paragraph.

**Scope must be verified before replay.** A caller-supplied payer address is a claim, not
proof of control. Before an early replay returns a cached result, the server MUST establish
that the caller controls the recorded verified scope. Acceptable proof is a signature by the
recorded payer over a server-issued challenge, an authenticated session bound to that payer,
or an equivalent proof the payment rail already verifies; implementations MUST name the
mechanism they use. A request that names the correct payer but supplies missing or invalid
proof MUST NOT receive the cached result: it MAY be rejected, or treated as a fresh paid
call, but it MUST NOT be treated as a replay. A retry that proves control of the recorded
scope recovers the settled result without a second payment.

**5.3 After the window (typed, not silent)**

When the window closes, the promoted record is removed and the server MAY keep a
**tombstone**: `{ responseHash, settledAt, expiredAt }` for a server-defined retention
period. A retry within the tombstone window re-measures with the payment wall re-armed
(there is no free measure — anything else would be a loophole) and the response carries:

```json
{
  "recovery": {
    "remeasured": true,
    "previousResponseHash": "<sha256 hex>",
    "expiredAt": "2026-10-18T18:00:00.000Z"
  }
}
```

so calling agents can branch on "this exact operation was charged before and its replay
window expired" instead of guessing. A fresh settlement of the same operation clears the
tombstone and re-opens the window. Tombstones themselves expire.

**5.4 Conformance controls (implementation self-test)**

An implementation claiming this extension SHOULD maintain the offline controls below. They
are deterministic, need no live facilitator, and each one pins a rule that a plausible-
looking but incorrect implementation silently violates:

1. **Identical output does not cross-promote.** Stage two operations whose projections are
   byte-identical (`{"verdict":"no_match"}` twice). Confirm settlement of A only. A MUST be
   replayable; B MUST remain inert. Promoting by response bytes alone fails this control.
2. **Settlement reference required.** Promotion of a staged record MUST return "not promoted"
   for each of: `{ ok: false }`, a missing settlement reference, and an empty settlement
   reference. A confirmed settlement with a reference MUST promote.
3. **Operation identity required.** A response body that does not name `operationId` MUST NOT
   promote, even when accompanied by a valid settlement.
4. **Key + changed content conflicts.** A key recorded for request R1, presented with request
   R2, MUST yield a typed conflict — not R1's verdict, not a charge.
5. **Key + changed scope conflicts.** A key recorded for verified payer P1, presented with
   verified payer P2, MUST yield a typed conflict.
6. **Payer must match on promotion.** A settlement whose payer differs from the staged scope
   MUST NOT promote.
7. **Companion requires verified scope.** A companion alias MUST NOT be returned to a caller
   with no verified scope, or a mismatched one — equal content or a matching declared address
   alone is never permission — and MUST be returned only to a caller that proves control of
   the recorded scope.
8. **Unverified scope does not replay.** A promoted record under verified payer P, retried
   with P's address but missing or invalid proof of control, MUST NOT return the cached
   result. A retry that proves control of P's scope MUST recover the settled result without a
   second payment.

**6. Protocol Integration**

The extension is transport-neutral. Normative behavior lives in the response body and the
request header, which makes it identical for x402 v1 responses and v2 responses.

For x402 v1 (body-level), a settlement response looks like:

```json
{
  "verdict": "no_edge",
  "netBps": -36.11,
  "evidence_bundle": { "...": "..." },
  "recovery": { "replayed": false }
}
```

For x402 v2, implementations MAY surface the same structures in the response body and MAY
additionally mirror declaration metadata into `extensions["recovery"]` as in §3. The v2
extension placement uses `info` and `schema` following existing extension conventions.

**7. Key Discovery and Trust**

No trust system is mandated beyond the settlement itself: the recovery guarantee is
anchored in the fact that an operation's verdict only becomes free-replayable through **that
operation's own settlement confirmation**, matched by the operation identity the server
generated and by the settlement reference the rail returned. The projection hash is an
additional integrity check, not the identity. The content companion inherits the sandbox of
the same promotion rule and the same authorization scope: it cannot promote records whose
projection does not match a successfully settled response, and it cannot hand a result to a
caller whose scope does not match.

**8. Use Cases (Non-Normative)**

- **Agent retry loops**: an agent that timed out after paying calls again with the same
  idempotency key and gets the answer, not a second charge — without the caller of the agent
  needing to keep a ledger.
- **Audited measurements**: a downstream consumer recomputes `requestHash`/`responseHash`
  from the body to prove the artifact they quote was really produced by the service for
  that request.
- **Dispute and reputation evidence**: hashes plus pinned block give attestation systems a
  minimal, portable payload — the same artifacts can be lifted into external proof formats
  verbatim.

**9. Integration with Proof Systems**

Both the evidence bundle and the recovery envelope are self-contained JSON objects and can
be lifted verbatim into signatures or attestations (see the Offer and Receipt extension for
signature formats). This extension does not sign anything itself; it makes the artifacts
that CAN be signed well-defined.

**10. Security Considerations**

- The settlement-gating rule (§5.1) exists precisely because the naive implementation
  (record in the route handler, settle afterwards) has been shown to reproduce: a failed
  settlement with records promoted by the handler leaves free replayable output. An
  independent review of a live deployment surfaced this and the fix is what §5.1 codifies.
- Promotion keyed on the operation identity — not the projection hash — closes the
  cross-promotion hole: two operations with identical output are still distinct, so settling
  one cannot unlock the other. The projection hash remains as a second check against
  staged-but-unsettled poisoning, and bounds damage from content-identical collisions:
  content-identical asks are one measurement by construction.
- The replay key is bound to request content and authorization scope, and a mismatch is a
  typed conflict resolved before payment or replay (§5.2). This prevents a reused key from
  returning the wrong caller's verdict or charging for a recovery the caller cannot receive.
- The replay key is a bearer secret; implementations SHOULD keep the window short and
  bounded so the 402 paywall remains effective.
- Hash projection choice is part of the contract: ambiguous projections (different sets of
  excluded fields in different places) make advertised hashes unrecomputable. This
  extension requires the exclusion set to be declared once and used identically everywhere
  (§4).
- Clock: TTL is measured from settlement confirmation, not from handler execution.

**11. Privacy Considerations**

- The recovery key binds to an operation, not to a person; the extension fixes no identity
  claim. Services SHOULD NOT add caller identity to artifacts without their own consent
  story.
- Tombstones reveal that "this request shape was measured before" — a bounded window keeps
  the information coarse.

**12. Version History**

| Version | Date       | Changes                                            | Author                          |
| ------- | ---------- | -------------------------------------------------- | ------------------------------- |
| 0.1     | 2026-10-18 | Initial draft. Extracted from a live x402 service (verify402.onrender.com, reference implementation open-source) and hardened after independent reproduction of two defects by an external agent (SameDayDesk): recovery-before-settlement and projection mismatch. | a32116150-ctrl (verify402) |
| 0.2     | 2026-10-19 | Addresses review by NSPG13 (x402-foundation/x402#3848, at `d97ebfa3`). Promotion now keys on a server-generated operation identity plus a confirmed settlement reference, with the projection hash as an additional check (§5.1) — output equality alone no longer identifies an operation. Added key/scope conflict semantics resolved before payment or replay (§5.2), scoped the content companion so equal content is not permission (§3.2, §7), and added a required self-test control set including the identical-output cross-promotion case (§5.4). | a32116150-ctrl (verify402) |
| 0.3     | 2026-10-19 | Names both mechanisms that satisfy §5.1 — async stage-then-promote and synchronous write-after-settle — since the choice is determined by whether settlement confirmation can complete before the response is built. Prompted by production corroboration from scvd.store on x402-foundation/x402#3847 (request-identity keying, scope-bound cache keys, no speculative write). | a32116150-ctrl (verify402) |
| 0.4     | 2026-10-20 | Requires a **verified** payer scope before replay, not merely a declared or matching address. §5.2 names acceptable proof-of-control mechanisms and forbids returning a cached result on missing or invalid proof; §5.4 adds the unverified-scope control. Prompted by NSPG13's review at `2a03ad6` (x402-foundation/x402#3848). | a32116150-ctrl (verify402) |
