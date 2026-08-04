# Scheme: `mandate-bound`

## Summary

`mandate-bound` settles a payment under a constraint envelope — a typed-data mandate the principal signs once and the agent reuses across multiple HTTP-402 settlements within its bounds (per-tx cap, cumulative cap, asset allowlist, validity window). The settling contract verifies the envelope, walks a policy chain, and either settles or reverts with a typed refusal code. A state-read-only `dryRun` simulator returns the same code, so buyer agents can plan multi-leg flows without burning nonces.

## Example Use Cases

- An agent settles N micropayments to N sellers under one principal-signed envelope, without re-prompting the human per-call.
- A buyer agent simulates a payment off-chain (`dryRun`), reads back a typed refusal code (e.g. `MANDATE_PER_TX_CAP`), and adjusts its plan before submitting.
- A seller batches accumulated micropayments from one mandate into a single on-chain settlement, charging the cumulative-cap counter once.

## Critical Validation Requirements

Implementations MUST:

1. Verify the principal's signature over the mandate envelope using EIP-712 typed-data hashing (or the chain-specific equivalent). Smart-contract principals are first-class via EIP-1271 fall-through.
2. Verify the agent's signature over the same envelope when `agent != principal`.
3. Reject envelopes outside the `[notBefore, expiresAt]` window.
4. Reject settlements exceeding `maxPerTxUsd` or projecting past `maxTotalUsd` against a registry-tracked cumulative-spend counter keyed on `mandateId`.
5. Reject settlements where the destination asset is not in `assetAllowlist` (or the list is the explicit "any asset" sentinel).
6. Treat `(mandateId, nonce)` as one-shot to prevent replay.
7. Surface refusals as typed codes, not opaque error strings, so agents can branch on the cause.
8. Provide a state-read-only `dryRun` simulator whose returned refusal code is byte-equivalent to the code a real settlement would revert with.

The envelope shape is rail-agnostic; this scheme covers the on-chain settlement path. Per-chain documents specify concrete envelope encoding, signature verification, and settlement flow.

- [EVM](scheme_mandate-bound_evm.md)

## Appendix

Reference implementation under MIT at https://github.com/rivier-ai/rivr (`contracts/src/rivier-token/`). The implementation is independent of the spec; the scheme contract is the envelope, the verification ordering, and the typed refusal codes.
