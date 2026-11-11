# Rejection Receipt Extension

## 1. Summary

When a resource server refuses a payment attempt, x402 today gives no standard way to leave a durable, independently-checkable record of that refusal. A buyer whose payment attempt was rejected has nothing to show afterward except its own word; the seller's "no" leaves no row anywhere for either party to point to later. [Pull request #3776](https://github.com/x402-foundation/x402/pull/3776), §5.5, closes a related but different gap: it makes every acceptance and refusal along a request's path resolve to the same `attempt_identity`. Nothing requires that a refusal be recorded at all. What follows closes that second gap: a signed artifact, a Rejection Receipt, that a resource server can return (or make available) when it rejects a payment attempt, bound to the exact attempt it refused, with a bounded, fail-closed vocabulary for the stated reason and an explicit evidence class per reason, so a reader can tell a claim the resource server can prove apart from one it can only assert.

This is a reference implementation, not a hypothetical: [`agent-receipt-verify`](https://github.com/holistis/agent-receipt-verify) (MIT/Apache-2.0, `npx -y agent-receipt-verify rejection-receipt`) has implemented and tested this checker since 2026-11-10: 26 recorded test vectors across 9 clauses in the reference implementation, every clause carrying at least one acceptance and one rejection, plus a separate real-cryptography suite (EIP-712 signing and verification against a freshly generated key, `did:web` key resolution against a faked fetch, no live network) that adds 50 passing tests and 0 failing ones.

## 2. Status, Scope, and Relationship to Other Work

This extension is optional and composable. It does not modify payment execution, verification, or settlement semantics. It defines a signed artifact format for one specific moment: a resource server's own decision to reject a payment attempt, and what it is willing to say about why.

This lands in the middle of a live discussion, not ahead of one. On the same thread this proposal's Summary cites, [ruiruii sketched a server-side row today, 2026-11-10](https://github.com/x402-foundation/x402/pull/3776#issuecomment-6767441891), independently describing the identical gap this proposal answers: "a duplicate replay refused with 402 leaves no row today, so 'buyer says it paid / seller says it refused' has nothing to line up on." That sketch, `gates-spec v0.1` (a separate draft of theirs: a VSR-style row with `settlement_status`, `redeem_count`, `refusal_reason`), is explicit about its own scope: "not normative x402 text... not a request for anything." It is signed; [what stays server-internal by default is its destination, not its content](https://github.com/x402-foundation/x402/pull/3776#issuecomment-6771918254), [a correction to how we first read that scoping](https://github.com/x402-foundation/x402/pull/4215#issuecomment-6796077062), not a change to the sketch itself. The complementary, buyer-facing layer is this: a *signed, portable* artifact the buyer can hold and show to someone else entirely, once the resource server's own internal row has already done its job, or failed to exist. Neither replaces the other; a resource server could keep an internal `gates-spec` row and issue a Rejection Receipt derived from it. Put plainly, as suggested in review: the internal row can be the default, written whether or not anyone asks; this receipt is the exportable form, issued when a buyer needs something to hold. This citation describes ruiruii's own sketch as they scoped it; it carries no endorsement of this proposal, which they have not seen.

This is also the companion half of a pair, not a standalone idea. [The Buyer Delivery Claim Extension, #3604](https://github.com/x402-foundation/x402/pull/3604) (also from this author, currently open and in review) covers what a buyer can durably say after a settlement completes: did the promised thing actually arrive. This proposal covers the symmetric case upstream of that: what a resource server can durably say when a payment attempt never gets that far, because it was refused. Put together, neither party is left holding only their own word, on either outcome, acceptance-and-delivery or refusal. Both share one posture: a signed, optional, composable artifact; a narrow, stated scope; honest, tested limitations over a claim of completeness.

Set that pairing aside, and the scope stays narrow in every other direction too. It does not attempt to cover:

- the still-open [delivery-receipt attestation discussion, #2833](https://github.com/x402-foundation/x402/issues/2833): also the successful-delivery side, not yet a PR;
- encrypted, retrievable storage of delivery evidence ([durable-evidence, #3377](https://github.com/x402-foundation/x402/pull/3377));
- who has authority to decide the next state of a dispute ([resolution-lineage, #3291](https://github.com/x402-foundation/x402/pull/3291));
- binding a completed settlement to an externally verifiable work-receipt ledger ([proof-of-done, #3379](https://github.com/x402-foundation/x402/issues/3379));
- a buyer explaining, before paying, why it chose not to ([#4087](https://github.com/x402-foundation/x402/issues/4087): the opposite direction, and that issue explicitly excludes post-settlement cases);
- the live, single-response-cycle, plain-text error body an HTTP 402 response can already carry ([#3795](https://github.com/x402-foundation/x402/pull/3795) and [#3882](https://github.com/x402-foundation/x402/pull/3882), merged, plus the still-open [#3148](https://github.com/x402-foundation/x402/issues/3148): useful, but gone once that one response is gone, not a durable artifact a buyer can hold and show later).

Each of those is a genuinely different question, worked on by other people in parallel. Unifying them is not the goal here; the scope stays exactly what the reference implementation checks, composing alongside them the same way #3604 composes alongside the [Offer and Receipt Extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-offer-and-receipt.md).

Phase 1 stays narrow in a second way, too: it is a verifier, not an issuer. Nothing in the reference implementation signs anything or holds a private key; every existing checker in that repository (`attempt-identity.mjs`, `verify-delivery.mjs`, `inam-countersigned.mjs`) only verifies, and this one follows the same rule. A party that wants to actually issue these receipts brings its own key management. A buyer-signed "Attempt Intent" sent before the request (so a refusal can be tied to a request the buyer actually sent, not merely one a seller claims it received) and a witness or transparency-log mode for detecting a hidden contradictory receipt both sit out of scope for this version: neither is built, tested, or operated yet, and claiming either here would hand sellers exactly the kind of unearned claim this format exists to prevent.

## 3. Design Principles

- A signature proves who signed, never that it is true. The resource server can sign a false reason as easily as a true one. Making a reason true is not the goal; making sure a reason never claims more proof than it can actually offer is.
- A reason's evidence class is a fixed ceiling, not a free field. Every `reason_code` maps to the highest evidence class that is honest for it (`CLIENT_VERIFIABLE`, `CHAIN_VERIFIABLE`, or `ISSUER_ASSERTED`; a fourth value, `INDEPENDENTLY_WITNESSED`, exists but nothing in this version claims it yet, see §8); a receipt may claim that class or lower, never higher. An unrecognized reason code closes at `ISSUER_ASSERTED`, the lowest class, so an unreviewed reason never defaults to sounding more rigorous than it is.
- Signing keys are never the `payTo` address. The Offer and Receipt Extension already warns that coupling a payment key and a signing key raises the cost of a key compromise (§4.5.1 of that extension); this format turns the separation into a checked rule whenever a verifier has both addresses, going beyond a recommendation. The reference implementation does not yet fail closed when it lacks one of the two addresses (§8): a known, tracked gap, not a silent exception to the rule.
- Two receipts about the same attempt cannot quietly disagree. Once a buyer holds two receipts that both point at the same `attempt_binding`, their `decision.outcome` and `decision.reason_code` MUST match. Detecting the contradiction needs no transparency log, only a comparison, once both documents are in the same hands.
- An uncertain settlement is never dressed up as a final rejection. A receipt whose `payment_observation.state` is `SETTLEMENT_PENDING` may not present its `decision` as final; the payment could still succeed later.

## 4. Receipt Structure

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | Yes | `x402-rejection-receipt` |
| `version` | integer | Yes | Currently `1` |
| `attempt_binding.payment_payload_hash` | string | Yes | Hash binding this receipt to the specific payment payload that was refused |
| `attempt_binding.payment_requirements_hash` | string | Yes | Hash binding this receipt to the specific payment requirements the attempt was evaluated against |
| `issuer.resource_origin` | string | Yes | The origin that issued this receipt; also the EIP-712 domain salt input (§5), so a signature cannot be replayed against a different resource server |
| `issuer.key_id` | string | Yes | `did:web:<host>#<fragment>`; resolves to a `did.json` whose matching `verificationMethod.blockchainAccountId` (CAIP-10, `eip155:<chainId>:<address>`) gives the signing address |
| `decision.outcome` | string | Yes | MUST be `REJECTED` for this format to apply at all |
| `decision.reason_code` | string | Yes | See the fixed table below; an unrecognized value is simply bounded at `ISSUER_ASSERTED`, not treated as an error |
| `decision.evidence_class` | string | Yes | One of `ISSUER_ASSERTED`, `CLIENT_VERIFIABLE`, `CHAIN_VERIFIABLE`, `INDEPENDENTLY_WITNESSED`; MUST NOT exceed the ceiling the reason code allows |
| `decision.final` | boolean | Conditional | MUST be present and `false` when `payment_observation.state` is `SETTLEMENT_PENDING`; MAY be omitted for the other three states, which already describe a resolved outcome |
| `payment_observation.state` | string | Yes | One of `NOT_SUBMITTED`, `SETTLEMENT_PENDING`, `REJECTED`, `UNKNOWN`; free text (for example `"payment_failed"`) is non-conformant, because the core x402 specification already treats a pending settlement as non-terminal (its own §9, Error Handling, not this document's) and a flattened "failed" erases exactly that distinction |
| `issued_at` | string | Yes | ISO 8601 timestamp |
| `client_attempt_id` | string | No | An identifier the buyer chooses per submission attempt. Top-level, never part of `attempt_binding` (§6). Not validated for format or uniqueness by this checker; carried through generically like every other field (§5) |
| `server_observation_id` | string | No | An identifier the resource server chooses per request it actually receives, even when the content duplicates an earlier one. Top-level, never part of `attempt_binding` (§6). Not validated by this checker |
| `receipt_id` | string | Yes | sha256 hex digest of the RFC 8785 canonical envelope (every field above, excluding `receipt_id` and `signature` themselves) |
| `signature` | string | Yes | See §5 |

Fixed reason table (the ceiling each `reason_code` is honestly allowed to claim):

| `reason_code` | Highest honest `evidence_class` |
| --- | --- |
| `invalid_signature` | `CLIENT_VERIFIABLE` |
| `wrong_amount` | `CLIENT_VERIFIABLE` |
| `wrong_recipient` | `CLIENT_VERIFIABLE` |
| `invalid_exact_evm_payload_authorization_valid_before` | `CHAIN_VERIFIABLE` |
| `invalid_exact_evm_payload_authorization_valid_after` | `CHAIN_VERIFIABLE` |
| `insufficient_funds` | `CHAIN_VERIFIABLE` |
| `duplicate_payment` | `CHAIN_VERIFIABLE` |
| `duplicate_payment_internal_record` | `ISSUER_ASSERTED` |
| `facilitator_timeout` | `ISSUER_ASSERTED` |
| `risk_policy_rejected` | `ISSUER_ASSERTED` |
| `commercial_refusal` | `ISSUER_ASSERTED` |
| anything else | `ISSUER_ASSERTED` (fail closed) |

This table belongs to this proposal, not to an x402 enumeration. If x402 later defines its own error codes for refusals, check this table against that list, not the reverse.

`duplicate_payment` and `duplicate_payment_internal_record` are deliberately two different codes for what can look like one fact. Use `duplicate_payment` only when an independent third party can confirm the underlying payment authorization was already consumed on-chain. Use `duplicate_payment_internal_record` when the resource server, or a facilitator relaying for it, recognized the repeat only from internal records (a database row, an in-memory table, a facilitator's own bookkeeping), with nothing on-chain to check. The first is honestly `CHAIN_VERIFIABLE`; claiming that ceiling for the second would be an overclaim this checker now rejects (§10, step 3).

The §9 example also carries `payment_observation.network` and `payment_observation.transaction`: realistic, implementation-useful context, but not part of this format's required schema and not read by the reference implementation's verification logic. An implementation MAY include fields like these; a verifier MUST NOT require them.

## 5. Computing the Receipt Identifier and Signature

```text
receipt_id = sha256_hex( canonicalize(envelope) )
digest     = sha256( canonicalize(envelope) )             // the bytes32 that gets signed
signature  = EIP-712 typed-data signature over { digest }, domain =
               { name: "x402-rejection-receipt", version: "1",
                 salt: sha256(issuer.resource_origin) }
```

`envelope` is every field in §4 except `receipt_id` and `signature` themselves. `canonicalize()` is RFC 8785 JSON Canonicalization. Binding the domain `salt` to `resource_origin` means a signature cannot be lifted from one resource server's receipt and replayed as if it were a different server's; the EIP-712 struct is deliberately minimal (one `bytes32` field over a hash of the full canonical envelope) rather than a full field-by-field typed struct, to get real domain separation without a second, parallel schema to keep in sync with §4.

## 6. Relationship to the Underlying Attempt

`attempt_binding` ties a receipt to one specific payment attempt via two hashes of this proposal's own, `payment_payload_hash` and `payment_requirements_hash`: these names belong to this proposal, not to [§5.5 of #3776](https://github.com/x402-foundation/x402/pull/3776). §5.5 defines a related but distinct concept, operation identity, derived from a frozen ingress snapshot of the whole request (method, path, query, body), and deliberately keeps that apart from a captured-artifact digest and a signed-content identifier, specifically so one digest is not made to serve all three. `attempt_binding` is narrower: a digest of the payment payload and the payment requirements alone. A verifier that holds the original payment payload and requirements can recompute both hashes and confirm they match before trusting anything else in the receipt. Whether the attempt should have been accepted is outside this format's job; its only job is checking that the resource server's account of refusing it stays internally consistent and does not overclaim.

Like §5.5's own operation identity, `attempt_binding` is content-addressed: identical content produces an identical value, no matter how many times, or when, that content was submitted. The same payload submitted twice, once settled and once refused as `duplicate_payment`, therefore binds to the same `attempt_binding` both times. Holding only the second receipt, a verifier learns that this payload was refused, not, by `attempt_binding` alone, that this was specifically the submitter's second attempt while a first attempt on the same payload settled.

`client_attempt_id` and `server_observation_id` (§4) close that gap, deliberately kept outside `attempt_binding`, never folded into it. Mixing a buyer-chosen value into the same comparison that recognizes a duplicate payment would let a buyer make a reused payment look new just by picking a new value, breaking duplicate detection outright; that risk, not a cryptographic limit, is why these are separate, optional, top-level fields. Telling two of a buyer's own receipts apart by `server_observation_id`, while confirming by `attempt_binding` that they are about the same underlying payment, gives both facts at once without either field compromising the other. What those two identifiers do not yet cover is named in §8.

## 7. Publishing and Discovery

This proposal does not mandate a publication substrate, matching the Buyer Delivery Claim Extension's own posture. A receipt is valid wherever it is found, provided it verifies. The reference implementation checks a receipt wherever a buyer or a tool already has one; a discovery or aggregation path is not yet built, unlike the EAS-based cross-installation discovery the Buyer Delivery Claim Extension's reference implementation already runs live on three chains. That gap stays open and named (§8).

## 8. Known Limitations

Worth stating plainly: a claimed limitation that is actually tested carries more weight than a claim of completeness that is not.

- Silence is not covered. A resource server that sends no receipt at all, as opposed to a false one, cannot be caught by this format alone. "The seller never answered" stays unsolved; only the case where the seller did answer gets stronger.
- A buyer can hold two honest-looking receipts about one underlying attempt and show only the one that reads better. §3's contradiction check only fires when two receipts share one `attempt_binding`; two different, legitimate presentations of the same payload bind differently, so neither receipt over-claims on its own and no single comparison catches the pair. [Raised against the identical shape in a parallel design](https://github.com/x402-foundation/x402/pull/4215#issuecomment-6796077062): the comparison that would catch it runs between issuers, or across time, outside what one verifier invocation can see. Named here for the same reason silence is named above, not solved by a check that would look like it closes it.
- A buyer-signed Attempt Intent does not exist yet. Without it, in this version a request the buyer never actually sent cannot be told apart from a real one that was refused: a stated limitation of this version, not a hidden guarantee.
- No witness mode exists. Detecting two contradictory receipts about the same attempt (§3) only works once a buyer holds both of them, and nothing here guarantees a buyer ever receives the second one. `INDEPENDENTLY_WITNESSED` exists as an evidence class value; no `reason_code` in the fixed table points to it yet, because nothing in this version makes that claim true.
- `did:web` key resolution reads a plain, overwritable file, so a `did.json` can be rewritten after the fact. The checker returns the full resolved document alongside the recovered address specifically so a caller can keep its own copy as evidence the moment a receipt arrives, instead of trusting a later re-resolution of the same URL.
- Our reason-code table is our own, not x402's. See §4.
- The payTo and signing-key check needs both addresses to run. Unlike the signature-verification step (§10, step 6), the reference implementation does not yet return a "not measured" result when it lacks the resource server's `payTo` address or the resolved signing address; today it simply has nothing to compare and moves on. A known gap, tracked for a fix, not a deliberate exception to §3's rule.
- `client_attempt_id`/`server_observation_id` close the "which submission was this" gap (§6), but not every shape of it. Specifically not covered yet: whether a buyer's timed-out retry should carry the same `client_attempt_id` or a fresh one; whether a receipt may reference an earlier `server_observation_id` (and the privacy question that raises if a third party replays the lookup); behavior across a resource server restart with an in-memory attempt table; and behavior across multiple resource servers sharing one `resource_origin`. An internal adversarial pass listed around sixty further scenarios (concurrent identical submissions, identifier reuse, identifier entropy requirements, and more); naming this list here, not working through all of it, is itself the limitation.
- `server_observation_id`'s own uniqueness is asserted by the resource server, not provable by a verifier; a resource server could in principle reuse one, including across two receipts with different `attempt_binding` values. This checker does not detect that, the same way it cannot detect a resource server that simply declines to issue a receipt at all.
- `did:web` resolution accepts only the bare-host form, `did:web:<host>#<fragment>`; path-segment identifiers and other verification method types fall outside what it supports.
- Nothing yet checks that `issuer.key_id`'s host matches `issuer.resource_origin`. §10, step 8, states the rule; the reference implementation does not yet enforce it. Without that check, the domain-salt binding in §5 only ties a signature to the `resource_origin` a receipt claims, not to the host its signing key actually resolves to.

## 9. Example

```json
{
  "type": "x402-rejection-receipt",
  "version": 1,
  "attempt_binding": {
    "payment_payload_hash": "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
    "payment_requirements_hash": "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222"
  },
  "issuer": {
    "resource_origin": "https://api.example.com",
    "key_id": "did:web:api.example.com#rejection-key"
  },
  "decision": {
    "outcome": "REJECTED",
    "reason_code": "insufficient_funds",
    "evidence_class": "CHAIN_VERIFIABLE"
  },
  "payment_observation": {
    "state": "NOT_SUBMITTED",
    "network": "eip155:8453",
    "transaction": ""
  },
  "issued_at": "2026-11-10T15:00:00.000Z",
  "receipt_id": "09a96653127cf6bb33ab3544f0dbfb33b946841dc3cf7d8aaa3bc232bf710332",
  "signature": "0xsig"
}
```

The values above are test-vector data (`vectors/rejection-receipt/signature-verifies.json` in the reference implementation); `signature` is a placeholder, not a real one, the same way the Buyer Delivery Claim Extension's own example uses trivial test keys, not a funded wallet.

## 10. Verification

1. Confirm `decision.outcome` is `REJECTED` and both `attempt_binding` hashes are present. Nothing else below checks either fact, and skipping this step is exactly how a receipt for an accepted attempt, or one with no binding at all, would otherwise pass.
2. Confirm `payment_observation.state` is one of the four fixed values, and that a `SETTLEMENT_PENDING` state is never paired with a `decision` presented as final.
3. Look up the evidence-class ceiling for `decision.reason_code` (fail closed to `ISSUER_ASSERTED` if unrecognized); confirm `decision.evidence_class` does not exceed it.
4. Recompute `receipt_id` from the canonical envelope (§5) and confirm it matches.
5. Resolve `issuer.key_id` (§4) and, where the resource server's `payTo` address is also known to the verifier, confirm the recovered signing address is not that address.
6. Verify the signature against the resolved key, never against a key the receipt supplies itself.
7. If a second receipt pointing at the same `attempt_binding` is available, confirm the two agree on `decision.outcome` and `decision.reason_code`.
8. Confirm the host in `issuer.key_id` equals the host in `issuer.resource_origin`. Not yet enforced by the reference implementation (§8); stated here because any implementation of this format should do it.

## 11. Security Considerations

- A receipt that signs truthfully for its own `did:web` host but falsely claims a different `resource_origin` is not yet caught by this format (§8, §10 step 8): a spoofed-identity gap found during this proposal's own review.
- A receipt's signature proves who signed it, not that the stated reason is true (§3). A resource server can sign a false `commercial_refusal` as easily as a true `insufficient_funds`; the evidence-class ceiling bounds how convincing a lie can present itself, not whether a lie was told.
- Verifiers MUST resolve the signing key on their own, instead of trusting a key the receipt itself supplies (§4, §10); otherwise a resource server could make any receipt self-certifying.
- A `did:web` key document stays a plain, mutable file (§8). A verifier that wants a durable record of what a key resolved to at a given time should keep its own copy at resolution time, rather than re-resolving later.
- Nothing here gives a resource server an incentive to actually issue a receipt on refusal; it only raises the cost of issuing a dishonest one once it chooses to.
- Implementations MUST NOT fold `client_attempt_id` into whatever value they use to detect a duplicate payment. Doing so lets a buyer make a reused payment look new to that detection logic simply by choosing a new `client_attempt_id`, which defeats the purpose of detecting it at all. `attempt_binding` and `client_attempt_id` answer different questions (§6) and must stay computed independently.

## 12. Reference Implementation

`agent-receipt-verify`, `npx -y agent-receipt-verify rejection-receipt`: https://github.com/holistis/agent-receipt-verify/tree/feat/rejection-receipt-v1 for `src/rejection-receipt.mjs` (the checker), `vectors/rejection-receipt/` (26 recorded vectors, one per clause outcome, with a README documenting what was checked against prior art and what this does and does not prove), and `test/rejection-receipt.mjs` (50 tests, including the real EIP-712 and `did:web` cryptography, ten regression tests for bugs an earlier adversarial review found and fixed, and a test demonstrating why `client_attempt_id` must stay out of duplicate-payment detection).
