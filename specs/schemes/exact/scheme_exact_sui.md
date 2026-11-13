# Scheme: `exact` on `Sui`

## Summary

The `exact` scheme on Sui pays a specific `amount` of an asset to the resource server's recipient,
`payTo`. The payer builds and signs a complete Sui transaction, so the facilitator can't change the
amount or the recipient. The facilitator submits the signed transaction and, when it sponsors gas,
co-signs it as the gas owner.

Verification only looks at the result: the transaction's balance changes must credit `payTo` with
exactly `amount`. How the transaction gets there doesn't matter, so the funds can come from an
address balance, `Coin<T>` objects, a swap, a contract withdrawal, or any mix. With
[splits](#splits), the same check covers each recipient's share.

## Terminology

- **Address balance**: A balance of one coin type held directly by an address, rather than in coin
  objects.
- **Coin reservation**: A transaction input that reserves part of an address balance.
- **Gas owner**: The address that pays for gas: the sender, or a sponsor that co-signs.
- **`GasCoin`**: The argument that refers to the gas coin. A command that uses it spends the gas
  owner's funds.
- **`Pure` input**: A plain value passed into a transaction. This scheme uses one to carry the
  server's nonce.

## Asset Transfer Method

The client signs a full transaction and the facilitator submits it. This is a "facilitator-submitted"
method in the [generic `exact` spec](./scheme_exact.md#asset-transfer-method-families), which asks
each such method to state the following:

- **Fee payer**: the payer, or the facilitator when it sponsors gas. Gasless transfers pay no fee.
  See [Gas](#gas).
- **Replay primitive**: the transaction digest. The chain executes a transaction at most once. Funds
  aren't reserved, though: if the payer spends them elsewhere after verify, settle fails, even if
  the resource has already been served.
- **Validity window**: at most two epochs (about 48 hours on mainnet), set by the required
  [expiration](#expiration).
- **Duplicate submission**: indistinguishable. Submitting an executed transaction again returns its
  original result as a success, so the facilitator deduplicates by digest (see
  [Settlement deduplication](#settlement-deduplication)).

## Protocol Sequencing

1. Client requests a resource and receives a `402 Payment Required` response with the
   `PaymentRequirements`.
2. Client fetches the current epoch, and any balance or gas data it needs, from a Sui RPC.
3. Client builds a transaction that credits `payTo`, and each split recipient, with its share of
   `amount` and arranges gas (see [Gas](#gas)).
4. Client signs the transaction and resends the request with the `PaymentPayload`.
5. Resource server asks the facilitator to verify the payload.
6. Resource server fulfills the request.
7. Resource server asks the facilitator to settle. On a sponsored payment the facilitator co-signs
   the client-signed bytes as gas owner.
8. Facilitator submits the transaction, waits for finality, and reports the result.
9. Resource server returns the response to the client.

This is the default `authorization` flow. Sui also supports `upfront`, where the resource server
settles before step 6. Finality is under a second, so `upfront` adds little latency, and a resource
server MAY use it when the work is expensive.

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
- `amount`: The total the payer pays, in atomic units, as a positive integer string. With splits,
  `payTo` receives the remainder.
- `extra.feePayer` (optional): The facilitator's sponsor address. The facilitator advertises it in
  `/supported` and the resource server copies it into the requirements. See
  [Gas sponsorship](#gas-sponsorship).
- `extra.maxGasBudget` (optional): The largest gas budget the sponsor accepts, in MIST, as an integer
  string. Present whenever `extra.feePayer` is. A client using the sponsor MUST NOT exceed it.
- `extra.nonce` (optional): A Base64 value from the server that ties the payment to its challenge.
  See [Server-issued nonce](#server-issued-nonce).
- `extra.splits` (optional): Additional recipients that share `amount`. See [Splits](#splits).

A resource server MUST NOT put the epoch or other build hints in `extra`. The server compares the
client's `accepted.extra` to its own, and the epoch changes every 24 hours.

## PaymentPayload `payload` Field

- `transaction`: The BCS-serialized Sui transaction, Base64-encoded.
- `signature`: One Base64 Sui signature per required signer, as a string or an array. The required
  signers are the sender and, if different, the gas owner. When the facilitator's sponsor is the gas
  owner, leave its signature out; the facilitator adds it at settlement.

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

The client builds one Sui transaction that credits `payTo` with exactly `amount` of `asset`, or,
with [splits](#splits), each recipient with exactly its share. The funds can come from anywhere. In
the Sui SDK, `tx.balance({ type, balance })` picks between the address balance and coins
automatically.

### Expiration

Sui already requires an expiration on transactions that use no owned objects, and remembers their
digests until it passes, so they can't run twice. Transactions that use owned objects are protected
by object versions instead. This scheme requires an expiration on every payment so that all payments
have the same window.

The client MUST set a `ValidDuring` or `Validity` expiration with both `minEpoch` and `maxEpoch`,
and `maxEpoch - minEpoch <= 1`. It SHOULD use the current epoch and the next one. It MUST NOT set
`minTimestamp` or `maxTimestamp`, because validators don't accept timestamps yet.

So the window is counted in epochs: up to about 48 hours on mainnet, where an epoch is 24 hours.
Sui can't enforce `maxTimeoutSeconds`, so it is advisory for now. Once Sui supports timestamps,
clients SHOULD expire the transaction after `maxTimeoutSeconds`.

### Server-issued nonce

`extra.nonce` is a Base64 value the resource server issues for each challenge. The client MUST add
a `Pure` input containing exactly the decoded bytes, not BCS-encoded. If the client's Move commands
need to read the nonce, it adds a separate BCS `vector<u8>` input for them.

The resource server MUST return the same nonce whenever it rebuilds the requirements for the same
challenge, because the requirements are compared by value. It can store the nonce or derive it, for
example as an HMAC of the challenge.

The nonce ties a payment to its challenge and can double as an order reference. Nothing consumes it
on-chain, and [settlement deduplication](#settlement-deduplication) uses the transaction digest, not
the nonce. A server that wants only one payment per challenge has to retire the challenge itself.

A nonce longer than 32 bytes rules out a [gasless transfer](#gasless-transfers).

### Gas

When the requirements include `extra.feePayer`, a client SHOULD use the facilitator's sponsor, and
MAY pay its own gas instead. Otherwise it can make a [gasless transfer](#gasless-transfers) when
eligible, or pay its own gas. A client MAY also use its own sponsor and include that sponsor's
signature in the payload.

#### Gas sponsorship

To use the facilitator's sponsor, the client builds the transaction with:

1. `sender` set to the payer.
2. Gas owner set to the facilitator's sponsor.
3. An empty gas payment (MUST), so gas comes from the sponsor's address balance.
4. A gas budget no larger than `extra.maxGasBudget`.
5. No command that uses `GasCoin`. A client paying in SUI with `tx.balance` or `tx.coin` passes
   `useGasCoin: false`.

The client signs as sender. At settlement the facilitator co-signs the same bytes as gas owner and
submits them with both signatures.

Whenever the gas owner is one of the facilitator's sponsors, whether or not the requirements name
it, the facilitator MUST check the following at verify and again at settle:

- The gas payment is empty, so the transaction can't name the sponsor's coins.
- The gas budget is at most `extra.maxGasBudget`.
- No command uses `GasCoin`, which would spend the sponsor's funds.
- No withdrawal draws from the sponsor, either as `Sponsor` or as `SenderAllowance` with the sponsor
  as `funder`. Sui rejects `Sponsor` withdrawals today; the check guards against that changing.

These checks apply only to sponsored payments. A payer covering its own gas may use `GasCoin`.

A sponsored transaction rejected for lack of funds costs the sponsor nothing. One that fails during
execution costs up to its gas budget. The sponsor SHOULD rate-limit each sender and MAY apply other
policy.

#### Gasless transfers

Sui runs some stablecoin transfers without gas. The full rules are in the
[Sui docs](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers). In short, a
gasless transfer:

- pays an allowlisted stablecoin (such as USDC) from the payer's address balance;
- on mainnet, credits each recipient at least 10,000 atomic units ($0.01 for USDC) and leaves the
  payer's address balance at 0 or at least that minimum;
- has every `Pure` input at most 32 bytes, with at most one unused;
- creates or changes no objects, so minting a receipt object rules it out.

With splits, the minimum applies to each recipient's share, the remainder included.

Gasless transactions get lower priority when the network is busy. One that breaks a rule is
rejected, not charged.

## Splits

A resource server MAY split one payment between `payTo` and up to 8 other recipients. This binds the
[multi-payee splits extension](./scheme_exact.md#multi-payee-splits-optional-extension) to Sui. The
whole payment is one transaction, so every recipient is paid or none is.

### `extra.splits`

```json
{
  "scheme": "exact",
  "network": "sui:mainnet",
  "amount": "1050000",
  "asset": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "payTo": "0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1",
  "maxTimeoutSeconds": 60,
  "extra": {
    "splits": [
      {
        "payTo": "0x369cf71b2f13b63c165c207bc3f263b1df9da754ca6a2d09300d9b4bf45f62f0",
        "amount": "50000",
        "memo": "platform fee"
      }
    ]
  }
}
```

The payer pays `1050000` in total: `50000` to the split recipient and the remaining `1000000` to
`payTo`.

- `splits[].payTo`: The recipient address.
- `splits[].amount`: The recipient's share in atomic units of `asset`, as an absolute amount.
- `splits[].memo` (optional): A label for the share, at most 566 bytes in UTF-8. It is not put on
  chain.

An absent or empty `splits` means a single-recipient payment.

### Requirements rules

- `splits` is an array of at most 8 entries, and no more than the facilitator advertises.
- Each entry is an object with `payTo`, `amount`, and optionally `memo`, and no other fields.
- Each `payTo` is a valid Sui address.
- Each `amount` is a positive decimal integer no greater than `2^64 - 1`, with no sign, decimal
  point, exponent, or leading zeros.
- `payTo` receives the remainder, `amount - Σ splits[].amount`, which MUST be greater than zero.
- All recipients, `payTo` included, MUST be distinct. Addresses are compared in normalized form
  (`0x` and 64 lowercase hex digits).

Requirements that break a rule are invalid (`invalid_payment_requirements`). There is no rounding. A
server that computes shares as percentages rounds them before it builds the requirements, and the
remainder to `payTo` absorbs the difference.

### Advertisement

A facilitator that accepts splits advertises `maxSplits`, an integer from 1 to 8, in the `extra` of
its `/supported` kind. Absent or 0 means it accepts no splits. A facilitator MUST reject
requirements whose `splits` has more entries than it accepts (`invalid_payment_requirements`). A
resource server MUST NOT build requirements that exceed what its facilitator advertises, and does
not copy `maxSplits` into the requirements. `maxSplits` does not depend on `feePayer`; a
facilitator that does not sponsor gas can still accept splits.

### Client

Before signing, the client MUST check that the split recipients, amounts, and memos are ones it
agreed to, and that the remainder is what reaches `payTo`. It shows a memo next to the address, not
in place of it. A client that cannot check them MUST NOT pay.

The client credits each recipient with its share. In the Sui SDK, one `0x2::balance::send_funds<T>`
per recipient does this, each funded by its own `tx.balance({ type, balance })`. A sponsored payment
passes `useGasCoin: false` to each. Sui allows at most 10 balance withdrawals in a transaction,
counting gas paid from an address balance, so this construction fits 9 recipients.

A split payment is eligible for [gasless](#gasless-transfers) execution only when every share,
including the remainder, meets the network minimum. A resource server that expects gasless clients
SHOULD keep every share at or above it.

### Effects with splits

The [effects check](#effects-check) runs once per recipient: `payTo` MUST net exactly the
remainder, and each split recipient exactly its `amount`. Because recipients are distinct and
balance changes are netted per address, each share is checked against its own balance change.

Netting has consequences for the server:

- A payment whose sender is a recipient cannot match.
- When `asset` is SUI, a payment whose gas owner is a recipient cannot match. A sponsor can be a
  split recipient, for example to recover its gas cost, only when `asset` is not SUI.

## Verification

The facilitator returns a `VerifyResponse` (core spec [§5.4](../../x402-specification-v2.md)) with
`payer` set to the transaction's `sender`. Steps 1-5 are the offline checks.

1. **Envelope.** `x402Version` MUST be `2` (`invalid_x402_version`). The scheme MUST be `"exact"`
   (`unsupported_scheme`). The payload network MUST match the requirements (`network_mismatch`) and
   be a supported Sui network (`invalid_network`). The payload MUST be `{ transaction, signature }`
   (`invalid_payload`), and the transaction bytes MUST decode
   (`invalid_exact_sui_payload_transaction_could_not_be_decoded`). The requirements' `amount` MUST
   be a positive integer, and a non-empty `extra.splits` MUST pass the
   [splits rules](#requirements-rules) (`invalid_payment_requirements`).
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
   Simulating an executed address-balance transaction again still succeeds, so this step is
   needed. It is best-effort: a node that hasn't indexed the transaction, or has pruned it, reports
   it as missing. See [deduplication](#settlement-deduplication).
7. **Simulate.** The facilitator simulates the signed transaction unchanged, with transaction checks
   on and without letting the node pick gas (`invalid_exact_sui_payload_simulation_failed`). This
   catches an expired transaction.
8. **Effects.** The simulated `balanceChanges` MUST pass the [effects check](#effects-check).

Any other error during verification returns `invalid_exact_sui_payload_verification_error`.

### Effects check

A balance change is `{ coinType, address, amount }`. Sui combines balance changes per address and
coin type. For each recipient, the facilitator adds up its entries for `asset` (zero if there are
none) and requires the total to equal that recipient's share
(`invalid_exact_sui_payload_transfer_mismatch` when simulated, `settlement_effects_mismatch` when
executed). Without splits, the only recipient is `payTo` and its share is `amount`. With splits, see
[Effects with splits](#effects-with-splits). It doesn't check what the payer spent or who else was
paid. Because balance changes are combined, a recipient that is also the sender, or the gas owner
when `asset` is SUI, can't match.

The facilitator MUST ask for balance changes when the RPC only returns them on request. At verify,
it MUST reject the payment if they're missing. At settle, if the result has no balance changes, it
fetches the transaction by digest. If they're still missing, it returns `transaction_failed`, not
`settlement_effects_mismatch`.

## Settlement

1. Re-run the offline checks (verification steps 1-5), with the same reason codes. If a signature
   check fails because of an outside error, such as a zkLogin RPC failure, return
   `transaction_failed`.
2. Check that the current epoch is within `[minEpoch, maxEpoch]`
   (`invalid_exact_sui_payload_invalid_expiration`). A fullnode returns the cached result of an
   executed transaction without checking its expiration again, so without this check a claim would
   have to be kept forever.
3. Claim the transaction digest. If it is already claimed, return `duplicate_settlement`.
4. Submit the transaction and wait for finality. If the payer covers its own gas, or the transfer is
   gasless, the facilitator just submits the signed bytes. If the payment is sponsored, the sponsor
   co-signs and submits it, or declines (`sponsor_rejected`).
5. Require a successful execution status (`transaction_failed`) and pass the
   [effects check](#effects-check) on the executed `balanceChanges` (`settlement_effects_mismatch`).

If submitting or waiting for finality fails, the facilitator SHOULD look the transaction up by
digest and report what actually happened. If the lookup also fails, it releases the claim and
returns `transaction_failed` with the digest in `transaction`, so the resource server can follow
up.

On success the facilitator returns a `SettlementResponse` (core spec
[§5.3](../../x402-specification-v2.md)) with the digest as `transaction`, the `network`, and the
`payer`.

### Settlement deduplication

The chain executes a transaction at most once, but submitting an executed transaction again returns
its original result as a success. The facilitator MUST deduplicate settlements so it reports success
at most once per transaction:

1. The claim key is the transaction digest, per network.
2. The facilitator claims the key before submitting, and only after the offline checks pass, so a
   forged payload can't hold a real payment's key.
3. Checking and recording a claim MUST be atomic across concurrent settle requests.
4. The facilitator keeps the claim only if settlement succeeds, and releases it otherwise. This is
   safe: a transaction that executed and failed returns the same failure when submitted again, so a
   retry can't turn it into a success.
5. A successful claim MUST be kept until at least one epoch after `maxEpoch` ends. Otherwise a node
   running an epoch behind could accept the payment again once the claim is gone.
6. When several processes serve `/settle`, they MUST share one claim store. A single process MAY
   keep claims in memory. After a restart, the only protection against settling a forgotten payment
   again is verify's best-effort [digest lookup](#verification), which the standard resource server
   flow always runs first. A facilitator whose settle can be called without verify SHOULD use a
   durable claim store. Two facilitators that don't share a claim store can both report the same
   payment as settled.
7. So `duplicate_settlement` means the payment has already settled, or a settle for it is in
   progress.

## Security Considerations

- **Authorization scope.** The payer signs the whole transaction, so nobody else can redirect the
  payment or reduce what the recipient gets.
- **Atomicity.** A Sui transaction either fully succeeds or does nothing, so the recipient is paid
  in full or not at all. With splits, every recipient is paid or none is.
- **Cross-network replay.** `ValidDuring` and `Validity` include the chain ID, so a payment signed
  for one network can't run on another.
- **Split consent.** The resource server chooses the split recipients. The client MUST check them
  before signing (see [Client](#client)).
- **Sponsor address.** The sponsor address SHOULD only be used for gas, with no other roles or
  permissions, because Move code can read `tx_context::sponsor()`.

Replay and repeat settlement are covered in [Expiration](#expiration) and
[Settlement deduplication](#settlement-deduplication), and sponsor costs in
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
| `invalid_exact_sui_payload_transfer_mismatch`                | verify          | Simulated effects do not credit each recipient with exactly its share.                      |
| `invalid_exact_sui_payload_verification_error`               | verify          | Unexpected error or RPC failure during verification.                                        |
| `invalid_payment_requirements`                               | verify / settle | `amount` is not a positive integer, or `extra.splits` breaks the splits rules.              |
| `sponsor_rejected`                                           | settle          | The sponsor declined the transaction.                                                       |
| `duplicate_settlement`                                       | settle          | The transaction has already settled successfully, or a settle for it is in progress.        |
| `transaction_failed`                                         | settle          | Execution failed or outcome unknown, balance changes missing, or a signature check errored. |
| `settlement_effects_mismatch`                                | settle          | Executed effects do not credit each recipient with exactly its share.                       |
