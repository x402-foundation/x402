# Scheme: `exact`

## Summary

`exact` is a scheme that transfers a specific amount of funds from a client to a resource server. The resource server must know in advance the exact
amount of funds they need to be transferred.

## Example Use Cases

- Paying to view an article
- Purchasing digital credits
- An LLM paying to use a tool

## Appendix

## Critical Validation Requirements

While implementation details vary by network, facilitators MUST enforce security constraints that prevent sponsorship abuse. Examples include:

### SVM

- Fee payer safety: the fee payer MUST NOT appear as an account in sensitive instructions or be the transfer authority/source.
- Destination correctness: the receiver MUST match the `payTo` derived destination for the specified `asset`.
- Amount exactness: the transferred amount MUST equal `maxAmountRequired`.

### Stellar

- Facilitator safety: the facilitator's address MUST NOT appear as transaction source, operation source, transfer `from` address, or in authorization entries.
- Authorization integrity: auth entries MUST use `sorobanCredentialsAddress` only, MUST NOT contain sub-invocations, and expiration MUST NOT exceed `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)` (fallback to `5` seconds).
- Transfer correctness: `to` MUST equal `payTo` and `amount` MUST equal `requirements.amount` exactly.
- Simulation verification: MUST emit events showing only the expected balance changes (recipient increase, payer decrease) for `requirements.amount`—no other balance changes allowed.

### TON

- Transfer correctness: exactly 1 `jetton_transfer` with destination equal to `payTo` and amount equal to `requirements.amount` exactly.
- Signature validity: Ed25519 signature MUST verify against a public key derived from the BoC's `stateInit` (seqno == 0) or from the on-chain `get_public_key` getter (seqno > 0). Only `internal_signed` (0x73696e74) opcode is supported in the current gasless flow.
- Wallet code validity: contract code MUST match a known W5 wallet contract, using `stateInit` for `nonexist`/`uninit` wallets and on-chain code for `active` wallets.
- Replay protection: seqno MUST be strictly equal to on-chain value; duplicate `settlementBoc` submissions rejected via BoC hash dedup.
- Simulation verification: SHOULD simulate via emulation during `/verify` to confirm expected balance changes.

Network-specific rules are in per-network documents: `scheme_exact_svm.md` (Solana), `scheme_exact_stellar.md` (Stellar), `scheme_exact_evm.md` (EVM), `scheme_exact_sui.md` (SUI), `scheme_exact_ton.md` (TON).
