# Scheme: `exact` on `Sui`

## Summary

The `exact` scheme on Sui transfers a specific amount of an asset type `T` from the payer
to the resource server's declared recipients. In every case the payer signs a **complete
transaction**, so the facilitator cannot modify the amount or destinations: it broadcasts
the payer-signed bytes, and under sponsorship additionally co-signs the gas it funds.

The scheme supports two asset transfer methods:

| AssetTransferMethod | Use Case                                                                             | Recommendation                                                                                              | Usage Semantics |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------- |
| **1. `gasless`**    | Protocol-allowlisted stablecoins (e.g. USDC), every credited leg at or above the `0.01` per-transfer minimum. | **Recommended** (truly gasless: no gas token, no sponsor, no coin-object storage cost).                     | One-time use    |
| **2. `coin`**       | Any `Coin<T>` — non-allowlisted assets, or any credited leg below the per-transfer minimum. | **Universal fallback** (client pays gas, or uses non-interactive gas sponsorship when the facilitator offers it). | One-time use    |

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
  - `gasPayment == []` ∧ `gasPrice == 0` ∧ `gasBudget == 0` → `gasless` (the protocol
    additionally requires the zero budget at signing); decoded gas owner MUST equal
    `sender`;
  - `gasPayment == []` ∧ `gasPrice > 0` → `coin`, **sponsored** (valid only when the
    requirements announced a `feePayer`; see the `coin` method);
  - `gasPayment != []` → `coin`, client-paid gas; decoded gas owner MUST equal `sender`
    (a distinct gas owner requires a sponsor co-signature, which only the sponsored shape
    carries);

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
| `extra.maxSplits`    | `string` | Optional         | Maximum number of `extra.splits` entries the facilitator accepts per payment (see Declared Splits). |

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
   auto-resolves gasless eligibility (`gasPayment = []`, `gasPrice = 0`, `gasBudget = 0`).
   On **`coin`** the
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

Full `PaymentPayload` object (single-recipient `gasless` payment; the client echoes the
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

1. **Gas fields.** The transaction MUST set `gasPayment = []` (empty), `gasPrice = 0`, and
   `gasBudget = 0` (the protocol rejects a gasless transaction with a non-zero budget at
   signing), and MUST leave the gas owner equal to `sender`.
2. **Allowlisted operations only.** Every command MUST be either a MoveCall on the
   validator's gasless function allowlist or one of the native coin-plumbing commands
   `SplitCoins` / `MergeCoins` (which a `Coin<T>`-object source emits to carve exact
   change); `TransferObjects` and every other command MUST be rejected. The function
   allowlist is a fixed set in the node software (release-versioned — distinct from the
   protocol-config allowlist that governs eligible token TYPES); as of this writing it is
   `0x2::balance::send_funds` / `redeem_funds` / `split` / `zero`,
   `0x2::funds_accumulator::withdrawal_split`, and `0x2::coin::send_funds` /
   `redeem_funds` / `into_balance` / `put`. A transfer to recipient `R` of `amount` of
   asset `T` is one `0x2::balance::send_funds<T>(balance, R)` command; the Move SDK's
   `tx.balance({ type, balance })` input resolves the source automatically (an Address
   Balance or `Coin<T>` objects, emitting the plumbing calls above as needed).
3. **No object writes.** Per the protocol, "no objects are written during the transaction,
   and all input coins are consumed or converted to address balances." A gasless transaction
   therefore cannot create, mutate, transfer, or wrap any object — which bounds the entire
   attack surface to value movement among Address Balances of the allowlisted asset.
4. **Allowlisted assets.** Only protocol-allowlisted stablecoins are gasless-eligible (e.g.
   USDC). A non-allowlisted asset MUST use the `coin` method.
5. **Minimum transfer amount.** The protocol applies a minimum transfer balance of `0.01`
   units **per transfer** on networks that enforce the allowlist parameter — with declared
   splits, every credited leg (the primary remainder included) is one transfer and MUST
   individually meet it. This minimum is a **protocol parameter, NOT a security boundary**,
   and verification MUST NOT rely on it. Verification anchors only on the exact
   `amount`/splits (see Recipient Verification). Below the minimum on an enforcing network,
   the payer MUST fall back to the `coin` method.
6. **Natural expiry (TTL).** When `gasPayment` is empty the protocol stamps the transaction
   with a `ValidDuring { minEpoch, maxEpoch }` window of approximately two epochs. This is
   the transaction's natural expiry: a stale signed transaction ceases to be executable
   after the window. Note that **simulation does not detect this** — verification checks
   the decoded window explicitly (see Verification).

A single-recipient gasless transfer credits exactly `payTo` and satisfies the single-`payTo`
rule (see Recipient Verification).

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
   `gasPayment == []` ∧ `gasPrice == 0` ∧ `gasBudget == 0`, that the gas owner equals
   `sender`, and that EVERY command is either a MoveCall on the protocol's gasless
   allowlist (see Construction) or one of the native coin-plumbing commands `SplitCoins` /
   `MergeCoins` (which a `Coin<T>`-object source emits to carve exact change).
   `TransferObjects` and every other command MUST be rejected. Because no object writes
   are possible, this replaces gas-cap guards entirely: with zero gas there is no
   facilitator gas to drain. A non-empty `gasPayment`, a non-zero `gasPrice` or
   `gasBudget`, a gas owner other than `sender`, or a disallowed command under this method
   MUST be rejected (`invalid_payload`).
4. **Replay guard.** Compute the transaction's digest from the signed bytes and look it up
   on-chain (e.g. `getTransactionBlock`); if it is already committed, reject
   (`invalid_transaction_state`). Simulation MUST NOT be relied on as the replay guard: a
   gasless transfer has no object inputs, so re-simulating already-executed
   bytes still SUCCEEDS (see Security Considerations).
5. **Expiry check.** Decode `expiration` and mirror the signing path's validity in full:
   for `ValidDuring`, the current epoch MUST lie within `[minEpoch, maxEpoch]`, the
   embedded chain identifier MUST match the network, and a window carrying the
   not-yet-supported timestamp fields MUST be rejected; for `Epoch(max)`, the current
   epoch MUST be ≤ `max`. Violations are rejected (`invalid_transaction_state`).
   **Simulation enforces none of this** — the node's transaction-input checks are not
   epoch-aware, so an expired (or wrong-chain, or timestamp-bearing) transaction still
   simulates cleanly and would fail only at broadcast. A facilitator that relies on
   simulation alone can therefore verify a payment that can no longer settle, which
   breaks serve-before-settle flows. Verification MUST perform these checks itself.
6. Simulate the transaction (e.g. `dryRunTransactionBlock` / `simulateTransaction`) to
   ensure it would still succeed (`invalid_transaction_state`).
7. Apply [Recipient Verification](#recipient-verification-all-methods) to the simulated
   `balanceChanges`.

> Verification asserts only the **asset** balance changes. A simulation previews a phantom
> SUI gas line because it runs with a non-zero budget; gasless-ness is asserted from the
> decoded transaction's `gasPrice == 0` / `gasPayment == []` (step 3), not from the
> simulated SUI line.

## AssetTransferMethod: `coin`

The universal path: the payer forms a complete signed transaction moving the exact `amount`
of the asset, drawn from its `Coin<T>` objects or its Address Balance (the gas shape, not
the asset source, is what distinguishes this method). This method MUST be used for
non-allowlisted assets and whenever any credited leg — the primary remainder or a declared
split — falls below an enforcing network's per-transfer gasless minimum.

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
5. **Expiry check.** When the decoded `expiration` is present (`ValidDuring` on the
   sponsored shape; `Epoch`/`ValidDuring` possible on client-paid), apply the same full
   validity mirror as the `gasless` method's expiry check (epoch window, chain identifier,
   timestamp-field rejection) — simulation does not enforce expiration on this method
   either (`invalid_transaction_state`).
6. Simulate the transaction to ensure it would still succeed (`invalid_transaction_state`).
7. Apply [Recipient Verification](#recipient-verification-all-methods) to the simulated
   `balanceChanges`.

## Declared Splits (`extra.splits`, OPTIONAL)

Because a Sui programmable transaction natively expresses N transfers in one atomic
transaction, the resource server MAY split a single payment across additional recipients.
It does so with a `splits` array in `PaymentRequirements.extra`. Each entry reuses the
top-level `payTo`/`amount` field names, so a split has the exact same shape as the core
payment; the top-level `payTo` remains the primary receiver, is never duplicated in
`extra`, and implicitly receives the remainder `amount − Σ splits[].amount`:

| Field             | Type     | Required | Description                                                     |
| ----------------- | -------- | -------- | --------------------------------------------------------------- |
| `extra.splits`    | `array`  | Optional | Additional recipients of the asset, beyond the primary `payTo`. |
| `splits[].payTo`  | `string` | Required | Recipient address (an AddressOwner of the asset).               |
| `splits[].amount` | `string` | Required | Atomic-unit amount credited to this recipient, decimal string.  |

Rules:

- `Σ splits[].amount < amount`, strictly, so the primary `payTo` always keeps a non-zero
  share. A requirements object violating this MUST be rejected
  (`invalid_payment_requirements`).
- Each `splits[].payTo` MUST be distinct and MUST NOT equal the top-level `payTo`; each
  `splits[].amount` MUST be > 0.
- When `extra.splits` is **present**, verification anchors on the EXACT payer debit: the
  payer MUST be debited exactly `amount`, the primary `payTo` MUST be credited exactly the
  remainder, each split recipient exactly its declared amount, and there MUST be no
  undeclared recipient of the asset.
- When `extra.splits` is **absent**, verification is UNCHANGED from the single-recipient
  rule: `payTo`'s observed balance change MUST equal `amount`; the default wire shape
  carries no `splits` and behaves identically to the merged spec.
- **Gasless bounds.** Each credited recipient — the primary remainder included — is one
  `send_funds` transfer, and on enforcing networks every transfer MUST individually meet
  the protocol's `0.01` minimum ("transfers below this minimum will not be executed"). A
  payment whose remainder or any split falls below it MUST use the `coin` method. There is
  no dedicated split-count parameter; the effective ceilings on a gasless transaction are
  its serialized-size cap (`get_gasless_max_tx_size_bytes`), its computation cap
  (`gasless_max_computation_units` × the reference gas price), and the generic PTB command
  cap — and, below all of those, the facilitator's `maxSplits`.
- **Facilitator split cap (`extra.maxSplits`).** A facilitator MAY announce `maxSplits`
  (a non-negative decimal integer string; `"0"` means no splits accepted) in its
  `/supported` `extra`, relayed by the resource server like the other fields; when
  announced, a requirements object declaring more than `maxSplits` entries MUST be
  rejected (`invalid_payment_requirements`). It caps routing fan-out and the per-payment
  verification work; a sponsoring facilitator SHOULD announce it, while its hard monetary
  exposure bound remains `maxGasBudget`.

`extra.splits` is chain-native atomic routing: it lets `PaymentRequirements` declare what a
payer could otherwise construct freely in a single PTB, and verification gets STRICTER
(every recipient is matched precisely; no skim to an undeclared address is possible).
Generic use cases: marketplace order routing (split a sale across a vendor and a platform),
affiliate/revenue splits, and tax withholding — each atomic in one transaction.

Example `PaymentRequirements` with one declared split (USDC has 6 decimals, so both legs
meet the `0.01` = `10000`-unit gasless minimum; the primary `payTo` implicitly keeps the
`40000` remainder of the `50000` total):

```json
{
  "scheme": "exact",
  "network": "sui:mainnet",
  "amount": "50000",
  "asset": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "payTo": "0x6fa6e5271e1d5eb02721930843a275aa1f9f4d6ba0dff88c5f8dcd367d9edceb",
  "maxTimeoutSeconds": 60,
  "extra": {
    "splits": [
      { "payTo": "0x369cf71b2f13b63c165c207bc3f263b1df9da754ca6a2d09300d9b4bf45f62f0", "amount": "10000" }
    ]
  }
}
```

The matching gasless transaction is a single PTB with one `0x2::balance::send_funds<USDC>`
command per credited recipient (the primary plus each split).

## Recipient Verification (all methods)

Verify the recipients of the simulation against the agreed requirements, reading the
asset's `balanceChanges`:

- If `extra.splits` is present: the primary `payTo` MUST be credited EXACTLY
  `amount − Σ splits[].amount`; each split recipient MUST be credited EXACTLY its declared
  amount; the payer MUST be debited EXACTLY `amount`; and there MUST be no undeclared
  recipient of the asset. Only AddressOwner credits count; ObjectOwner/Shared credits MUST
  be rejected. A mismatch MUST be rejected (`invalid_exact_sui_payload_splits_mismatch`).
- If `extra.splits` is absent: the resource server's address (`payTo`) MUST see a balance
  change equal to `amount` in the agreed `asset`
  (`invalid_exact_sui_payload_recipient_mismatch`). Facilitators SHOULD additionally
  assert the exact payer debit and the absence of undeclared same-asset recipients in this
  case as well — the merged spec did not require it, so it stays a SHOULD for
  compatibility.

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

Re-broadcast is **idempotent**: the chain commits a given signed transaction at most once.
The facilitator MUST treat a re-settle of an already-committed transaction as a success
returning the original digest, not as a new payment. It does so by checking executed-first:
compute the digest from the signed bytes, look it up on-chain, and if it is already
committed return that digest WITHOUT re-broadcasting (re-broadcasting an executed gasless
transaction can error on some RPC transports). The executed-first branch MUST NOT bless a
digest on existence alone: before returning success, the facilitator MUST validate the
committed transaction against THESE requirements — signature and payer recovery, and
Recipient Verification applied to the committed effects' balance changes. Raw bytes and
signatures of every committed transaction are public, so an unbound executed-first branch
would let a historical transfer be replayed as payment for unrelated requirements. This
executed-first check also means a re-settle does NOT re-run the replay guard against
itself.

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
  `gasless` method and the sponsored `coin` shape alike — additionally bounds how long a
  signed-but-unbroadcast transaction remains executable. Expiry is asserted by
  verification's explicit decoded-window check, NOT by simulation, which does not enforce
  expiration (see the expiry-check verification step). A facilitator MAY additionally support the
  [`payment-identifier`](../../extensions/payment_identifier.md) extension for
  application-level verify/settle deduplication; this scheme does not require it for safety.
- **Authorization scope.** The payer signs the complete transaction, so the facilitator cannot
  redirect funds. On the `gasless` method the allowlisted-operation set plus the
  no-object-writes bound mean the only possible effect is a value movement of the allowlisted
  asset among Address Balances. When `extra.splits` is declared, the exact payer-debit and
  per-recipient checks make the signature authorize EXACTLY the declared recipients and
  amounts and nothing else; in the single-recipient default, verification asserts the
  `payTo` credit, and facilitators SHOULD additionally assert the exact payer debit and
  the absence of undeclared same-asset recipients there too (see Recipient Verification).
  `extra.splits` does not widen authorization: it can only ever be matched by a
  transaction whose total payer debit equals `amount`, so the payer's trust model is
  unchanged from the single-recipient case.
- **Settlement atomicity.** The primary payment and all declared splits settle in a single
  transaction; a Sui PTB is all-or-nothing, so a partial split (one recipient credited but
  not another) is impossible.
- **Independently recomputable settlement.** Verification is effects-based: the digest is
  recomputed from the signed bytes and the per-recipient `balanceChanges` are checked
  against the requirements (primary remainder plus declared splits). On the `gasless`
  method there are no gas side-effects to net out of the balance-change set, so any third
  party can recompute a settled payment's exact outcome from public chain data alone —
  digest, per-recipient credits, payer debit — with no trust in the facilitator's report.
  Receipt or attestation extensions can bind to this recomputable result without
  additional on-chain state.
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

- For allowlisted stablecoin payments with every credited leg at or above the per-transfer
  protocol minimum, use the **`gasless`** method: no gas token, no sponsor, no coin-object
  storage cost. Single-recipient by default; declared `extra.splits` for atomic
  multi-recipient routing.
- For non-allowlisted assets, or payments where any credited leg falls below an enforcing
  network's per-transfer gasless minimum, use the **`coin`** method: the client pays gas,
  or — when the facilitator announces a `feePayer` — uses non-interactive Address Balance
  gas sponsorship.
