# Fiscal authority readiness card sample

This directory is a small discovery index for public, no-secret fiscal-authority
readiness card examples.

The sample is intentionally a reference index, not the authoritative store for
contributor-maintained card bytes. Contributors keep their filled cards in
their own repositories or public surfaces, where they can keep values fresh
against their source systems. The x402-side files here point to those cards by
URL and content hash so buyer-agent preflight implementations can discover and
verify them without copying contributor-owned bytes into this repository.

## Scope

The readiness card is a buyer-agent preflight artifact for x402 resources. It
answers whether an autonomous buyer-agent can spend without a human in the loop
and records the public evidence behind that answer.

The card is not a wallet, credential, private dashboard, payment link, or
compliance oracle. Every referenced field must be safe to publish.

## Common substrate

The examples in this directory should converge on these common primitives:

- content-addressed references use sha256:<lowercase-hex-64> over
  JCS-canonicalized bytes when the referenced object exists
- canon_version is in-band, currently jcs-rfc8785-v1
- freshness is explicit enough for buyer-agent preflight
- absent evidence remains informative: missing, partial, null, or omitted by
  domain rule; examples should not invent fake hashes or fake authority

## Domain fields

Fiscal-authority readiness cards are expected to carry the domain fields that a
buyer-agent needs before spend:

- price or discovery-time ceiling
- authority / approval source
- cap, including enforcement type and currency or unit
- charge evidence, including receipt or signed attestation references
- canonicalization and hash profile
- revocation or dispute path
- preflight verdict, including buyer_agent_can_spend_without_human

## Indexed examples

| File | Status | Variant |
| --- | --- | --- |
| 0001-vauban-bounded-spend.json | committed contributor-owned reference | cryptographic cap / receipt |
| 0002-algovoi-signed-attestation.json | ready contributor-owned reference | facilitator policy cap / signed attestation |

Future examples, such as a CREST urn:crest:trust-check-v1 independent
observation envelope, can be added as separate reference stubs when a public
no-secret URL and content hash are available.
