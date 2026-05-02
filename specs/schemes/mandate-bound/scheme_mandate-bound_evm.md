# Mandate-bound payment envelope — settlement-side primitive for x402 sellers

## Summary

Proposing a contribution to x402 from the **settlement side**: a typed
mandate envelope verified at the token contract, so an x402 seller's
receiver can prove the payment carried a valid AP2-compatible
authorization without trusting the relaying agent or the buyer's wallet
client.

## Context

x402 today specifies the request/response shape for HTTP 402 payments
on top of EIP-3009 `transferWithAuthorization`. The seller verifies
that USDC moved; what the seller can't currently verify on-chain is
**why** the buyer's agent authorized the transfer — caps, asset
allowlists, expiry, principal binding.

We've shipped this as a token-level primitive in RIVR: every
transferring path verifies an EIP-712 `MandateEnvelope` carrying the
constraints the user pre-signed. The same envelope shape is an obvious
fit for x402 sellers who want stronger guarantees than "the agent paid"
— specifically, "the agent paid within the user's mandated cap on a
mandated asset before mandate expiry."

## What we're proposing

A **non-breaking** addition to the x402 `payment_requirements` shape:
an optional `mandate_envelope_required: true` flag plus a verifier
contract address. When set, the facilitator validates the buyer's
mandate envelope against the verifier before settling.

This composes cleanly with EIP-3009 — `transferWithAuthorization` runs
as today; the mandate gate is an *additional* check, not a replacement.

## Reference implementation

- Contract: https://github.com/rivier-ai/rivier/blob/main/contracts/src/rivier-token/RivierTokenCCT.sol
- Mandate type: https://github.com/rivier-ai/rivier/blob/main/contracts/src/rivier-token/types/MandateEnvelope.sol
- Test suite: https://github.com/rivier-ai/rivier/tree/main/contracts/test/rivier-token (113 tests)
- 113 forge tests including `dryRun` byte-equivalence (10 dedicated cases) and namespace sum-preserving fuzz invariants
- Audit: not yet commissioned (independent contributor, pre-funding); engagement planned post-launch

## Position

RIVR is the first stablecoin where mandate validation, agent
attestation, programmable batching, and continuous settlement streams
are token-contract primitives — not orchestration above an inert
ERC-20. We're contributing the mandate-envelope shape upstream so x402
sellers can adopt the pattern even when settling in USDC.

## What we're asking for

1. Feedback on the proposed shape from facilitator implementers
2. A path to a draft spec PR if the shape is acceptable
3. Working-group discussion on whether mandate verification belongs
   in the x402 spec or in a sibling specification

Happy to write the draft PR, run the working-group sync, or both.
