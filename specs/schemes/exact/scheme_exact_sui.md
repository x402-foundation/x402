# Scheme: `exact` on `Sui`

## Summary

The `exact` scheme on Sui transfers a specific `amount` of an asset from the payer to the resource
server's recipient, `payTo`. The payer builds and signs a complete Sui transaction, so the
facilitator cannot change the amount or the destination. The facilitator broadcasts the payer-signed
bytes and, when it sponsors gas, co-signs as the gas owner.

Verification is effects-only: it checks only the outcome, that the transaction's balance changes
credit `payTo` with exactly `amount`, not how the transaction is built. A payment can draw the asset
from an address balance, `Coin<T>` objects, a swap, a contract withdrawal, or any mix.

## Terminology

- **Address balance**: A per-address, per-coin-type balance held by the protocol, not in a coin
  object.
- **Coin reservation**: An input or gas-payment entry that reserves part of an address balance.
- **Gas owner**: The address that pays for gas and signs for it; the sender unless sponsored.
- **`GasCoin`**: The argument for the gas coin; with an empty gas payment, a coin equal to the
  budget.
- **`Pure` input**: A transaction input of raw bytes; it is unused when no command references it.

## Protocol Sequencing

1. Client requests a resource and receives a `402 Payment Required` response with the
   `PaymentRequirements`.
2. Client queries a Sui RPC for the current epoch and any balance or gas data it needs.
3. Client builds a transaction that credits `payTo` with exactly `amount` and arranges gas (see
   [Gas](#gas)).
4. Client signs the transaction and resends the request with the `PaymentPayload`.
5. Resource server asks the facilitator to verify the payload.
6. Resource server fulfills the request.
7. Resource server asks the facilitator to settle. On a sponsored payment the facilitator co-signs
   the client-signed bytes as gas owner.
8. Facilitator submits the transaction, waits for finality, and reports the result.
9. Resource server returns the response to the client.

Because Sui finality is sub-second, a resource server MAY settle before step 6 when the work is
costly.

## Network Format

x402 v2 uses CAIP-2 network identifiers:

- **Mainnet:** `sui:mainnet`
- **Testnet:** `sui:testnet`
- **Devnet:** `sui:devnet`

## `PaymentRequirements` for `exact`

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

- `asset`: The coin type `T`, as a normalized Sui struct tag.
- `payTo`: The recipient address.
- `amount`: The exact amount in atomic units, as a positive decimal string. A resource server
  refuses to build requirements with any other amount.
- `extra.feePayer` (optional): The facilitator's sponsor address. The facilitator advertises it in
  `/supported` and the resource server copies it into the requirements. See
  [Gas sponsorship](#gas-sponsorship).
- `extra.maxGasBudget` (optional): The largest gas budget the sponsor accepts, in MIST, as a decimal
  string. Present whenever `extra.feePayer` is. A client using the sponsor MUST NOT exceed it.
- `extra.nonce` (optional): A Base64-encoded, server-issued value that binds the payment to its
  challenge. See [Server-issued nonce](#server-issued-nonce).

A resource server MUST NOT put the epoch or other build hints in `extra`: the server compares the
client's `accepted.extra` to its own by value, and the epoch changes every 24 hours.

## PaymentPayload `payload` Field

- `transaction`: The Base64-encoded, BCS-serialized Sui transaction.
- `signature`: One Base64 Sui signature per required signer, as a string or an array. Required
  signers are the sender and, if different, the gas owner. When the gas owner is the facilitator's
  sponsor, omit its signature; the facilitator adds it at settlement.

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

The client builds one Sui transaction whose effects credit `payTo` with exactly `amount` of `asset`.
Because verification is effects-only, the asset source is unconstrained.
`tx.balance({ type, balance })` in the Sui SDK picks the source (address balance or coins)
automatically.

### Expiration

Sui requires a bounded expiration on any transaction with no address-owned inputs, no coin
reservations, and no gas payment. Validators remember executed digests for the current and previous
epoch, so such a transaction executes at most once. Owned-object transactions are protected by
object versions instead; this scheme requires the expiration on every payment so that all payments
have the same bounded window.

The client MUST set a `ValidDuring` or `Validity` expiration with both `minEpoch` and `maxEpoch` set
and `maxEpoch - minEpoch <= 1`. It SHOULD set `minEpoch` to the current epoch and `maxEpoch` to the
current epoch plus one. It MUST NOT set `minTimestamp` or `maxTimestamp`, because validators
currently reject timestamp-based expiration.

The validity window is therefore epoch-granular: up to about 48 hours on mainnet, where an epoch is
24 hours. `maxTimeoutSeconds` is advisory because Sui cannot enforce it. Once Sui supports timestamp
expiration, clients SHOULD bound the transaction by `maxTimeoutSeconds`.

### Server-issued nonce

`extra.nonce` is a Base64-encoded value that the resource server issues per challenge. The client
MUST add a `Pure` input whose bytes equal the decoded nonce exactly (raw bytes, not BCS-encoded). A
client that wants its Move commands to read the nonce adds a separate BCS `vector<u8>` input.

The resource server MUST return the same value each time it rebuilds the requirements for the same
challenge, because requirement matching compares `extra` by value. It can store the value or derive
it statelessly, for example as an HMAC over the challenge.

The nonce binds a payment to its challenge and can serve as an invoice or order reference. It is not
consumed on-chain, and [settlement deduplication](#settlement-deduplication) is keyed on the
transaction digest, not the nonce. A server that wants at most one payment per challenge retires the
challenge itself once it has served it.

A nonce longer than 32 bytes makes the payment ineligible for [gasless](#gasless-transfers)
execution.

### Gas

When the requirements include `extra.feePayer`, a client SHOULD use the facilitator's sponsor (the
address in `extra.feePayer`), and MAY instead pay its own gas. Otherwise it MAY build a
[gasless transfer](#gasless-transfers) when eligible, or make a self-paid payment (the sender is the
gas owner). A client MAY also use its own sponsor and include that sponsor's signature in the
payload.

#### Gas sponsorship

To use the facilitator's sponsor, the client builds the transaction with:

1. `sender` set to the payer.
2. Gas owner set to the facilitator's sponsor.
3. Gas payment set explicitly to `[]` (MUST), so gas is reserved from the sponsor's SUI address
   balance.
4. A gas budget no larger than `extra.maxGasBudget`.
5. No command that uses `GasCoin`. A client using `tx.balance` or `tx.coin` for a SUI payment passes
   `useGasCoin: false`.

The client signs as sender. At settlement the facilitator co-signs the same bytes as gas owner and
executes with both signatures.

Whenever the gas owner is an address the facilitator sponsors for, whether or not the requirements
name it, the facilitator MUST check the following at verify and again at settle:

- The gas payment is empty. A non-empty payment names the sponsor's coin objects or coin
  reservations, which contend with concurrent payments, and a reservation can expose the sponsor's
  whole balance.
- The gas budget is at most the facilitator's configured cap, advertised as `extra.maxGasBudget`.
- No command argument references `GasCoin`, which would spend the sponsor's funds up to the budget.
- No funds withdrawal draws from the sponsor, either as `Sponsor` or as `SenderAllowance` with the
  sponsor as `funder`. Sui currently rejects `Sponsor` withdrawals; the check guards against that
  changing.

These checks apply only to sponsored payments. A self-paid payment may use `GasCoin`, and a gasless
transaction has no gas coin to use.

A sponsored transaction that fails for lack of funds is not charged gas. One that aborts during
execution costs the sponsor up to the signed budget, bounded by the cap and per-sender rate
limiting. The sponsor SHOULD rate-limit per sender and MAY apply other policy.

Earlier drafts of this spec used `extra.gasStation`; clients MUST ignore it.

#### Gasless transfers

Sui executes some stablecoin transfers with no gas. The
[Sui docs](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers) define the
full rules. In summary, a gasless transfer:

- pays an allowlisted stablecoin (such as USDC) from the payer's address balance;
- on mainnet, credits each recipient at least 10,000 atomic units ($0.01 for USDC) and leaves the
  payer's address balance at 0 or at least that minimum;
- has every `Pure` input at most 32 bytes, with at most one unused;
- creates or mutates no objects, so an on-chain receipt object forfeits gasless.

Gasless transactions are deprioritized under congestion. A gas-price-0 transaction that breaks a
rule is rejected, not charged.

## Verification

The facilitator returns a `VerifyResponse` (core spec [§5.4](../../x402-specification-v2.md)) with
`payer` set to the transaction's `sender`. Steps 1-5 are the offline checks.

1. **Envelope.** `x402Version` MUST be `2` (`invalid_x402_version`). The scheme MUST be `"exact"`
   (`unsupported_scheme`). The payload network MUST match the requirements (`network_mismatch`) and
   be a supported Sui network (`invalid_network`). The payload MUST be `{ transaction, signature }`
   (`invalid_payload`), and the transaction bytes MUST decode
   (`invalid_exact_sui_payload_transaction_could_not_be_decoded`). The requirements' `amount` MUST
   be a positive integer (`invalid_payment_requirements`).
2. **Signatures.** The transaction MUST have a `sender`
   (`invalid_exact_sui_payload_missing_sender`). The payload MUST carry exactly one valid signature
   per required signer, as described in [`payload`](#paymentpayload-payload-field)
   (`invalid_exact_sui_payload_invalid_signature`).
3. **Nonce.** When the requirements declare `extra.nonce`, it MUST be valid Base64 and a `Pure`
   input MUST equal the decoded bytes (`invalid_exact_sui_payload_missing_nonce`).
4. **Expiration.** The transaction MUST carry a `ValidDuring` or `Validity`
   [expiration](#expiration) with both epochs set and a span of at most one
   (`invalid_exact_sui_payload_invalid_expiration`). This step checks only the variant, the epochs,
   and the span. Timestamps are not checked offline; simulation rejects them today.
5. **Sponsorship.** When the gas owner is an address the facilitator sponsors for, the transaction
   MUST pass the [sponsorship checks](#gas-sponsorship)
   (`invalid_exact_sui_payload_sponsorship_rejected`).
6. **Not already executed.** The facilitator recomputes the digest and looks it up. If the
   transaction has already executed, it rejects with `invalid_exact_sui_payload_already_executed`.
   This is needed because re-simulating an executed address-balance transaction still succeeds. The
   lookup is best-effort: a node that has not indexed or has pruned the transaction reports it as
   missing. See [deduplication](#settlement-deduplication).
7. **Simulate.** The facilitator simulates the signed transaction as-is, with transaction checks
   enabled and without letting the node select gas (`invalid_exact_sui_payload_simulation_failed`).
   This rejects an expired transaction.
8. **Effects.** The simulated `balanceChanges` MUST pass the [effects check](#effects-check).

Any other error during verification returns `invalid_exact_sui_payload_verification_error`.

### Effects check

A balance change is `{ coinType, address, amount }`. Sui nets balance changes per address and coin
type, so there is normally one entry for `payTo`; the facilitator sums any entries for `payTo` in
`asset` (zero if there are none) and requires the total to equal `amount` exactly
(`invalid_exact_sui_payload_transfer_mismatch` on a simulation, `settlement_effects_mismatch` on
executed effects). It does not check the payer's debit or other recipients. When `asset` is SUI and
`payTo` is the gas owner, gas nets into the same balance change, so the payment cannot match.

The facilitator MUST request balance changes where the transport makes them opt-in. At verify it
MUST reject the payment when they are unavailable. At settle, if the execution result lacks balance
changes, it fetches the transaction by digest. If they are still missing, it returns
`transaction_failed`, not `settlement_effects_mismatch`.

## Settlement

1. Re-run the offline checks (verification steps 1-5), with the same reason codes. A signature check
   that fails for environmental reasons, such as a zkLogin RPC error, returns `transaction_failed`.
2. Check that the current epoch is within `[minEpoch, maxEpoch]`
   (`invalid_exact_sui_payload_invalid_expiration`). A fullnode returns the cached effects of an
   executed transaction without re-checking its expiration; without this check, a claim would have
   to be kept forever.
3. Claim the transaction digest. If it is already claimed, return `duplicate_settlement`.
4. Submit the transaction and wait for finality. On a self-paid or gasless payment the facilitator
   only relays the signed bytes. On a sponsored payment the sponsor co-signs and executes, or
   declines (`sponsor_rejected`).
5. Require a successful execution status (`transaction_failed`) and pass the
   [effects check](#effects-check) on the executed `balanceChanges` (`settlement_effects_mismatch`).

If submission or the finality wait fails, the facilitator SHOULD look the transaction up by digest
and report its actual outcome. If the lookup also fails, it releases the claim and returns
`transaction_failed` with the digest in `transaction`, so the resource server can reconcile.

On success the facilitator returns a `SettlementResponse` (core spec
[§5.3](../../x402-specification-v2.md)) with the digest as `transaction`, the `network`, and the
`payer`.

### Settlement deduplication

The chain executes a transaction at most once, but re-submitting an executed transaction returns its
original effects as a success. The facilitator MUST deduplicate settlements so that it reports
success at most once per transaction:

1. The claim key is the transaction digest, scoped by network.
2. The facilitator claims the key before submitting, and only after the offline checks pass, so a
   forged payload cannot hold a genuine payment's key.
3. Checking and recording the claim MUST be atomic with respect to concurrent settle requests.
4. The facilitator keeps the claim only when settlement succeeds and releases it on any other
   outcome. Releasing on failure is safe: if the transaction executed and failed, re-submitting it
   returns the same failure, so a retry cannot turn it into a success.
5. A successful claim MUST be kept until at least one epoch after `maxEpoch` has ended. A node that
   lags by an epoch would otherwise accept a re-settle of an evicted claim.
6. A single process MAY keep claims in memory. After a restart, the only protection against
   re-settling a payment the store has forgotten is verify's best-effort
   [digest lookup](#verification), which the standard resource server flow always runs first. A
   facilitator whose settle can be called without verify, or that runs several instances, SHOULD use
   a shared, durable claim store. Two facilitators that do not share a claim store can each report
   the same payment as settled.
7. `duplicate_settlement` therefore means the payment has already settled successfully or a settle
   for it is in progress.

## Security Considerations

- **Authorization scope.** The payer signs the complete transaction, so no other party can redirect
  the payment or reduce the recipient's credit.
- **Atomicity.** A Sui programmable transaction is all-or-nothing, so the credit lands in full or
  not at all.
- **Cross-network replay.** `ValidDuring` and `Validity` carry the chain identifier, so a payment
  signed for one network cannot execute on another.
- **Sponsor address.** The sponsor address SHOULD be dedicated to gas, with no roles or privileges
  elsewhere, since Move code can read `tx_context::sponsor()`.

Replay and repeat settlement are covered under [Expiration](#expiration) and
[Settlement deduplication](#settlement-deduplication); sponsor exposure under
[Gas sponsorship](#gas-sponsorship).

## Appendix

### Reason codes

| Code                                                         | Stage           | Meaning                                                                                     |
| ------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------- |
| `invalid_x402_version`                                       | verify / settle | `x402Version` is not `2`.                                                                   |
| `unsupported_scheme`                                         | verify / settle | Scheme is not `"exact"`.                                                                    |
| `network_mismatch`                                           | verify / settle | Payload network does not match the requirements.                                            |
| `invalid_network`                                            | verify / settle | Network is not a supported Sui network.                                                     |
| `invalid_payload`                                            | verify / settle | Payload is not `{ transaction, signature }`.                                                |
| `invalid_exact_sui_payload_transaction_could_not_be_decoded` | verify / settle | Transaction bytes failed to decode.                                                         |
| `invalid_exact_sui_payload_missing_sender`                   | verify / settle | Transaction has no `sender`.                                                                |
| `invalid_exact_sui_payload_invalid_signature`                | verify / settle | Signatures are missing, extra, or invalid for the required signers.                         |
| `invalid_exact_sui_payload_missing_nonce`                    | verify / settle | Declared `extra.nonce` is not valid Base64 or no `Pure` input equals it.                    |
| `invalid_exact_sui_payload_invalid_expiration`               | verify / settle | Expiration missing or malformed, span exceeds one epoch, or (settle) outside window.        |
| `invalid_exact_sui_payload_sponsorship_rejected`             | verify / settle | A sponsored transaction fails the sponsorship checks.                                       |
| `invalid_exact_sui_payload_already_executed`                 | verify          | Transaction has already executed.                                                           |
| `invalid_exact_sui_payload_simulation_failed`                | verify          | Simulation failed, including for an expired transaction.                                    |
| `invalid_exact_sui_payload_transfer_mismatch`                | verify          | Simulated effects do not credit `payTo` with exactly `amount`.                              |
| `invalid_exact_sui_payload_verification_error`               | verify          | Unexpected error or RPC failure during verification.                                        |
| `invalid_payment_requirements`                               | verify / settle | The requirements' `amount` is not a positive integer.                                       |
| `sponsor_rejected`                                           | settle          | The sponsor declined the transaction.                                                       |
| `duplicate_settlement`                                       | settle          | The transaction has already settled successfully, or a settle for it is in progress.        |
| `transaction_failed`                                         | settle          | Execution failed or outcome unknown, balance changes missing, or a signature check errored. |
| `settlement_effects_mismatch`                                | settle          | Executed effects do not credit `payTo` with exactly `amount`.                               |
