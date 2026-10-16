# Scheme: `upto` on `Stellar`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:

- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The `upto` scheme on Stellar lets a client authorize a **maximum amount** of a [SEP-41] token once, and lets the facilitator it chose settle the **actual amount** (from `0` up to that maximum) after the resource server has measured usage. It meets the five core properties of [`scheme_upto.md`](./scheme_upto.md).

Settlement goes through the **UptoProxy** Soroban contract, deployed at one [canonical address](#canonical-uptoproxy-deployments) per network. The client signs one Soroban authorization entry for `UptoProxy.settle_upto` with a nested `token.approve`; it never builds, signs or pays for a transaction. The facilitator swaps in the actual amount, adds its own authorization and submits the transaction, paying all fees.

> [!NOTE]
> **This design ships a Soroban contract.** SEP-41 allowances alone (`approve` + `transfer_from` by the facilitator) cannot bind the recipient or enforce single use: an allowance lets its spender move the tokens to any address, any number of times, until it expires or is used up. The contract enforces the recipient, the facilitator, the time window and the nonce on chain. See [Security Considerations](#security-considerations).

> [!NOTE]
> **Scope:** [SEP-41]-compliant Soroban tokens, including Stellar Asset Contracts (SAC) for classic assets.

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `402 Payment Required` and a `PAYMENT-REQUIRED` header. The `upto` entry carries `amount` (the maximum), `asset`, `payTo`, `maxTimeoutSeconds` and `extra.facilitatorAddress`.
3. **Client** builds the authorization entry for `UptoProxy.settle_upto` described in [Authorization Entry](#authorization-entry): the canonical proxy, the token, the recipient, the facilitator, the maximum, a fresh random 32-byte nonce, a validity window and a nested `token.approve` of the maximum to the proxy.
4. **Client** signs the entry with its wallet, with `signatureExpirationLedger` equal to the entry's `allowance_expiration_ledger`.
5. **Client** sends a new request with the `PaymentPayload`, whose `payload.authorization` is the signed entry as base64 XDR.
6. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator**'s `/verify` endpoint.
7. **Facilitator** decodes the entry, checks it against the requirements and simulates the settlement at the full maximum ([Verification](#facilitator-verification-rules-must)).
8. **Resource Server**, on a valid response, runs the request and measures usage.
9. **Resource Server** calls `/settle` with the same `PaymentPayload` and `PaymentRequirements` whose `amount` is now the **actual amount** ([`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)).
10. **Facilitator** re-verifies against the signed maximum, builds `settle_upto` with the actual amount, simulates it, submits it, and returns a `SettlementResponse` with the amount charged ([Settlement](#settlement-logic)).
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
    "facilitatorAddress": "GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM"
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
- `extra.facilitatorAddress`: The Stellar account (`G...`) that will settle the payment. The facilitator publishes it in the `extra` of its `/supported` entry for `upto`, and the resource server copies it into its requirements. The client signs it as the `facilitator` argument, so only that facilitator can settle.

`maxTimeoutSeconds` MUST NOT exceed what `MAX_ALLOWANCE_LEDGERS` (17,280 ledgers) covers at the network's ledger close time: 86,400 seconds at 5-second ledgers. The contract refuses an allowance expiry further ahead (`InvalidAllowanceExpiration`), so a longer window can't be settled.

The proxy address is **not** a requirements field. Clients and facilitators MUST use the [canonical deployment](#canonical-uptoproxy-deployments) for the network, so a resource server cannot point a client at a different contract.

## PaymentPayload `payload` Field

```json
{
  "authorization": "AAAAAQAAAAAAAAAA..."
}
```

`authorization` is the base64 XDR of one signed `SorobanAuthorizationEntry`. Every argument of `settle_upto` except `actual_amount` can be read from it: `from` from the credentials, `allowance_expiration_ledger` from the `approve` sub-invocation, and the rest from the root invocation.

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
      "facilitatorAddress": "GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM"
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
  args     = [token, to, facilitator, max_amount, nonce, valid_after, deadline]
  subInvocations:
    - contract = token, function = "approve"
      args     = [from, UptoProxy, max_amount, allowance_expiration_ledger]
      subInvocations: []
```

| Value                         | Type         | Set to                                                                                        |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `token`                       | `Address`    | `requirements.asset`                                                                          |
| `to`                          | `Address`    | `requirements.payTo`                                                                          |
| `facilitator`                 | `Address`    | `requirements.extra.facilitatorAddress`                                                       |
| `max_amount`                  | `I128`       | `requirements.amount`                                                                         |
| `nonce`                       | `BytesN<32>` | 32 random bytes from a cryptographically secure source, fresh for every payment               |
| `valid_after`                 | `U64`        | Unix seconds, at most the current time. Clients MAY back-date it by up to 60 s for clock skew |
| `deadline`                    | `U64`        | Unix seconds, at most `now + maxTimeoutSeconds`                                               |
| `allowance_expiration_ledger` | `U32`        | `currentLedger + ceil(maxTimeoutSeconds / ledgerCloseSeconds)`: it MUST last until `deadline` |

- The root `args` are the exact vector the contract passes to `from.require_auth_for_args`, in this order and with these types. `from` and `actual_amount` are not in it: `from` is the signer, and `actual_amount` is chosen by the facilitator within the signed maximum.
- `ledgerCloseSeconds` is the network's target ledger close time. It is a network setting since protocol 23 ([CAP-0070](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0070.md)), so clients and facilitators MUST read it from the network rather than assume 5 seconds.
- `signatureExpirationLedger` MUST equal `allowance_expiration_ledger`. The host keeps a nonce entry for the client's signature until `signatureExpirationLedger`, the facilitator pays its rent, and the contract never sees that value; the equality is what bounds it.
- The tree is fully determined by the requirements and the client's own choices, so the client MAY build it directly without simulation. A client that wants a preflight check MAY simulate a draft `settle_upto` call with `actual_amount = max_amount` in recording mode; the draft's source account MUST then be `facilitatorAddress`, because with the client as source the simulation records source-account credentials and returns nothing to sign. That simulation needs a balance of at least `max_amount`.
- 🚨 A client that simulates MUST compare the returned tree with the one built from the requirements and MUST refuse to sign anything else. The simulation comes from an RPC or facilitator the client doesn't control, and a lying one can return, for example, a plain `token.transfer` of the client's balance.
- Smart-wallet (`C...`) clients with per-context policies MUST allow both contexts: `settle_upto` on the proxy and `approve` on the token.

## Facilitator Verification Rules (MUST)

A facilitator verifying an `upto` payment on Stellar MUST enforce all of the following. At `/verify`, `requirements.amount` is the maximum.

### 1. Protocol Validation

- `x402Version` MUST be `2`.
- `payload.accepted.scheme` and `requirements.scheme` MUST be `"upto"`.
- `payload.accepted.network` MUST equal `requirements.network`.
- `requirements.extra.facilitatorAddress` MUST be one of this facilitator's own addresses.

### 2. Authorization Entry

- `payload.authorization` MUST decode to exactly one `SorobanAuthorizationEntry`.
- Its credentials MUST be `sorobanCredentialsAddress` or `sorobanCredentialsAddressV2` (see [`scheme_exact_stellar.md` §3](../exact/scheme_exact_stellar.md#3-authorization-entries) for the two preimages). `sorobanCredentialsSourceAccount` and `sorobanCredentialsAddressWithDelegates` MUST be rejected.
- Its `rootInvocation` MUST equal, byte for byte as XDR, the tree in [Authorization Entry](#authorization-entry) built from the requirements and from the entry's own `from`, `nonce`, `valid_after`, `deadline` and `allowance_expiration_ledger`. In particular:
  - the root contract is the canonical UptoProxy for the network, and the function is `settle_upto`;
  - `token == requirements.asset`, `to == requirements.payTo`, `facilitator == requirements.extra.facilitatorAddress`, `max_amount == requirements.amount`;
  - there is exactly one sub-invocation, `approve` on `token` with `[from, UptoProxy, max_amount, allowance_expiration_ledger]`, and it has no sub-invocations of its own.
- The signature MUST be valid for `from`.

### 3. Time Bounds

- `valid_after <= now <= deadline`, and `deadline` MUST NOT exceed `now + maxTimeoutSeconds`.
- `signatureExpirationLedger` MUST equal `allowance_expiration_ledger`. This check is required, not defence in depth: nothing else bounds how long the host keeps the client's signature nonce, whose rent the facilitator pays.
- `allowance_expiration_ledger` MUST be no earlier than the ledger expected at `deadline`, less a small margin for the close-time estimate. An earlier expiry passes verification but fails settlement with `Expired` after the resource server has served.
- `allowance_expiration_ledger` MUST NOT exceed `currentLedger + ceil(maxTimeoutSeconds / ledgerCloseSeconds)` plus a small margin. The facilitator pays temporary rent on the nonce entry and the allowance until that ledger, so a far expiry is a cost the client chooses.
- The contract independently refuses an expiry more than 17,280 ledgers ahead (`InvalidAllowanceExpiration`).

### 4. Nonce

- `UptoProxy.is_nonce_used(from, nonce)` MUST return `false`.
- `(from, nonce)` MUST NOT be in the facilitator's own record of settled nonces (see [Settlement](#settlement-logic)). The contract forgets a nonce once its temporary entry expires, so the record is what stops a later payload that reuses it.

### 5. 🚨 Facilitator Safety

- `from` MUST NOT be any of the facilitator's addresses, including fee-bump and channel accounts. The same address can't authorize twice in one call, so the host would refuse the settlement after the resource server has served.
- `to` MUST NOT be the UptoProxy address.
- The facilitator's own authorization MUST NOT come from the client: the facilitator adds it at settlement.

### 6. Simulation

- The facilitator MUST simulate `settle_upto` with `actual_amount = max_amount` (the worst case), the client's entry and its own authorization, against the current ledger state.
- The simulation MUST succeed.
- The only balance changes MUST be `from` decreasing by `max_amount` and `to` increasing by `max_amount`. The only other writes allowed are the `(from, UptoProxy)` allowance on `token`, the proxy's nonce entry, and TTL extensions. A non-SAC token may emit extra events or charge transfer fees, so facilitators MUST check balance changes, not only events.

## Settlement Logic

### Phase 1: Settle-Time Verification

At `/settle`, `requirements.amount` is the **actual** amount ([`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)).

1. Run every [verification rule](#facilitator-verification-rules-must) again, independently of any earlier `/verify`, but against the **signed** `max_amount` read from the entry, not against `requirements.amount`.
2. Require `0 <= requirements.amount <= max_amount`, else fail with `invalid_upto_stellar_payload_settlement_exceeds_amount`.

### Phase 2: Zero Settlement

If `requirements.amount` is `0`, the facilitator MUST NOT submit a transaction. It MUST first record `(from, nonce)` durably as settled, as in [Submission](#phase-4-submission), then return `success: true`, `transaction: ""` and `amount: "0"`. Without the record, a second `/settle` on the same payload with a non-zero amount would pass, because the contract never saw the nonce. On chain the nonce stays unused until the authorization expires, but only this facilitator can settle it.

The contract also accepts `actual_amount = 0`, which uses the authorization up on chain and emits the event; a facilitator MAY submit it that way, at the cost of a transaction fee.

### Phase 3: Transaction Construction

1. Build one `invokeHostFunction` operation calling `UptoProxy.settle_upto` with all ten arguments: `[token, from, to, facilitator, max_amount, actual_amount, nonce, valid_after, deadline, allowance_expiration_ledger]`, where `actual_amount = requirements.amount`.
2. Attach the client's entry **unchanged**.
3. Authorize the facilitator's `require_auth()`. The facilitator SHOULD be the **operation source**, so its authorization is source-account credentials and needs no separate entry. Otherwise it adds its own `sorobanCredentialsAddress` entry for the full call with no sub-invocations.
4. The **transaction source** is the facilitator's account or a channel account the facilitator controls. The facilitator MAY wrap the transaction in a fee bump.
5. Simulate in enforcing mode with the actual amount. The simulation MUST succeed, MUST leave the client's tree unchanged, and the only balance changes MUST be `from` decreasing and `to` increasing by `actual_amount`.
6. Set the fee and Soroban resource data from that simulation, as in [`scheme_exact_stellar.md` — Transaction Fees](../exact/scheme_exact_stellar.md#transaction-fees).

### Phase 4: Submission

1. Durably record `(from, nonce)` as settled **before** submitting, and never delete it.
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
- **The nonce and the allowance.** Temporary rent until `allowance_expiration_ledger`, about 1.3 stroops per ledger on testnet; at the 17,280-ledger cap, about 25,000 stroops.
- **The token's own entries.** A first allowance or balance entry, or a token instance that extends its own TTL in the same transaction. The proxy doesn't bound this.

Measured on testnet on 2026-10-09: a normal settlement cost 29,000–47,000 stroops; the costliest settlement without token rent is about 215,000; a settlement in which a SAC instance also extended itself by 54,689 ledgers cost 330,032, and up to about 480,000 is possible for a SAC instance close to expiry. `exact`'s 50,000-stroop default is far too low for `upto`. We suggest a separate `upto` ceiling of about 500,000 stroops, and that facilitators keep the instances of the tokens they accept extended outside settlements, so token rent rarely lands on a payment.

## Error Codes

The `upto` scheme on Stellar uses the standard x402 error codes, plus these:

| Error code                                                 | When                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `invalid_upto_stellar_payload_malformed`                   | `payload.authorization` is missing or isn't one `SorobanAuthorizationEntry`                        |
| `invalid_upto_stellar_payload_unsupported_credential_type` | The credentials aren't `Address` or `AddressV2`                                                    |
| `invalid_upto_stellar_payload_wrong_contract`              | The root contract isn't the canonical UptoProxy, or the function isn't `settle_upto`               |
| `invalid_upto_stellar_payload_auth_mismatch`               | The tree doesn't match the requirements (token, recipient, facilitator, maximum or `approve`)      |
| `invalid_upto_stellar_payload_missing_payer_signature`     | The signature is missing or invalid                                                                |
| `invalid_upto_stellar_signature_expiration_too_far`        | The allowance expiry is past the `maxTimeoutSeconds` bound or the contract's 17,280-ledger cap (contract error `InvalidAllowanceExpiration`), ends before `deadline`, or `signatureExpirationLedger` differs from it |
| `invalid_upto_stellar_payload_not_yet_valid`               | `now < valid_after` (contract error `NotYetValid`)                                                 |
| `invalid_upto_stellar_payload_expired`                     | `now > deadline` or the ledger is past the allowance (contract error `Expired`)                    |
| `invalid_upto_stellar_payload_nonce_used`                  | The nonce is used on chain or in the facilitator's record (contract error `NonceUsed`)             |
| `invalid_upto_stellar_payload_facilitator_is_payer`        | `from` is a facilitator address                                                                    |
| `invalid_upto_stellar_payload_invalid_recipient`           | `to` is the proxy or `from` (contract errors `InvalidRecipient`, `SelfPayment`)                    |
| `invalid_upto_stellar_payload_settlement_exceeds_amount`   | `requirements.amount` at settlement exceeds the signed maximum (contract error `AmountExceedsMax`) |
| `invalid_upto_stellar_payload_simulation_failed`           | Simulation failed for any other reason, including a low balance                                    |
| `invalid_upto_stellar_payload_unexpected_balance_change`   | Simulation shows balance changes other than `from` and `to`                                        |
| `invalid_upto_stellar_payload_fee_exceeds_maximum`         | The simulated fee exceeds `maxTransactionFeeStroops`                                               |

## Security Considerations

1. **Why a contract.** With SEP-41 allowances alone, the client would `approve` the facilitator, which could then `transfer_from` to any recipient, any number of times, until the allowance runs out or expires. UptoProxy binds the recipient, the facilitator, the maximum, the window and a single-use nonce into the client's signature and checks them on chain. It is immutable (no admin, no upgrade) and never holds funds.
2. **Replay is refused twice.** Reusing a signed entry fails in Soroban's own authorization (`Error(Auth, ExistingValue)`); re-signing the same `(from, nonce)` fails in the contract (`NonceUsed`) while its entry lives. The facilitator's settled-nonce record covers the time after the entry expires.
3. **Recipient and facilitator binding.** `to` and `facilitator` are signed, and the contract calls `facilitator.require_auth()`. Another party that sees the payload cannot settle it, even for a smaller amount, and a facilitator that rewrites `facilitator` to itself breaks the client's signature.
4. **Leftover allowance.** `approve` sets the proxy's allowance to `max_amount`, and `transfer_from` spends `actual_amount`, so `max_amount - actual_amount` stays approved to the proxy until `allowance_expiration_ledger`. Only the proxy can spend it, and only through `settle_upto` with a new client signature and an unused nonce. A client that wants it cleared earlier can set its allowance to the proxy to `0`.
5. **Nonce scope.** The nonce is per `from`, not per facilitator, and each facilitator's settled-nonce record covers only its own settlements. A client that signs the same nonce for two resource servers on different facilitators passes both `/verify` calls; the first settlement wins, and the second fails with `NonceUsed`. No extra funds move, but the second resource server is not paid (item 6).
6. **Server credit risk.** In `upto` the resource server serves before settlement, so a client can make the settlement fail afterwards, for example by moving its balance away or reusing its nonce as above. The settle-time simulation catches this before anything is submitted, so the facilitator pays no fee, but the resource server is exposed to at most one maximum per open authorization. Short windows and small maximums bound it.
7. **Server trust.** As on every network, the client trusts the resource server to charge for real usage, up to the maximum.
8. **Blind signing.** A client that signs whatever a simulation returns can be made to authorize another call. Clients build the tree from the requirements, or compare the simulated tree with it ([Authorization Entry](#authorization-entry)).
9. **Fee exposure.** The facilitator pays for failed transactions too. Simulating immediately before submission and capping fees bound that cost; a state change between simulation and inclusion can still make a settlement fail and be charged.
10. **Rent chosen by the client.** The client picks `allowance_expiration_ledger` and `signatureExpirationLedger`, and the facilitator pays rent on the entries that live until then. The [time-bound rules](#3-time-bounds) and the contract's 17,280-ledger cap keep that cost within the payment window.
11. **Availability.** The proxy's instance and code are persistent entries that expire if nobody extends them. Every settlement extends them ([Availability](#availability)), and open authorizations are bound to the proxy's address, so they can't move to a redeployment.
12. **Throughput.** One payment is one transaction. Settlements from different clients don't contend, and with N channel accounts a facilitator can land N per ledger, up to the network's share of ledger capacity.

## Appendix

### Canonical UptoProxy Deployments

| Network           | Contract address                                           | WASM hash                                                          |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `stellar:testnet` | `CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC` | `00a06b1683557a60d2822bbab4e1fee9012e9b521d52b22a8ab22fd47cd4b79c` |
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
    facilitator: Address,
    max_amount: i128,
    actual_amount: i128,
    nonce: BytesN<32>,
    valid_after: u64,
    deadline: u64,
    allowance_expiration_ledger: u32,
) -> Result<(), UptoError>;

pub fn is_nonce_used(env: Env, from: Address, nonce: BytesN<32>) -> bool;
```

`settle_upto` runs in this order; any error rolls the whole call back:

1. `max_amount <= 0` or `actual_amount < 0` → `InvalidAmount`; `actual_amount > max_amount` → `AmountExceedsMax`.
2. `from == to` → `SelfPayment`; `to == UptoProxy` → `InvalidRecipient`.
3. `from.require_auth_for_args([token, to, facilitator, max_amount, nonce, valid_after, deadline])`.
4. `facilitator.require_auth()`.
5. `now < valid_after` → `NotYetValid`; `now > deadline` → `Expired` (ledger timestamp, both inclusive).
6. `allowance_expiration_ledger` before the current ledger → `Expired`; beyond the network's maximum TTL or more than `MAX_ALLOWANCE_LEDGERS` (17,280) ledgers ahead → `InvalidAllowanceExpiration`.
7. `(from, nonce)` already stored → `NonceUsed`; otherwise store it in temporary storage and extend its TTL to `allowance_expiration_ledger`.
8. `token.approve(from, UptoProxy, max_amount, allowance_expiration_ledger)`.
9. If `actual_amount > 0`: `token.transfer_from(UptoProxy, from, to, actual_amount)`.
10. Extend the proxy's instance and code TTL: `extend_ttl_with_limits(518_400, 120, 720)` (see [Availability](#availability)).
11. Emit `upto_settled`.

### Contract Errors

| Code | Name                         |
| ---- | ---------------------------- |
| 1    | `InvalidAmount`              |
| 2    | `AmountExceedsMax`           |
| 3    | `SelfPayment`                |
| 4    | `NotYetValid`                |
| 5    | `Expired`                    |
| 6    | `InvalidAllowanceExpiration` |
| 7    | `NonceUsed`                  |
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
- data (map): `facilitator`, `max_amount`, `actual_amount`, `nonce`

### Testnet Evidence

An end-to-end suite passed 58 of 58 scenarios on testnet on 2026-10-09 against the canonical testnet deployment, across Circle testnet USDC, a classic asset through its SAC, and a non-SAC SEP-41 token: settlements below, at and at zero of the maximum, two payments from one payer in one ledger, every rejection above, tampering with each signed value, a client refusing a forged simulated tree, the facilitator's window and signature-expiry checks, and the TTL self-extension on a fresh instance. The client paid no fees. Report with all 23 transaction hashes and the rent measurements: [UptoProxy testnet report](https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/upto-proxy-testnet-report.md). Threat model: [`docs/threat-model.md`](https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/threat-model.md).

[SEP-41]: https://stellar.org/protocol/sep-41
