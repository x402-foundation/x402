# Scheme: `exact` on `Sui`

## Summary

The `exact` scheme on Sui transfers a specific `amount` of an asset from the payer to the resource
server's declared recipient, `payTo`. The payer builds and signs a complete Sui transaction, so the
facilitator cannot change the amount or the destination; it broadcasts the payer-signed bytes and,
when it sponsors gas, co-signs the gas it funds.

Verification is effects-only. The facilitator reads the transaction's `balanceChanges` and verifies
that the declared recipient was credited exactly the requested amount. It does not constrain the
payer's total debit, forbid other recipients, or otherwise limit how the transaction is built. A
payment MAY draw the asset from an Address Balance, from `Coin<T>` objects, from an on-demand swap,
from a contract withdrawal with a balance limit, or from any combination, and MAY attach an on-chain
payment or receipt record in the same transaction. Any party can recompute a settled payment's
outcome from public chain data.

Payments of an allowlisted stablecoin drawn from the payer's Address Balance are often
[naturally gasless](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers)
(no gas coin, no sponsor). Gaslessness is a property the client MAY choose on the paying side; the
facilitator neither requires nor rewards it.

## Protocol Sequencing

The flow is client-driven. When the facilitator sponsors gas, it advertises `extra.feePayer` (the
sponsor address) via its `/supported` response, and the resource server relays it verbatim in the
payment requirements.

1. Client requests a resource and receives a `402 Payment Required` response carrying the
   `PaymentRequirements`.
2. If the client lacks local balance information, it MAY query an RPC service to construct the
   transaction.
3. Client builds a complete transaction whose effects transfer the exact `amount` to the declared
   recipient. It sources the asset and arranges gas however it chooses: paying its own gas,
   producing a naturally gasless transfer, or — when the requirements announce a `feePayer` — setting
   the announced sponsor as the gas owner with an empty gas payment.
4. Client signs the transaction and resends the request with the `PaymentPayload`.
5. Resource server passes the payload to the facilitator for verification.
6. Resource server fulfills the request.
7. Resource server requests settlement from the facilitator.
8. On a sponsored payment the facilitator co-signs the gas over the identical client-signed bytes;
   otherwise no sponsor signature is added.
9. Facilitator submits the transaction and reports the result to the resource server.
10. Resource server returns the response to the client.

## Network Format

x402 v2 uses CAIP-2 network identifiers:

- **Mainnet:** `sui:mainnet`
- **Testnet:** `sui:testnet`
- **Devnet:** `sui:devnet`

## `PaymentRequirements` for `exact`

In addition to the standard fields, the `exact` scheme on Sui uses the following `extra` fields, all
optional:

```json
{
  "scheme": "exact",
  "network": "sui:mainnet",
  "amount": "10000",
  "asset": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "payTo": "0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1",
  "maxTimeoutSeconds": 60,
  "extra": {}
}
```

- `asset`: The coin type `T` (a normalized Sui struct tag).
- `payTo`: The recipient address.
- `amount`: The exact amount in atomic units (decimal string).
- `extra.feePayer` (string): The sponsor's address, present when the facilitator offers gas
  sponsorship. A client using sponsorship sets it as the transaction's gas owner. See
  [Gas sponsorship](#gas-sponsorship).
- `extra.nonce` (string): A server-issued, per-request identifier that binds a payment to the
  challenge that issued it and lands on-chain for reconciliation. See
  [Server-issued nonce](#server-issued-nonce).

## PaymentPayload `payload` Field

The `payload` field contains:

- `transaction`: The Base64-encoded BCS-serialized Sui transaction.
- `signature`: A Base64-encoded serialized signature over the transaction, or an array of such
  signatures. It MUST cover the payer (`sender`); a single string is equivalent to a one-element
  array, and both map to Sui `executeTransaction({ signatures })`. An array is used only when the
  transaction has more than one required signer — for example a
  sponsored transaction whose gas owner (the sponsor) is a distinct signer from the sender, such as a
  client using its own gas sponsor. When the facilitator itself sponsors, it adds its sponsor
  signature at settlement, so in that case the client sends only the sender signature.

```json
{
  "transaction": "AAAA...AAAA=",
  "signature": "AbCd...=="
}
```

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/resource",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "sui:mainnet",
    "amount": "10000",
    "asset": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "payTo": "0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1",
    "maxTimeoutSeconds": 60,
    "extra": {}
  },
  "payload": {
    "transaction": "AAAA...AAAA=",
    "signature": "AbCd...=="
  }
}
```

## Construction

The client builds one complete Sui transaction whose effects credit the declared recipient with
exactly the requested amount. Beyond that, construction is unconstrained:

- **Asset source is arbitrary.** The asset MAY come from the payer's Address Balance, from `Coin<T>`
  objects, from an on-demand swap, from a contract withdrawal, or any mix. The Sui SDK's
  `tx.balance({ type, balance })` input resolves the source automatically and often yields a gasless
  stablecoin transfer.
- **Gas is the client's choice.** The client MAY pay its own gas, produce a naturally gasless
  transfer, arrange its own separate gas sponsor, or use the facilitator's announced sponsor. A
  transaction with more than one required signer — a sponsored transaction whose gas owner (the
  sponsor) differs from the sender — carries all the signatures it needs in the
  [payload](#paymentpayload-payload-field).
- **Expiry.** A payment's validity window is bounded on-chain by the transaction's own expiration,
  enforced by simulation at verify and by execution at settle. `maxTimeoutSeconds` is the resource
  server's advertised window and is NOT enforced at the transaction level by this scheme.
- **Server nonce.** When the requirements declare `extra.nonce`, the client Base64-decodes it and
  embeds the resulting bytes as a `Pure` input in the transaction (see
  [Server-issued nonce](#server-issued-nonce)).

### Gas sponsorship

Sponsorship is a gas arrangement available to any payment, independent of how the asset is sourced.
It is non-interactive: gas is drawn from the SUI
[Address Balance](https://sdk.mystenlabs.com/sui/transactions/signing-and-execution#address-balance-sponsorship)
of the announced sponsor, so no gas coin objects appear in the signed bytes and the client talks only
to the resource server. To use sponsorship, the client builds the transaction with:

1. `sender` set to the payer; the transfer effects move the exact `amount` to the declared
   recipient.
2. Gas owner set to `extra.feePayer`.
3. Gas payment set to `[]`, so gas resolves from the sponsor's Address Balance.

The facilitator supplies the sponsor signature at settlement, co-signing the identical client-signed
bytes and executing with `[senderSignature, sponsorSignature]`.

What the facilitator is willing to sponsor — package and function filters, budget ceilings,
withdraw-from-sponsor protection, gas-coin protection — is the sponsor's own policy, enforced by the
sponsor at settlement, and is outside x402 scope. A sponsor MAY decline a payment for any policy
reason, which surfaces at settlement as `sponsor_rejected`. Sponsorship changes only who pays gas,
never what x402 validates.

## Verification

The facilitator returns `{ isValid, payer }` (with `invalidReason` when invalid) per
[VerifyResponse](../../x402-specification-v2.md#54-verifyresponse-schema). Steps:

1. **Envelope.** `x402Version` MUST be `2` (`invalid_x402_version`), the scheme MUST be `"exact"`
   (`unsupported_scheme`), the payload `network` MUST match the requirements (`network_mismatch`) and
   be a supported Sui network (`invalid_network`), and the payload MUST have the shape
   `{ transaction, signature }` (`invalid_payload`, or
   `invalid_exact_sui_payload_transaction_could_not_be_decoded` when the bytes fail to decode).
2. **Signature binds the payer.** The transaction MUST carry a `sender`
   (`invalid_exact_sui_payload_missing_sender`), and the supplied `signature` MUST verify over the
   transaction against that `sender` (`invalid_exact_sui_payload_invalid_signature`). On a sponsored
   payment the sponsor's gas signature is added later, at
   settlement; execution enforces that every required signer is covered, so a transaction missing any
   required signature fails to execute.
3. **Server nonce.** When the requirements declare `extra.nonce`, the facilitator Base64-decodes it
   (rejecting a value that is not valid Base64) and the transaction MUST carry the decoded bytes as a
   `Pure` input; a transaction that does not is rejected
   (`invalid_exact_sui_payload_missing_nonce`). When the requirements do not declare a nonce, this
   step is skipped.
4. **Not already executed.** Recompute the transaction digest from the signed bytes and look it up
   on-chain; if it is already committed, reject (`invalid_transaction_state`). A transaction sourced
   entirely from Address Balances has no object inputs, so simulation alone cannot detect a replay.
   The lookup is best-effort — nodes prune old transactions — but at-most-once execution does not
   depend on it: an executed transaction can never commit again, so a replay whose digest has been
   pruned instead fails simulation or execution (its inputs are consumed or its expiration has
   passed).
5. **Simulate.** Simulate the transaction with transaction checks enabled to confirm it would
   succeed (`invalid_exact_sui_payload_simulation_failed`). Checks-enabled simulation validates the
   transaction's expiration, so an expired transaction fails here.
6. **Effects.** Apply the [effects check](#effects-check) to the simulated `balanceChanges`.

A simulation may preview a SUI gas line even for a would-be-gasless payment, because the node
simulates with a non-zero budget; only the asset effects are asserted.

### Effects check

A balance change is `{ coinType, address, amount }`; the facilitator matches the recipient by its
`address` in the agreed asset's balance changes, summing the amounts per address.

The facilitator MUST request balance changes from transports where they are opt-in and MUST reject
verification or settlement when they are unavailable.

Reading the agreed asset's `balanceChanges` (from simulation during verify, or from the executed
effects during settle), the facilitator asserts that the declared recipient, `payTo`, was credited
(net) exactly `amount` in the agreed asset.

It does not assert how much the payer was debited, nor forbid other recipients of the asset.

A mismatch is rejected with `invalid_exact_sui_payload_transfer_mismatch`.

### Server-issued nonce

`extra.nonce` is an optional, server-issued, per-request identifier: a Base64-encoded value (matching
how `transaction` and `signature` are encoded in this scheme). A value that is not valid Base64 is
rejected. It SHOULD be at most 32 bytes so the payment can remain gasless-eligible — the gasless
stablecoin path allows a single unused `Pure` input of at most 32 bytes. It MAY be longer when
needed, but a payment carrying a larger nonce (as an unused input) cannot use the gasless path and
must pay gas from the sender or use a sponsor. The resource server issues one value per payment challenge and persists it so the same request
always resolves to the same value across requirement rebuilds, while distinct requests get distinct
values. It MUST NOT be regenerated randomly on each rebuild, since requirement matching compares
`extra` by value against the client's `accepted.extra`.

It serves as a stable challenge-binding and reconciliation key: a unique-per-request value that binds
the payment to the challenge that issued it, MAY double as an invoice or order reference, and lets a
server make each payment single-use by construction (see
[Exactly-once serving](#exactly-once-serving)). Like SVM's `extra.memo`, it is not consumed on-chain
and provides no single-use guarantee on its own.

When present, the client Base64-decodes `extra.nonce` to raw bytes and MUST embed those bytes as a
`Pure` input in the transaction; the facilitator Base64-decodes `extra.nonce` and matches the bytes
against the transaction's `Pure` inputs, rejecting a transaction that does not carry them
(`invalid_exact_sui_payload_missing_nonce`). The input need not be unused —
the client MAY reference the nonce in a command, for example to write it to an on-chain receipt.

## Settlement

Settlement broadcasts the signed transaction and judges success only on the executed effects. On a
self-paid or naturally gasless payment the broadcast is keyless: the facilitator holds no payer key
and only relays the signed bytes. On a sponsored payment the facilitator delegates execution to the
sponsor, which applies its own policy to the identical client-signed bytes and either co-signs and
executes or returns a policy rejection (`sponsor_rejected`). The sponsor's SUI is an Address Balance,
so no gas coin objects are reserved and concurrent sponsorships do not contend for a coin pool.

Steps:

1. Re-run the offline checks: envelope, the sender-bound signature, and the declared nonce. The
   not-already-executed digest lookup and the simulation are not repeated.
2. Broadcast the transaction — or, when sponsored, hand the signed bytes to the sponsor to co-sign
   and execute — and wait for finality.
3. From the executed effects, require a successful execution status and the
   [effects check](#effects-check) against the executed `balanceChanges`. A committed-but-failed
   transaction returns `transaction_failed`; effects that do not match return
   `settlement_effects_mismatch`.

Sui transaction execution is idempotent: re-submitting an already-committed transaction returns its
existing effects rather than erroring, and the chain commits a given transaction at most once. A
retried settle re-executes to the same committed effects and re-runs the same effects check, with no
double charge. Transport or execution errors surface as `transaction_failed`.

The `SettlementResponse` returns `success`, the transaction `digest` (as `transaction`), the `network`,
and the `payer` per
[SettlementResponse](../../x402-specification-v2.md#53-settlementresponse-schema).

### Exactly-once serving

The chain guarantees at-most-once execution: a given signed transaction commits once, so
double-spend is impossible. It does not guarantee at-most-once *serving*. Because execution is
idempotent, two requests carrying the same payment — retried or concurrent — both observe the same
successful effects. Whether the same payment is served more than once is therefore an
application-level concern the protocol cannot decide: the chain exposes no signal to tell a first
settlement from a repeat.

A facilitator or resource server MAY deduplicate repeat or concurrent settlement requests, keyed on
the transaction digest — the payment's on-chain identity, which already encodes a declared nonce since
that nonce is enforced inside the transaction — and reject a duplicate with `duplicate_settlement`.
For the guard to hold, the step that claims a payment and the settlement it
protects MUST be atomic with respect to concurrent requests, so that of two in-flight requests for
the same payment only one proceeds: a party that claims the payment before acting on it keeps both
from serving it.

Alternatively, a server MAY make each payment single-use by construction: issue a fresh per-request
`extra.nonce` and treat that challenge — not the payment — as the thing it retires. A payment then
satisfies only the one request it was built for, so a repeat cannot be redirected at a different unit
of work. This narrows the guard to a per-challenge check but does not remove the atomicity
requirement above for two concurrent requests bearing the same challenge.

A single instance MAY hold this state locally. A horizontally-scaled deployment has no shared view of
what its peers have served, so it SHOULD use shared deduplication state; without it, duplicates routed
to different instances each pass their local check.

## Security Considerations

- **Authorization scope.** The payer signs the complete transaction, so no party can redirect funds
  away from the declared recipient or reduce its credited amount. The scheme verifies that the
  server receives exactly what it declared — the recipient credited exactly `amount` — and does not
  constrain whatever else the transaction does.
- **Effects-only validation.** Verification inspects the balance changes, not the transaction's
  commands or gas shape. It lets a payment be sourced arbitrarily: Address Balance,
  `Coin<T>` objects, swaps, withdrawals, or a mix. Sui transactions are intentionally composable, and
  the exact recipient-credit check already binds what the server receives, so the scheme does not
  constrain the transaction shape with a command allowlist or a gasless-eligibility requirement.
- **Replay prevention.** Settlement is at-most-once per signed transaction. Simulation is not a
  sufficient replay guard for a payment sourced entirely from Address Balances, since re-simulating
  executed bytes still succeeds; verification detects a recent replay by recomputing the digest and
  looking it up on-chain, and a replay old enough to outlive node retention fails simulation or
  execution instead, since an executed transaction can never commit again. A payment's validity
  window is bounded on-chain by the transaction's own expiration, enforced by simulation at verify
  and by execution at settle. Serving a payment at most once is an application-level concern the
  chain does not decide; a facilitator or resource server MAY deduplicate above the chain (see
  [Exactly-once serving](#exactly-once-serving)).
- **Settlement atomicity.** The payment settles in one transaction; a Sui programmable transaction is
  all-or-nothing, so the recipient credit either lands in full or the transaction commits nothing.
- **Independently recomputable settlement.** Because verification is effects-based, any third party
  can recompute a settled payment's outcome — the digest and the recipient's credit — from
  public chain data, with no trust in the facilitator's report. Receipt and attestation extensions
  can bind to this result without additional on-chain state.
- **Sponsor exposure.** What a facilitator is willing to sponsor is bounded by the sponsor's own
  policy, not by any x402 field or facilitator check. x402 defines no gas-budget or gas-shape
  validation; it delegates sponsored settlement to the sponsor, which enforces its policy and MAY
  decline.

## Appendix

### Reason codes

| Code | Stage | Meaning |
| ---- | ----- | ------- |
| `invalid_x402_version` | verify / settle | `x402Version` is not `2`. |
| `unsupported_scheme` | verify / settle | Scheme is not `"exact"`. |
| `network_mismatch` | verify / settle | Payload network does not match the requirements. |
| `invalid_network` | verify / settle | Network is not a supported Sui network. |
| `invalid_payload` | verify / settle | Payload is not `{ transaction, signature }`. |
| `invalid_exact_sui_payload_transaction_could_not_be_decoded` | verify / settle | Transaction bytes failed to decode. |
| `invalid_exact_sui_payload_missing_sender` | verify / settle | Transaction carries no `sender`. |
| `invalid_exact_sui_payload_invalid_signature` | verify / settle | Signature does not verify against `sender`. |
| `invalid_exact_sui_payload_missing_nonce` | verify / settle | Declared `extra.nonce` malformed (not valid Base64) or not carried as a `Pure` input in the transaction. |
| `invalid_transaction_state` | verify | Transaction is already executed. |
| `invalid_exact_sui_payload_simulation_failed` | verify | Simulation would not succeed. |
| `invalid_exact_sui_payload_transfer_mismatch` | verify | The declared recipient was not credited exactly `amount` in the agreed asset. |
| `invalid_exact_sui_payload_verification_error` | verify | Catch-all for an unexpected error or RPC failure during verification. |
| `invalid_payment_requirements` | server | Requirements are invalid. |
| `duplicate_settlement` | settle | A repeat or concurrent settle for the same payment was rejected by deduplication. |
| `transaction_failed` | settle | Execution failed or a transport error occurred. |
| `settlement_effects_mismatch` | settle | Executed effects do not match the requirements. |
| `sponsor_rejected` | settle | The sponsor declined under its own policy. |

## Recommendation

Construct payments to be gasless-eligible by default: an allowlisted stablecoin (such as USDC) drawn
from the payer's Address Balance, at or above the protocol's per-transfer minimum, settles with no
gas token and no sponsor — the cheapest path for both the client and the server. Reserve sender-paid
gas, or an offered sponsor, for payments that cannot meet those conditions, such as a non-allowlisted
asset or an amount below the minimum.
