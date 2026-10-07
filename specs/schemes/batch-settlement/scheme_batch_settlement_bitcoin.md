# Scheme: `batch-settlement` on Bitcoin with GoBTC Rails

> Status: **draft**. Companion to the network-agnostic
> [`batch-settlement` specification](./scheme_batch_settlement.md).

## Summary

This document specifies a capital-backed `batch-settlement` binding for Bitcoin
mainnet using GoBTC Rails custody-assisted wallets. A client signs a prepared
[PSBT](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki) for each
request. The facilitator accepts that signed PSBT as an offchain commitment,
the resource server responds immediately, and the facilitator later adds the
platform signature and broadcasts the latest accumulated transaction.

The binding is `batch-settlement`, not `exact`, because successful x402
settlement records a commitment while Bitcoin value moves later. Several
commitments from one payer wallet may be redeemed by one Bitcoin transaction.

The method is specific to GoBTC Rails wallets. It does not define a generic
PSBT flow for arbitrary Bitcoin wallets or facilitators.

## Use Cases

- An AI agent pays a GoBTC Rails merchant for an API request in satoshis
  without waiting for a Bitcoin block.
- A resource server accepts many low-value BTC commitments while each payer
  amortizes its network fee across an accumulated transaction.

## 1. Roles and Trust Model

The binding uses a 2-of-3 P2WSH wallet:

- **K1 — client:** held by the payer and used to sign prepared payment PSBTs.
- **K2 — facilitator:** held by the GoBTC Rails co-signer and used for normal
  redemption.
- **K3 — recovery provider:** used with K1 for a recovery exit that does not
  require K2.

Normal spending requires K1 and K2. The facilitator stores the wallet
descriptor, selects UTXOs, constructs PSBTs, serializes wallet operations, and
retains the latest accepted commitment until redemption. It cannot change a
K1-signed transaction's recipient, amount, inputs, fee, or change outputs when
adding K2.

This is a **capital-backed** binding: an accepted commitment spends live
Bitcoin UTXOs controlled by the payer's multisig wallet. The facilitator does
not extend unsecured credit to the payer. Resource servers nevertheless trust
the facilitator to enforce UTXO reservations, preserve accepted obligations
when rebuilding a batch, and complete K2 signing and broadcast.

`payTo` MUST be a Bitcoin address registered to a GoBTC Rails merchant. The
binding does not support arbitrary external recipients because the facilitator
must preserve the merchant obligation across batch replacement and broadcast
recovery.

The payer funds the Bitcoin network fee. The payment output MUST equal the x402
`amount`; fees may reduce only a payer-controlled change output.

## 2. Protocol Flow

The binding uses the x402 `authorization` flow:

1. The client requests a protected resource.
2. The resource server returns `402 Payment Required` with a
   `batch-settlement` Bitcoin requirement.
3. The client asks the same facilitator that will serve `/verify` and `/settle`
   to prepare a PSBT for the selected requirement and resource.
4. The facilitator stores an expiring preparation record and returns an
   unsigned PSBT plus its opaque `preparationId`.
5. The client validates the PSBT against its local spending policy and signs it
   with K1.
6. The client retries the resource request with a `PAYMENT-SIGNATURE` carrying
   the K1-signed PSBT and `preparationId`.
7. `/verify` validates the preparation and signature without mutating wallet,
   UTXO, or batch state.
8. The resource handler runs.
9. `/settle` atomically accepts the commitment, reserves its inputs, and links
   the merchant obligation to the live batch. No Bitcoin transaction is
   broadcast in the request path.
10. A background redemption worker adds K2, finalizes the accumulated
    transaction, broadcasts it, and reconciles its Bitcoin confirmation.

The preparation operation is network-specific and is not a new core x402
endpoint. Implementations MAY expose it through an SDK or facilitator API, but
MUST preserve the semantics in section 4. Bare x402 clients require a plugin
that implements this operation and K1 signing.

## 3. Wire Format

The core `PaymentRequired`, `PaymentPayload`, `VerifyResponse`, and
`SettlementResponse` types are defined in
[`x402-specification-v2.md`](../../x402-specification-v2.md).

### 3.1 `PaymentRequirements`

| Field | Required value |
|---|---|
| `scheme` | `"batch-settlement"` |
| `network` | Bitcoin mainnet [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md): `"bip122:000000000019d6689c085ae165831e93"`. |
| `amount` | Positive canonical base-10 satoshi amount. |
| `asset` | Native BTC [CAIP-19](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-19.md): `"bip122:000000000019d6689c085ae165831e93/slip44:0"`. |
| `payTo` | Registered GoBTC Rails merchant Bitcoin address. |
| `maxTimeoutSeconds` | Maximum duration of the HTTP payment attempt. |
| `extra` | Method parameters below. |

`extra` is a closed object:

| Field | Required | Description |
|---|---|---|
| `assetTransferMethod` | yes | MUST be `"gobtc-rails-preauthorized-psbt"`. |
| `paymentFlow` | no | When present, MUST be `"authorization"`. |
| `maxBatchDelaySeconds` | yes | Positive integer bounding the delay between commitment acceptance and the first broadcast attempt. |

Example:

```json
{
  "scheme": "batch-settlement",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "amount": "5000",
  "asset": "bip122:000000000019d6689c085ae165831e93/slip44:0",
  "payTo": "bc1qexamplemerchantaddress",
  "maxTimeoutSeconds": 60,
  "extra": {
    "assetTransferMethod": "gobtc-rails-preauthorized-psbt",
    "paymentFlow": "authorization",
    "maxBatchDelaySeconds": 180
  }
}
```

### 3.2 Preparation Record

The client sends the selected `PaymentRequirements`, the core `resource`
object, and an opaque Rails wallet identifier to the facilitator's preparation
operation. The facilitator returns:

| Field | Type | Description |
|---|---|---|
| `preparationId` | string | Cryptographically random, single-use identifier. |
| `unsignedPsbt` | string | Base64 BIP-174 PSBT constructed by the facilitator. |
| `expiresAt` | number | Unix timestamp after which the preparation cannot be verified or settled. |

The facilitator MUST store, keyed by `preparationId`:

- the exact `resource` and selected `PaymentRequirements`;
- the payer wallet and descriptor;
- the unsigned transaction bytes and PSBT metadata;
- every selected input and permitted output;
- the current accepted batch that this preparation extends, if any;
- the expiration time.

The record MUST be immutable. A new construction attempt creates a new
`preparationId`. `expiresAt` MUST NOT exceed the earlier of the preparation
time plus `maxTimeoutSeconds` and the live parent's broadcast deadline.

### 3.3 `PaymentPayload`

For this method, the otherwise optional core `resource` field is REQUIRED. It
MUST equal the resource stored in the preparation record.

The scheme-specific `payload` object is closed:

| Field | Type | Description |
|---|---|---|
| `type` | string | MUST be `"payment"`. |
| `preparationId` | string | Identifier returned by the preparation operation. |
| `signedPsbt` | string | Base64 PSBT containing a valid K1 signature for every wallet input. |

Example:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "batch-settlement",
    "network": "bip122:000000000019d6689c085ae165831e93",
    "amount": "5000",
    "asset": "bip122:000000000019d6689c085ae165831e93/slip44:0",
    "payTo": "bc1qexamplemerchantaddress",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "gobtc-rails-preauthorized-psbt",
      "paymentFlow": "authorization",
      "maxBatchDelaySeconds": 180
    }
  },
  "payload": {
    "type": "payment",
    "preparationId": "prep_7f3c...",
    "signedPsbt": "cHNidP8BA..."
  }
}
```

### 3.4 `SettlementResponse`

A successful `/settle` response records offchain commitment acceptance:

```json
{
  "success": true,
  "transaction": "",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "amount": "5000",
  "extra": {
    "commitmentId": "commitment_01J...",
    "status": "accepted"
  }
}
```

`extra.commitmentId` MUST be non-empty and unique within the facilitator. It is
the durable reference for the accepted merchant obligation and MUST remain
stable if the underlying PSBT is later replaced by a larger accumulated PSBT.
`transaction` is empty because no Bitcoin transaction is broadcast during
request settlement.

## 4. Preparation Requirements

The facilitator MUST construct the PSBT; the client MUST NOT supply arbitrary
inputs, outputs, fee policy, or change addresses.

The PSBT MUST:

1. spend only unspent, policy-eligible UTXOs belonging to the payer wallet;
2. increase the aggregate value assigned to `payTo` by exactly `amount`
   satoshis relative to the accepted parent, or assign exactly `amount` when
   there is no parent;
3. preserve every unredeemed merchant obligation from the accepted parent
   batch;
4. send change only to an address derived from the payer wallet descriptor;
5. use a fee rate selected under the facilitator's published Bitcoin fee
   policy;
6. contain no other value-moving outputs;
7. expose to the client all input UTXOs, scripts, amounts, outputs, and fee data
   needed by a BIP-174 signer to validate the transaction.

The client signer MUST independently verify those properties and its local
spending policy before adding K1 signatures.

An unaccepted preparation MUST NOT reserve funds, supersede an accepted batch,
or reduce the payer's available balance. It expires at `expiresAt` without any
payment effect.

## 5. Verification

`POST /verify` MUST be read-only. It MUST NOT reserve an input, consume a
`preparationId`, advance batch state, add K2, or broadcast a transaction.

The facilitator MUST verify:

1. `x402Version`, `accepted`, and `resource` match the immutable preparation
   record exactly;
2. the preparation exists, is unexpired, and has not been accepted with a
   different payload;
3. the signed PSBT has the same unsigned transaction and permitted metadata as
   the prepared PSBT;
4. every required K1 signature is valid for the payer wallet descriptor;
5. every input is still unspent, belongs to the payer wallet, and is not
   reserved by an incompatible accepted commitment;
6. the transaction increases the value assigned to `payTo` by exactly `amount`
   relative to its parent;
7. all inherited merchant obligations and payer change outputs remain intact;
8. the fee is payer-funded and within facilitator policy;
9. the prepared parent is still the current accepted batch for the wallet.

The facilitator MUST fail closed when wallet, UTXO, or parent-batch state is
unavailable. A resource server MUST delegate verification to the facilitator
that created the preparation; local verification is insufficient because the
preparation and reservation state are facilitator-owned.

## 6. Commitment Settlement

After the resource handler succeeds, `/settle` MUST repeat every mutable-state
check from section 5 and atomically:

1. consume `preparationId` for this exact signed PSBT;
2. reserve its inputs;
3. store the K1-signed PSBT as the wallet's live accepted batch;
4. attach a new durable `commitmentId` to the merchant obligation;
5. supersede the prepared parent only after all of its unredeemed obligations
   are linked to the new live batch.

Two concurrent settlements for one wallet MUST be serialized. If one changes
the parent before the other commits, the latter MUST fail with a stale
preparation error and the client MUST prepare and sign a new PSBT.

Repeating `/settle` with the same `preparationId` and byte-identical payload
MUST return the original successful response. Reusing it with different bytes,
requirements, or resource data MUST fail.

The settlement amount for this binding is fixed: `SettlementResponse.amount`
MUST equal `PaymentRequirements.amount`. Dynamic undercharging is not supported.

## 7. Accumulation and Redemption

An accepted PSBT MAY be used as the parent of a later preparation for the same
wallet. The child preserves all parent obligations and adds the new payment
delta. The child does not supersede the parent until its K1 signatures are
accepted by `/settle`.

The facilitator MUST make the first broadcast attempt no later than
`maxBatchDelaySeconds` after the oldest commitment in the live batch was
accepted. A background worker:

1. revalidates the live batch and its input reservations;
2. adds K2 through the policy-enforcing co-signer;
3. finalizes the Bitcoin transaction;
4. broadcasts the exact K1+K2 transaction;
5. records its txid against every included `commitmentId`;
6. reconciles broadcast ambiguity by txid before retrying.

Infrastructure failures, RPC timeouts, and an ambiguous broadcast result MUST
leave commitments recoverable and MUST NOT silently discard merchant
obligations. The facilitator retries the same finalized transaction or
reconciles it by txid.

If a Bitcoin node definitively rejects the transaction and the txid is absent
from the network, the facilitator MUST rebuild every still-valid merchant
obligation into a replacement PSBT before retiring the failed batch. A
commitment remains pending until it is included in a replacement or resolved
under the facilitator's merchant guarantee.

Onchain redemption remains pending until the transaction reaches the
facilitator's configured Bitcoin confirmation threshold. That threshold and
deeper merchant policy do not change the earlier x402 commitment response.

## 8. Replay and Double-Spend Prevention

Replay protection has three layers:

- `preparationId` is random, immutable, single-use, and bound to one resource,
  requirement, wallet, and unsigned transaction.
- `/settle` consumes the identifier atomically and is idempotent only for the
  identical signed PSBT.
- Bitcoin UTXOs are the authoritative network replay primitive. A redeemed or
  conflicting input can never produce a second successful Bitcoin payment.

The facilitator MUST serialize all operations that may spend the same wallet,
including payments, withdrawals, batch replacement, and recovery exit. A lock
alone is not a correctness mechanism: durable input reservations, parent-state
comparison, and transactional compare-and-swap checks remain mandatory.

An initiated K1+K3 recovery exit MUST freeze new preparations and settlements.
Before releasing or accepting a recovery transaction, the facilitator and
recovery provider MUST reconcile all accepted commitments so that the exit
cannot silently invalidate merchant obligations.

## 9. Security Considerations

### Authorization Scope

K1 signatures authorize the complete Bitcoin transaction, including inputs,
merchant outputs, payer change, and fee. K2 MUST be added only to the exact
transaction bytes accepted from the client. The facilitator MUST NOT use a
generic message signature or preparation record as a substitute for validating
the PSBT signatures.

### Recipient and Amount Integrity

`payTo` and `amount` come from the selected requirements. The facilitator and
client signer MUST both validate that the transaction increases the value
assigned to `payTo` by exactly `amount` relative to its parent. A smaller or
larger delta is invalid. The facilitator MUST verify that `payTo` belongs to the
registered merchant represented by the resource server.

### Batch Replacement

A replacement is valid only when it contains every unredeemed obligation from
its exact parent. Parent supersession and child acceptance MUST be one atomic
state transition. An unsigned or expired child never affects the parent.

### Fee Safety

The payer funds the Bitcoin fee. The facilitator MUST bound the fee rate and
absolute fee, and the client signer SHOULD enforce stricter local limits. A fee
increase MUST reduce only payer change and MUST NOT reduce a merchant output.

### Facilitator and Recovery Trust

The facilitator controls K2 and the preparation database; the recovery
provider controls K3. Either service alone cannot spend the wallet. Clients and
resource servers still rely on both services to enforce the freeze and
reconciliation protocol during recovery. Implementations MUST document this
trust dependency and their merchant guarantee for a commitment that cannot be
redeemed onchain.

## 10. Error Handling

The facilitator SHOULD use these machine-readable `invalidReason` or
`errorReason` values:

| Code | Meaning |
|---|---|
| `invalid_batch_settlement_bitcoin_preparation` | The preparation is missing, malformed, or bound to different requirements or resource data. |
| `expired_batch_settlement_bitcoin_preparation` | `expiresAt` has passed. |
| `stale_batch_settlement_bitcoin_parent` | The wallet's accepted parent changed after preparation. |
| `invalid_batch_settlement_bitcoin_psbt` | The PSBT differs from the prepared transaction or violates its input, output, change, or fee policy. |
| `invalid_batch_settlement_bitcoin_signature` | A required K1 signature is absent or invalid. |
| `insufficient_batch_settlement_bitcoin_funds` | Eligible wallet UTXOs cannot fund the payment and fee. |
| `duplicate_settlement` | The `preparationId` was reused with non-identical data. |

An expired or stale preparation is recoverable: the client requests a new
preparation and signs the replacement PSBT. A failed `/verify` or `/settle`
MUST NOT alter an existing accepted batch.

## 11. Limitations

- Only Bitcoin mainnet and native BTC are defined.
- Only GoBTC Rails 2-of-3 P2WSH wallets can act as payers.
- Only facilitator-registered GoBTC Rails merchants can be recipients.
- Verification is not facilitator-portable because preparation state, input
  reservations, K2, and the wallet descriptor are held by GoBTC Rails.
- A custom client plugin is required for preparation and K1 signing.

Testnet network identifiers, external-wallet payment methods, additional
facilitators, and SDK implementations are outside this specification.
