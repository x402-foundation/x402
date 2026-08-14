# Scheme: `exact`

## Summary

`exact` is a scheme that transfers a specific amount of funds from a client to a resource server. The resource server must know in advance the exact
amount of funds they need to be transferred.

## Example Use Cases

- Paying to view an article
- Purchasing digital credits
- An LLM paying to use a tool

## Payment Flow

By default, `exact` uses the `authorization` payment flow (verify → resource → settle): the payment is verified before the resource executes and settled afterward. See [Payment Flow Models](../../x402-specification-v2.md) (section 6.1) in the core specification.

## Asset Transfer Methods for Pre-Handler Settlement: The `upfront` Payment Flow
 
`exact` may also be used with the `upfront` payment flow (settle → resource → respond). In that ordering the facilitator's `/verify` endpoint is not invoked: validity is established by settle, and commitment does not need to be an onchain write — settle MAY bind a payment to the request after read-only observation of ledger state. See [Payment Flow Models](../../x402-specification-v2.md) (section 6.1) and `/settle` (section 7.2) in the core specification.

The families described below are descriptive categories used by this specification. They are not `assetTransferMethod` values, and this section introduces no new field. `assetTransferMethod` values remain mechanism-defined (section 6.1), and settlement ordering is already set in the wire by `extra.paymentFlow`. A mechanism MUST state which family its method belongs to and MUST satisfy that family's requirements below.
 
Two families of asset transfer method are defined under this flow. They differ in which party submits the payment, which determines how replay safety is obtained:
 
| Family | Who submits the payment | Replay safety | Facilitator state |
| --- | --- | --- | --- |
| Signed transaction (facilitator-submitted) | Facilitator, during settle | Network-enforced (account nonce, UTXO, or equivalent) | None required |
| Payment proof (client-executed) | Client, before the request reaches the resource server | Enforced by the mechanism, the payment instrument, and a consumed-proof store | Consumed-proof store required |
 
Mechanisms SHOULD implement a facilitator-submitted method where the network and payer tooling permit it, and a client-executed one only where they do not.
 
### Signed transaction (facilitator-submitted)
 
The client signs a transaction but does not submit it. The facilitator submits it during settle. Because the transaction is submitted by the facilitator within the request's own settlement, replay safety is inherited from the network and no facilitator-side deduplication is required.
 
- Submission: the facilitator MUST submit the signed transaction during settle, before the resource executes, and MUST NOT return success until the transaction has reached the mechanism's declared finality condition.
- Transfer correctness: the signed transaction MUST transfer exactly `requirements.amount` of `requirements.asset` to `payTo`, and MUST NOT contain additional value-moving operations.
- Facilitator safety: the facilitator's own address MUST NOT appear as a funding source or transfer authority in the signed transaction.
- Replay protection: the mechanism MUST rely on the network's own replay primitive (account nonce, UTXO consumption, or equivalent) and MUST verify that primitive is unconsumed at settle time. Facilitators SHOULD NOT be required to maintain a consumed-payment store for this family.
- Expiry: where the network supports transaction validity windows, the signed transaction's window MUST cover the advertised `maxTimeoutSeconds` at settle time.

### Payment proof (client-executed)
 
The client executes the payment itself and presents a proof of it. Settle validates that proof and binds it to the request. This family applies where the payer cannot produce a signed but unsubmitted transaction or where the client's payment initiates asynchronous downstream settlement rather than being the settlement itself. It carries strictly weaker guarantees than a facilitator-submitted method and requires the state described below.

Proofs are specific to each mechanism: an onchain transaction reference, or a cryptographic settlement secret such as a payment preimage.

- Proof identity: the payment payload MUST carry the mechanism's proof artifact. Mechanisms MUST define a canonical consumption identifier for the payment, formed as a CAIP-2 network identifier joined to the mechanism's canonical payment identifier (an onchain transaction hash, a payment hash, or equivalent). Mechanisms MAY define a narrower identifier where a single payment can satisfy more than one requirement set.
  - Mechanisms MAY accept more than one proof form where the network supports it; where they do, they MUST state how each form is identified and validated, and MUST define a consumption identifier for each.
- Proof validation: mechanisms MUST make clear whether the proof is self-verifying, i.e., cryptographically checkable against the payment requirements without querying a ledger or node, as when a preimage is checked against a payment hash, or whether validation requires observing ledger or backend state. Self-verifying proofs SHOULD be preferred, as they remove a liveness and trust dependency from settle.
- Single-use claim: a proof MUST be atomically claimed before the resource executes. Where two requests present the same proof concurrently, exactly one MUST succeed in claiming it, the other MUST be rejected.
- Requirement binding: presenting a proof alone does not establish that the payment was made for this request. Mechanisms MUST declare which binding they rely on, from: (a) a payment instrument unique to this request — a per-payment recipient address, or an invoice issued for this request — so that a payment against that instrument is bound to the requirements that advertised it; (b) a server-issued nonce carried in the payment itself, as a memo, destination tag, `OP_RETURN` output, or calldata suffix; (c) a signature by the payer over the payment requirements, carried in the payment payload; or (d) a commitment to the payment requirements signed by the payee and embedded in the payment instrument the client must satisfy, such as a BOLT11 `description_hash` over the canonicalized requirements. Mechanisms MUST NOT depend on an optional protocol extension to obtain this binding, and MUST NOT rely on transport integrity alone.
- Payer identity: mechanisms relying on a declared payer address MUST state that a declared, or even ownership-proven, address does not bind the actual sender of the payment. The sender is observable only once the payment exists.
- Amount acceptance: acceptance follows the amount semantics of the exact scheme. Because the client controls the amount it sends, mechanisms MUST state how a non-conforming payment, below or above the required amount, is handled, including whether and by what path it is returned.
- Finality: mechanisms MUST declare the condition under which a payment is final, i.e, which observable event constitutes finality for settle, which party owns confirmation-depth policy on networks with probabilistic finality, and where settlement completes in more than one stage, which stage is the finality boundary. That single declaration determines the payment's state at settle time: *not yet final*, where the condition is unmet but may still be met; *final-success*, where it has been met; and *final-failure*, where it can no longer be met. The latter two are terminal states, and the requirements below are expressed in those terms.
   - Not yet final: where the payment is not yet final, settle MUST NOT permanently consume the proof, MUST NOT deliver the resource, and MUST return an error identifying the unmet condition. The proof MUST remain usable for a later attempt: any in-flight claim held for the failed attempt MUST be released before returning, and implementations MUST ensure that an attempt terminating abnormally cannot leave a proof claimed indefinitely.
   - Proof lifecycle: the proof MUST be claimed as in-flight when settle begins and permanently consumed only when the payment reaches a terminal state. A proof MUST NOT be permanently consumed before then, so that a transient settlement failure does not burn a payment that never delivered the resource, and MUST NOT be accepted again afterward.
- Failure disposition: mechanisms MUST state, for each final-failure state, whether the payment is returned to the payer and by what path. Refunds are out of protocol unless the mechanism provides one; clients MUST NOT assume a refund path exists.
- Capability documentation: mechanisms MUST document their `assetTransferMethod` value and any variants, so that facilitator support for the method can be enumerated by capability declaration; see `GET /supported` (section 7.3) in the core specification.

Mechanisms whose payment instrument can be held conditionally before being settled or released, MAY instead target the `escrow` payment flow (section 6.1), where settle runs both before and after the resource executes.

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

### Starknet

- Facilitator safety: the submitting executor MUST come from facilitator configuration, never client input, and MUST NOT be the payer or the recipient.
- Transfer correctness: the signed SNIP-9 OutsideExecution MUST contain exactly one call — `transfer` on `requirements.asset` with calldata `[payTo, amount_low, amount_high]` — and the u256 amount MUST equal `requirements.amount` exactly.
- Signature validity: the SNIP-12 hash MUST be computed from the facilitator's own canonical reconstruction of the typed data and validate via SNIP-6 `is_valid_signature`.
- Caller binding and expiry: `Caller` MUST equal `extra.feePayer` — the required sponsor address the facilitator announces via `/supported` and the resource server puts in the requirements; `Execute Before` MUST cover the advertised `maxTimeoutSeconds` window (within a skew margin) at verification, with a minimum remaining window at settlement.
- Replay protection: the SNIP-9 nonce MUST be unused at verification; it is consumed on-chain at execution.
- Simulation verification: MUST simulate the settlement and fail closed unless it shows exactly one asset `Transfer` from payer to `payTo` for the exact amount.

Network-specific rules are in per-network documents: `scheme_exact_svm.md` (Solana), `scheme_exact_stellar.md` (Stellar), `scheme_exact_evm.md` (EVM), `scheme_exact_sui.md` (SUI), `scheme_exact_ton.md` (TON), `scheme_exact_starknet.md` (Starknet).
