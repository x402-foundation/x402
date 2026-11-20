# Scheme: `upto` on `Stellar`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:

- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The `upto` scheme on Stellar lets a client authorize a **maximum amount** of a [SEP-41] token once, and lets the **receiver authorizer** it bound authorize the **actual amount** (from `0` up to that maximum) after the resource server has measured usage. A facilitator submits the settlement. It meets the five core properties of [`scheme_upto.md`](./scheme_upto.md).

Settlement goes through the **UptoProxy** Soroban contract, deployed at one [canonical address](#canonical-uptoproxy-deployments) per network. The client signs one Soroban authorization entry for `UptoProxy.settle_upto` with a nested `token.approve`; it never builds, signs or pays for a transaction. At settlement the receiver authorizer signs its own authorization for the call with the actual amount, and the facilitator submits the transaction, paying all fees.

> [!NOTE]
> **This design ships a Soroban contract.** SEP-41 allowances alone (`approve` + `transfer_from` by the facilitator) cannot bind the recipient or enforce single use: an allowance lets its spender move the tokens to any address, any number of times, until it expires or is used up. The contract enforces the recipient, the receiver authorizer and the time window on chain, and Soroban's own authorization nonce makes each signed entry single-use. See [Security Considerations](#security-considerations).

> [!NOTE]
> **Scope:** [SEP-41]-compliant Soroban tokens, including Stellar Asset Contracts (SAC) for classic assets.

## Receiver Authorizer Modes

Every authorization binds a **receiver authorizer**: the key that authorizes the actual amount at settlement. Its authorization covers every argument of `settle_upto`, `actual_amount` included, so whoever submits the transaction cannot charge more than it signed. As in [`scheme_upto_svm.md`](./scheme_upto_svm.md), the resource server picks one of two modes:

| Mode                      | `extra.receiverAuthorizer`                                          | Who signs the receiver authorization                                                                    |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Self-managed**          | The resource server's own key                                       | The resource server, after measuring usage; it sends the entry with `/settle` as `payload.receiverAuthorization` |
| **Facilitator-delegated** | The key the facilitator publishes as `extra.receiverAuthorizer` in its `/supported` entry for `upto` | The facilitator, at settlement                                                                          |

- **Self-managed** needs a server hot key that holds no funds. Any facilitator can relay the server's entry, so open authorizations survive a change of facilitator, and no facilitator can charge more than the server signed.
- **Facilitator-delegated** needs no server key. The server trusts the facilitator to settle the amount it asked for and no more, and the facilitator authenticates the server's `/settle` calls out of band.
- A facilitator that doesn't relay self-managed payments MUST refuse them at `/verify` with `invalid_upto_stellar_payload_receiver_authorization`, so the resource server learns before it serves.
- The receiver authorizer MAY be a Stellar account (`G...`) or a contract account (`C...`). A `G...` signature can be checked off chain; a `C...` account's `__check_auth` runs only on chain, so the facilitator verifies it by the enforcing simulation alone, under its fee ceiling, as it does for a smart-wallet client.

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `402 Payment Required` and a `PAYMENT-REQUIRED` header. The `upto` entry carries `amount` (the maximum), `asset`, `payTo`, `maxTimeoutSeconds` and `extra.receiverAuthorizer`.
3. **Client** builds the authorization entry for `UptoProxy.settle_upto` described in [Authorization Entry](#authorization-entry): the canonical proxy, the token, the recipient, the receiver authorizer, the maximum, a fresh random 32-byte nonce, a validity window and a nested `token.approve` of the maximum to the proxy.
4. **Client** signs the entry with its wallet, with `signatureExpirationLedger` equal to the entry's `allowance_expiration_ledger`.
5. **Client** sends a new request with the `PaymentPayload`, whose `payload.authorization` is the signed entry as base64 XDR.
6. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator**'s `/verify` endpoint.
7. **Facilitator** decodes the entry, checks it against the requirements and simulates the settlement at the full maximum ([Verification](#facilitator-verification-rules-must)).
8. **Resource Server**, on a valid response, runs the request and measures usage.
9. **Resource Server** calls `/settle` with the same `PaymentPayload` and `PaymentRequirements` whose `amount` is now the **actual amount** ([`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)). In self-managed mode it first adds `payload.receiverAuthorization`, its signed entry for the call with that amount ([Receiver Authorization Entry](#receiver-authorization-entry)).
10. **Facilitator** re-verifies against the signed maximum, builds `settle_upto` with the actual amount, attaches the receiver authorization (the server's in self-managed mode, its own in facilitator-delegated mode), simulates it, submits it, and returns a `SettlementResponse` with the amount charged ([Settlement](#settlement-logic)).
11. **Resource Server** returns the resource to the **Client**.

## `PaymentRequirements` for `upto`

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "amount": "5000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 300,
  "extra": {
    "areFeesSponsored": true,
    "receiverAuthorizer": "GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM"
  }
}
```

| Field               | Type     | Required | Description                                                                                                                     |
| ------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `scheme`            | `string` | Required | `"upto"`                                                                                                                        |
| `network`           | `string` | Required | `stellar:pubnet` or `stellar:testnet`                                                                                           |
| `amount`            | `string` | Required | Phase-dependent: the maximum at verification, the actual amount at settlement. Atomic units, a positive integer at verification |
| `asset`             | `string` | Required | The SEP-41 token contract address (`C...`)                                                                                      |
| `payTo`             | `string` | Required | The recipient address (`G...` or `C...`)                                                                                        |
| `maxTimeoutSeconds` | `number` | Required | Bounds the authorization's lifetime (see [Authorization Entry](#authorization-entry)). At most about a day (see below)          |
| `extra`             | `object` | Required | See below                                                                                                                       |

**`extra` fields:**

- `extra.areFeesSponsored`: MUST be `true`. The facilitator pays every fee; the client never pays one.
- `extra.receiverAuthorizer`: The address (`G...` or `C...`) that authorizes the actual amount at settlement ([Receiver Authorizer Modes](#receiver-authorizer-modes)). In self-managed mode it is the resource server's own key; in facilitator-delegated mode the resource server copies it from `extra.receiverAuthorizer` in the facilitator's `/supported` entry for `upto`. The client signs it as the `receiver_authorizer` argument, so nothing settles without that key's authorization.

`maxTimeoutSeconds` MUST NOT exceed what `MAX_ALLOWANCE_LEDGERS` (17,280 ledgers) covers at the network's ledger close time: 86,400 seconds at 5-second ledgers. The contract refuses an allowance expiry further ahead (`InvalidAllowanceExpiration`), so a longer window can't be settled.

The proxy address is **not** a requirements field. Clients and facilitators MUST use the [canonical deployment](#canonical-uptoproxy-deployments) for the network, so a resource server cannot point a client at a different contract.

## PaymentPayload `payload` Field

```json
{
  "authorization": "AAAAAQAAAAAAAAAA..."
}
```

`authorization` is the base64 XDR of one signed `SorobanAuthorizationEntry`. Every argument of `settle_upto` except `actual_amount` can be read from it: `from` from the credentials, `allowance_expiration_ledger` from the `approve` sub-invocation, and the rest from the root invocation.

In self-managed mode the resource server adds one field before it calls `/settle`:

```json
{
  "authorization": "AAAAAQAAAAAAAAAA...",
  "receiverAuthorization": "AAAAAQAAAAAAAAAB..."
}
```

`receiverAuthorization` is the base64 XDR of the receiver authorizer's signed `SorobanAuthorizationEntry` ([Receiver Authorization Entry](#receiver-authorization-entry)). The client never sets it, and it is absent at `/verify` and in facilitator-delegated mode.

**Full `PaymentPayload` object:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "stellar:testnet",
    "amount": "5000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    "maxTimeoutSeconds": 300,
    "extra": {
      "areFeesSponsored": true,
      "receiverAuthorizer": "GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM"
    }
  },
  "payload": {
    "authorization": "AAAAAQAAAAAAAAAA..."
  }
}
```

## Authorization Entry

The client signs exactly one entry with this tree:

```
credentials: sorobanCredentialsAddress or sorobanCredentialsAddressV2
  address                   = from (the client)
  nonce                     = random int64 (Soroban's own replay nonce)
  signatureExpirationLedger = allowance_expiration_ledger
rootInvocation:
  contract = UptoProxy (canonical), function = "settle_upto"
  args     = [token, to, receiver_authorizer, max_amount, nonce, valid_after, deadline]
  subInvocations:
    - contract = token, function = "approve"
      args     = [from, UptoProxy, max_amount, allowance_expiration_ledger]
      subInvocations: []
```

| Value                         | Type         | Set to                                                                                        |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `token`                       | `Address`    | `requirements.asset`                                                                          |
| `to`                          | `Address`    | `requirements.payTo`                                                                          |
| `receiver_authorizer`         | `Address`    | `requirements.extra.receiverAuthorizer`                                                       |
| `max_amount`                  | `I128`       | `requirements.amount`                                                                         |
| `nonce`                       | `BytesN<32>` | A payment ID: 32 random bytes from a cryptographically secure source, fresh for every payment |
| `valid_after`                 | `U64`        | Unix seconds, at most the current time. Clients MAY back-date it by up to 60 s for clock skew |
| `deadline`                    | `U64`        | Unix seconds, at most `now + maxTimeoutSeconds`                                               |
| `allowance_expiration_ledger` | `U32`        | `currentLedger + ceil(maxTimeoutSeconds / ledgerCloseSeconds)`: it MUST last until `deadline` |

- The root `args` are the exact vector the contract passes to `from.require_auth_for_args`, in this order and with these types. `from` and `actual_amount` are not in it: `from` is the signer, and `actual_amount` is chosen by the facilitator within the signed maximum.
- `ledgerCloseSeconds` is the network's target ledger close time. It is a network setting since protocol 23 ([CAP-0070](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0070.md)), so clients and facilitators MUST read it from the network rather than assume 5 seconds.
- `signatureExpirationLedger` MUST equal `allowance_expiration_ledger`. The host keeps a nonce entry for the client's signature until `signatureExpirationLedger`, the facilitator pays its rent, and the contract never sees that value; the equality is what bounds it.
- The tree is fully determined by the requirements and the client's own choices, so the client MAY build it directly without simulation. A client that wants a preflight check MAY simulate a draft `settle_upto` call with `actual_amount = max_amount` in recording mode; the draft's source account MUST NOT be the client (the facilitator's account works), because with the client as source the simulation records source-account credentials and returns nothing to sign. That simulation needs a balance of at least `max_amount`.
- 🚨 A client that simulates MUST compare the returned tree with the one built from the requirements and MUST refuse to sign anything else. The simulation comes from an RPC or facilitator the client doesn't control, and a lying one can return, for example, a plain `token.transfer` of the client's balance.
- Smart-wallet (`C...`) clients with per-context policies MUST allow both contexts: `settle_upto` on the proxy and `approve` on the token.
- The x402 `nonce` is a payment ID, not a single-use key: Soroban's own authorization nonce in the credentials makes the entry single-use. A client that signs two entries with the same payment ID has signed two payments.

## Receiver Authorization Entry

At settlement the receiver authorizer signs one entry for the exact call the facilitator submits:

```
credentials: sorobanCredentialsAddress or sorobanCredentialsAddressV2
  address                   = receiverAuthorizer
  nonce                     = random int64
  signatureExpirationLedger <= the client entry's allowance_expiration_ledger
rootInvocation:
  contract = UptoProxy (canonical), function = "settle_upto"
  args     = [token, from, to, receiver_authorizer, max_amount, actual_amount, nonce,
              valid_after, deadline, allowance_expiration_ledger]
  subInvocations: []
```

- In self-managed mode the resource server builds it from the client's entry and the actual amount, without simulation, and sends it as `payload.receiverAuthorization`.
- In facilitator-delegated mode the facilitator builds the same entry with its own key, or authorizes as the operation source when it is one.
- `signatureExpirationLedger` MUST NOT exceed the client entry's `allowance_expiration_ledger`: the host keeps a nonce entry for this signature until then, and the facilitator pays its rent. The entry is useless after the client's authorization has expired anyway.

## Facilitator Verification Rules (MUST)

A facilitator verifying an `upto` payment on Stellar MUST enforce all of the following. At `/verify`, `requirements.amount` is the maximum.

### 1. Protocol Validation

- `x402Version` MUST be `2`.
- `payload.accepted.scheme` and `requirements.scheme` MUST be `"upto"`.
- `payload.accepted.network` MUST equal `requirements.network`.
- If `requirements.extra.receiverAuthorizer` is one of the receiver authorizers this facilitator publishes, the payment is facilitator-delegated; otherwise it is self-managed. A facilitator that rotates its receiver authorizer MUST keep treating the retired key as its own until every authorization bound to it has expired (at most `maxTimeoutSeconds`).
- A facilitator that doesn't relay self-managed payments MUST refuse a self-managed payment here (`invalid_upto_stellar_payload_receiver_authorization`).
- `payload.receiverAuthorization` MUST be absent at `/verify`.

### 2. Authorization Entry

- `payload.authorization` MUST decode to exactly one `SorobanAuthorizationEntry`.
- Its credentials MUST be `sorobanCredentialsAddress` or `sorobanCredentialsAddressV2` (see [`scheme_exact_stellar.md` §3](../exact/scheme_exact_stellar.md#3-authorization-entries) for the two preimages). `sorobanCredentialsSourceAccount` and `sorobanCredentialsAddressWithDelegates` MUST be rejected.
- Its `rootInvocation` MUST equal, byte for byte as XDR, the tree in [Authorization Entry](#authorization-entry) built from the requirements and from the entry's own `from`, `nonce`, `valid_after`, `deadline` and `allowance_expiration_ledger`. In particular:
  - the root contract is the canonical UptoProxy for the network, and the function is `settle_upto`;
  - `token == requirements.asset`, `to == requirements.payTo`, `receiver_authorizer == requirements.extra.receiverAuthorizer`, `max_amount == requirements.amount`;
  - there is exactly one sub-invocation, `approve` on `token` with `[from, UptoProxy, max_amount, allowance_expiration_ledger]`, and it has no sub-invocations of its own.
- The signature MUST be valid for `from`. For a `C...` client this is established by the enforcing simulation at settlement (and at `/verify` in facilitator-delegated mode).

### 3. Time Bounds

- `valid_after <= now <= deadline`, and `deadline` MUST NOT exceed `now + maxTimeoutSeconds`.
- `signatureExpirationLedger` MUST equal `allowance_expiration_ledger`. This check is required, not defence in depth: nothing else bounds how long the host keeps the client's signature nonce, whose rent the facilitator pays.
- `allowance_expiration_ledger` MUST be no earlier than the ledger expected at `deadline`, less a small margin for the close-time estimate. An earlier expiry passes verification but fails settlement with `Expired` after the resource server has served.
- `allowance_expiration_ledger` MUST NOT exceed `currentLedger + ceil(maxTimeoutSeconds / ledgerCloseSeconds)` plus a small margin. The facilitator pays temporary rent on the host's nonce entry for the client's signature and on the allowance until that ledger, so a far expiry is a cost the client chooses.
- The contract independently refuses an expiry more than 17,280 ledgers ahead (`InvalidAllowanceExpiration`).

### 4. Single Use

- The client entry's authorization nonce MUST NOT be consumed on chain. The host keeps a temporary ledger entry for each consumed nonce until the entry's `signatureExpirationLedger`; in facilitator-delegated mode the enforcing simulation below fails with `Error(Auth, ExistingValue)` on a consumed nonce. In self-managed mode the simulation runs in recording mode, which never checks the client's nonce, so the facilitator MUST read that ledger entry (`getLedgerEntries` on the client address's `LedgerKeyNonce`).
- `(from, authorization nonce)` MUST NOT be in the facilitator's record of settlements ([Phase 2](#phase-2-zero-settlement), [Phase 4](#phase-4-submission)).

### 5. 🚨 Facilitator Safety

- `from` MUST NOT be the receiver authorizer or any of the facilitator's addresses, including fee-bump and channel accounts. The same address can't authorize twice in one call, so the host would refuse the settlement after the resource server has served.
- `to` MUST NOT be the UptoProxy address.
- The receiver authorization MUST NOT come from the client: the resource server adds it at `/settle` (self-managed), or the facilitator at settlement (facilitator-delegated).

### 6. Simulation

- The facilitator MUST simulate `settle_upto` with `actual_amount = max_amount` (the worst case) against the current ledger state.
  - Facilitator-delegated: in enforcing mode, with the client's entry and its own receiver authorization.
  - Self-managed: the receiver authorizer signs only at settlement, so the facilitator simulates in recording mode, checks the client's signature (for a `G...` client) and reads its authorization nonce entry as in [Single Use](#4-single-use), and leaves the enforcing simulation to settlement ([Phase 3](#phase-3-transaction-construction)).
- The simulation MUST succeed.
- The only balance changes MUST be `from` decreasing by `max_amount` and `to` increasing by `max_amount`. The only other writes allowed are the `(from, UptoProxy)` allowance on `token`, the host's authorization nonce entries, and TTL extensions. A non-SAC token may emit extra events or charge transfer fees, so facilitators MUST check balance changes, not only events.

## Settlement Logic

### Phase 1: Settle-Time Verification

At `/settle`, `requirements.amount` is the **actual** amount ([`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)).

1. Run every [verification rule](#facilitator-verification-rules-must) again, independently of any earlier `/verify`, but against the **signed** `max_amount` read from the entry, not against `requirements.amount`.
2. Require `0 <= requirements.amount <= max_amount`, else fail with `invalid_upto_stellar_payload_settlement_exceeds_amount`.
3. Self-managed: `payload.receiverAuthorization` MUST decode to exactly one `SorobanAuthorizationEntry` with `sorobanCredentialsAddress` or `sorobanCredentialsAddressV2` for `requirements.extra.receiverAuthorizer`, whose `rootInvocation` equals, byte for byte as XDR, the call the facilitator will submit with `actual_amount = requirements.amount`, with no sub-invocations, and whose `signatureExpirationLedger` does not exceed the client's `allowance_expiration_ledger`. This is the case for a zero amount too, since the entry is what authorizes the server's claim. Facilitator-delegated: `payload.receiverAuthorization` MUST be absent.

### Phase 2: Zero Settlement

If `requirements.amount` is `0`, the facilitator MUST NOT submit a transaction. It MUST first record `(from, authorization nonce)` of the client's entry durably as settled and never delete it, then return `success: true`, `transaction: ""` and `amount: "0"`. Without the record, a second `/settle` on the same payload with a non-zero amount would pass, because the host never saw the entry. On chain the entry stays usable until it expires, but only with the receiver authorizer's authorization. The record is keyed by the authorization nonce, not the payment ID, so it blocks exactly this signed entry, at this facilitator only: in self-managed mode another facilitator can still settle the entry with a new server authorization ([Security Considerations](#security-considerations), item 7).

The contract also accepts `actual_amount = 0`, which uses the authorization up on chain and emits the event; a facilitator MAY submit it that way, at the cost of a transaction fee.

### Phase 3: Transaction Construction

1. Build one `invokeHostFunction` operation calling `UptoProxy.settle_upto` with all ten arguments: `[token, from, to, receiver_authorizer, max_amount, actual_amount, nonce, valid_after, deadline, allowance_expiration_ledger]`, where `actual_amount = requirements.amount`.
2. Attach the client's entry **unchanged**.
3. Attach the receiver authorization ([Receiver Authorization Entry](#receiver-authorization-entry)): in self-managed mode `payload.receiverAuthorization` unchanged; in facilitator-delegated mode an entry the facilitator signs, or source-account credentials when the receiver authorizer is the operation source. Source-account credentials MUST NOT be used when the operation has no source of its own, because they would authorize as the transaction source (for example a channel account).
4. The **transaction source** is the facilitator's account or a channel account the facilitator controls. The facilitator MAY wrap the transaction in a fee bump.
5. Simulate in enforcing mode with the actual amount. This checks both signatures, including a `C...` account's `__check_auth`. The simulation MUST succeed, MUST leave the client's and the receiver authorizer's trees unchanged, and the only balance changes MUST be `from` decreasing and `to` increasing by `actual_amount`.
6. Set the fee and Soroban resource data from that simulation, as in [`scheme_exact_stellar.md` — Transaction Fees](../exact/scheme_exact_stellar.md#transaction-fees).

### Phase 4: Submission

1. Durably record `(from, authorization nonce)` of the client's entry **before** submitting, and refuse a second `/settle` for that entry while the record is in progress, settled, or its outcome isn't established. The host would refuse the second transaction anyway, but only after the facilitator has paid its fee; the record stops concurrent `/settle` calls on one payload from both being sent. A record reopens to a later `/settle` for the same client entry and actual amount, while that entry is unexpired, in two cases:
   - The earlier attempt ended with **nothing sent** (for example no channel was free, or signing failed). The record SHOULD reopen.
   - The earlier transaction reached a final **`FAILED`**. A failed transaction rolls back the host's nonce, so the client's entry is valid again. The record MAY reopen: the resource server has already served, and the client has no reason to sign a new payment.

   A reopened settlement repeats the enforcing simulation of [Phase 3](#phase-3-transaction-construction) before it is sent.
2. Sign and submit with RPC `sendTransaction`. The status MUST be `PENDING`; then poll for `SUCCESS` or `FAILED`.
3. A successful settlement emits the `upto_settled` event (see [Event](#event)).
4. If the transaction was sent but its outcome can't be established, the facilitator MAY return `settlement_pending` with the transaction hash, as in [x402 v2 §9](../../x402-specification-v2.md#9-error-handling).

### Phase 5: `SettlementResponse`

```json
{
  "success": true,
  "transaction": "d66a76ffa2198e7c78ae67e6ad04202bf81633f95986c81debc86fa76cd8d672",
  "network": "stellar:testnet",
  "payer": "GCADNNOZTTKEGX3Z2TA6O2MLPVPMPXL3OLI6UWWQNWZSEANFDOMNE6F6",
  "amount": "1250000"
}
```

- `transaction`: the transaction hash (64 hex characters), or `""` for a zero settlement.
- `payer`: the client's address (`from`), not the facilitator's.
- `amount`: the amount charged in atomic units, which may be `"0"`.

## Transaction Fees

The facilitator pays every fee and MUST derive it as `exact` does: a fresh simulation at settle time plus an inclusion buffer of at least 100 stroops.

Facilitators MAY expose `maxTransactionFeeStroops` as a safety ceiling and reject verification above it with `invalid_upto_stellar_payload_fee_exceeds_maximum`. Its default MUST leave room for rent, which a settlement pays whenever it creates a ledger entry or extends a TTL:

- **The proxy's own TTL.** Every settlement extends the proxy's instance and code by up to 720 ledgers (see [Availability](#availability)): about 149,000 stroops of rent on testnet at most.
- **The authorization nonces and the allowance.** Temporary rent on the host's nonce entries (the client's, and the receiver authorizer's when it signs an entry) and on the allowance, until at most `allowance_expiration_ledger`: a few stroops per ledger on testnet, about 25,000 stroops at the 17,280-ledger cap.
- **The token's own entries.** A first allowance or balance entry, or a token instance that extends its own TTL in the same transaction. The proxy doesn't bound this.

Measured on testnet on 2026-11-12, against the current deployment: a settlement at the maximum cost 21,399–23,061 stroops and a zero settlement 17,653–17,770. Measured on 2026-10-09, against the previous deployment: a normal settlement cost 29,000–47,000 stroops; the costliest settlement without token rent is about 215,000; a settlement in which a SAC instance also extended itself by 54,689 ledgers cost 330,032, and up to about 480,000 is possible for a SAC instance close to expiry. `exact`'s 50,000-stroop default is far too low for `upto`. We suggest a separate `upto` ceiling of about 500,000 stroops, and that facilitators keep the instances of the tokens they accept extended outside settlements, so token rent rarely lands on a payment.

## Error Codes

The `upto` scheme on Stellar uses the standard x402 error codes, plus these:

| Error code                                                 | When                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `invalid_upto_stellar_payload_malformed`                   | `payload.authorization` is missing or isn't one `SorobanAuthorizationEntry`                        |
| `invalid_upto_stellar_payload_unsupported_credential_type` | The credentials aren't `Address` or `AddressV2`                                                    |
| `invalid_upto_stellar_payload_wrong_contract`              | The root contract isn't the canonical UptoProxy, or the function isn't `settle_upto`               |
| `invalid_upto_stellar_payload_auth_mismatch`               | The tree doesn't match the requirements (token, recipient, receiver authorizer, maximum or `approve`)      |
| `invalid_upto_stellar_payload_missing_payer_signature`     | The signature is missing or invalid                                                                |
| `invalid_upto_stellar_signature_expiration_too_far`        | The allowance expiry is past the `maxTimeoutSeconds` bound or the contract's 17,280-ledger cap (contract error `InvalidAllowanceExpiration`), ends before `deadline`, or `signatureExpirationLedger` differs from it |
| `invalid_upto_stellar_payload_not_yet_valid`               | `now < valid_after` (contract error `NotYetValid`)                                                 |
| `invalid_upto_stellar_payload_expired`                     | `now > deadline` or the ledger is past the allowance (contract error `Expired`)                    |
| `invalid_upto_stellar_payload_nonce_used`                  | The client entry's authorization nonce is used on chain (`Error(Auth, ExistingValue)`) or in the facilitator's settlement record |
| `invalid_upto_stellar_payload_facilitator_is_payer`        | `from` is the receiver authorizer or a facilitator address                                         |
| `invalid_upto_stellar_payload_receiver_authorization`      | Self-managed: `payload.receiverAuthorization` is missing at `/settle`, present at `/verify`, or isn't one validly signed entry for exactly the submitted call, or expires after the client's allowance; facilitator-delegated: it is present; or the facilitator doesn't relay self-managed payments |
| `invalid_upto_stellar_payload_invalid_recipient`           | `to` is the proxy or `from` (contract errors `InvalidRecipient`, `SelfPayment`)                    |
| `invalid_upto_stellar_payload_settlement_exceeds_amount`   | `requirements.amount` at settlement exceeds the signed maximum (contract error `AmountExceedsMax`) |
| `invalid_upto_stellar_payload_simulation_failed`           | Simulation failed for any other reason, including a low balance                                    |
| `invalid_upto_stellar_payload_unexpected_balance_change`   | Simulation shows balance changes other than `from` and `to`                                        |
| `invalid_upto_stellar_payload_fee_exceeds_maximum`         | The simulated fee exceeds `maxTransactionFeeStroops`                                               |

## Security Considerations

1. **Why a contract.** With SEP-41 allowances alone, the client would `approve` the facilitator, which could then `transfer_from` to any recipient, any number of times, until the allowance runs out or expires. UptoProxy binds the recipient, the receiver authorizer, the maximum and the window into the client's signature and checks them on chain, and the client's signed entry is single-use. It is immutable (no admin, no upgrade) and never holds funds.
2. **Replay.** Reusing a signed entry fails in Soroban's own authorization (`Error(Auth, ExistingValue)`). That is the only single-use check, and it needs no contract storage: the host's nonce entry lives until the entry's `signatureExpirationLedger`, after which the entry can't be used anyway. A zero settlement never reaches the chain, so the facilitator's record of `(from, authorization nonce)` covers it. The x402 `nonce` is a payment ID: two entries with the same ID are two payments the client signed, and both settle.
3. **Recipient and receiver authorizer binding.** `to` and `receiver_authorizer` are signed, and the contract calls `receiver_authorizer.require_auth()`, whose authorization covers `actual_amount`. Another party that sees the payload cannot settle it, even for a smaller amount, and a facilitator that rewrites `receiver_authorizer` to itself breaks the client's signature. In self-managed mode no facilitator can charge more than the resource server signed.
4. **Leftover allowance.** `approve` sets the proxy's allowance to `max_amount`, and `transfer_from` spends `actual_amount`, so `max_amount - actual_amount` stays approved to the proxy until `allowance_expiration_ledger`. Only the proxy can spend it, and only through `settle_upto` with a new client signature. A client that wants it cleared earlier can set its allowance to the proxy to `0`.
5. **Receiver authorizer key.** In self-managed mode the resource server's key authorizes the actual amount. A stolen key can charge open authorizations up to their maximums, but only to the signed `payTo` and within the signed windows. It holds no funds and SHOULD be used for nothing else. Open authorizations are bound to the key, so a stolen key can't be revoked before their windows end, and rotating it strands them: keep windows short.
6. **Server credit risk.** In `upto` the resource server serves before settlement, so a client can make the settlement fail afterwards, for example by moving its balance away or revoking its allowance to the proxy. In self-managed mode `/verify` can't run the enforcing simulation, so a `C...` client's failing `__check_auth` also surfaces only at settlement. The settle-time simulation catches this before anything is submitted, so the facilitator pays no fee, but the resource server is exposed to at most one maximum per open authorization. Short windows and small maximums bound it.
7. **Server trust.** As on every network, the client trusts the resource server to charge for real usage, up to the maximum. The facilitator's settlement record is its own: in self-managed mode a server that zero-settled at one facilitator can still charge the same entry, within its maximum, through another.
8. **Blind signing.** A client that signs whatever a simulation returns can be made to authorize another call. Clients build the tree from the requirements, or compare the simulated tree with it ([Authorization Entry](#authorization-entry)).
9. **Fee exposure.** The facilitator pays for failed transactions too. Simulating immediately before submission and capping fees bound that cost; a state change between simulation and inclusion can still make a settlement fail and be charged. Recording each entry before submitting ([Phase 4](#phase-4-submission)) keeps concurrent `/settle` calls on one payload from paying for a doomed duplicate. A record reopened after a `FAILED` transaction is sent again only if the repeated simulation passes; facilitators SHOULD also bound the number of resends per entry.
10. **Rent chosen by the client and the server.** The client picks `allowance_expiration_ledger` and `signatureExpirationLedger`, and in self-managed mode the resource server picks its entry's `signatureExpirationLedger`; the facilitator pays rent on the entries that live until then. The [time-bound rules](#3-time-bounds), the cap on the receiver authorization's expiry and the contract's 17,280-ledger cap keep that cost within the payment window.
11. **Availability.** The proxy's instance and code are persistent entries that expire if nobody extends them. Every settlement extends them ([Availability](#availability)), and open authorizations are bound to the proxy's address, so they can't move to a redeployment.
12. **Throughput.** One payment is one transaction. Settlements from different clients don't contend, and with N channel accounts a facilitator can land N per ledger, up to the network's share of ledger capacity.

## Appendix

### Canonical UptoProxy Deployments

| Network           | Contract address                                           | WASM hash                                                          |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `stellar:testnet` | `CDPHI4JYNSWNAQFXUAZAWTBUBYLZZRWFU6F6EJIHLSTAL6MJWXOVEA2X` | `a3d7bd0a4d8f24002b2a07162b32c36abe4620bc60d3550262da05b4ef52f666` |
| `stellar:pubnet`  | TBD                                                        | TBD                                                                |

A Soroban contract address depends on the deployer and a salt. The contract is deployed with its WASM hash as the salt, so a code change gets a new address. Every new address is a change to this table.

Source: [`contracts/upto-proxy`](https://github.com/rumblefishdev/stellar-x402/tree/develop/contracts/upto-proxy) (Apache-2.0). Where the source lives long-term is an open question for maintainers.

### Contract Interface

```rust
pub fn settle_upto(
    env: Env,
    token: Address,
    from: Address,
    to: Address,
    receiver_authorizer: Address,
    max_amount: i128,
    actual_amount: i128,
    nonce: BytesN<32>,
    valid_after: u64,
    deadline: u64,
    allowance_expiration_ledger: u32,
) -> Result<(), UptoError>;
```

`settle_upto` runs in this order; any error rolls the whole call back:

1. `max_amount <= 0` or `actual_amount < 0` → `InvalidAmount`; `actual_amount > max_amount` → `AmountExceedsMax`.
2. `from == to` → `SelfPayment`; `to == UptoProxy` → `InvalidRecipient`.
3. `from.require_auth_for_args([token, to, receiver_authorizer, max_amount, nonce, valid_after, deadline])`.
4. `receiver_authorizer.require_auth()`.
5. `now < valid_after` → `NotYetValid`; `now > deadline` → `Expired` (ledger timestamp, both inclusive).
6. `allowance_expiration_ledger` before the current ledger → `Expired`; beyond the network's maximum TTL or more than `MAX_ALLOWANCE_LEDGERS` (17,280) ledgers ahead → `InvalidAllowanceExpiration`.
7. `token.approve(from, UptoProxy, max_amount, allowance_expiration_ledger)`.
8. If `actual_amount > 0`: `token.transfer_from(UptoProxy, from, to, actual_amount)`.
9. Extend the proxy's instance and code TTL: `extend_ttl_with_limits(518_400, 120, 720)` (see [Availability](#availability)).
10. Emit `upto_settled`.

The contract stores no data of its own.

### Contract Errors

| Code | Name                         |
| ---- | ---------------------------- |
| 1    | `InvalidAmount`              |
| 2    | `AmountExceedsMax`           |
| 3    | `SelfPayment`                |
| 4    | `NotYetValid`                |
| 5    | `Expired`                    |
| 6    | `InvalidAllowanceExpiration` |
| 7    | (retired)                    |
| 8    | `InvalidRecipient`           |

### Availability

The proxy's instance and WASM code are persistent ledger entries. If they were archived, every settlement would first pay a restore, and open authorizations are bound to the address, so a redeployment couldn't take them over. Two things keep them alive:

- The deployment is extended to the network's maximum TTL (about 180 days).
- Every successful settlement calls `extend_ttl_with_limits` with these constants, paid by the facilitator inside the settlement fee:

| Constant            | Ledgers | About (5 s ledgers) | Meaning                      |
| ------------------- | ------: | ------------------- | ---------------------------- |
| `TTL_EXTEND_TO`     | 518,400 | 30 days             | the target TTL               |
| `TTL_MIN_EXTENSION` |     120 | 10 minutes          | smaller gains are skipped    |
| `TTL_MAX_EXTENSION` |     720 | 1 hour              | the most one settlement adds |

The cap keeps one settlement from refilling a long gap: rent is about 198.8 stroops per ledger on testnet, so an uncapped refill after a quiet week would cost about 24 million stroops and be refused by any reasonable fee ceiling. A deployment that sees fewer than about one settlement an hour runs down after the deploy-time extension and must be extended again by its operator; anyone can do that.

### Event

`upto_settled`, emitted on every successful settlement including zero:

- topics: `"upto_settled"`, `token`, `from`, `to`
- data (map): `receiver_authorizer`, `max_amount`, `actual_amount`, `nonce`

### Testnet Evidence

An end-to-end suite passed 61 of 61 scenarios on testnet on 2026-11-12 against the canonical testnet deployment, across Circle testnet USDC, a classic asset through its SAC, and a non-SAC SEP-41 token: settlements below, at and at zero of the maximum, a replayed entry refused, a reused payment ID under a new signature settled, two payments from one payer in one ledger, every rejection above, tampering with each signed value, a client refusing a forged simulated tree, the facilitator's window and signature-expiry checks, and the TTL self-extension on a fresh instance. Facilitator-delegated settlements carried the facilitator's own address-credential entry as the receiver authorization. A self-managed settlement per token had the seller's account sign the receiver authorization without simulation, and a second facilitator, which had not seen the payment, relayed it through its own channel and fee bump. The client paid no fees. Report with the transaction hashes and the rent measurements: [UptoProxy testnet report](https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/upto-proxy-testnet-report.md). Threat model: [`docs/threat-model.md`](https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/threat-model.md).

[SEP-41]: https://stellar.org/protocol/sep-41
