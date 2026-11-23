# Scheme: `exact` on bb84 (`eip155:42069000`)

## Summary

This document specifies the x402 `exact` payment scheme on the bb84 chain, an
OP-Stack rollup on Ethereum mainnet with chain ID `42069000`. bb84 user accounts
are keccak-256 hash-chain accounts: they hold no ECDSA key and sign nothing. A
payment is a typed hash transaction that the payer submits itself, and it is
gas-free for the payer. The asset transfer methods of
[`scheme_exact_evm.md`](scheme_exact_evm.md) (`eip3009`, `permit2`, `erc7710`)
all require a payer signature that a facilitator submits later, so none of them
can be used on this network.

This document defines the asset transfer method `memo-transfer` for this network.
It belongs to the client-submitted (payment proof) family of
[`scheme_exact.md`](scheme_exact.md). The client pays first: it submits an
ERC-20 transfer of `amount` of `asset` to `payTo` whose calldata carries a
server-issued reference (the memo). It then presents the transaction hash. The
facilitator reads the transaction from the chain, checks recipient, asset,
amount and memo against the payment requirements, binds the transaction to
those requirements and records it. The facilitator never holds funds, keys or
signing authority and never submits a transaction.

`memo-transfer` supports only the `upfront` payment flow. The resource server
processes the request only after `/settle` has succeeded.

This scheme targets x402 protocol version 2 and uses the core
`PaymentRequirements`, `PaymentPayload` and `SettlementResponse` types from
[x402-specification-v2.md](../../x402-specification-v2.md).

## Scheme and Network

- `scheme` MUST be `"exact"`.
- `network` MUST be `"eip155:42069000"`. This method is defined for this network
  only; hash-chain accounts exist on no other network.
- `asset` MUST be the address of an ERC-20 token on bb84. The tokens are USDC
  `0x50590EE131EdC98a7213c91Ae82e3e8987B9b5eE` and EURC
  `0x47dbBf8233cd91C16360bDb69e325f771FD9A667`, both with 6 decimals. Facilitators
  advertise the tokens they accept in `/supported` (see
  [Facilitator `/supported`](#facilitator-supported)). Addresses are compared
  case-insensitively.
- `payTo` MUST be a 20-byte address, `0x` followed by 40 hexadecimal characters.
  It is the recipient of the token transfer and is compared case-insensitively.
- `amount` MUST be a decimal string encoding a positive integer in base units
  (`"10000"` is 0.01 USDC).

The chain is registered in
[ethereum-lists/chains](https://github.com/ethereum-lists/chains) as `BB84`.
The account model, transaction types and public endpoints are specified in the
[bb84 protocol for autonomous agents](https://bb84.com/agent/protocol.md),
referred to below as the bb84 protocol.

### Relation to `scheme_exact_evm.md`

The methods of `scheme_exact_evm.md` MUST NOT be offered on `eip155:42069000`.
A requirement for this network MUST carry `extra.assetTransferMethod` set to
`"memo-transfer"` explicitly, because the EVM default for a missing value is
`eip3009`. An implementation that handles `eip155:*` with the EVM methods MUST
NOT construct a payment for a requirement whose `assetTransferMethod` it does not
implement, and MUST NOT fall back to `eip3009` for it. SDKs that resolve a
scheme client by network SHOULD resolve the concrete network before a wildcard,
so that an implementation registered for `eip155:42069000` takes precedence over
one registered for `eip155:*`.

## Asset Transfer Method and Payment Flow

`"memo-transfer"` is the only asset transfer method on this network.
`extra.assetTransferMethod` MUST be present and MUST equal `"memo-transfer"`.

`"upfront"` is the only payment flow. The payer's transaction is already final
when the proof is presented, so no earlier ordering exists. `extra.paymentFlow`
MUST be present and MUST equal `"upfront"`. Clients, resource servers and
facilitators MUST reject any other value.

The protocol sequence is:

1. The resource server issues a payment requirement with a fresh memo in
   `extra.memo`.
2. The client validates the requirement and submits a bb84 payment of `amount`
   of `asset` to `payTo` whose calldata carries the memo. It waits for the
   transaction receipt.
3. The client constructs a `PaymentPayload` containing the transaction hash and
   repeats the request.
4. The resource server checks that it issued the presented memo for these terms,
   claims the memo, and sends the payload to the facilitator's `/settle`
   endpoint. It MAY call `/verify` first as a read-only check; `/verify` is not
   required by this flow.
5. The facilitator validates the transaction against the chain, binds it to the
   requirements and records the binding.
6. The resource server processes the protected request only after `/settle`
   succeeds.

## Terminology

- **Payer account**: a bb84 hash-chain account. Its address is derived from a
  commitment, not from a public key.
- **Spend step**: one payment on bb84, a `HashCommitTx` (type `0x7c`) followed by
  a `HashRevealTx` (type `0x7f`). The reveal transaction carries the ERC-20 call
  and is the transaction the proof names.
- **Memo**: the server-issued per-request reference in `extra.memo`.
- **Payment type byte**: the byte after the 68-byte ERC-20 calldata, `0x00` for a
  friends-and-family payment and `0x01` for a goods-and-services payment.
- **Goods-and-services fee**: on a goods-and-services payment the chain forwards
  `feeBps / 10000` of the amount (currently 0.5 %) from the recipient to a fee
  collector in the same transaction, so the recipient is credited less than the
  declared amount. Payments to a registered merchant MUST be goods-and-services
  payments (bb84 protocol §7.3).
- **Binding**: the tuple (`network`, `payTo`, `asset`, `amount`, normalized memo)
  a settled transaction is recorded with.
- **Binding store**: storage that atomically records settled transactions with
  their binding and persists across facilitator restarts.

## Amounts

`amount` MUST be a decimal string that encodes a positive integer number of base
units of `asset`. It MUST NOT contain a sign, decimal point, exponent, separator
or unit suffix. Both tokens have 6 decimals.

| Meaning | Wire `amount` |
|---|---:|
| 0.01 USDC | `"10000"` |
| 1 EURC | `"1000000"` |
| 12.50 USDC | `"12500000"` |

User-facing SDKs MAY accept dollar-string prices for USDC and euro-string prices
for EURC (`"$0.10"`, `"€0.10"`) and MUST use exact decimal arithmetic. A bare
numeric price MUST NOT resolve to EURC.

Let `declared` be the amount in the transfer calldata and `credited` the sum of
the `Transfer` events of `asset` that credit `payTo` and originate from the payer
(see [Facilitator Validation](#facilitator-validation)). A payment satisfies
`amount` when

- `credited >= amount`, or
- the payment type byte is `0x01`, `declared >= amount` and
  `credited >= floor(amount * 99 / 100)`.

The second rule admits the goods-and-services fee. The fee is `feeBps` as read
from the chain's `PaymentFeeConfig` (bb84 protocol §1); facilitators MUST NOT
accept a shortfall larger than 1 % under this rule even if `feeBps` is raised.

The settled amount reported in `SettlementResponse.amount` is
`PaymentRequirements.amount`. Overpayment is accepted and grants no additional
resource or credit. Underpayment is rejected with
`invalid_exact_bb84_amount_insufficient`. This method defines no return path:
a rejected or excess payment stays with `payTo`, and any refund is a separate
arrangement between the resource server and the payer. Clients MUST NOT assume a
refund is available.

## `PaymentRequirements`

The resource server MUST issue a fresh memo for every payment challenge and
place it in `extra.memo`.

```json
{
  "scheme": "exact",
  "network": "eip155:42069000",
  "amount": "10000",
  "asset": "0x50590EE131EdC98a7213c91Ae82e3e8987B9b5eE",
  "payTo": "0xba7fc8791c8ce5aad97b2f654496ea7a96c51441",
  "maxTimeoutSeconds": 86400,
  "extra": {
    "assetTransferMethod": "memo-transfer",
    "paymentFlow": "upfront",
    "memo": "x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01"
  }
}
```

The `extra` fields are:

| Field | Required | Meaning |
|---|---|---|
| `extra.assetTransferMethod` | Yes | MUST be `"memo-transfer"`. |
| `extra.paymentFlow` | Yes | MUST be `"upfront"`. |
| `extra.memo` | Yes | Fresh per-request reference the payer puts into the transaction calldata. |

`maxTimeoutSeconds` MUST be a positive integer. It is the time after issuance
for which the resource server commits to accept a payment that carries this memo.
The facilitator does not enforce it; the facilitator's own bound is the maximum
proof age below.

### Memo format

`extra.memo` MUST:

- consist of 1 to `memoMaxLength` Unicode scalar values, where `memoMaxLength`
  is the value the facilitator advertises in `/supported` (100 at the reference
  facilitator), and encode to at most `2 * memoMaxLength` bytes of UTF-8;
- contain no control characters (U+0000 to U+001F, U+007F), no leading or
  trailing whitespace and no run of two or more whitespace characters;
- not contain the separator sequence U+0020 U+00B7 U+0020 (`" · "`), which is
  reserved for the payer's addition (see [Request Binding](#request-binding)).

A memo MUST be unique per challenge and unpredictable: it MUST contain at least
80 bits from a cryptographically secure random source. The resource server MUST
be able to recognize, without a per-challenge store, that it issued a presented
memo for a given (`payTo`, `asset`, `amount`). The RECOMMENDED construction is

```text
memo = "x402:" + hex(nonce, 10 bytes) + "." + hex(tag)[0:20]
tag  = HMAC-SHA256(key, hex(nonce) + "|" + lower(payTo) + "|" + lower(asset) + "|" + amount)
```

with a server-held `key` shared by every instance that issues challenges for the
same `payTo`.

`extra.memo` is dynamic: scheme implementations MUST declare `memo` as a dynamic
`extra` field, so that a payload whose `accepted.extra.memo` differs from the
memo of the current challenge still matches the requirement. Every core field
and every other server-declared `extra` field MUST match.

## Request Binding

The memo is a server-issued nonce carried in the payment, which is one of the
binding forms permitted by `scheme_exact.md`. The transaction's `Transfer` to
`payTo` proves that a payment happened; the memo in its calldata proves that it
was made for this challenge. The binding is complete only together with the
resource server's check that it issued the memo for these terms: a payment to
`payTo` carrying any other text, for example a reference from an unrelated
purchase, MUST NOT be accepted as a proof.

### On-chain memo and the payer's addition

The transfer calldata is (bb84 protocol §7.1):

```text
data = 0xa9059cbb ‖ pad32(payTo) ‖ u256be(declared) ‖ paymentType ‖ memoBytes
```

`memoBytes` is the UTF-8 encoding of the on-chain memo, at most 280 bytes. The
node strips everything after byte 68 before it executes the token call and
stores the full calldata in the transaction, so the memo is read back from the
transaction input. The on-chain memo MUST be either the requirement memo or the
requirement memo followed by `" · "` and a payer-supplied addition. bb84 wallets
use the addition for their own payment reference. An addition MUST NOT alter
the requirement memo.

### Normalization and matching

Before comparison, implementations MUST normalize both the on-chain memo and
`extra.memo` as follows: replace every run of whitespace with one U+0020, strip
leading and trailing whitespace, and apply Unicode case folding. An on-chain memo
matches when, after normalization, it equals the requirement memo or begins with
the requirement memo followed by `" · "`.

### Paid retry

On the paid retry the resource server MUST take the memo from
`accepted.extra.memo`, verify that it issued that memo for the `payTo`, `asset`
and `amount` of the matched requirement, and send that memo in
`paymentRequirements.extra.memo` to `/settle`. It MUST NOT send the fresh memo
of the retry's own challenge, because the facilitator matches the on-chain memo
against `paymentRequirements`. A memo the server did not issue, or issued for
other terms, MUST be rejected before any facilitator call.

## `PaymentPayload`

After the reveal transaction is included, the client sends its hash in the
scheme-specific `payload` object. `accepted` is the requirement it paid,
including the memo:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/weather",
    "description": "Weather report",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:42069000",
    "amount": "10000",
    "asset": "0x50590EE131EdC98a7213c91Ae82e3e8987B9b5eE",
    "payTo": "0xba7fc8791c8ce5aad97b2f654496ea7a96c51441",
    "maxTimeoutSeconds": 86400,
    "extra": {
      "assetTransferMethod": "memo-transfer",
      "paymentFlow": "upfront",
      "memo": "x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01"
    }
  },
  "payload": {
    "transaction": "0x8f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0"
  }
}
```

| Field | Type | Requirements |
|---|---|---|
| `payload.transaction` | string | Hash of the reveal transaction: `0x` followed by 64 hexadecimal characters. Facilitators MUST accept either letter case and MUST use the lowercase form in the binding store and in responses. |

Over the HTTP transport the payload travels in the `PAYMENT-SIGNATURE` header
and over the MCP transport in `_meta["x402/payment"]`; see
[transports-v2/http.md](../../transports-v2/http.md) and
[transports-v2/mcp.md](../../transports-v2/mcp.md).

## Client Payment Construction

Before paying, a client MUST:

1. Require `scheme == "exact"`, `network == "eip155:42069000"`, an `asset` the
   client knows on this network, a positive integral `amount`, a positive
   integral `maxTimeoutSeconds` and a well-formed `payTo`.
2. Require `extra.assetTransferMethod == "memo-transfer"` and
   `extra.paymentFlow == "upfront"`.
3. Require `extra.memo` to satisfy [Memo format](#memo-format). A memo that the
   client cannot put on chain unchanged MUST cause rejection, not truncation: a
   truncated memo buys nothing.
4. Perform the recipient checks of the bb84 protocol §7.2. A deleted or locked
   recipient MUST NOT be paid. An unregistered recipient needs a registration
   step before the transfer (bb84 protocol §7.4).
5. Build one spend step whose reveal transaction has `to = asset`, `value = 0`
   and the calldata of [On-chain memo and the payer's
   addition](#on-chain-memo-and-the-payers-addition) with `declared = amount`.
   The payment type byte MUST be `0x01` when `payTo` is a registered merchant,
   and MAY be `0x01` otherwise. The client MUST NOT put the memo anywhere but in
   the calldata.
6. Submit the step and wait for the reveal transaction's receipt with
   `status == 0x1` (bb84 protocol §7.5). A reveal whose EVM call reverted still
   consumes a chain step but is not a payment; the client MUST NOT present it.
7. Construct the `PaymentPayload` with the reveal transaction hash.

A client that holds no bb84 account secret, for example an assistant inside a
chat, cannot submit the payment itself. It MAY hand the requirement to the
user's wallet or to a budget account it is allowed to spend from and present the
resulting transaction hash; the resource server and facilitator cannot tell the
difference and need not.

Clients SHOULD present the proof promptly after the receipt. See
[Public proof](#public-proof) for why.

## Facilitator Validation

The facilitator MUST treat the payload and the requirements as untrusted and
MUST read all chain state from a bb84 node it trusts. It MUST NOT accept
receipts, logs or block data supplied by the caller. `/verify` and `/settle`
perform the same checks; `/verify` MUST NOT write to the binding store.

The checks, in order:

1. Require `paymentPayload` and `paymentRequirements` to be objects
   (`invalid_payload`).
2. Require `paymentRequirements.scheme == "exact"` (`unsupported_scheme`) and
   `paymentRequirements.network == "eip155:42069000"` (`invalid_network`).
3. Require `asset` to be an advertised token (`invalid_exact_bb84_asset`), a
   well-formed `payTo`, a positive integral `amount` and a positive integral
   `maxTimeoutSeconds` (`invalid_payment_requirements`).
4. Require `extra.assetTransferMethod == "memo-transfer"`
   (`invalid_exact_bb84_asset_transfer_method`) and
   `extra.paymentFlow == "upfront"` (`invalid_exact_bb84_payment_flow`).
5. Require `extra.memo` to be present (`invalid_exact_bb84_memo_missing`) and to
   satisfy [Memo format](#memo-format) (`invalid_exact_bb84_memo_malformed`).
6. When `accepted` is present, require its `scheme`, `network`, `asset`,
   `payTo` and `amount` to equal the requirements
   (`invalid_exact_bb84_accepted_mismatch`). `accepted.extra.memo` MAY differ
   from the requirement memo; the requirement memo is authoritative.
7. Require `payload.transaction` to be `0x` and 64 hexadecimal characters
   (`invalid_exact_bb84_transaction_hash_malformed`).
8. Fetch the transaction and its receipt. If either is unknown, return
   `invalid_exact_bb84_transaction_not_found`. This result is not final: the
   transaction may still be included, and the caller MAY retry.
9. Require `receipt.status == 0x1` (`invalid_exact_bb84_transaction_failed`).
10. Require the recipient named in the calldata to equal `payTo`
    (`invalid_exact_bb84_recipient_mismatch`). The calldata names the recipient
    in a transfer `0xa9059cbb ‖ pad32(recipient) ‖ u256be(declared)` sent to
    `asset`, or in a credit-line draw
    `0xcfd45e7c ‖ u256be(id) ‖ pad32(recipient) ‖ u256be(declared)` sent to the
    bb84 credit-line contract `0x420000000000000000000000000000000000004b`
    (see [Credit-line draws](#credit-line-draws)). A `Transfer` event that
    credits `payTo` is not sufficient on its own: a goods-and-services payment
    also emits a `Transfer` to the fee collector, and a payment requirement
    naming the fee collector as `payTo` MUST NOT be satisfied by it.
11. Sum the `Transfer` events (`topic0 =
    0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`) emitted
    by `asset` whose `to` is `payTo`. For a credit-line draw count only events
    whose `from` is the credit-line contract. If no such event exists, return
    `invalid_exact_bb84_recipient_mismatch`. Apply the rule of
    [Amounts](#amounts) with the payment type byte and `declared` from the
    calldata (`invalid_exact_bb84_amount_insufficient`). The `from` of the
    counted events is the `payer`; for a credit-line draw the `payer` is the
    transaction sender.
12. Decode the on-chain memo: the bytes after the calldata head (68 bytes for a
    transfer, 100 bytes for a credit-line draw) and the payment type byte, as
    UTF-8 with replacement of invalid sequences. Require it to match
    `extra.memo` under [Normalization and matching](#normalization-and-matching)
    (`invalid_exact_bb84_memo_mismatch`). A transaction without a payment type
    byte has no memo and fails this check.
13. Require the timestamp of the transaction's block to be no older than the
    maximum proof age of 180 days at validation time
    (`invalid_exact_bb84_transaction_too_old`).
14. Look the transaction up in the binding store. If it is recorded with a
    binding whose `payTo`, `asset` or normalized memo differs from this
    request's, return `invalid_exact_bb84_transaction_already_bound`. A read
    error of the store MUST fail the check; it MUST NOT be read as "not
    recorded".

A `/verify` that passes every check returns `isValid: true` with `payer`.

### Credit-line draws

bb84 lets an account grant another account a credit line held in escrow by the
credit-line contract. A draw on it is a payment by the grantee: the grantee's
reveal transaction calls `drawLine(id, recipient, amount)` on the contract, which
transfers from the escrow to `recipient` and carries the payment type byte and
memo after the 100-byte call. Facilitators MUST accept such a draw under the
rules above. The escrow's token is not in the calldata, so only `Transfer`
events emitted by `asset` with `from` equal to the credit-line contract count.

## Settlement and Replay Protection

Settlement does not move funds; the transfer happened before the proof was
presented. `/settle` establishes finality for the resource server by binding the
transaction to the requirements and recording the binding.

The canonical consumption key MUST be the ASCII string

```text
"eip155:42069000:" + transaction
```

where `transaction` is the lowercase reveal transaction hash with its `0x`
prefix. The separator is one colon.

After the checks above pass, the facilitator MUST, under a lock on the key:

1. Read the existing record. If one exists with a different binding, return
   `invalid_exact_bb84_transaction_already_bound`.
2. If none exists, insert a record with the binding and the settlement time. The
   store MUST be restart-durable and MUST be shared by every process serving
   `/settle` for this network.
3. Return `success: true` with `payer`, `transaction`, `network` and
   `amount` equal to `PaymentRequirements.amount`.

A repeated `/settle` with an identical binding MUST return success again. The
transaction hash and the memo are public on the chain, so any observer can call
`/settle` with the correct binding before the payee does. If the first call
consumed the proof, an observer could lock the payee out of every payment at no
cost. Idempotent settlement per binding removes that attack: whoever calls first,
the payee's own settle succeeds. The single-use claim required by
`scheme_exact.md` is therefore owned by the resource server: it MUST claim the
memo atomically before it executes the resource, so that of two concurrent
presentations exactly one is served, and it MUST release the claim when `/settle`
fails or its handler fails, so that the payer can present the proof again. All
resource server instances that issue memos for the same `payTo` MUST share this
claim store or MUST use distinct memo keys.

A binding record MUST be retained for at least the maximum proof age after the
transaction's block time. The reference facilitator forgets a record 190 days
after settlement; by then the transaction fails the age check and can never be
presented again.

On success, `SettlementResponse.transaction` is the lowercase reveal transaction
hash and `payer` is the payer account:

```json
{
  "success": true,
  "payer": "0xb4b030d0d7d47943e039a6eddc5b711f8827efe4",
  "transaction": "0x8f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
  "network": "eip155:42069000",
  "amount": "10000"
}
```

## Finality and Failure Disposition

A payment is final when its reveal transaction is included in a bb84 block with
receipt `status == 0x1`, as observed by the facilitator's node. bb84 blocks are
produced every 2 seconds by the chain's sequencer. The facilitator owns the
confirmation-depth policy; the reference facilitator accepts inclusion. While
the transaction is known to the node but has no receipt, `/settle` MUST return
`invalid_exact_bb84_transaction_not_found` without recording anything.

If the reveal transaction is never included, for example because its commit
expired, no funds moved and the client MAY pay again with the same memo. If it
is included with `status != 0x1`, no funds moved either. If it is included
successfully but fails validation, the funds are with `payTo`; this method
defines no return path (see [Amounts](#amounts)).

## Facilitator `/supported`

A facilitator for this network MUST advertise the method in the `extra` of its
`kinds[]` entry:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:42069000",
      "extra": {
        "assetTransferMethod": "memo-transfer",
        "paymentFlow": "upfront",
        "assets": {
          "USDC": "0x50590EE131EdC98a7213c91Ae82e3e8987B9b5eE",
          "EURC": "0x47dbBf8233cd91C16360bDb69e325f771FD9A667"
        },
        "memoMaxLength": 100,
        "documentation": "https://bb84.com/developers#x402"
      }
    }
  ],
  "extensions": [],
  "signers": {}
}
```

| Field | Required | Meaning |
|---|---|---|
| `extra.assetTransferMethod` | Yes | `"memo-transfer"`. |
| `extra.paymentFlow` | Yes | `"upfront"`. |
| `extra.assets` | Yes | Symbol to token address for every `asset` the facilitator accepts. |
| `extra.memoMaxLength` | Yes | Maximum memo length in Unicode scalar values that the facilitator and the bb84 wallets carry unchanged. |
| `extra.documentation` | No | Human-readable documentation of the deployment. |

`signers` is empty: the facilitator submits nothing.

## Error Vocabulary

Facilitators MUST use the following stable strings in `invalidReason` and
`errorReason`.

| Reason | Meaning |
|---|---|
| `invalid_payload` | `paymentPayload` or `paymentRequirements` is not an object. |
| `unsupported_scheme` | `scheme` is not `exact`. |
| `invalid_network` | `network` is not `eip155:42069000`. |
| `invalid_payment_requirements` | `payTo`, `amount` or `maxTimeoutSeconds` is malformed. |
| `invalid_exact_bb84_asset` | `asset` is not a token the facilitator advertises. |
| `invalid_exact_bb84_asset_transfer_method` | `extra.assetTransferMethod` is missing or not `memo-transfer`. |
| `invalid_exact_bb84_payment_flow` | `extra.paymentFlow` is missing or not `upfront`. |
| `invalid_exact_bb84_memo_missing` | `extra.memo` is absent or empty. |
| `invalid_exact_bb84_memo_malformed` | `extra.memo` violates the memo format. |
| `invalid_exact_bb84_accepted_mismatch` | A core field of `accepted` differs from the requirements. |
| `invalid_exact_bb84_transaction_hash_malformed` | `payload.transaction` is not `0x` and 64 hexadecimal characters. |
| `invalid_exact_bb84_transaction_not_found` | The node knows no transaction or no receipt for the hash yet. Not final. |
| `invalid_exact_bb84_transaction_failed` | The receipt status is not `0x1`. |
| `invalid_exact_bb84_recipient_mismatch` | The calldata names another recipient, or no `Transfer` of `asset` credits `payTo`. |
| `invalid_exact_bb84_amount_insufficient` | The credited amount does not satisfy `amount`. |
| `invalid_exact_bb84_memo_mismatch` | The on-chain memo does not match `extra.memo`. |
| `invalid_exact_bb84_transaction_too_old` | The transaction's block is older than the maximum proof age. |
| `invalid_exact_bb84_transaction_already_bound` | The transaction is recorded with a different binding. |

Resource server implementations SHOULD use these local failure reasons; they are
not facilitator response reasons:

| Reason | Meaning |
|---|---|
| `invalid_exact_bb84_memo_not_issued` | The presented memo was not issued by this server for these terms. |
| `exact_bb84_payment_already_used` | The memo was already claimed and delivered. |

## Security Considerations

### Public proof

The proof is a transaction hash, and the transaction, including its memo, is
public on the chain. Unlike a Lightning preimage, it is not a secret. Request
binding therefore limits a proof to the challenge it was issued for, but it does
not identify the presenter: between the transaction's inclusion and the payer's
retry, anyone who observes the chain and knows the resource server's endpoint
and price could present the proof first and be served, after which the payer's
own presentation fails with `exact_bb84_payment_already_used`. The window is the
few seconds between inclusion and the retry, and the gain is one delivery of a
resource priced at `amount`.

Resource servers whose resources are valuable enough to attract such a race
SHOULD bind the challenge to the client beyond the memo, for example by issuing
the memo only within an authenticated session and accepting its proof only from
the same session, or SHOULD use another payment method. Clients SHOULD present
the proof immediately after the receipt. Operators MUST NOT treat the `payer`
field as proof that the presenter controls the payer account.

### Memo issuance authority

The memo is the only link between a payment and a challenge. A resource server
MUST accept a proof only for a memo it issued for exactly these terms. Without
this check any payment to `payTo`, including ordinary purchases with their own
references, could be presented as a proof for a priced resource. The memo key
MUST be kept secret; every instance that issues or settles memos for the same
`payTo` MUST share it, or an instance will reject proofs for memos another
instance issued.

### Recipient from calldata

A goods-and-services payment emits two `Transfer` events: one to the recipient
and one to the fee collector. The facilitator MUST take the recipient from the
calldata, not from an event, so that a requirement naming the fee collector as
`payTo` is not satisfied by the fee leg of someone else's payment.

### Bystander settlement and idempotency

Because the proof and the binding are public, `/settle` cannot distinguish the
payee from a bystander. A first-presentation-wins facilitator would let a
bystander deny service to the payee for free. Settlement is therefore idempotent
per binding, and single delivery is enforced by the resource server's memo
claim. A different binding for the same transaction is rejected, so a payment
cannot be spent at two resource servers or for two prices.

### Durable binding store

A facilitator restart MUST NOT forget bindings: a forgotten binding would let
the same transaction be bound to another `payTo`, `asset` or memo. All
facilitator processes for this network MUST share one store with atomic insert
under a per-key lock. A store read error MUST fail validation closed.

### Proof age

A transaction older than 180 days is never accepted, which bounds the binding
store. Resource servers that remember claimed memos SHOULD keep them for the same
period, after which the proof can no longer be presented.

### Unauthenticated facilitator endpoints

`/verify` and `/settle` need no credentials, and every call costs the
facilitator node reads. Facilitators SHOULD rate-limit callers; the reference
facilitator allows 120 calls per minute per IP address and answers HTTP 429
beyond that.

### No facilitator custody

The facilitator holds no funds and no signing authority and cannot move value. A
compromised facilitator can misreport, but it cannot redirect a payment. The
trust placed in it is the trust in its chain reading and its binding store.

### Payer privacy

`payer` is a bb84 account address. bb84 accounts are commonly one-time
addresses; the field identifies the paying account for reconciliation, not a
person.

## Appendix

### A. Calldata test vector

Requirement: `amount = "10000"`, `payTo = 0xba7fc8791c8ce5aad97b2f654496ea7a96c51441`,
`extra.memo = "x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01"`. The payer sends a
goods-and-services transfer without an addition. The reveal transaction's `to`
is the USDC contract and its `data` is the following 115 bytes:

```text
a9059cbb
000000000000000000000000ba7fc8791c8ce5aad97b2f654496ea7a96c51441
0000000000000000000000000000000000000000000000000000000000002710
01
783430323a35663163306139653362376432633465366138302e3963316537623361356432663465366338613031
```

The same payment with the addition `" · pr_0123456789abcdef01234567"` has 146
bytes of `data`; the last 31 bytes are
`20c2b72070725f303132333435363738396162636465663031323334353637`. Both
transactions match the requirement memo.

### B. Memo matching cases

The requirement memo is `x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01`.

| On-chain memo | Result |
|---|---|
| `x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01` | Match. |
| `X402:5F1C0A9E3B7D2C4E6A80.9C1E7B3A5D2F4E6C8A01` | Match (case folding). |
| `x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01 · pr_0123456789abcdef01234567` | Match (payer's addition). |
| `x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01pr_0123` | `invalid_exact_bb84_memo_mismatch`. |
| `x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a0` | `invalid_exact_bb84_memo_mismatch`. |
| `Kaffee · x402:5f1c0a9e3b7d2c4e6a80.9c1e7b3a5d2f4e6c8a01` | `invalid_exact_bb84_memo_mismatch`. |
| no payment type byte, 68-byte calldata | `invalid_exact_bb84_memo_mismatch`. |

### C. Settlement cases

Each case starts with an empty binding store and a successfully included
goods-and-services transfer `T` of 10000 USDC base units to `payTo` with the
requirement memo `M`.

| Case | Expected result |
|---|---|
| Settle `T` against the requirement with memo `M`. | Success. |
| Settle `T` again with the same requirement. | Success; the record is unchanged. |
| Settle `T` concurrently twice with the same requirement. | Both succeed; the resource server's memo claim serves one. |
| Settle `T` against a requirement with the same `payTo` and `asset` but memo `M'`. | `invalid_exact_bb84_memo_mismatch`. |
| Settle `T` with memo `M` for `amount = "20000"`. | `invalid_exact_bb84_amount_insufficient`. |
| Settle `T` with memo `M` and `payTo` set to the fee collector. | `invalid_exact_bb84_recipient_mismatch`. |
| Settle `T` with memo `M` and `asset` set to EURC. | `invalid_exact_bb84_recipient_mismatch`. |
| `T` is a friends-and-family transfer of 9950 base units. | `invalid_exact_bb84_amount_insufficient`. |
| `T` is a goods-and-services transfer with `declared = 10000` and `credited = 9950`. | Success. |
| `T` is included with `status == 0x0`. | `invalid_exact_bb84_transaction_failed`. |
| `T` is 181 days old. | `invalid_exact_bb84_transaction_too_old`. |

## References

- [x402 protocol specification v2](../../x402-specification-v2.md)
- [`exact` scheme overview](scheme_exact.md)
- [`exact` on EVM](scheme_exact_evm.md)
- [bb84 protocol for autonomous agents](https://bb84.com/agent/protocol.md)
- [bb84 developer documentation, x402 section](https://bb84.com/developers#x402)
- [Reference facilitator](https://bb84.com/api/x402/supported)
- [CAIP-2 chain identification](https://chainagnostic.org/CAIPs/caip-2)
- [ethereum-lists/chains entry for chain 42069000](https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-42069000.json)
