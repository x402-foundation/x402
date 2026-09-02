# Scheme: `contingent`

**Status:** Draft 0 — proposed for discussion. Not implemented; conformance vectors not yet pinned.

## Summary

`contingent` makes settlement and delivery a single cryptographic event. The server executes the request *first* and returns the result encrypted; the client's payment authorization is an adaptor pre-signature whose completion by the server (a) settles through the existing rail unchanged and (b) reveals the decryption key for the already-delivered ciphertext. The state "payment happened but delivery didn't" is not detected or remediated — it is unconstructible.

Compared to `exact`:

- No escrow, no held funds, no refund path — no partial state can exist.
- Zero on-chain changes: settlement receives a completed, standard signature. All novelty lives in client construction, server completion, and facilitator verification.
- One additional round trip (quote → offer → accept), amortizable under sessions.

What this scheme does NOT provide: correctness of the plaintext beyond a hash binding. A server can deliver a valid box containing a wrong answer; that failure class is left to receipt and arbitration layers, which this scheme feeds with a self-contained evidence bundle (ciphertext, commitment, settlement receipt).

## Example Use Cases

- **Paid inference / analysis APIs**: the buyer cannot be charged for a 5xx, a timeout, or a withheld response; the seller cannot settle without simultaneously releasing the result.
- **One-shot data products** (reports, renders, datasets): delivery-versus-payment without a marketplace intermediary or escrow contract.
- **Agent-to-agent commerce with no shared trust**: neither party needs reputation, history, or an arbiter for the delivery-atomicity failure class.

## Flow

```
1. Client  → request
2. Server  → 402 (quote: accepts[] carries scheme "contingent")
3. Client  → request + PAYMENT-SIGNATURE {phase: "request"}
4. Server  → executes the work NOW, then
             402 (offer: ciphertext + key commitment + binding commitment)
5. Client  → request + PAYMENT-SIGNATURE {phase: "accept", adaptor pre-signature}
6. Server  → completes pre-signature with secret t → standard settlement path
           → 200 OK + PAYMENT-RESPONSE {transaction, completedSignature}
7. Client  → extracts t from the completed signature, decrypts,
             checks the plaintext against the binding commitment
```

Step 4 responding `402` again is deliberate: the resource is still unpaid — the client holds a locked box. Step 6's settlement is itself the trustless delivery channel: even if the server goes silent after settling, the completed signature is recoverable (from chain data or the facilitator's settlement response), and the client extracts the key from it.

## Core Invariants

- **Execute-then-lock.** The server MUST fully produce the response before any payment authorization exists. A failed or withheld response cannot be charged for, because no pre-signature is ever produced against it.
- **Key = payment witness.** The decryption key for the delivered ciphertext MUST be the adaptor secret whose revelation is inherent to completing the payment signature. Settled ⇒ key public to the pre-signature holder.
- **Binding commitment.** The offer MUST commit to the plaintext (e.g., a hash), so misdelivery after settlement is provable from artifacts the client already holds.
- **Quote binding.** The payment authorization MUST be cryptographically bound to the specific quote, price, payee, and resource, such that any drift fails closed (see per-chain specs).
- **At-most-once settlement** MUST fall out of the rail's existing replay protection; the scheme adds no settlement infrastructure.

## Critical Validation Requirements

Facilitators MUST, in addition to the standard checks (balance, amount ≤ quoted, time window):

- Verify the pre-signature is well-formed and completable against the offer's key commitment (for ECDSA rails this requires a DLEQ proof — see the chain spec).
- Recompute and verify the quote binding from the offer fields; reject on mismatch.
- Echo the completed signature in the `SettlementResponse`, so key extraction survives batch settlement (where individual signatures may never appear in calldata).

### EVM

See `scheme_contingent_evm.md` (EIP-3009 / `transferWithAuthorization`).

Other networks: a Schnorr-native variant is cleaner than the ECDSA construction and SHOULD be preferred wherever the rail supports it. No other chain specs are drafted yet.

## Known Costs

- **+1 round trip** versus `exact`. Sessions amortize this across calls to the same origin.
- **Seller-side griefing surface**: the server computes before payment is assured. Mitigations are economic and idiomatic — session-gated access, per-client rate limits, small quote fees for expensive routes.
- **New signing-side SDK surface** for clients (adaptor pre-signature + proof). No new on-chain interaction for the client.

## Appendix

### Prior art

- **zkCP** (Maxwell, concept 2011; executed on Bitcoin 2016): payment-completion-reveals-key.
- **Adaptor signatures**: atomic-swap literature; ECDSA variants require a proof of completability (Moreno-Sanchez et al., Aumayr et al.).
- **A402** (arXiv:2603.01179, 2026): TEE-assisted Schnorr adaptor signatures binding x402 payments to service execution over "atomic service channels" — the same witness-reveal atomicity, traded against hardware trust for throughput. `contingent` is the no-TEE, zero-on-chain-changes variant of the same idea.

### Relationship to receipts / arbitration

Case "decrypted plaintext ≠ binding commitment" yields provable misdelivery: the client holds ciphertext, commitment, and settlement receipt — a self-contained evidence bundle for receipt and arbitration layers. This scheme narrows their job to the wrong-answer failure class; it does not replace them.
