# Correctness and Dispute Extension

Status: Draft · Layer: downstream of settlement · Relates to: offer-and-receipt extension, issue #2887

## Motivation

x402 specifies how payment is offered, made, identified, and settled, and how a
receipt proves it. It does not specify what happens when the thing paid for was
**wrong** — a tool returns an incorrect result, a feed serves stale data, an answer
fails against ground truth. Payment correctness and *delivery* correctness are
different guarantees. Settlement proves money moved; it says nothing about whether the
counterparty earned it.

This extension defines a dispute path and a **bonded verdict**: a neutral adjudicator
stakes collateral that is slashed if its verdict is shown wrong, so a correctness claim
carries economic weight rather than reputation alone.

## Terms

- **Resolver** — the named source of ground truth a verdict is resolved against,
  identified by `resolver_id` and `resolver_version`.
- **Criterion** — the specific, pre-agreed test the work is judged against,
  identified by `criterion_id`. A verdict without a criterion is an opinion.
- **Verdict** — a signed, hash-chained statement (`CONFIRMED | REFUTED | PARTIAL |
  INSUFFICIENT_DATA`) over a disputed claim, bound to its criterion, its evidence and
  its resolver version.
- **`INSUFFICIENT_DATA`** — the criterion **could not be evaluated**. It is explicitly
  **NOT** a finding of incorrect work and **MUST NOT** be rendered, aggregated or
  reported as one. It makes no claim in either direction.
- **Correctness bond** — collateral held by the adjudicator, with a declared
  `per_verdict_max` slashable amount and a public on-chain balance.

## Normative requirements

1. A verdict **MUST** name its resolver and be independently re-verifiable: a third
   party recomputes the verdict hash from a published preimage and checks the signature
   against the adjudicator's key. (This reuses the receipt extension's signature model.)
   **Recomputing a hash and checking a signature proves only WHO asserted WHICH
   statement. It does not re-check whether the work was correct.** These are two
   distinct operations and an implementation **MUST NOT** present the first as the
   second. Accordingly, a verdict **MUST** carry `criterion_id`, the `evidence_digest`
   it was evaluated against, `resolver_id` and `resolver_version`, and **MUST** publish
   the command or procedure by which an independent party re-evaluates that criterion
   against that evidence and reaches its own verdict.
2. An adjudicator offering bonded verdicts **MUST** publish, at a stable endpoint: the
   bond wallet, network, asset, `bonded_total`, `per_verdict_max`, live on-chain
   balance, custody type, and a running `slash_count` / `slashed_total`.
   **A visible balance is not a reservation and is not enforceably slashable on its
   own.** The same endpoint **MUST** therefore also declare: who may withdraw the
   collateral and after what delay; which party is authorised to order a slash and
   under what authority; the challenge window, its deadline, and what happens when the
   deadline passes unanswered; and the amount currently **reserved** against open
   verdicts versus free. A custody policy (for example 2-of-N multisig) is a control
   over **movement** of funds and **MUST NOT** be presented as establishing a
   guaranteed payout.
3. `per_verdict_max` **MUST NOT** exceed the on-chain balance divided by outstanding
   unslashed obligations; an adjudicator **MUST** report any unpaid or overdue slash
   obligation rather than advertise capacity it cannot cover.
4. A bond **MUST** declare whether a payout SLA is committed or best-effort; an
   uncommitted SLA **MUST NOT** be presented as a guarantee.
5. A dispute record **MUST** be append-only and reference the receipt it disputes.
   **`payment_identifier` alone is NOT a unique authenticated settlement reference**
   and **MUST NOT** be the sole binding: an unrelated payment reusing the same
   identifier would otherwise inherit the verdict. The reference **MUST** be scoped to
   `(payer, payee, operation)` and **MUST** link the exact verified settlement evidence
   — the receipt digest or on-chain settlement reference — that the verdict was issued
   against.
6. A bond **MAY** accept external contributions and **MAY** reinvest realized
   revenue into collateral; where it does, `per_verdict_max` scales with funded
   collateral, so the correctness guarantee compounds as capital is contributed
   rather than being fixed at issuance. Contribution and payout terms **MUST** be
   public, and the live collateral balance **MUST** remain independently checkable
   (requirement 2). This lets the party that bears a loss co-fund the guarantee that
   protects them, rather than requiring a single adjudicator to pre-commit all capital.

## Security considerations

- The bond caps the adjudicator's maximum lie-cost at `per_verdict_max`; consumers
  **MUST** treat a verdict's trust as bounded by that figure, not by the adjudicator's
  claims. A $1 `per_verdict_max` secures a verdict to $1, no more.
- Self-adjudication is disallowed: an adjudicator **MUST NOT** rule on a claim where it
  is the paid counterparty.
- Resolver drift: if the resolver's source changes after a verdict, the verdict is
  reported as unreproducible rather than silently re-resolved.

## Reference implementation (live)

StillOS Notary runs this today: bonded verdicts against named resolvers, Ed25519-signed
and hash-chained, with an on-chain correctness bond on Base (2-of-2 Gnosis Safe custody)
whose balance and slash history are public and re-verifiable. Endpoints:
`/notary/bond` (bond state, free), `/notary/claim-verdict` (signed verdict, priced —
answers HTTP 402), `/notary/verify?hash=` (recompute any verdict or receipt, free).
The bond starts small by design and is built to compound via reinvestment and open
contribution (requirement 6); the mechanism, not the current amount, is what this
extension standardizes.

Conformance vectors **MUST** be published in two separately labelled sets, because they
test different properties and conflating them is exactly the failure mode requirement 1
warns about:

- **Hash / signature conformance** — proves record integrity and authorship. Proves
  nothing about whether the work was correct.
- **Verdict correctness** — a `criterion_id`, its `evidence_digest` and
  `resolver_version`, re-evaluated independently to reach a verdict without trusting
  the adjudicator's.

What this reference implementation currently publishes is the **first set only**: 12
real receipts, each reproducing `SHA-256(preimage)` cross-language byte-for-byte. The
vectors carry no `criterion_id` or `resolver_version`, so **no correctness-conformance
set exists yet** and the published set must not be read as one. That gap is stated
here rather than papered over; it is tracked as the next change to the kit.

https://github.com/stillmarcus24/notary-x402-reference-kit/blob/main/conformance/dispute-extension-vectors.json
