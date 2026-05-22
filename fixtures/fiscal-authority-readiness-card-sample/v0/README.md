# Fiscal Authority Readiness Card -- Sample v0

## What this is

This directory contains a filled `fiscal_authority_readiness_card_v0` artifact, using the card shape proposed by @egoriklok in x402-foundation/x402#2405.

The card is filled against the **Vauban bounded-spend fixture** introduced in PR #2432 (`fixtures/bounded-spend-authorization-sample/v0/vectors/0001-baseline.json`). It is a public, no-secret preflight artifact: every field is inspectable without API keys, wallets, or dashboards. A buyer agent can evaluate fiscal authority coverage before attempting a spend.

## Files

| File | Description |
|------|-------------|
| `0001-vauban-bounded-spend.json` | Filled card for the Vauban bounded-spend baseline vector |

## How the card maps to the fixture

The source vector (`0001-baseline.json`) encodes a `DelegationGrant` plus a `SettlementReceipt`. The card surfaces the fiscally relevant fields in a single flat artifact:

- **authority**: the grantor is a `human_principal` identified by a `UserPseudonym` pseudonymous address. The agent spending within the grant's cap requires no further human approval at spend time.
- **cap.enforcement = cryptographic**: the `DelegationGrant` is cryptographically signed (HMAC-SHA-256 over a JCS-canonical payload). The cap is not a facilitator policy assertion; it is verifiable against the `grant_hash`.
- **cap bounds**: 1 000 000 micro-USDC per transaction, 100 000 000 micro-USDC per 86 400-second period.
- **charge_evidence**: a settled `SettlementReceipt` with a live Starknet Sepolia transaction hash anchors the charge.

## Honest PARTIAL statuses

Two fields carry `PARTIAL` status rather than `PASS`. These are honestly flagged, not elided:

1. **canonicalisation.status = PARTIAL**: the fixture's `canon_version` field currently carries value `"1.0"`. A normalised identifier (`jcs-rfc8785-v1`) is tracked under PR #2436. The algorithm itself is JCS-RFC8785 with SHA-256; the partial flag signals the version string is not yet finalised.

2. **revocation.status = PARTIAL**: the `revocation_authority` URL (`https://pay.vauban.tech/.well-known/revocation/v0/`) is declared in the grant anchor and present in the card. The endpoint is not yet a live status surface in Vauban Pay Phase MVP. A buyer agent should resolve this URL at preflight; if it returns no valid revocation status, treat the grant as unverified-for-revocation before spending.

## Preflight interpretation

`preflight_verdict.buyer_agent_can_spend_without_human = true` because:

- The authority source is a `human_principal` who has pre-delegated spend authority via a signed grant.
- The cap is cryptographically enforced and verifiable locally.
- The two PARTIAL fields do not block spend; they signal verification gaps the agent should resolve or log before each transaction.

`preflight_verdict.status = PARTIAL` (not `READY`) because the revocation endpoint has not been confirmed live at the time this card was produced.

## Connection to x402#2405

@egoriklok proposed this card shape to enable buyer agents to perform fiscal authority preflight without human escalation when grants are well-formed. This filled card is the concrete example they asked for: one card, one fixture, all fields populated, PARTIAL statuses explained.

If you are evaluating whether a buyer agent can spend autonomously against a Vauban bounded-spend grant, this card is the artifact to inspect first.
