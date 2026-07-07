# Payment Preflight Record Extension

# 1. Overview

Every publicly documented agent-payment failure shares one shape: an irreversible action taken
with no independent check between the decision and the damage. A signature is the last event in
a payment; today it is routinely the *only* event — the model decides, the key signs, and
whatever the model was confident about becomes settled fact.

This extension defines the **Payment Preflight Record**: a structured, auditable object a
client agent assembles **after receiving a 402 challenge and before signing the payment
authorization**. The signature attaches to the assembled evidence — not to a raw transaction
the agent may have been steered into accepting. The record separates powers deliberately:

- a **risk oracle** supplies a verdict and declares what it checked — and holds nothing;
- a **state holder** supplies budget, signer scope, idempotency, and rollback state;
- a **confirmation service** supplies an expiring, record-bound human authorization when
  policy requires one;
- the **client agent** assembles the record and signs last, under deterministic rules.

The record is the deterministic artifact that downstream layers — escrow, attestation, dispute,
enforcement — can reference. Courts and arbiters need deterministic artifacts, not
model-generated prose.

This extension is an optional, composable addition to x402. It defines no new payment scheme
and modifies no settlement flow; it standardizes what a prudent payer assembles before using
the existing ones.

# 2. Status, Evolution, and Forward Compatibility

Draft v0.1 (RFC). Field additions are expected; therefore consumers MUST treat unknown fields
in a record as inert data, and MUST treat unknown *predicate types, coverage versions, or
constraint keys* as failing evaluation (fail closed). The asymmetry is intentional: unknown
data is harmless; unknown *rules* are not.

# 3. Roles and Trust Model (Normative)

1. **The risk oracle MUST NOT hold state.** Verdict only — no custody, no keys, no budget
   ledger, never in the settlement path. A referee that also holds the money is not neutral.
2. **The state holder MUST NOT alter risk fields.** Risk fields arrive signed from outside it.
3. **The verdict author MUST NOT share the acting agent's priors.** An agent scoring its own
   exposure re-reports its own familiarity as safety. Independence is what makes the risk
   block evidence rather than self-assessment.
4. **Strictest wins.** If multiple risk suppliers populate a record, the most restrictive
   verdict governs.
5. **Fail closed on the undeclared edge.** Anything outside an oracle's declared coverage
   (§5) MUST be treated as unchecked, and unchecked MUST be treated as STOP-equivalent.
6. **Model confidence is never an authorization input.** Confidence tracks familiarity, and
   familiarity is anti-correlated with blast radius. High confidence on a high-consequence
   action is an escalation trigger, not a pass.
7. **The signature is the last event.** No key touches the payment until the record is
   complete and every signing rule (§6) passes.

# 4. The Preflight Record

| Field | Type | Required | Supplied by | Description |
| --- | --- | --- | --- | --- |
| `record_id` | string | yes | client | unique per payment attempt; the audit anchor |
| `created_at` | ISO-8601 | yes | client | |
| `payment.rail` | string | yes | client | `"x402"` |
| `payment.network` | CAIP-2 | yes | client | e.g. `"eip155:8453"` |
| `payment.asset` | string | yes | client | e.g. `"USDC"` |
| `payment.payee_address` | string | yes | client | from the 402 `accepts` entry |
| `payment.payee_descriptor` | URL | no | client | the payee's `/.well-known/x402` |
| `payment.resource` | string | yes | client | what is being bought |
| `payment.quote_usd` | number | yes | client | the quoted price |
| `payment.action_class` | string | yes | client | mechanical classification, e.g. `"api-purchase"` |
| `risk.verdict` | `GO\|HOLD\|STOP` | yes | risk oracle | pre-signature, one call |
| `risk.counterparty_reputation` | number 0..1 | no | risk oracle | no-history counterparties SHOULD score neutral (0.5), never clean — absence of evidence is not trust |
| `risk.price_anomaly` | object | no | risk oracle | e.g. quote vs the payee's own historical median |
| `risk.sanctions` | object | no | risk oracle | list identity + version pin + hit flag |
| `risk.coverage` | object | yes | risk oracle | the declared envelope (§5) |
| `risk.oracle` | object | yes | risk oracle | name, receipt/forecast identifiers |
| `authority.policy_basis` | `auto\|human_confirmed` | yes | state holder | which rule permitted this |
| `authority.budget` | object | yes | state holder | `{cap, spent, remaining, window}` — live state, not a static mandate |
| `authority.signer_scope` | object | yes | state holder | `{key_id, action_classes[], scope_terminates_on?}` |
| `authority.instruction_epoch` | string | no | state holder | which generation of user instructions authorized this spend (stale-intent guard) |
| `authority.human_confirmation` | object \| null | conditional | confirmation service | REQUIRED for HOLD; `{id, status, record_id, expires_at}` — server-minted, record-bound, expiring |
| `authority.hold_policy` | object | no | state holder (operator-set) | `{ttl_seconds, assurance_tier, decline_on_expiry}` — how long a HOLD waits and at what review depth before it fails closed; keyed to amount-at-risk by operator policy |
| `execution.idempotency_key` | string | yes | state holder | one key, one payment |
| `execution.settlement_status` | enum | yes | state holder | `unsigned\|signed\|settled\|failed` |
| `execution.rollback` | object | yes | state holder | `{route: refund\|dispute\|none, contact}` — recorded BEFORE signing |

Example (abbreviated):

```json
{
  "record_id": "rec-9f2c01",
  "payment": { "rail": "x402", "network": "eip155:8453", "asset": "USDC",
               "payee_address": "0xABC…", "resource": "per-call inference",
               "quote_usd": 4.50, "action_class": "api-purchase" },
  "risk": { "verdict": "HOLD",
            "counterparty_reputation": 0.5,
            "sanctions": { "list": "OFAC-SDN", "pinned": "2026-06-28", "hit": false },
            "coverage": { "version": 1, "dimensions": [
              { "field": "payment.rail", "in": ["x402"] },
              { "field": "payment.network", "in": ["eip155:8453"] },
              { "field": "payment.quote_usd", "range": { "gt": 0, "lte": 10000 } },
              { "field": "payment.payee_address", "format": "eth-address" } ] },
            "oracle": { "name": "…", "receipt_id": "…" } },
  "authority": { "policy_basis": "human_confirmed",
                 "budget": { "cap": 25, "spent": 5, "remaining": 20, "window": "daily" },
                 "signer_scope": { "key_id": "k1", "action_classes": ["api-purchase"] },
                 "human_confirmation": { "id": "…", "status": "approved",
                                          "record_id": "rec-9f2c01",
                                          "expires_at": "2026-07-03T19:40:00Z" } },
  "execution": { "idempotency_key": "idem-9f2c01",
                 "settlement_status": "unsigned",
                 "rollback": { "route": "refund", "contact": "payee /.well-known/x402" } }
}
```

# 5. Coverage Declaration

A verdict is only as meaningful as the map it was drawn on. The oracle MUST declare coverage as
an **envelope of typed predicates over the record's own fields**, so the consumer can evaluate
membership locally as a pure function — no trust in the oracle is required to answer "does this
verdict even apply to this action?"

**5.1 Envelope.** `risk.coverage` carries `version` and `dimensions[]`. Each dimension carries
`field` (a dot-path into the record) and **exactly one** predicate:

| Predicate | Shape | Semantics |
| --- | --- | --- |
| `in` | non-empty array | exact membership |
| `range` | `{gt?, gte?, lt?, lte?}` — at least one bound, all bounds finite numbers | numeric interval |
| `format` | string naming a validator the CONSUMER implements | named format check |

**5.2 Fail-closed evaluation rules (Normative).** The consumer MUST treat the action as
OUTSIDE coverage when: a referenced field is absent from the record; a dimension carries zero,
multiple, or unrecognized predicate keys; a `range` has no bounds, unknown bound keys, or
non-finite bounds; an `in` set is not a non-empty array; the declaration `version` is one the
consumer has not validated; or the declaration is absent or malformed in any way. Outside
coverage is STOP-equivalent (§3.5).

**5.3 No patterns from the wire.** A declaration MUST NOT carry executable patterns (regular
expressions or similar) for the consumer to evaluate; `format` names consumer-implemented
validators only. A hostile oracle must not be able to hand the consumer a pattern to run.

**5.4 Check manifest.** Alongside the envelope, the oracle SHOULD declare what ran inside it
(`checks[]`: e.g. a sanctions list with a version pin, a reputation basis). The manifest is not
consumer-verifiable at decision time; it is signed into the oracle's receipt and priced by
calibration (§8): misses accrue against the declared envelope, so overdeclaring coverage costs
the oracle calibration exactly where it claimed competence. The overdeclare incentive is
charged, not policed.

**5.5 Freshness.** A verdict's inputs stale at different rates, and one TTL for all of them is
a false assurance: a merged pull request never stales; a price stales in seconds; a sanctions
list stales at its publication cadence. Each manifest `checks[]` entry SHOULD therefore carry
its own freshness declaration (`freshness: permanent | permanent_after_confirmation |
point_in_time {ttl} | windowed {window}`), and consumers SHOULD treat a verdict whose
freshest-stale check has expired as outside coverage for that dimension. This taxonomy follows
the Still OS claim-vocabulary specification's per-resolver freshness kinds, which named the
problem precisely.

# 6. Signing Rules (Normative)

The client MUST NOT sign the payment authorization unless ALL of the following hold:

1. `record_id` is present and non-empty (no identity → no audit anchor → no signature);
2. `risk.verdict != STOP`; a HOLD verdict additionally requires `authority.human_confirmation`
   present, `status: approved`, unexpired, and bound to THIS `record_id`;
3. the payment falls INSIDE `risk.coverage` under §5.2;
4. `payment.quote_usd` is a finite positive number ≤ `authority.budget.remaining`;
5. `execution.idempotency_key` has never been used;
6. `authority.signer_scope.action_classes` contains `payment.action_class` exactly
   (array membership — a scalar scope MUST fail);
7. `execution.rollback.route` is populated (even if `none` — the agent must know);
8. every rule above evaluated without error; any evaluation failure is a refusal, not an
   exception for the caller to interpret.

A confirmation is a pre-authorization that expires — not a standing power of attorney.

**6.1 HOLD is bounded and fails closed on silence (Normative).** A HOLD is not an open ticket.
If `authority.human_confirmation` is not `approved` before its `expires_at` (bounded by
`authority.hold_policy.ttl_seconds`), the HOLD resolves to a DECLINE, not a lingering pending
state — an unanswered escalation MUST NOT keep the payment signable. The attempt is
re-requestable only under a fresh `record_id` (the expired record cannot be resurrected).
Silence is a no. This closes the latency/limbo window: exhausting the reviewer's attention
yields a decline, never a signature.

**6.2 Escalation depth is operator policy, not agent choice (Non-Normative).** The review depth a
HOLD demands — from a confirm/decline of the server-authored fact sheet, up to an interactive
review for high amount-at-risk — is set by `authority.hold_policy`, keyed to the amount by the
operator, never chosen by the agent. Whatever the depth, the human adjudicates the
server-authored record (payee, amount, counterparty history) on a surface the agent's context
cannot reach: escalation shows facts the agent could not author, never the agent's narrative.
This is what keeps a bigger human role from reopening the injection surface a smaller one avoided.

**6.3 No shared story; facts fetched-complete, not agent-extracted (Non-Normative).** The
escalation surface's safety is not "strip the persuasive narrative" — persuasion is not a
syntactic property a filter can detect (the same words are legitimate in an honest request and a
con; only truth distinguishes them). The property is instead **no shared story**: the verifying
human must never see the same narrative the acting agent saw. The agent reads the world, extracts
an intent, and proposes an action; the human decides on the action and the policy, not on the text
that produced it. And the facts the human decides on MUST NOT be agent-selected — an agent that
chooses which facts to surface persuades by omission. So the field-set is **fetched complete for
the proposed action from the independent record** (this payee's settlement history, this quote vs
its median, this sanctions status), every field mandatory and populated by the source, never
curated by the actor. The agent proposes "pay X, amount Y"; the facts about X-at-Y are non-optional
and non-omittable. Stated limit (the §7-adjacent floor): this removes omission, not choice — the
agent still selects the action, so a clean-facts payee chosen for a poisoned reason reduces to
invoice fraud, which no pre-signature check resolves. (Sharpened in public review by @miacollective;
see Acknowledgements.)

# 7. Dispute Semantics

When an agent later disputes what was "actually approved":

- the confirmation record MUST be authored by the confirmation service, never the agent — what
  is being approved, the amount, and what was shown are assigned server-side at mint time;
- the human MUST resolve on a surface separate from the agent's channel;
- the resolution MUST carry a signed receipt; after the fact, neither party can rewrite it.

A dispute reduces to reading the record, not comparing memories. Stated limit: the record
proves what was displayed and what was resolved. It does not prove the human *understood* it;
comprehension remains a human problem and this specification does not pretend otherwise.

# 8. Calibration and Outcome Provenance (SHOULD)

Attestation is not calibration: a receipt proves what was predicted, not that the verdict was
right. Oracles SHOULD pre-register every verdict (signed receipt issued before the outcome is
known, hash-bound) and SHOULD score verdicts against realized outcomes, with **outcome
provenance as a first-class axis**: chain-attested outcomes, then third-party-resolver-attested,
then counterparty-corroborated, then caller self-report — self-reported outcomes segregated and
discounted, never pooled into a headline number. An outcome source is admissible only if it is
named before the claim, operated outside the claimer's control, and non-revisable after
resolution.

# 9. Protocol Integration (Non-Normative)

Position in the x402 flow: client requests resource → server responds `402` with `accepts` →
**client assembles the Preflight Record** (queries a risk oracle — itself typically an
x402-payable resource — and its state holder; obtains human confirmation if the verdict is
HOLD) → signing rules pass → client signs the payment authorization and retries with the
payment header. The record's `payment.*` fields are populated directly from the 402 challenge's
`accepts` entry, which prevents a class of steering attacks: the record binds the *challenged*
payment, not whatever the model later believes it agreed to.

This extension composes with the Offer and Receipt extension: an offer is the server's signed
commitment to terms; the preflight record is the client's assembled justification for
accepting them; the receipt is proof of the completed exchange. Before / during / after.

# 10. Relationship to Adjacent Work (Non-Normative)

- **Offer and Receipt (this repo):** structural sibling; see §9.
- **Mastercard Verifiable Intent:** delegation-chain credentials; explicitly out of its scope
  are confirmation receipts, budget state, and risk data — a VI credential can ride in this
  record's authority block as delegation evidence.
- **AP2 Agent Authorization Framework:** static user-signed constraints (budget, allowed
  payees). This record carries the *live* state those constraints govern (spent, remaining,
  idempotency, rollback) plus a third-party risk verdict. AP2 v0.1 reserved an intentionally
  open-ended Risk Payload; v0.2 removed it without replacement — this record's `risk` block is
  a candidate concrete schema for that vacated slot.
- **OWASP AI Agent Security guidance (2026):** prescribes action-bound, expiring approvals and
  independent pre-execution validation, without a schema. This record is a candidate schema
  for that requirement.
- **Still OS claim-vocabulary specification** (nolawealthfinancial.com/evidence/notary-doctrine/
  claim-vocabulary-spec.json): an open, versioned vocabulary for post-hoc claim resolution
  against external resolvers. Complementary by tense: that specification speaks *after* (what a
  claim resolved to, against which source, with what freshness); this record speaks *before*
  (whether a payment is safe to sign). Its resolver types are candidate suppliers for this
  record's third-party outcome-provenance tier (§8), and its per-resolver freshness taxonomy
  informs §5.5. The two documents cite each other by mutual agreement rather than duplicating.

# 11. Use Cases (Non-Normative)

- An autonomous purchasing agent gates every x402 payment on a GO verdict within a declared
  envelope, with HOLD escalating to a human confirmation that expires in minutes.
- A platform holding agent budgets refuses signatures whose records cite verdicts outside the
  oracle's declared coverage — silence no longer reads as safety.
- An enforcement or arbitration layer references the record as the deterministic artifact of
  what was known, checked, authorized, and signed — in that order.

# 12. Security Considerations

- **Hostile oracle:** the envelope is consumer-evaluated; §5.2's fail-closed rules and §5.3's
  no-patterns rule are the containment. Dispatch ambiguity (a dimension carrying a passing
  predicate alongside an unevaluated one) MUST fail closed — this is the empirically dangerous
  bypass class.
- **Prompt injection / steering:** record fields are data, never instructions; `payment.*` is
  bound to the 402 challenge, not to model output; the confirmation is minted and resolved
  outside the agent's channel.
- **Replay:** `record_id` + `idempotency_key` are single-use; confirmations are record-bound
  and expiring.
- **Self-flattering telemetry:** §8's provenance tiers exist because callers grade their own
  homework otherwise.

# 13. Privacy Considerations

The record contains payment metadata, not payload content. Implementations SHOULD keep
personal data out of `resource` strings and SHOULD treat records as auditable business
documents with corresponding retention discipline.

# 14. Acknowledgements

This specification was materially improved by a public design review on Moltbook (July 2026)
before submission: @cohesivity (the record framing; `instruction_epoch`), @Starfish (expiring
pre-authorization receipts; the separate log of what was shown), @otto-sba (verdict-author
independence; fail-closed on the undeclared edge; attestation-is-not-calibration and the
outcome-authorship recursion), @evil_robot_jas (dispute semantics), @xiao_shuai_oc (cold-start
honesty; cross-payee sparsity), @LnHyper (the delivery-oracle boundary; verdict-schema
convergence), @jontheagent (scope termination; remedy interface), @fridaykirill (the authority
lease), @stillos (the outcome-source independence triad; the per-resolver freshness taxonomy
adopted in §5.5, per the mutual-citation agreement of 2026-07-04), @gadgethumans-hub ("courts
need deterministic artifacts"), @miacollective (the naive-HOLD injection/latency critique that
sharpened §6.1/§6.2 — bounded, fail-closed-on-silence, operator-tiered escalation; and §6.3 —
the no-shared-story / facts-fetched-complete escalation surface, and the honest reduction of
residual intent-poisoning to the invoice-fraud floor).

# 15. Version History

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 0.1-draft | 2026-07-03 | BlueTier Operations (Black_Wall) | Initial draft for RFC |
