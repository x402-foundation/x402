# Scheme: `exact` on `Atto`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses the following [CAIP-2](https://chainagnostic.org/CAIPs/caip-2)-formatted identifiers under the proposed
`atto` namespace. Its [ChainAgnostic namespace registration](https://github.com/ChainAgnostic/namespaces/pull/178) is
pending:

- `atto:live` — Atto mainnet
- `atto:beta` — Atto beta / testnet
- `atto:dev` — Atto devnet
- `atto:local` — local / private development network

The corresponding native transaction JSON uses the uppercase Atto network values `LIVE`, `BETA`, `DEV`, and `LOCAL`.

## Summary

The x402 `exact` scheme on Atto uses a fully signed native Atto `SEND` transaction to transfer an exact amount of the
native Atto asset from the client to the resource server's recipient. The client funds the payment itself. Atto is
feeless; instead of a monetary network fee, the client computes the transaction's proof-of-work (PoW).

This **facilitator-submitted** method uses the standard [authorization flow](./scheme_exact.md#payment-flow): verify,
execute the resource, then settle. Its default `assetTransferMethod` is `native`, its only supported `paymentFlow` is
`authorization`, and both defaults MAY be omitted from `PaymentRequirements.extra`.

- **Fee payer:** payer-funded; the facilitator only relays the signed native transaction.
- **Replay primitive:** the sender's next account-chain position (`publicKey`, `height`, and `previous`), shared with
  other transactions from that account. Only one payment built from a given confirmed frontier can settle. Competing
  payments can both pass `/verify`; unrelated account activity can invalidate a payment before `/settle`.
- **Validity window:** Atto has no native transaction expiry. For x402, the signed block timestamp plus
  `maxTimeoutSeconds` is the acceptance deadline. A facilitator MUST NOT begin a first broadcast after that deadline.
  This is an x402 policy deadline, not a native network expiry: an unused transaction can remain network-valid until the
  sender advances its account chain. The payer can invalidate it by publishing another next block.
- **Duplicate submission:** Atto's transaction submission API can be idempotent for the same native transaction hash and
  can return an already-confirmed transaction. Facilitators therefore MUST provide their own atomic settlement
  deduplication.

## `PaymentRequirements` for `exact`

Use the standard [v2 `PaymentRequirements`](../../x402-specification-v2.md) with these Atto values:

```json
{
  "scheme": "exact",
  "network": "atto:local",
  "amount": "500000000",
  "asset": "atto",
  "payTo": "atto://aaqccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d76lv23r6q",
  "maxTimeoutSeconds": 60,
  "extra": {}
}
```

- `scheme` MUST be `"exact"`.
- `network` MUST be one of the Atto CAIP-2 identifiers above.
- `amount` MUST be the exact required amount in raw Atto units, encoded as an x402 decimal string.
- `asset` MUST be `"atto"` for this native-asset method.
- `payTo` MUST be the recipient Atto address in canonical `atto://` form.
- `maxTimeoutSeconds` MUST be a finite positive integer. The x402 acceptance deadline in epoch milliseconds is
  `block.timestamp + 1000 * maxTimeoutSeconds`, computed with exact arithmetic without overflow.
- If present, `extra.assetTransferMethod` MUST be `"native"` and `extra.paymentFlow` MUST be `"authorization"`.

## PaymentPayload `payload` Field

Use the standard [v2 `PaymentPayload`](../../x402-specification-v2.md) envelope. Its `payload.transaction` MUST contain
the structured address-based JSON profile below, not an encoded binary transaction:

```json
{
  "transaction": {
    "block": {
      "type": "SEND",
      "network": "LOCAL",
      "version": 0,
      "algorithm": "V1",
      "address": "atto://aab2cb576phbbpq5odorrz2lycmwpzgwgcn2kdk7dxoimzaskuy3rg4s6qz6c",
      "height": "2",
      "balance": "9500000000",
      "timestamp": "1789732800000",
      "previous": "A0A1A2A3A4A5A6A7A8A9AAABACADAEAFB0B1B2B3B4B5B6B7B8B9BABBBCBDBEBF",
      "receiverAddress": "atto://aaqccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d76lv23r6q",
      "amount": "500000000"
    },
    "signature": "0859A4636878EC4A6D43F9198F6A49E09773122BBE7797F71866DCC965C602E5EC5598347729945455E840EC484DB88ECE606CA4E985C56AF2D7C1B6FBB6540D",
    "work": "ABCF000000000000"
  }
}
```

Its signature and LOCAL PoW are valid, and its native block hash is
`DEDCDD3B58E06441BD653FA01B917A943C05EAFAABF140B24BADB07B2BD2EEE0`; the account-state values are illustrative.

## Native Transaction JSON and Hashing

The object shown above is the x402 address-based JSON profile of a native Atto transaction:

- `block` is an Atto `SEND` block.
- `signature` is the 64-byte Ed25519 signature as 128 unprefixed hexadecimal characters.
- `work` is the 8-byte PoW value as 16 unprefixed hexadecimal characters.
- `height`, `balance`, `timestamp`, and `amount` MUST be canonical decimal strings in this x402 profile. Unsigned values
  use `0` or a nonzero decimal digit followed by decimal digits; signed timestamps MAY additionally have a leading minus
  for nonzero values. Leading zeros, a plus sign, `-0`, fractions, exponents, and whitespace MUST be rejected.
- `height` MUST be in `1..18446744073709551615`; `balance` in `0..18000000000000000000`; `amount` in
  `1..18000000000000000000`; and `timestamp` in `-9223372036854775808..9223372036854775807` epoch milliseconds.
  Native timestamp and account-chain validation still apply. `version` remains a JSON integer number.
- Hashes, signatures, and work are byte strings represented as unprefixed hexadecimal. The examples use uppercase.
- `address` is the sender's canonical Atto address. Its decoded algorithm MUST equal `algorithm`; its decoded public key
  is the native block's `publicKey`.
- `receiverAddress` is the recipient's canonical Atto address. Its decoded algorithm and public key are the native
  block's `receiverAlgorithm` and `receiverPublicKey`.
- `publicKey`, `receiverAlgorithm`, and `receiverPublicKey` are redundant compatibility fields and MAY be present. An
  x402 payload parser MUST accept the transaction without them. If present, each MUST exactly equal the value decoded
  from its address; disagreement is invalid.

Native Atto JSON encodes the four 64-bit fields as integer numbers. Implementations MUST parse the x402 strings into
exact native integers before binary serialization, hashing, or submission; they MUST NOT convert them through an
IEEE-754-only number type. Native JSON submission MUST emit their exact integer tokens, without rounding.

The current Atto node submission API also requires the compatibility fields. Before submission, a facilitator MUST
derive and add them from the verified addresses. This normalization MUST preserve the native field values, block bytes,
signature, work, and hash. An endpoint that accepts the x402 profile directly MAY perform the normalization itself.

The canonical transaction identifier is the Atto block hash:

```text
BLAKE2b-256(
  type[1] || network[1] || version[2 LE] || algorithm[1] || address.publicKey[32] ||
  height[8 LE] || balance[8 LE] || timestamp[8 signed LE] || previous[32] ||
  receiverAddress.algorithm[1] || receiverAddress.publicKey[32] || amount[8 LE]
)
```

Verifiers MUST hash the 134 native block bytes, excluding signature and work; they MUST NOT hash JSON text or the x402
envelope. Equivalent JSON representations MUST yield the same hash. The canonical payment key is the normalized pair
`(paymentRequirements.network, nativeBlockHash)`.

## Client Construction

The client MUST:

1. Read the sender's latest confirmed account state from a trusted node. The payer MUST be opened and sufficiently funded.
2. Build a native `SEND` satisfying the profile and verification rules below, sign its native block hash, and compute PoW.
3. Encode `{ "block", "signature", "work" }` in `payload.transaction` using the defined decimal-string profile.

When using the optional [payment-identifier](../../extensions/payment_identifier.md) extension, the client MUST reuse the
original signed payment and identifier when retrying the same operation. A different identifier does not make a used
payment reusable.

## Facilitator Verification Rules

Facilitators MUST enforce these rules on `/verify` and independently before first submission during `/settle`. Failures
return `isValid: false` with the listed `invalidReason` or `success: false` with the listed `errorReason`, without broadcast.
Shared reasons follow the [v2 specification](../../x402-specification-v2.md). Pending settlement retries follow Settlement
below. Optional confirmed recovery is checked after rules 1–10 and before the current-state and admission checks in
rules 12–15; it does not admit a new payment or broadcast.

1. **Protocol version.** Both `paymentPayload.x402Version` and the facilitator request's `x402Version` MUST be `2`.
   Failure: `invalid_x402_version`.
2. **Scheme.** The selected scheme MUST be `"exact"`. Failure: `invalid_scheme`.
3. **Network.** The selected network MUST be a supported Atto identifier above, and the decoded native block network MUST
   correspond to it. Failure: `invalid_network`.
4. **Requirements.** `asset` MUST be `"atto"`; `payTo` MUST be canonical; `amount` MUST be a positive decimal string within
   the native monetary range; and `maxTimeoutSeconds` MUST be a finite positive integer. The transfer method MUST resolve
   to `"native"` and flow to `"authorization"`. Failure: `invalid_payment_requirements`.
5. **Accepted requirements.** `accepted` MUST match `paymentRequirements` for `scheme`, `network`, `asset`, `payTo`,
   `amount`, `maxTimeoutSeconds`, and resolved transfer method and flow. Failure: `invalid_payment_requirements`.
6. **Transaction profile.** `payload.transaction` MUST be an object conforming to the profile above. The block MUST be
   `SEND`; its native fields and relationships, version, algorithms, integer encodings and ranges, field lengths,
   addresses, and compatibility fields MUST be valid. Sender and receiver public keys MUST differ. Decode the addresses
   and normalize compatibility fields; derive the payer and native public key from `address`, whose algorithm MUST equal
   `block.algorithm`. Failure: `invalid_payload`.
7. **Recipient.** `receiverAddress` MUST equal validated `payTo`, including algorithm and public key.
   Failure: `invalid_exact_atto_recipient_mismatch`.
8. **Exact amount.** Parse the required and block amounts without loss; they MUST be equal. Underpayment and overpayment
   both fail. Failure: `invalid_exact_atto_amount_mismatch`.
9. **Signature.** The Ed25519 signature MUST authenticate the reconstructed native block hash using the sender key
   decoded from `address`. Failure: `invalid_exact_atto_signature`.
10. **Proof-of-work.** Work MUST be valid for `previous` under the native network and block timestamp.
    Failure: `invalid_exact_atto_pow`.
11. **Replay and recovery.** `/verify` MUST NOT reserve a canonical payment key or return `duplicate_settlement`.
    A matching confirmed recovery MAY return `invalid_exact_atto_already_settled` as specified below. Other confirmed
    replays fail the sender-frontier checks with `invalid_exact_atto_chain_state`. During `/verify`, a known claim whose
    outcome remains unresolved MUST fail closed with `unexpected_verify_error` while the facilitator reconciles it; an
    unresolved claim does not establish confirmation or invalid native account state. `/settle` MUST apply the atomic
    duplicate check below.
12. **Sender frontier.** From trusted canonical state, the sender MUST be opened, `height == current.height + 1`, and
    `previous == current.lastTransactionHash`; `block.version` MUST NOT be lower than the account's current version.
    Height arithmetic MUST NOT wrap.
    Failure: `invalid_exact_atto_chain_state`.
13. **Funding.** The sender's confirmed balance MUST cover the exact amount. Failure: `insufficient_funds`.
14. **Balance conservation.** `current.balance == block.balance + block.amount` MUST hold using exact arithmetic without
    wrapping. Failure: `invalid_exact_atto_chain_state`.
15. **Timestamp and admission deadline.** `block.timestamp` MUST be strictly later than the sender's confirmed timestamp,
    no more than one minute ahead of the verifier's clock, and valid under native Atto rules. Before a first broadcast,
    verifier time MUST NOT exceed `block.timestamp + 1000 * maxTimeoutSeconds` in epoch milliseconds.
    Failure: `invalid_exact_atto_timestamp`.

If trusted canonical state cannot be established, `/verify` MUST fail closed with `unexpected_verify_error`, and `/settle`
MUST fail with `unexpected_settle_error` before any possible broadcast. Uncertain broadcast outcomes use the shared
settlement handling below.

Atto exposes no simulation or dry-run endpoint; native validation and the account-state checks above provide preflight.

### Optional confirmed recovery

Facilitators MAY support recovery through the existing [payment-identifier](../../extensions/payment_identifier.md)
extension. When offered, the first settlement claim MUST durably record the original identifier when present, or its
absence otherwise, together with the payment/request binding in the original facilitator-caller scope. When an identifier
is present, the resource server MUST bind it to its original application operation as described by the extension. An
identifier supplied only on a later retry MUST NOT establish or replace the original binding. The canonical payment key
remains `(network, nativeBlockHash)`, independently of the identifier.

After rules 1–10 pass, `/verify` MAY return `isValid: false` with `invalid_exact_atto_already_settled` only when the exact
`SEND` is canonically confirmed and the original identifier, caller scope, and payment/request binding match. The response
MUST include the original hash and network in `extra.transaction` and `extra.network`. Missing original attribution,
missing or changed identifiers, and binding conflicts MUST NOT authorize recovery; normal verification failures or the
extension's conflict behavior apply. A confirmed replay that is not recoverable fails with `invalid_exact_atto_chain_state`.

For the transaction fixture above:

```json
{
  "isValid": false,
  "invalidReason": "invalid_exact_atto_already_settled",
  "payer": "atto://aab2cb576phbbpq5odorrz2lycmwpzgwgcn2kdk7dxoimzaskuy3rg4s6qz6c",
  "extra": {
    "transaction": "DEDCDD3B58E06441BD653FA01B917A943C05EAFAABF140B24BADB07B2BD2EEE0",
    "network": "atto:local"
  }
}
```

This is evidence for recovery of the original operation, not a valid authorization for another resource execution or
another settlement. A resource server opting into recovery MUST recognize this result before generic failed-verification
handling, validate its original operation and authorization, and recover only that operation's retained result. A generic
resource server MAY treat it as failed verification. A resource server tracking an unresolved original settlement MAY
resume the existing `/settle` observation path without executing the operation again; `/verify` MUST NOT report that
unresolved claim as already settled.

### Error reasons

The following table summarizes the numbered rules and settlement outcomes. Both endpoints enforce ordinary validation
before a first submission; confirmed recovery and pending settlement retries follow their explicit paths above and below.

| Reason | Meaning / endpoint |
| --- | --- |
| `invalid_x402_version` | Wrong protocol version; `/verify` or prebroadcast `/settle`. |
| `invalid_scheme` | Scheme is not `exact`; both endpoints. |
| `invalid_network` | Unsupported network or native network mismatch; both endpoints. |
| `invalid_payment_requirements` | Malformed requirements or `accepted` mismatch; both endpoints. |
| `invalid_payload` | Malformed transaction profile or native fields; both endpoints. |
| `invalid_exact_atto_recipient_mismatch` | Receiver differs from `payTo`; both endpoints. |
| `invalid_exact_atto_amount_mismatch` | Payment differs from the exact required amount; both endpoints. |
| `invalid_exact_atto_signature` | Invalid native signature; both endpoints. |
| `invalid_exact_atto_pow` | Invalid proof-of-work; both endpoints. |
| `invalid_exact_atto_chain_state` | Invalid sender frontier, version, or balance conservation; both endpoints. |
| `insufficient_funds` | Insufficient confirmed sender balance; both endpoints. |
| `invalid_exact_atto_timestamp` | Invalid timestamp or expired first-broadcast deadline; both endpoints. |
| `invalid_exact_atto_already_settled` | `/verify` only: confirmed original payment with matching recovery binding; not fresh authorization. |
| `unexpected_verify_error` | `/verify`: trusted state is unavailable or a known claim remains unresolved pending reconciliation. |
| `unexpected_settle_error` | `/settle`: trusted state is unavailable before any possible broadcast. |
| `duplicate_settlement` | `/settle` only: competing or consumed claim; does not establish confirmation. |
| `settlement_pending` | `/settle`: submitted transaction remains unresolved; nonterminal, with original hash and network. |

## Settlement

The facilitator MUST submit the exact native `block`, `signature`, and `work` it verified, applying only the JSON
normalization above. The recommended native call is `POST /transactions/stream?deduplicate=true`. Success requires
confirmation of the exact native `SEND` hash in sender history; the recipient may be unopened, and its separate `RECEIVE`
is not required. Return the standard `SettleResponse` with that hash in `transaction`, the selected `network`, and the
canonical sender address in `payer`.

If submission occurred but confirmation cannot be established, the facilitator MAY return the shared `settlement_pending`
response with the original hash and network. A retry observes that transaction before fresh sender-frontier or deadline
checks, without creating another settlement claim or payment.

### Settlement response examples

Successful settlement of the transaction fixture above:

```json
{
  "success": true,
  "payer": "atto://aab2cb576phbbpq5odorrz2lycmwpzgwgcn2kdk7dxoimzaskuy3rg4s6qz6c",
  "transaction": "DEDCDD3B58E06441BD653FA01B917A943C05EAFAABF140B24BADB07B2BD2EEE0",
  "network": "atto:local"
}
```

Submission occurred but confirmation cannot be established:

```json
{
  "success": false,
  "errorReason": "settlement_pending",
  "payer": "atto://aab2cb576phbbpq5odorrz2lycmwpzgwgcn2kdk7dxoimzaskuy3rg4s6qz6c",
  "transaction": "DEDCDD3B58E06441BD653FA01B917A943C05EAFAABF140B24BADB07B2BD2EEE0",
  "network": "atto:local"
}
```

### Duplicate Settlement Mitigation (REQUIRED)

Before first submission, the facilitator MUST durably and atomically claim the canonical payment key across every process
serving `/settle`. The existence check and insertion MUST be one atomic operation with uniqueness on
`(network, nativeBlockHash)`. When recovery is supported, the original identifier when present, or its absence otherwise,
and the binding MUST be recorded in the same claim operation; changing the identifier MUST NOT create another claim for
that payment.
A competing claim MUST fail with the shared `duplicate_settlement` reason; this indicates a seen or consumed payment,
not necessarily successful settlement. A completed payment MUST NOT yield another success; consumed keys MUST remain
rejectable using retained settlement history or canonical ledger evidence.

The facilitator MUST retain the claim while the transaction can still land. Atto has no native expiry: an elapsed x402
deadline or confirmation timeout alone does not prove failure. Reconcile the original hash before releasing the claim.

## Security Considerations

Because the client chooses `block.timestamp` and native validation permits up to 60 seconds of future skew, the remaining
x402 acceptance window at verification can be as long as `maxTimeoutSeconds + 60` seconds.

The payment identifier is outside the native block signature and is not, by itself, proof of entitlement to recover an
operation. Recovery depends on the original recorded binding and application authorization. Expiring an application result
or recovery binding MUST NOT make a claimed or consumed payment reusable.

## References

- [x402 v2 specification](../../x402-specification-v2.md)
- [Generic exact scheme](./scheme_exact.md)
- [Payment identifier extension](../../extensions/payment_identifier.md)
- [HTTP transport v2](../../transports-v2/http.md)
- [Atto integration documentation](https://atto.cash/docs/integration)
- [Atto transaction format and offline signing](https://atto.cash/docs/integration/advanced/protocol-offline-signing-reference)
- [Native transaction JSON serialization source](https://github.com/attocash/commons/blob/979b0103a6c8b554848be5fbd271fc88037e7df7/commons-core/src/commonMain/kotlin/cash/atto/commons/AttoTransaction.kt)
- [Native block serialization and validation source](https://github.com/attocash/commons/blob/979b0103a6c8b554848be5fbd271fc88037e7df7/commons-core/src/commonMain/kotlin/cash/atto/commons/AttoBlock.kt)
- [Atto node transaction submission API](https://github.com/attocash/node/blob/e33b5a8ce653e39154e966853415a8d8fdc93ad6/src/main/kotlin/cash/atto/node/transaction/TransactionController.kt)
- [Atto node account-chain validation](https://github.com/attocash/node/tree/e33b5a8ce653e39154e966853415a8d8fdc93ad6/src/main/kotlin/cash/atto/node/transaction/validation/validator)
