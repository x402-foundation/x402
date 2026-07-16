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

## `verify()` must be fail-closed relative to `settle()`

`verify()` is the facilitator's last opportunity to reject a payment before it sponsors fees and submits the transaction to consensus. It MUST return `isValid: false` for every condition that would cause `settle()` to fail on-chain.

A `verify()` that validates transfer semantics (amounts, destinations, scheme version) but skips security-critical pre-conditions is unsafe: the facilitator sponsors fees and network round-trips for transactions the ledger will reject.

### Three negative cases every `exact` mechanism MUST handle

These apply to all networks regardless of signing scheme:

**1. Payer signature invalid**

`verify()` MUST reject transactions where the inferred payer did not produce a valid signature over the frozen transaction body. This includes:

- A transaction signed with the wrong private key
- An unsigned (serialized but never signed) transaction body

A facilitator that does not verify the payer's signature will: (a) add its own fee-payer signature and submit; (b) receive `INVALID_SIGNATURE` (or equivalent) from the ledger; (c) have paid fees for a payment that was always going to fail on consensus.

**2. Recipient cannot receive the asset**

`verify()` SHOULD reject transactions where `payTo` cannot receive the specified asset. Common cases:

- HTS, SPL, or Stellar asset not associated or opted-in to the receiver account
- Receiver account inactive or not yet initialized for the token

Preflight via the network's REST API or RPC is the reliable data source. Do not rely on fields that network nodes have stopped returning reliably; always use an authoritative off-chain query (e.g. Mirror Node for Hedera, JSON-RPC for EVM, Solana `getAccountInfo` for SVM).

**3. Payer balance insufficient**

`verify()` SHOULD reject transactions where the payer does not hold at least `requirements.amount` of the specified asset at verify time. An on-chain balance query via the network's REST or RPC API is the minimum reliable source.

### Consequence of skipping any case

| Missing check | `verify()` result | `settle()` result |
|---|---|---|
| Payer signature | `isValid: true` | `INVALID_SIGNATURE` / equivalent |
| Recipient not provisioned | `isValid: true` | `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` / equivalent |
| Payer balance | `isValid: true` | `INSUFFICIENT_BALANCE` / equivalent |

In all three cases the facilitator has already sponsored a fee for a payment that was undeliverable at verify time.

### Error reason conventions

Mechanism-specific `invalidReason` values SHOULD follow the pattern:

- `invalid_exact_{mechanism}_payload_signature_invalid`: payer did not sign the frozen body
- `invalid_exact_{mechanism}_payload_preflight_failed`: recipient provisioning or balance check failed

Per-mechanism documents SHOULD document the specific reason strings and the data source used for each check.
