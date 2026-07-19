# Scheme: `exact` on `Sui`

## Summary

The `exact` scheme on Sui transfers a specific amount of an asset type `T` from the payer to
the resource server. In every case the payer signs a **complete transaction**, so the
facilitator cannot modify the amount or destination — it serves only as the transaction
broadcaster.

The scheme supports two asset transfer methods:

| AssetTransferMethod | Use Case                                                                             | Recommendation                                                                                              | Usage Semantics |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------- |
| **1. `gasless`**    | Protocol-allowlisted stablecoins (e.g. USDC) at or above the `0.01` gasless minimum. | **Recommended** (truly gasless: no gas token, no sponsor, no coin-object storage cost).                     | One-time use    |
| **2. `coin`**       | Any `Coin<T>` — non-allowlisted assets or amounts below the gasless minimum.         | **Universal fallback** (client pays gas, or uses non-interactive gas sponsorship when the facilitator offers it). | One-time use    |

Neither method constrains where the payer's assets live: a payer holding only `Coin<T>`
objects can pay under either method (the SDK resolves the asset source automatically), and a
`gasless`-method payer may equally draw from an Address Balance. The discriminator between
the methods is the transaction's **gas shape**, never the asset's location — which is why the
method names describe the gas property, not the asset store.

Method selection rules:

- `PaymentRequirements.extra.assetTransferMethod` is OPTIONAL and, when present, MUST be
  `"gasless"` or `"coin"`; the payment MUST then use the declared method.
- When absent, the client MAY use either method and SHOULD default to `gasless`
  whenever the asset and amount are eligible for
  [gasless stablecoin transfers](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers).
- The client SHOULD echo the method it selected in `accepted.extra.assetTransferMethod`.
- Both methods share the same `payload` shape. The facilitator MUST derive the effective
  method — and, within `coin`, the gas arrangement — from the requirements and the decoded
  transaction's gas shape:
  - `gasPayment == []` ∧ `gasPrice == 0` → `gasless`;
  - `gasPayment == []` ∧ `gasPrice > 0` → `coin`, **sponsored** (valid only when the
    requirements announced a `feePayer`; see the `coin` method);
  - `gasPayment != []` → `coin`, client-paid gas;

  and MUST reject (`invalid_payload`) a payment whose declared or echoed method contradicts
  the decoded shape.

### Sponsorship announcement (`extra.feePayer`, `extra.maxGasBudget`)

A facilitator that sponsors gas for `coin` payments announces it per scheme/network kind in
the `extra` of its `/supported` response; the resource server relays the fields verbatim in
`PaymentRequirements.extra`. The **presence of `feePayer` is the signal that sponsorship is
offered**, mirroring `extra.feePayer` in `exact` on SVM (the account that pays fees and
provides the final signature):

| Field                | Type     | Required         | Description                                                                              |
| -------------------- | -------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `extra.feePayer`     | `string` | With sponsorship | The facilitator's sponsor address. The client MUST set it as the transaction's gas owner. |
| `extra.maxGasBudget` | `string` | With `feePayer`  | Ceiling (in MIST, decimal string) for the client-set `gasBudget` of a sponsored transaction. |

Verification is effects-based for both methods, so they settle to the same independently
recomputable result. Core types (`PaymentRequirements`, `PaymentPayload`, `SettleResponse`,
`VerifyResponse`) are defined in
[x402-specification-v2.md](../../x402-specification-v2.md#5-types); Sui networks use CAIP-2
`sui:mainnet` / `sui:testnet` / `sui:devnet`.

## Protocol Sequencing

The following outlines the flow of the `exact` scheme on `Sui`:

1. Client makes a request to a `resource server` and receives a payment required response.
2. Client selects an asset transfer method per the rules above.
3. If the client doesn't already have local information about the asset it owns (an Address
   Balance and/or Coin objects) it can request it from an RPC service for transaction
   construction.
4. On **`gasless`** the client builds over a gRPC/GraphQL RPC endpoint, which
   auto-resolves gasless eligibility (`gasPayment = []`, `gasPrice = 0`). On **`coin`** the
   client builds a regular transaction, providing its own gas — or, when the requirements
   announce a `feePayer`, setting the announced sponsor as gas owner with an empty gas
   payment (non-interactive Address Balance gas sponsorship; see the `coin` method). No
   method involves a gas-station round trip: the client always builds the complete
   transaction itself.
5. Client signs the transaction and resends the request to the `resource server` including
   the `PaymentPayload`.
6. `resource server` passes the `PaymentPayload` to the `facilitator` for verification under
   the effective method's verification rules.
7. `resource server` does the work to fulfill the request.
8. `resource server` requests settlement from the `facilitator`.
9. On the sponsored `coin` flow the `facilitator` re-verifies and attaches its sponsor
   signature over the identical client-signed bytes; on `gasless` there is no sponsor
   signature (the transaction carries no gas).
10. `facilitator` submits the transaction to the `Sui` network for execution and reports back
    to the `resource server` the result of the transaction.
11. `resource server` returns the response to the client.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` MUST contain the following fields for both asset
transfer methods:

- `signature`: The user signature over the Sui transaction.
- `transaction`: The Base64-encoded BCS-serialized Sui transaction itself.

Example `payload`:

```json
{
  "signature": "99X8xzbQkOBY3yUnaeCvDslpGdMfB81aqEf7QQC8RhXJ6rripVz2Z21Vboc/CAmodHZkcDjiraFbJlzqQJKkBQ==",
  "transaction": "AAAIAQDi1HwjSnS6M+WGvD73iEyUY2FRKNj0MlRp7+3SHZM3xCvMdB0AAAAAIFRgPKOstGBLCnbcyGoOXugUYAWwVzNrpMjPCzXK4KQWAQCMoE29VLGwftex8rhIlOuFLFNfxLIJlHqGXoXA8hx6l+LMdB0AAAAAIHbPucTRIEWgO6lzqukswPZ6i72IHEKK5LyM1l9HJNZNAQBthSeHDVK8Xr5/zp3JMZPLtG5uAoVgedTA4pEnp+h8qUlUzRwAAAAAIACH0swYW/QfGCFczGnjAVPHPqZrQE5vfvJr36i6KVEFAQAC7W4K5vCwB+nprjxcNlLiOQ7SIIfyCZjmj2qSis2iTsCuzBwAAAAAIAkSUkXOoeq52GNdhwpbs+jZqqrqPdmiN3oPw5EzDIanAQAIyFNGWD6OxiFIyXSxrNEcFG0npm+nImk6InUssXb1EZgx1hwAAAAAILhsjmMKyM0n75Cd7z6ufH2LNhOMibFOGhNlLgV5RFuEAQC+Mh4kGkLwrw/11729oUQnt3xOmOreE6PcnuN6M68ZBcCuzBwAAAAAIO2PQhSSqSAawCbRr005lfjBgFOqIHo4zb2GcQ/WCxAlAAgA+QKVAAAAAAAgjiAHD0X4HNSdVPpJtf2E6W2uRc8kbvCHYkgEQ1B+w1MDAwEAAAUBAQABAgABAwABBAABBQACAQAAAQEGAAEBAgEAAQcAHrfFfj8r0Pxsudz/0UPqlX5NmPgFw1hzP3be4GZ/4LEB5XXrONxGw0qOUsq3yNKeUhOCOgCIwaa4pswKaer66EKqPGwdAAAAACBrOIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO1B63xX4/K9D8bLnc/9FD6pV+TZj4BcNYcz923uBmf+Cx7gIAAAAAAABg4xYAAAAAAAA="
}
```

Full `PaymentPayload` object (single-output `gasless` payment; the client echoes the
selected method in `accepted.extra`, which may also carry the OPTIONAL Sui fields described
below):

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
    "extra": {
      "assetTransferMethod": "gasless"
    }
  },
  "payload": {
    "signature": "99X8xzbQkOBY3yUnaeCvDslpGdMfB81aqEf7QQC8RhXJ6rripVz2Z21Vboc/CAmodHZkcDjiraFbJlzqQJKkBQ==",
    "transaction": "AAAIAQDi1HwjSnS6M..."
  },
  "extensions": {}
}
```

## AssetTransferMethod: `gasless`

When the asset is an allowlisted stablecoin and the per-transfer amount meets the protocol
minimum of 0.01, the payer SHOULD construct a **gasless** transaction. Sui's gasless
stablecoin transfer feature (protocol v125,
[docs](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers)) accepts
such a transaction with no gas token, no sponsor, and no coin-object creation. This
eliminates the coin-object storage cost and any sponsorship round trip.

### Construction

The following protocol constraints MUST hold:

1. **Gas fields.** The transaction MUST set `gasPayment = []` (empty) and `gasPrice = 0`.
2. **Allowlisted operations only.** Every MoveCall command MUST be one of the
   protocol-allowlisted stablecoin operations. The relevant set is the four functions
   that exist in the framework: `0x2::balance::send_funds`, `0x2::balance::redeem_funds`,
   `0x2::coin::send_funds`, and `0x2::coin::into_balance` (the Move SDK's
   `tx.balance({ type, balance })` input resolves to `balance::redeem_funds` for an
   Address Balance and `coin::into_balance` for a `Coin<T>`, then `balance::send_funds`
   to the recipient). A transfer to recipient `R` of `amount` of asset `T` from an Address
   Balance is one `0x2::balance::send_funds<T>(balance, R)` command. When the source is a
   `Coin<T>` OBJECT (the common case after a normal coin transfer), the SDK additionally
   emits the native `SplitCoins` (and, when merging fragments, `MergeCoins`) commands to
   carve exact change off the coin before converting it — these move no asset to a third
   party and are tolerated; `TransferObjects` and every other non-MoveCall command MUST be
   rejected.
3. **No object writes.** Per the protocol, "no objects are written during the transaction,
   and all input coins are consumed or converted to address balances." A gasless transaction
   therefore cannot create, mutate, transfer, or wrap any object — which bounds the entire
   attack surface to value movement among Address Balances of the allowlisted asset.
4. **Allowlisted assets.** Only protocol-allowlisted stablecoins are gasless-eligible (e.g.
   USDC). A non-allowlisted asset MUST use the `coin` method.
5. **Minimum transfer amount.** The protocol applies a minimum transfer balance of `0.01`
   units per transfer on networks that enforce the allowlist parameter. This minimum is a
   **protocol parameter, NOT a security boundary**, and verification MUST NOT rely on it.
   Verification anchors only on the exact `amount`/`outputs` (see Output Verification).
   Below the minimum on an enforcing network, the payer MUST fall back to the `coin` method.
6. **Natural expiry (TTL).** When `gasPayment` is empty the protocol stamps the transaction
   with a `ValidDuring { minEpoch, maxEpoch }` window of approximately two epochs. This is
   the transaction's natural expiry: a stale signed transaction ceases to be executable after
   the window, and verification's simulation step fails for an expired transaction.

A single-output gasless transfer credits exactly `payTo` and satisfies the single-`payTo`
output rule (see Output Verification).

### Verification (`gasless`)

Steps to verify a payment using the `gasless` method:

1. Verify `x402Version == 2`, the `scheme` is `"exact"`, and the `network` matches the
   requirements (`invalid_x402_version` / `invalid_scheme` / `invalid_network`). The
   `PaymentPayload.payload` MUST have the shape `{ signature, transaction }`
   (`invalid_payload`).
2. Verify the signature is valid over the provided transaction AND the recovered address
   equals the transaction's `sender` (`invalid_exact_sui_payload_signature`). This binds the
   debit to the signer.
3. **Gasless-shape assertions.** BCS-decode the transaction and assert
   `gasPayment == []` ∧ `gasPrice == 0`, and that EVERY command is either an allowlisted
   MoveCall (`0x2::balance::send_funds` / `redeem_funds`, `0x2::coin::send_funds` /
   `into_balance`) or one of the native coin-plumbing commands `SplitCoins` / `MergeCoins`
   (which a `Coin<T>`-object source emits to carve exact change). `TransferObjects` and every
   other command MUST be rejected. Because no object writes are possible, this replaces
   gas-cap guards entirely: with zero gas there is no facilitator gas to drain. A non-empty
   `gasPayment`, a non-zero `gasPrice`, or a disallowed command under this method MUST be
   rejected (`invalid_payload`).
4. **Replay guard.** Compute the transaction's digest from the signed bytes and look it up
   on-chain (e.g. `getTransactionBlock`); if it is already committed, reject
   (`invalid_transaction_state`). Simulation MUST NOT be relied on as the replay guard: a
   gasless transfer has no object inputs, so re-simulating already-executed
   bytes still SUCCEEDS (see Security Considerations).
5. Simulate the transaction (e.g. `dryRunTransactionBlock` / `simulateTransaction`) to ensure
   it would still succeed and has not expired (the TTL window). A TTL-expired transaction
   fails simulation (`invalid_transaction_state`).
6. Apply [Output Verification](#output-verification-all-methods) to the simulated
   `balanceChanges`.

> Verification asserts only the **asset** balance changes. A simulation previews a phantom
> SUI gas line because it runs with a non-zero budget; gasless-ness is asserted from the
> decoded transaction's `gasPrice == 0` / `gasPayment == []` (step 3), not from the
> simulated SUI line.

## AssetTransferMethod: `coin`

The universal path: the payer forms a complete signed transaction moving the exact `amount`
of the asset, drawn from its `Coin<T>` objects or its Address Balance (the gas shape, not
the asset source, is what distinguishes this method). This method MUST be used for
non-allowlisted assets and for amounts below an enforcing network's gasless minimum.

### Construction (client-paid gas)

The client builds a regular Sui transaction transferring the exact `amount` of the asset to
the declared recipient(s), providing its own gas payment. If the client does not want to (or
cannot) pay gas, it uses the sponsored construction below when the requirements announce a
`feePayer`.

### Construction (sponsored — Address Balance gas sponsorship)

Sponsorship is **non-interactive**: gas is drawn from the SUI *Address Balance* of the
announced sponsor
([Address Balance sponsorship](https://sdk.mystenlabs.com/sui/transactions/signing-and-execution#address-balance-sponsorship)),
so no gas coin objects appear in the signed bytes, no gas object is reserved per
sponsorship, and the client never talks to any party other than the resource server. The
client builds the **complete** transaction itself:

1. `sender` = the payer; the transfer commands move the exact `amount` to the declared
   recipient(s) without touching the gas coin (the gas belongs to the sponsor).
2. **Gas owner** = `PaymentRequirements.extra.feePayer` (the announced sponsor address),
   which MUST NOT equal `sender`.
3. **Gas payment** = `[]` (empty — gas resolves from the gas owner's Address Balance) with a
   normal (non-zero) reference `gasPrice`.
4. **Gas budget**: client-set, MUST NOT exceed `extra.maxGasBudget`. The budget is part of
   the signed BCS bytes, so the facilitator cannot set or raise it after signing — it
   co-signs identical bytes; the announced ceiling is what bounds its exposure.
5. The client signs and sends the standard `{ signature, transaction }` payload. The
   facilitator adds its sponsor signature asynchronously at settlement — no round trip
   before signing.

Because `gasPayment` is empty, a sponsored transaction carries the same
`ValidDuring` (~2-epoch) natural expiry as the `gasless` method.

### Verification (`coin`)

Steps to verify a payment using the `coin` method:

1. Verify `x402Version == 2`, the `scheme` is `"exact"`, and the `network` matches the
   requirements (`invalid_x402_version` / `invalid_scheme` / `invalid_network`). The
   `PaymentPayload.payload` MUST have the shape `{ signature, transaction }`
   (`invalid_payload`).
2. Verify the signature is valid over the provided transaction AND the recovered address
   equals the transaction's `sender` (`invalid_exact_sui_payload_signature`). This binds the
   debit to the signer.
3. **Gas-shape check.** BCS-decode the transaction and derive the gas arrangement:
   - **Client-paid**: `gasPayment` is non-empty ∧ `gasPrice > 0`.
   - **Sponsored**: `gasPayment == []` ∧ `gasPrice > 0`. This shape is valid ONLY when the
     requirements announced a `feePayer`; the decoded gas owner MUST equal that announced
     `feePayer` and MUST NOT equal `sender`, and the decoded `gasBudget` MUST NOT exceed the
     announced `maxGasBudget`. A facilitator MUST NOT co-sign a transaction whose gas owner
     is not one of its own announced sponsor addresses.
   - A transaction with `gasPayment == []` ∧ `gasPrice == 0` MUST be verified under
     `gasless` instead.

   Violations are rejected (`invalid_payload`).
4. **Replay guard.** Compute the transaction's digest from the signed bytes and look it up
   on-chain; if it is already committed, reject (`invalid_transaction_state`). On the
   client-paid shape re-simulation of executed bytes also fails naturally (the Coin object
   inputs are consumed), but a sponsored transaction may have NO object inputs at all (asset
   and gas both drawn from Address Balances), where re-simulation of executed bytes still
   succeeds — the digest lookup is the uniform, race-free guard across all shapes.
5. Simulate the transaction to ensure it would still succeed (`invalid_transaction_state`).
6. Apply [Output Verification](#output-verification-all-methods) to the simulated
   `balanceChanges`.

## Declared Outputs (`extra.outputs`, OPTIONAL)

Because a Sui programmable transaction natively expresses N transfers in one atomic
transaction, the resource server MAY declare more than one recipient for a single payment.
When it does, it includes an `outputs` array in `PaymentRequirements.extra`:

| Field           | Type     | Required | Description                                                       |
| --------------- | -------- | -------- | ----------------------------------------------------------------- |
| `extra.outputs` | `array`  | Optional | Ordered list of `{ to, amount }` recipients of the asset.         |
| `outputs[].to`  | `string` | Required | Recipient address (an AddressOwner of the asset).                 |
| `outputs[].amount` | `string` | Required | Atomic-unit amount credited to `to`, as a decimal string.      |

Rules:

- The resource server MUST set `sum(outputs[].amount) == amount`. A requirements object whose
  declared outputs do not sum to `amount` is invalid and MUST be rejected
  (`invalid_payment_requirements`).
- When `extra.outputs` is **present**, verification anchors on the EXACT payer debit: the
  payer MUST be debited exactly `amount`, each declared recipient MUST be credited exactly its
  declared amount, and there MUST be no undeclared recipient of the asset.
- When `extra.outputs` is **absent**, verification is UNCHANGED from the single-recipient
  rule: `payTo`'s observed balance change MUST equal `amount`. `extra.outputs` is opt-in
  per-resource; the default wire shape carries no `outputs` and behaves identically to the
  merged spec.

`extra.outputs` is chain-native atomic routing: it lets `PaymentRequirements` declare what a
payer could otherwise construct freely in a single PTB, and verification gets STRICTER (every
output is matched precisely; no skim to an undeclared address is possible). Generic
use cases: marketplace order routing (split a sale across a vendor and a platform),
affiliate/revenue splits, and tax withholding — each atomic in one transaction.

Example `PaymentRequirements` with declared outputs (a two-recipient split summing to
`amount`):

```json
{
  "scheme": "exact",
  "network": "sui:mainnet",
  "amount": "50000",
  "asset": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "payTo": "0x6fa6e5271e1d5eb02721930843a275aa1f9f4d6ba0dff88c5f8dcd367d9edceb",
  "maxTimeoutSeconds": 60,
  "extra": {
    "outputs": [
      { "to": "0x6fa6e5271e1d5eb02721930843a275aa1f9f4d6ba0dff88c5f8dcd367d9edceb", "amount": "49000" },
      { "to": "0x369cf71b2f13b63c165c207bc3f263b1df9da754ca6a2d09300d9b4bf45f62f0", "amount": "1000" }
    ]
  }
}
```

The matching gasless transaction is a single PTB with one `0x2::balance::send_funds<USDC>`
command per declared output.

## Output Verification (all methods)

Verify the outputs of the simulation against the agreed recipients, reading the asset's
`balanceChanges`:

- If `extra.outputs` is present: each declared recipient MUST be credited EXACTLY its
  declared amount; the payer MUST be debited EXACTLY `amount` (= the sum of outputs); and
  there MUST be no undeclared recipient of the asset. Only AddressOwner credits count;
  ObjectOwner/Shared credits MUST be rejected. A mismatch MUST be rejected
  (`invalid_exact_sui_payload_outputs_mismatch`).
- If `extra.outputs` is absent: the resource server's address (`payTo`) MUST see a balance
  change equal to `amount` in the agreed `asset`
  (`invalid_exact_sui_payload_recipient_mismatch`).

Gas is excluded from the asset movement: on the `coin` method, when the asset is the gas
token itself, the payer's debit is assessed net of any gas fees charged to the payer (the
effects report gas separately; a payer whose transaction is sponsored bears no gas).

Return `{ isValid, payer }` (and `invalidReason` when invalid) per
[VerifyResponse](../../x402-specification-v2.md#54-verifyresponse-schema).

## Settlement

Settlement is performed via the facilitator broadcasting the signed transaction to the network
for execution. On the `gasless` method the broadcast is **keyless**: the facilitator
holds no payer key and only relays the already-signed bytes — a third party can broadcast the
payer's signed transaction without any additional signature. On the sponsored `coin` flow the
facilitator re-asserts the gas-shape check (decoded gas owner equals its announced
`feePayer` and is not `sender`; decoded `gasBudget` ≤ its announced `maxGasBudget`), then
attaches its sponsor signature over the **identical** client-signed bytes and broadcasts
with both signatures. The sponsor's SUI is held as an Address Balance, so no gas coin
objects are reserved and concurrent sponsorships do not contend for a coin pool.

Re-broadcast is **idempotent**: the chain commits a given signed transaction at most once. The
facilitator MUST treat a re-settle of an already-committed transaction as a success returning
the original digest, not as a new payment. It does so by checking executed-first — compute the
digest from the signed bytes, look it up on-chain, and if it is already committed return that
digest WITHOUT re-broadcasting (re-broadcasting an executed gasless transaction can error on
some RPC transports). This executed-first check also means a re-settle does NOT re-run the
replay guard against itself.

Before broadcasting a NOT-yet-executed transaction, the facilitator SHOULD re-run the
verification steps above (defense in depth). The `SettleResponse` returns `success`, the
transaction `digest` (as `transaction`), the `network`, and the `payer` per
[SettleResponse](../../x402-specification-v2.md#53-settlementresponse-schema).

## Security Considerations

- **Replay attack prevention.** Settlement is at-most-once per signed transaction: the chain
  refuses to commit the same transaction twice. **Simulation is NOT a sufficient replay
  guard** on the `gasless` method — nor on a sponsored `coin` transaction whose asset and
  gas both come from Address Balances — because such transactions have no object inputs, so
  re-simulating already-executed bytes still SUCCEEDS (nothing was consumed).
  Verification therefore detects a replay statelessly by computing the transaction digest
  from the signed bytes and looking it up on-chain: an already-committed digest is rejected
  (`invalid_transaction_state`). At settlement the facilitator likewise checks executed-first
  and returns the original digest as an idempotent success WITHOUT re-broadcasting —
  re-broadcasting an executed gasless transaction can error on some RPC transports, so the
  executed-first check is the portable way to keep a re-settle a no-op rather than a failure.
  The ~2-epoch `ValidDuring` TTL — stamped whenever `gasPayment` is empty, i.e. the
  `gasless` method and the sponsored `coin` shape alike — additionally bounds how long
  a signed-but-unbroadcast transaction remains executable (the simulation step in
  verification fails once it expires). A facilitator MAY additionally support the
  [`payment-identifier`](../../extensions/payment_identifier.md) extension for
  application-level verify/settle deduplication; this scheme does not require it for safety.
- **Authorization scope.** The payer signs the complete transaction, so the facilitator cannot
  redirect funds. On the `gasless` method the allowlisted-operation set plus the
  no-object-writes bound mean the only possible effect is a value movement of the allowlisted
  asset among Address Balances; combined with the exact payer-debit and per-output checks, the
  signature authorizes EXACTLY the declared recipients and amounts and nothing else.
  `extra.outputs` does not widen authorization: it can only ever be matched by a transaction
  whose total payer debit equals `amount`, so the payer's trust model is unchanged from the
  single-output case.
- **Settlement atomicity.** All declared outputs settle in a single transaction; a Sui PTB is
  all-or-nothing, so a partial split (one recipient credited but not another) is impossible.
- **Independently recomputable settlement.** Verification is effects-based: the digest is
  recomputed from the signed bytes and the per-output `balanceChanges` are checked against the
  declared outputs. On the `gasless` method there are no gas side-effects to net out
  of the balance-change set, so any third party can recompute a settled payment's exact
  outcome from public chain data alone — digest, per-output credits, payer debit — with no
  trust in the facilitator's report. Receipt or attestation extensions can bind to this
  recomputable result without additional on-chain state.
- **No-object-writes bound.** Because a gasless transaction cannot write objects, it cannot be
  used to mint, upgrade, transfer object capabilities, or perform any side effect beyond the
  asset transfer — the BCS command-shape allowlist in the `gasless` verification
  enforces this and is strictly tighter than a gas cap.
- **Sponsor gas exposure (`coin`).** A sponsoring facilitator funds the gas of transactions
  it did not author. Its per-transaction exposure is bounded by the client-set `gasBudget`,
  which verification asserts does not exceed the announced `maxGasBudget`; it MUST only
  co-sign transactions whose decoded gas owner equals its own announced `feePayer` (the
  verification gas-shape check). Guardrails a managed gas station would provide as service
  configuration — per-address or per-period sponsorship caps, recipient or move-call
  policies — do not disappear under Address Balance sponsorship: they become the
  facilitator's own verify-time policy over the decoded bytes, explicit in its verification
  rules rather than hidden in a station's config. A facilitator MAY reject sponsorship for
  any policy reason ahead of settlement.
- **Minimum-amount parameter.** The `0.01` gasless minimum is a protocol parameter and MUST NOT
  be treated as a verification invariant; verification anchors on exact amounts regardless of
  whether a given network enforces the minimum.

## Appendix

### Future Work

The Address Balances feature may be extended to support `EIP-3009` and/or `EIP-2612` style
authorizations that would let a client authorize a payment without crafting a fully formed
transaction (a signed authorization object rather than a signed transaction). That is left to
a follow-up.

### Recommendation

- For allowlisted stablecoin payments at or above the protocol minimum, use the
  **`gasless`** method: no gas token, no sponsor, no coin-object storage cost. Single-output
  by default; declared `extra.outputs` for atomic multi-recipient routing.
- For non-allowlisted assets or amounts below an enforcing network's gasless minimum, use the
  **`coin`** method: the client pays gas, or — when the facilitator announces a `feePayer` —
  uses non-interactive Address Balance gas sponsorship.
