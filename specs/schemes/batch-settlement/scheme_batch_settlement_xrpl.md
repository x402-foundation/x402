# Scheme: `batch-settlement` on XRPL with opaque payout routing

Status: Draft  
Version: `xrpl-paychan-v1`

## 1. Scope

This document defines the XRPL network binding for the x402
`batch-settlement` scheme.

The binding uses an XRP Ledger Payment Channel with per-request cumulative,
capital-backed authorizations:

1. The payer funds a channel whose destination is the settlement recipient.
2. For each request, the payer signs an XRPL claim whose cumulative amount is
   the committed channel amount plus that request's maximum charge.
3. The resource server verifies that exact cumulative amount before executing
   the request.
4. Each request has a unique x402 `payment-identifier`.
5. The facilitator records the actual charge for each successful request.
6. The channel destination later redeems the accumulated charge with an XRPL
   `PaymentChannelClaim`.

The client supplies a cumulative XRPL claim for each logical request. A retry
of the same logical request reuses the same claim and payment identifier.

This version supports native XRP only.

## 2. Conformance

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are to be interpreted as described in BCP 14 when they appear in
all capitals.

An implementation conforms to this binding only if it implements the x402 v2
facilitator interface and all requirements in this document.

## 3. Roles and trust model

- **Payer:** The XRPL account that creates and funds the payment channel.
- **Channel destination:** The XRPL account in `PayChannel.Destination`. It is
  the x402 `payTo` account and can redeem the signed authorization.
- **Resource server:** The HTTP server providing the paid resource.
- **Facilitator:** The service that verifies authorizations, reserves capacity,
  commits charges, and exposes `/verify`, `/settle`, and `/supported`.
- **Beneficiary:** An optional downstream recipient identified by the opaque
  `PaymentRequirements.extra.payoutReference`.

The payer-to-channel-destination leg is capital-backed by XRP allocated to the
channel.

When `extra.payoutReference` is present, the channel destination is a
collector. The facilitator resolves the reference in its registry to the
beneficiary's payout configuration. The collector owes a separate payout to
that beneficiary. The reference does not prescribe a payout network or wallet
format. That downstream obligation is credit-backed: the XRPL channel does not
cryptographically earmark funds for the beneficiary.

Each XRPL signature authorizes the channel destination to claim up to its
signed cumulative amount. The resource server's authoritative state determines
the expected amount for each request and records the lower actual charge.
Clients **SHOULD** treat the highest amount they have signed as their exposure
to the channel destination.

## 4. Identifiers and amounts

### 4.1 Network

`PaymentRequirements.network` **MUST** be:

```text
xrpl:<network_id>
```

`<network_id>` is the unsigned `network_id` returned by XRPL `server_info`.
Examples are `xrpl:0` for livenet and `xrpl:1` for testnet.

The facilitator **MUST** confirm that its XRPL endpoint reports the requested
`network_id`.

### 4.2 Asset

`PaymentRequirements.asset` **MUST** identify native XRP:

```text
xrpl:<network_id>/slip44:144
```

For example:

```text
xrpl:0/slip44:144
```

Issued currencies, MPTs, LP tokens, NFTs, and non-XRP native assets are outside
this version.

### 4.3 Amounts

All monetary amounts **MUST** be non-negative base-10 integer strings
representing drops. JSON numbers, signs, decimal XRP values, separators,
whitespace, and scientific notation **MUST NOT** be used.

Amounts **MUST** fit in an unsigned 64-bit integer. One XRP is 1,000,000 drops.

### 4.4 Accounts and tags

`payTo` and payer values **MUST** be canonical XRPL classic addresses.
X-addresses **MUST NOT** be used.

Destination tags, when present, **MUST** be unsigned 32-bit integers.

## 5. Payment requirements

Example with direct settlement:

```json
{
  "scheme": "batch-settlement",
  "network": "xrpl:0",
  "amount": "1000",
  "asset": "xrpl:0/slip44:144",
  "payTo": "rEXAMPLEChannelDestination",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "binding": "xrpl-paychan-v1",
    "minSettleDelay": 86400,
    "redemptionSafetySeconds": 60
  }
}
```

Example with downstream payout routing:

```json
{
  "scheme": "batch-settlement",
  "network": "xrpl:0",
  "amount": "1000",
  "asset": "xrpl:0/slip44:144",
  "payTo": "rEXAMPLECollector",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "binding": "xrpl-paychan-v1",
    "minSettleDelay": 86400,
    "redemptionSafetySeconds": 60,
    "payoutReference": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

XRPL-specific fields:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `extra.binding` | string | yes | **MUST** equal `xrpl-paychan-v1`. |
| `extra.minSettleDelay` | integer | yes | Minimum acceptable channel `SettleDelay`, in seconds. **MUST** be at least `maxTimeoutSeconds + extra.redemptionSafetySeconds`. |
| `extra.redemptionSafetySeconds` | integer | yes | Positive time reserved for claim submission and validation, in seconds. |
| `extra.destinationTag` | integer | no | Required tag on the channel destination. |
| `extra.payoutReference` | string | no | Non-empty opaque downstream recipient reference. Its presence selects collector operation. |

`amount` is the maximum charge for one request.
`extra.redemptionSafetySeconds` **MUST** be chosen to cover XRPL transaction
submission, queueing, and validation under the facilitator's operating policy.

`payTo` **MUST** equal the payment channel's `Destination`. When
`extra.payoutReference` is absent, `payTo` is the final recipient. When it is
present, `payTo` is the collector and the reference identifies the downstream
beneficiary in the facilitator's registry.

The facilitator **MUST** compare the payout reference exactly and **MUST NOT**
interpret or normalize it before lookup. During `/verify`, it **MUST** resolve
the reference through the registry it operates and require it to be valid for
the advertised resource or authenticated resource server. The resolution
**MUST** identify the beneficiary and an immutable payout-configuration version
or hash. The payout reference is an opaque routing identifier, not a secret or
bearer credential.

The selected `PaymentRequirements`, including the fields above, **MUST** be
echoed in `PaymentPayload.accepted`. Client-added fields **MUST NOT** change or
override the server-advertised payout reference.

For `/verify` and `/settle`, the facilitator **MUST** require
`paymentRequirements.extra.payoutReference` to be identical to
`paymentPayload.accepted.extra.payoutReference` and use the server-supplied
requirements as the authoritative source. It **MUST NOT** route a payout from
`paymentPayload.accepted` alone.

## 6. Per-request cumulative authorization

### 6.1 Channel preparation

Before making paid requests, the payer creates or funds a `PayChannel`:

- `Account` is the payer.
- `Destination` equals `PaymentRequirements.payTo`.
- `Amount` is sufficient for the intended cumulative authorizations.
- `SettleDelay` is at least `extra.minSettleDelay`.
- `PublicKey` is the key used to sign the authorization.
- `DestinationTag`, if required, equals `extra.destinationTag`.

Creation and funding **MUST** be observed in a validated ledger before the
new capacity is used.

### 6.2 Signing input

Each request authorization is a native XRPL payment-channel claim signature
over:

```text
0x434C4D00
|| channelId
|| authorizedAmount
```

where:

- `0x434C4D00` is the four-byte `CLM\0` prefix;
- `channelId` is 32 bytes; and
- `authorizedAmount` is an unsigned 64-bit integer in big-endian form.

The signature authorizes a cumulative channel amount. For a new logical
request, `authorizedAmount` **MUST** equal the authoritative
`committedAmount + PaymentRequirements.amount` at verification time.

`channelId`, `publicKey`, and `signature` **MUST** be uppercase hexadecimal on
the wire. A verifier **MAY** accept lowercase and normalize it.

### 6.3 Payment payload

The x402 `PAYMENT-SIGNATURE` header contains base64-encoded JSON:

`resource` is the optional core x402 v2 `PaymentPayload.resource`
(`ResourceInfo`) field. It is not defined by this network binding.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/data"
  },
  "accepted": {
    "scheme": "batch-settlement",
    "network": "xrpl:0",
    "amount": "1000",
    "asset": "xrpl:0/slip44:144",
    "payTo": "rEXAMPLECollector",
    "maxTimeoutSeconds": 3600,
    "extra": {
      "binding": "xrpl-paychan-v1",
      "minSettleDelay": 86400,
      "redemptionSafetySeconds": 60,
      "payoutReference": "550e8400-e29b-41d4-a716-446655440000"
    }
  },
  "payload": {
    "type": "authorization",
    "authorization": {
      "channelId": "64_UPPERCASE_HEX_CHARACTERS",
      "authorizedAmount": "42000",
      "publicKey": "66_UPPERCASE_HEX_CHARACTERS",
      "signature": "UPPERCASE_HEX_SIGNATURE"
    }
  },
  "extensions": {
    "payment-identifier": {
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "required": { "type": "boolean" },
          "id": { "type": "string", "minLength": 16, "maxLength": 128 }
        },
        "required": ["required"]
      },
      "info": {
        "required": true,
        "id": "pay_7d5d747be160e280504c099d984bcfe0"
      }
    }
  }
}
```

Authorization fields:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `payload.type` | string | yes | **MUST** equal `authorization`. |
| `authorization.channelId` | string | yes | 32-byte channel ID in hexadecimal. |
| `authorization.authorizedAmount` | string | yes | Signed cumulative amount for this request in drops. |
| `authorization.publicKey` | string | yes | 33-byte XRPL public key in hexadecimal. |
| `authorization.signature` | string | yes | Native XRPL claim signature in hexadecimal. |

Each logical HTTP request **MUST** supply the cumulative authorization expected
from the current authoritative state and **MUST** use a new
`payment-identifier.info.id`. A retry of the same logical request **MUST** reuse
its original authorization and identifier. An authorization from an earlier
request **MUST NOT** be accepted merely because its XRPL signature remains
valid.

Resource servers using this binding **MUST** advertise the x402
`payment-identifier` extension with `required: true`.

## 7. Authoritative state

The resource server is the sole owner of per-channel charging state. It
**MAY** delegate storage and atomic updates to one facilitator acting as its
state authority. Exactly one logical state store **MUST** serialize updates for
each `(network, channelId)`.

The store **MUST** retain:

| Field | Meaning |
| --- | --- |
| `authorizedAmount` | Highest valid cumulative authorization associated with a successfully settled request. |
| `authorizationSignature` | Signature for `authorizedAmount`. |
| `committedAmount` | Cumulative actual charges, including amounts already redeemed. |
| `ledgerBalance` | Last validated `PayChannel.Balance`. |
| `reservations` | Pending maximum charges, request authorizations, and any immutable payout resolution keyed by payment identifier. |
| `payments` | Verified or settled request records keyed by payment identifier. |
| `channel` | Payer, destination, key, allocation, delay, expiration, and validated ledger index, hash, and close time. |

For a new record, `committedAmount` **MUST** start at the validated
`PayChannel.Balance`.

The invariant is:

```text
ledgerBalance
  <= committedAmount
  <= authorizedAmount
  <= PayChannel.Amount
```

At most one logical request may be active for a channel. Processing from
verification through settlement **MUST** be serialized per channel. A pending
request authorization **MUST NOT** replace the stored redemption authorization
until the protected handler succeeds and settlement commits.

Production implementations **MUST** use durable storage. Multiple instances
**MUST** use transactions, locking, or atomic compare-and-set semantics. A
resource server and facilitator **MUST NOT** maintain independent writable
copies of channel state. A resource server **MUST** accept a channel only
through its configured state authority, and facilitator calls that read or
mutate this state **MUST** authenticate that resource server. Independent
resource servers or facilitators **MUST NOT** accept the same channel unless
they share the same authoritative store and serialization domain. In collector
operation, this rule applies across all resource servers using that collector
as `payTo`.

## 8. Verification

For `POST /verify`, `paymentRequirements` is the advertised per-request maximum
and **MUST** match `paymentPayload.accepted`.

The verifier **MUST**:

1. Validate the x402 v2 envelope and required `payment-identifier`.
2. Require `scheme == "batch-settlement"` and
   `extra.binding == "xrpl-paychan-v1"`.
3. Validate network, asset, amounts, accounts, tags, and exact payout-reference
   agreement between `paymentRequirements` and `paymentPayload.accepted`.
4. Read the `PayChannel` from a validated ledger on the requested network.
5. Require the channel to exist and not be expired.
6. Require `PayChannel.Destination == payTo`.
7. Require the channel's destination tag to match `extra.destinationTag`,
   including absence.
8. Require the channel's `PublicKey` to equal
   `authorization.publicKey`.
9. Require `PayChannel.SettleDelay >= extra.minSettleDelay` and
   `extra.minSettleDelay >= maxTimeoutSeconds + extra.redemptionSafetySeconds`.
10. Let `deadline` be the earlier of `PayChannel.Expiration` and
    `PayChannel.CancelAfter`, ignoring an absent field. When a deadline exists,
    require:

    ```text
    deadline - validatedLedgerCloseTime
      >= maxTimeoutSeconds + extra.redemptionSafetySeconds
    ```
11. Require
    `PayChannel.Balance <= authorization.authorizedAmount <= PayChannel.Amount`.
12. Verify the native XRPL claim signature for the channel and authorized
    amount.
13. Require:

    ```text
    authorization.authorizedAmount
      == committedAmount + paymentRequirements.amount
    ```

    using the value read under the channel's serialization lock.
14. If `extra.payoutReference` is present, resolve it once to the beneficiary
    and an immutable payout-configuration version or hash.
15. Bind the payment identifier to a normalized fingerprint of the payment
    requirements, resource, authorization, payout reference, and resolved
    beneficiary and configuration version or hash.
16. Atomically reserve `paymentRequirements.amount`, its authorization, any
    payout resolution from step 14, and the validated channel snapshot.

Verification **MUST** fail if another logical request is active for the
channel or if the signed cumulative amount exceeds the channel allocation.

A reservation expires after `maxTimeoutSeconds`. Expiry releases reserved
capacity and does not change `committedAmount`, but it **MUST NOT** discard the
payment record, fingerprint, or stored payout resolution.

The same payment identifier with the same fingerprint is an idempotent retry.
The same identifier with a different fingerprint **MUST** fail.

An idempotent `/verify` retry **MUST** use any stored payout resolution and
**MUST NOT** query the payout registry again.

Example success:

```json
{
  "isValid": true,
  "payer": "rEXAMPLEPayer",
  "extra": {
    "paymentIdentifier": "pay_7d5d747be160e280504c099d984bcfe0",
    "authorizedAmount": "42000",
    "committedAmount": "41000",
    "reservedAmount": "1000",
    "ledgerBalance": "20000"
  }
}
```

## 9. Per-request settlement

After the protected handler succeeds, the resource server MAY use the x402
settlement override mechanism to set an actual charge lower than the
advertised maximum.

The resource server **MUST NOT** release the paid response before `/settle`
succeeds.

The settlement service **MUST**:

1. Revalidate the payload, fingerprint, and unexpired reservation.
2. Under the channel's serialization lock, reread the `PayChannel` from the
   latest validated ledger on the requested network and record that ledger's
   index, hash, and close time.
3. Require the channel to exist and not be expired; recheck its destination,
   destination tag, public key, `SettleDelay`, `Amount`, and `Balance` against
   the payment requirements, authorization, and stored channel record. Let
   `deadline` be the earlier of `Expiration` and `CancelAfter`, ignoring an
   absent field. When a deadline exists, require:

   ```text
   deadline - validatedLedgerCloseTime
     >= extra.redemptionSafetySeconds
   ```

4. Require:

   ```text
   0 <= actualCharge <= advertisedMaximum
   ```

5. Compute `newCommittedAmount = committedAmount + actualCharge` and require:

   ```text
   PayChannel.Balance
     <= newCommittedAmount
     <= authorization.authorizedAmount
     <= PayChannel.Amount
   ```

6. Atomically set `committedAmount = newCommittedAmount`, update
   `ledgerBalance` and the stored validated channel snapshot, store the request
   authorization for redemption if its signed cumulative amount is higher than
   the stored `authorizedAmount`, mark the payment identifier settled, and
   release its reservation.
7. If `extra.payoutReference` is present, use exactly the beneficiary and
   payout-configuration version or hash stored in the reservation and
   atomically create exactly one payout obligation for that beneficiary and
   actual charge. Settlement **MUST NOT** resolve the payout reference again.
8. If `newCommittedAmount > PayChannel.Balance` and either `Expiration` is
   present or a present `CancelAfter` is no more than `extra.minSettleDelay`
   after the validated ledger close time, bypass normal batching and
   immediately submit the latest committed authorization for redemption.
9. Return the same result for an identical retry.
10. Reject a retry that changes the actual charge or fingerprint.

`POST /settle` records an off-ledger commitment. It does not normally submit an
XRPL transaction except when step 8 requires immediate redemption.

### 9.1 Commitment identifier

Every successful settlement **MUST** return a non-empty commitment identifier
in `SettleResponse.transaction`.

The identifier **MUST** be stable for retries and unique per channel and
payment identifier. This version uses:

```text
xrpl-paychan:<network_id>:<CHANNEL_ID>:<PAYMENT_ID_SHA256>
```

`PAYMENT_ID_SHA256` is the uppercase hexadecimal SHA-256 digest of the UTF-8
payment identifier.

This value is an off-ledger commitment identifier, not an XRPL transaction
hash.

Consumers **MUST** discriminate the `xrpl-paychan:` prefix before applying
XRPL transaction-hash parsing. Later redemption transaction hashes, when an
implementation exposes them, are separate redemption records and do not
replace this per-request commitment identifier in `SettleResponse`.

Example:

```json
{
  "success": true,
  "transaction": "xrpl-paychan:0:5DB01B7F...A4D5BDB3:4D9674A2...8B15C7E1",
  "network": "xrpl:0",
  "payer": "rEXAMPLEPayer",
  "amount": "",
  "extra": {
    "chargedAmount": "600",
    "committedAmount": "41600",
    "remainingChannelCapacity": "958400",
    "paymentIdentifier": "pay_7d5d747be160e280504c099d984bcfe0",
    "channelState": {
      "channelId": "64_UPPERCASE_HEX_CHARACTERS",
      "account": "rEXAMPLEPayer",
      "destination": "rEXAMPLECollector",
      "destinationTag": null,
      "publicKey": "66_UPPERCASE_HEX_CHARACTERS",
      "amount": "1000000",
      "balance": "20000",
      "settleDelay": 86400,
      "expiration": null,
      "cancelAfter": null,
      "committedAmount": "41600",
      "validatedLedgerIndex": 12345678,
      "validatedLedgerHash": "64_UPPERCASE_HEX_CHARACTERS",
      "validatedLedgerCloseTime": 800000000
    },
    "payoutObligationId": "optional-collector-obligation-id"
  }
}
```

Top-level `amount` is empty because no XRP moves during the HTTP request.
`extra.chargedAmount` is the actual request charge. In this example,
`PayChannel.Amount` is `1000000`, so `remainingChannelCapacity` is
`PayChannel.Amount - committedAmount`, or `958400`.

Every successful settlement response **MUST** include `extra.channelState`
from the validated-ledger reread in settlement step 2. It **MUST** contain the
channel ID, account, destination and tag, public key, `Amount`, `Balance`,
`SettleDelay`, `Expiration`, `CancelAfter`, `committedAmount`, and validated
ledger index, hash, and close time.

## 10. Resource-server idempotency

The facilitator prevents a payment identifier from being charged twice. The
resource server **MUST** also prevent the protected operation from being
executed twice for the same payment identifier.

For a repeated identifier with the same request fingerprint, the resource
server **SHOULD** return a cached result. If it cannot safely replay the result,
it **MUST** reject the duplicate instead of executing the handler again.

For a repeated identifier with a different fingerprint, it **MUST** return a
conflict.

## 11. Redemption

The channel destination periodically redeems the latest committed amount using
`PaymentChannelClaim`:

| Transaction field | Value |
| --- | --- |
| `Account` | `PaymentRequirements.payTo` |
| `Channel` | Stored `authorization.channelId` |
| `Amount` | Stored `authorization.authorizedAmount` |
| `Balance` | Stored `committedAmount` |
| `PublicKey` | Stored `authorization.publicKey` |
| `Signature` | Stored `authorization.signature` |

`Balance` **MUST NOT** exceed `Amount`. A redemption worker **MUST** submit only
a value already committed by successful `/settle` calls.

The worker **MUST** treat a claim as final only after a validated `tesSUCCESS`
result and then update `ledgerBalance`. Redemption does not reduce
`committedAmount`.

One `PaymentChannelClaim` can redeem charges from any number of HTTP requests.

The destination **MUST** monitor validated ledgers for every accepted channel
while `committedAmount > ledgerBalance`. If `Expiration` appears, it **MUST**
bypass normal batching and immediately submit the latest committed
authorization. It **MUST** also submit in time for the claim to be validated at
least `extra.redemptionSafetySeconds` before the earlier present value of
`Expiration` and `CancelAfter`. Until the claim is validated, the worker
**MUST** monitor and retry failed or unvalidated submissions. The resource
server **MUST NOT** accept a new request when the verification safety window in
Section 8 is not available.

## 12. Downstream payouts

When `extra.payoutReference` is present, `/verify` **MUST** resolve it once and
store the immutable beneficiary and payout-configuration version or hash in
the reservation. Settlement **MUST** use exactly that stored resolution and
atomically create a payout obligation containing at least:

- commitment identifier;
- payout reference;
- the resolved payout configuration or an immutable reference to its version;
- actual charged amount;
- asset;
- creation time; and
- status.

A settlement retry **MUST NOT** create a second obligation.

Changing the registry mapping after verification **MUST NOT** change the
beneficiary or payout configuration for an existing reservation.

The collector **MUST**:

1. keep obligations in durable storage;
2. route the payout using the stored configuration resolved during
   verification;
3. prevent duplicate payout;
4. apply the confirmation and finality rules of the selected payout rail; and
5. retain a mapping from each payout receipt to the included commitment
   identifiers.

The payout rail, wallet format, commercial fee schedule, and payout cadence are
outside this binding, but they **MUST** be disclosed to the beneficiary. If the
payout is net of fees, the recorded obligation **MUST** contain both gross and
net amounts.

## 13. Facilitator discovery

`GET /supported` **MUST** use the x402 v2 `SupportedResponse` envelope. Each
conforming network is advertised as one entry in `kinds`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "xrpl:0",
      "extra": {
        "binding": "xrpl-paychan-v1",
        "assets": [
          "xrpl:0/slip44:144"
        ],
        "features": [
          "per-request-cumulative-authorization"
        ],
        "payoutRouting": true
      }
    }
  ],
  "extensions": [
    "payment-identifier"
  ],
  "signers": {}
}
```

The top-level `extensions` array **MUST** include `payment-identifier`.
`signers` **MAY** be empty when the facilitator does not advertise an XRPL
transaction signer.

`extra.payoutRouting` **MUST** equal `true` only if the facilitator implements
Section 12 for that supported kind. When it is absent, the facilitator does
not support payout references for that kind.

A facilitator **MUST NOT** advertise this binding until its `/verify` and
`/settle` implementations conform.

## 14. Client state and recovery

### 14.1 Steady-state client validation

The client **MUST** retain `committedAmount` for each channel. Before signing
the next authorization, it **MUST** verify from the successful settlement
response that:

1. `extra.chargedAmount <= PaymentRequirements.amount`;
2. `extra.channelState.committedAmount == extra.committedAmount ==
   previousCommittedAmount + extra.chargedAmount`;
3. `extra.channelState.channelId` identifies the expected channel;
4. the channel snapshot matches a validated ledger on the expected network and
   has the expected destination, destination tag, and public key; and
5. `PayChannel.Balance <= extra.committedAmount <=
   authorization.authorizedAmount <= PayChannel.Amount`.

The client **MUST** durably store the verified `committedAmount` before signing
another authorization. If any check fails, it **MUST NOT** sign another
authorization for the channel.

### 14.2 Corrective 402 and client recovery

If a request fails because its cumulative authorization does not match the
authoritative `committedAmount`, the resource server **MUST** return
`invalid_batch_settlement_xrpl_cumulative_amount_mismatch`. When it has durable
off-ledger state, the corresponding `accepts[].extra` **MUST** include the
validated channel snapshot, `committedAmount`, and the highest stored
authorization associated with a successful settlement. The following shows
those corrective fields:

```json
{
  "channelState": {
    "channelId": "64_UPPERCASE_HEX_CHARACTERS",
    "account": "rEXAMPLEPayer",
    "destination": "rEXAMPLECollector",
    "destinationTag": null,
    "publicKey": "66_UPPERCASE_HEX_CHARACTERS",
    "amount": "1000000",
    "balance": "20000",
    "settleDelay": 86400,
    "expiration": null,
    "cancelAfter": null,
    "validatedLedgerIndex": 12345678,
    "validatedLedgerHash": "64_UPPERCASE_HEX_CHARACTERS",
    "validatedLedgerCloseTime": 800000000,
    "committedAmount": "41600"
  },
  "authorizationState": {
    "authorizedAmount": "42000",
    "publicKey": "66_UPPERCASE_HEX_CHARACTERS",
    "signature": "UPPERCASE_HEX_SIGNATURE"
  }
}
```

Before adopting the returned `committedAmount`, the client **MUST**:

1. independently confirm the channel snapshot from a trusted validated XRPL
   endpoint;
2. require the snapshot's channel ID, destination, tag, public key, allocation,
   and network to match its channel;
3. verify that `authorizationState.signature` is its native XRPL claim
   signature over the same channel ID and `authorizedAmount` and that the
   public key matches the channel; and
4. require:

   ```text
   PayChannel.Balance
     <= committedAmount
     <= authorizationState.authorizedAmount
     <= PayChannel.Amount
   ```

Only after these checks succeed **MAY** the client adopt the returned baseline
and retry with `authorizedAmount = committedAmount +
PaymentRequirements.amount`. The stored claim proves the signed upper bound;
it does not independently prove the exact off-ledger charge history. A client
that cannot reconcile the returned baseline **SHOULD** treat the mismatch as
evidence of possible split-brain or state corruption and **MUST** stop using
and retire the channel before opening a replacement.

On client cold start, the client **MUST** first read the validated
`PayChannel.Balance`. If the resource server has a higher durable
`committedAmount`, it **MUST** supply the corrective state above. If no durable
off-ledger state exists, the client and resource server use
`PayChannel.Balance` as the cumulative baseline.

### 14.3 Facilitator state recovery

If no durable record exists, the facilitator **MUST** initialize
`committedAmount` from validated `PayChannel.Balance`.

Unredeemed off-ledger charges cannot be recovered from the XRPL channel alone.
The facilitator **MUST NOT** infer them. Durable backups or an append-only audit
log are therefore required for production use.

Downstream payout obligations **MUST NOT** be discarded during recovery.

After recovery, the next request authorization **MUST** use the recovered
`committedAmount`. If the facilitator lost unredeemed off-ledger charges, those
charges are forfeited and the client uses the validated `PayChannel.Balance`
as the new cumulative baseline.

## 15. Errors

Implementations **SHOULD** use these stable error strings:

| Error | Meaning |
| --- | --- |
| `invalid_batch_settlement_xrpl_payload` | Envelope or authorization is malformed. |
| `invalid_batch_settlement_xrpl_binding` | Binding is missing or unsupported. |
| `invalid_batch_settlement_xrpl_requirements` | Network, asset, amount, recipient, tag, or payout terms are invalid or mismatched. |
| `invalid_batch_settlement_xrpl_channel` | Channel is missing, closed, expired, or otherwise ineligible. |
| `invalid_batch_settlement_xrpl_signature` | XRPL claim signature is invalid. |
| `invalid_batch_settlement_xrpl_cumulative_amount_mismatch` | Corrective 402: signed cumulative amount does not equal the authoritative committed amount plus the request maximum. |
| `invalid_batch_settlement_xrpl_capacity` | Authorization or channel capacity is insufficient. |
| `invalid_batch_settlement_xrpl_redemption_window` | The validated channel does not leave the required redemption safety window. |
| `invalid_batch_settlement_xrpl_payment_identifier` | Identifier is missing, reused inconsistently, or invalid. |
| `invalid_batch_settlement_xrpl_reservation` | Reservation is absent, expired, or mismatched. |
| `invalid_batch_settlement_xrpl_charge` | Actual charge exceeds the reserved maximum. |
| `invalid_batch_settlement_xrpl_state` | Durable or atomic state update failed. |
| `invalid_batch_settlement_xrpl_payout` | Payout reference resolution, routing, or obligation creation failed. |

## 16. Security considerations

### 16.1 Cumulative-signature authority

An XRPL signature permits the channel destination to redeem up to its
`authorizedAmount`; the ledger cannot enforce the lower off-ledger
`committedAmount`. The payer therefore trusts the channel destination not to
over-claim. A facilitator that controls the destination key is in this trust
boundary. Older signed claims also remain valid, so clients **MUST NOT** assume
that signing a lower cumulative amount revokes a higher one.

The payer-facing safety property is that, absent a separate payer-authorized
on-ledger transaction, the channel destination cannot make the channel's
cumulative validated `PayChannel.Balance` exceed either the greatest valid
`authorizedAmount` the payer has ever signed or `PayChannel.Amount`. Even if
split-brain resource servers or facilitator lanes accept overlapping channel
capacity, XRPL does not pay each branch separately. Such split-brain can cause
duplicate service delivery or uncollectible destination-side charges, but it
does not increase the payer's exposure beyond that signed cumulative maximum.

Clients **SHOULD** use a dedicated claim key and a bounded authorization cap.
SDKs **SHOULD NOT** silently authorize the channel's entire allocation.

### 16.2 Signature binding

The native claim signature binds only the channel ID and cumulative amount. It
does not sign the HTTP resource, network string, payout reference, or price.
Exact requirement comparison, validated-ledger selection, authoritative
payout-reference resolution, TLS, and payment-identifier state are therefore
mandatory.

### 16.3 Concurrency and replay

Per-request cumulative authorizations are safe for metering only when request
processing is serialized per channel, the expected cumulative amount is
computed from authoritative state, and payment identifiers are idempotently
stored. In-memory or split-brain state can accept the same capacity more than
once or execute a paid operation twice.

### 16.4 Collector risk

An `extra.payoutReference` beneficiary has a claim against the collector, not
against the XRPL payment channel. Collectors **MUST NOT** describe that leg as
capital-backed by the payer's channel.

## 17. Minimum conformance tests

A conforming implementation **MUST** test:

1. Ed25519 and secp256k1 authorizations.
2. A new cumulative authorization for each unique payment identifier, and
   rejection of an earlier request's authorization when its amount does not
   match the authoritative cumulative amount.
3. Retry of one payment identifier without duplicate charge or handler
   execution.
4. Reuse of an identifier with a different fingerprint.
5. Rejection or serialization of concurrent requests on one channel.
6. Actual charge below, equal to, and above the advertised maximum.
7. Invalid network, asset, payTo, destination tag, public key, and signature.
8. Missing, expired, underfunded, closing, and unvalidated channels, including
   `Expiration` or `CancelAfter` changes between `/verify` and `/settle` and
   exact redemption-window boundary values.
9. Client steady-state validation, cold start, corrective 402 recovery, and
   rejection of invalid recovery signatures or bounds, plus facilitator
   restart with durable state recovery.
10. Redemption with signed `Amount` above committed `Balance`, mandatory
    closure monitoring, and immediate redemption after closure is detected.
11. A non-empty stable commitment identifier.
12. Unknown or malformed payout references, registry remapping between
    `/verify` and `/settle`, payout redirection attempts, and duplicate payout,
    when payout routing is supported.

## References

1. [x402 `batch-settlement` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md)
2. [x402 payment-identifier extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md)
3. [XRPL Payment Channels](https://xrpl.org/docs/concepts/payment-types/payment-channels)
4. [XRPL `PaymentChannelClaim`](https://xrpl.org/docs/references/protocol/transactions/types/paymentchannelclaim)
5. [XRPL `PayChannel`](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/paychannel)
6. [XRPL `channel_verify`](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/payment-channel-methods/channel_verify)
7. [XRPL CAIP-2 profile](https://namespaces.chainagnostic.org/xrpl/caip2)
8. [XRPL CAIP-19 profile](https://namespaces.chainagnostic.org/xrpl/caip19)