# Scheme: `upto` on `Stellar`

## Versions supported

- ❌ `v1` - not supported.
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:
- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The x402 `upto` scheme on Stellar enables usage-based payments: the Client (Buyer) authorizes a **maximum amount**, and the Facilitator settles for the **actual amount** metered by the Resource Server at the end of the request. It is the Stellar realization of the generic [`upto`](./scheme_upto.md) scheme — see that document for the network-agnostic core properties this spec MUST satisfy.

Like [`exact` on Stellar](../exact/scheme_exact_stellar.md), this scheme uses [SEP-41][SEP-41]-compliant Soroban tokens, the Client signs authorization entries (not the full transaction), and the Facilitator sponsors transaction fees. It differs in **what** the Client signs: instead of a fixed `transfer(from, to, amount)`, the Client authorizes a call to a **settlement Kernel** contract that caps the transfer at the signed maximum while letting the Facilitator supply the lower actual amount at settlement time.

> [!NOTE]
> **Scope:** This spec covers [SEP-41]-compliant Soroban tokens **only**. Classic Stellar assets are not supported.

> [!NOTE]
> **Status.** The Kernel is a canonical, per-network deployment, pinned by contract id and WASM hash. Its ABI and addresses are still provisional, pending a standardized, versioned x402 release and independent review; a code change yields a new address and a new pinned constant. Implementations MUST pin the exact Kernel contract id per network (see [The Settlement Kernel](#the-settlement-kernel)) and MUST NOT adopt a Kernel address advertised by a Facilitator without verifying it against their own pinned value. Integrity SHOULD be established by a reproducible build reproducing the pinned WASM hash and an on-chain `stellar contract fetch … | sha256sum` check.

## How the core `upto` properties map to Stellar

The generic scheme's [Core Properties (MUST)](./scheme_upto.md#core-properties-must) are enforced on Stellar as follows:

| Core property | Stellar enforcement |
| ------------- | ------------------- |
| **Single-use authorization** | Each authorization is a Soroban authorization entry carrying a nonce; once the settlement transaction is included, the nonce is consumed and the entry cannot be replayed. |
| **Time-bound authorization** | The Kernel `terms` carry `valid_after_ledger` and `deadline_ledger`, and the Buyer's authorization entry expires at `deadline_ledger`. The Kernel enforces both **on-chain** against the live ledger sequence (`NotYetValid` / `Expired`); the Facilitator additionally checks them at `/verify`. |
| **Recipient binding** | The recipient (`pay_to`) is part of the Kernel `terms` the Buyer signs; on-chain the Kernel moves funds only to `terms.pay_to` (`transfer_from(kernel, payer, pay_to, actual_amount)`), and the Buyer's SEP-41 `approve` names the Kernel as the only spender. Neither the Facilitator nor the Resource Server can redirect funds. |
| **Maximum amount enforcement** | The Buyer signs `terms.max_amount`; the Kernel enforces `0 < actual_amount <= max_amount` **on-chain** (`InvalidActualAmount` / `ExceedsMaximum`), and the Facilitator independently rejects `requirements.amount > max_amount`. A zero charge is settled off-chain with no transaction (see [Zero settlement](#zero-settlement)). |
| **Phase-dependent `amount`** | `requirements.amount` is the authorized maximum at `/verify` and the actual amount to settle at `/settle`. See [Settle-Time Verification](#settle-time-verification). |

## The Settlement Kernel

The `upto` scheme is mediated by a stateless **Kernel** contract. The Kernel is a neutral, trustless primitive — no owner, upgrade authority, pause, withdrawal, or stored state. On-chain it transfers at most the Buyer's signed `max_amount`, only to the signed `pay_to`, and only when **both** the Buyer and the named Facilitator have authorized the call. No party — not the Facilitator, not the Resource Server, not an SDK — can redirect funds or exceed the signed terms.

### Pinned Kernel addresses (provisional)

| Network | Kernel contract id |
| ------- | ------------------ |
| `stellar:testnet` | `CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3` |
| `stellar:pubnet` | `CCV4RALFBEE2QLKPK6H5ZX24CYMKIFN3723J5J4TMDEFWAFLELGYODNI` |

A redeploy to a new contract id is a breaking change: Clients pin these addresses and refuse any other, so a new Kernel requires a new SDK release.

### Kernel ABI

The Kernel exposes a single method:

```
settle(terms: SettlementTerms, actual_amount: i128)
```

where `SettlementTerms` is a `#[contracttype]` struct, encoded on the wire as a Soroban map with
symbol keys:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `payer` | `address` | The Buyer; the account whose funds are debited. May be a G-account or a C-account. |
| `asset` | `address` | The SEP-41 token contract. |
| `pay_to` | `address` | The recipient of the transfer. |
| `facilitator` | `address` | The Facilitator authorization address that must co-sign the call. The Kernel accepts any address; the scheme requires a G-account because the Client also uses it as the simulation source. |
| `max_amount` | `i128` | The maximum the Buyer authorizes. |
| `valid_after_ledger` | `u32` | The Kernel call is not valid before this ledger. |
| `deadline_ledger` | `u32` | The Kernel call is not valid after this ledger. |

**`actual_amount` is excluded from the Buyer's authorization.** The Kernel's `require_auth_for_args` commits the Buyer's signature to `terms` only, not to `actual_amount`. This is the mechanism that makes `upto` work: the Buyer signs once at `max_amount`, and the Facilitator substitutes the lower actual amount into the second positional argument at settlement without invalidating the Buyer's signature. The Kernel still enforces `actual_amount <= terms.max_amount` on-chain.

The Buyer's authorization tree for a Kernel call is:

```
kernel.settle(terms)                         // root invocation (actual_amount excluded)
└── asset.approve(payer, kernel, max_amount, deadline_ledger)   // SEP-41 allowance to the Kernel only
```

### Replay protection (stateless)

This scheme is **stateless**: single-use is enforced by the nonce in the Buyer's Soroban authorization entry, which the host consumes when the settlement transaction is included (a replay fails with `Error(Auth, ExistingValue)`). The Kernel stores no nonce state of its own. A Facilitator additionally keeps its own durable record of settled authorizations so a duplicate `/settle` — most importantly a zero-amount one that never reaches the chain — is answered from the record rather than re-settled.

### Residual allowance (no auto-revoke)

The Buyer's `approve` grants the Kernel an allowance of `max_amount` expiring at `deadline_ledger`, and the Kernel draws the `actual_amount` from it. The `approve` runs inside `settle` and overwrites any existing payer→Kernel allowance, so a pre-existing or stale approval cannot be reused to settle without this nested Buyer authorization. The scheme does **not** auto-revoke the residual allowance (`max_amount − actual_amount`) after a partial settlement; it simply expires at `deadline_ledger`. Because the Kernel moves funds only with both the Buyer's and the named Facilitator's authorization, a residual allowance to the Kernel cannot be drawn by any other party.

## Protocol Flow

The flow is Client-driven with Facilitator-sponsored execution, mirroring `exact` on Stellar:

1. **Client** requests a resource from the **Resource Server**.
2. **Resource Server** responds `402 Payment Required` with `PaymentRequirements` whose `extra` carries the Kernel contract id (`settlementContract`), the Facilitator authorization address (`facilitator`), and `areFeesSponsored`.
3. **Client** pins the advertised `settlementContract` against its own trusted Kernel for the network and **refuses** any mismatch.
4. **Client** assembles the Kernel call `settle(terms)` with `terms.max_amount = requirements.amount` and a ledger window derived from `maxTimeoutSeconds`, using the advertised `facilitator` address as the **simulation source account** (the Buyer must not be the source — see [Authorization patterns](#authorization-patterns)).
5. **Client** simulates the call, confirms the authorization tree matches the approved terms, and signs **only** the Buyer's authorization entry (setting its expiration to `deadline_ledger`). It does not build, sign, or broadcast a transaction.
6. **Client** serializes that single signed `SorobanAuthorizationEntry` as XDR (base64) and re-sends the request with the `PaymentPayload` carrying it as `payload.authorization`.
7. **Resource Server** forwards `PaymentPayload` and `PaymentRequirements` to the **Facilitator**'s `/verify` endpoint, with `requirements.amount` set to the authorized maximum.
8. **Facilitator** validates the authorization entry (see [Facilitator Verification Rules](#facilitator-verification-rules-must)).
9. **Facilitator** returns a `VerifyResponse`.
10. After the request is served and the actual usage is metered, the **Resource Server** calls the Facilitator's `/settle` endpoint with `requirements.amount` set to the **actual** amount (`<= max_amount`).
    - NOTE: `/settle` MUST perform full verification independently and MUST NOT assume prior verification.
11. **Facilitator** builds the Kernel call `settle(terms, actual_amount)` with `actual_amount = requirements.amount`, attaches the Buyer's authorization entry unchanged, generates and signs its own Facilitator authorization entry, assembles the transaction on a channel account it controls as the source, and fee-bumps it so the Facilitator pays network fees.
12. **Facilitator** submits via RPC `sendTransaction`, polls for confirmation, and returns a `SettlementResponse`.
13. **Resource Server** grants access to the resource on successful settlement.

## `PaymentRequirements` for `upto`

In addition to the standard x402 `PaymentRequirements` fields, the `upto` scheme on Stellar carries the following inside `extra`:

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "amount": "10000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 60,
  "extra": {
    "settlementContract": "CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3",
    "facilitator": "GARASMITH...FACILITATORAUTHADDRESS",
    "areFeesSponsored": true
  }
}
```

**Field Definitions (`extra`):**

- `settlementContract`: The Kernel contract id. MUST be a valid Soroban contract address and MUST equal the Client's pinned Kernel for the network.
- `facilitator`: The Facilitator authorization address that co-signs the Kernel call and is bound into the signed `terms`, so no other party can settle the authorization. MUST be a valid Ed25519 G-account; the Client also uses it as the source account when simulating the call (the Buyer must not be the source — see [Authorization patterns](#authorization-patterns)).
- `areFeesSponsored`: Whether the Facilitator sponsors fees. Currently always `true`; the `upto` scheme requires sponsored fees.

> **Note:** `amount` is phase-dependent. At `/verify` it is the authorized **maximum**; at `/settle` it is the **actual amount to settle**, which MUST be `<= max_amount`. See [§ PaymentRequirements Schema](#paymentrequirements-schema).

## PaymentPayload `payload` Field

```json
{
  "authorization": "AAAAAQAAAAAAAAAAbriIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO..."
}
```

The `authorization` field is the base64-encoded XDR of **one** signed `SorobanAuthorizationEntry` — the Buyer's consent to the Kernel call. The Client never signs or broadcasts a transaction, and pays no fee; the Facilitator assembles the settlement transaction itself (see [Settlement Logic](#settlement-logic)). The entry:

- uses an **address-based credential** (legacy `sorobanCredentialsAddress` or V2 `sorobanCredentialsAddressV2` ([CAP-71][CAP-71])) whose address is the Buyer (`terms.payer`), with a random nonce and `signatureExpirationLedger = terms.deadline_ledger`;
- has a `rootInvocation` of `settle(terms)` on the Kernel — carrying **only** the `terms` struct, not `actual_amount` (which is excluded from the Buyer's authorization; see [Kernel ABI](#kernel-abi));
- has exactly **one** sub-invocation: `approve(payer, Kernel, max_amount, deadline_ledger)` on `terms.asset`, and no deeper sub-invocations.

**Full `PaymentPayload` object:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "stellar:testnet",
    "amount": "10000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    "maxTimeoutSeconds": 60,
    "extra": {
      "settlementContract": "CBB7WCIQOBOJ4G7JUPVOA3RI553HBSYQ3GLBJ25X7W7S7MRJIGVCXRE3",
      "facilitator": "GARASMITH...FACILITATORAUTHADDRESS",
      "areFeesSponsored": true
    }
  },
  "payload": {
    "authorization": "AAAAAQAAAAAAAAAAbriIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO..."
  }
}
```

## Facilitator Verification Rules (MUST)

A Facilitator verifying an `upto` payment on Stellar MUST enforce all of the following before sponsoring and signing a settlement. The same rules run at both `/verify` and `/settle`, differing only in the amount check (noted below). Every rejection carries the Buyer address (`terms.payer`) once it is known.

### 1. Protocol validation

- `x402Version` MUST be `2`.
- Both `payload.accepted.scheme` and `requirements.scheme` MUST be `"upto"`.
- `payload.accepted` and `requirements` MUST agree on `network`, `asset`, `payTo`, `maxTimeoutSeconds`, and `extra.settlementContract`/`extra.facilitator` (the settlement terms, apart from `amount`).
- `network` MUST be a supported Stellar network.
- `accepted.amount` MUST be a positive integer; `requirements.amount` MUST be a non-negative integer.

### 2. Authorization entry structure

- `payload.authorization` MUST decode as exactly **one** canonical `SorobanAuthorizationEntry` (implementations SHOULD bound its size).
- Its `rootInvocation` MUST call `"settle"` on `extra.settlementContract` (the Kernel) with exactly **1 argument**: the `terms` struct. The Buyer's authorization MUST NOT bind `actual_amount`.
- The `terms` struct MUST parse into all fields listed in [Kernel ABI](#kernel-abi).
- The root MUST have exactly **one** sub-invocation — `"approve"` on `terms.asset` with arguments `(terms.payer, Kernel, terms.max_amount, terms.deadline_ledger)` — and no deeper sub-invocations.

### 3. 🚨 Facilitator safety

- `terms.facilitator` MUST equal the Facilitator's authorization address, and `terms.payer` MUST NOT be the Facilitator's authorization address or any Facilitator-controlled account: a Facilitator must never be tricked into paying itself. The settlement is assembled by the Facilitator on its own channel account, so the Buyer's entry cannot carry an envelope, source account, or precondition that steers the transaction.
- The Facilitator MUST reconstruct the **expected** authorization tree from `requirements` and the entry's own fields — root `settle(terms)` on the Kernel with the single `approve(payer, Kernel, max_amount, deadline_ledger)` sub-invocation of [Rule 2](#2-authorization-entry-structure) — and MUST compare it to the entry's `rootInvocation` byte-for-byte, rejecting any mismatch.
- The entry's credential MUST be address-based — `sorobanCredentialsAddress` (legacy) or `sorobanCredentialsAddressV2` ([CAP-71][CAP-71]). Both carry the same `SorobanAddressCredentials` fields and differ only in the signed preimage (`ENVELOPE_TYPE_SOROBAN_AUTHORIZATION` vs. the address-bound `..._WITH_ADDRESS`). Delegated (`sorobanCredentialsAddressWithDelegates`) and source-account (`sorobanCredentialsSourceAccount`) credentials MUST be rejected.

### 4. Kernel terms match the accepted payment

The `terms` the Buyer signed MUST match what the Resource Server advertised:

- `terms.asset == accepted.asset`
- `terms.pay_to == accepted.payTo`
- `terms.facilitator == extra.facilitator == the Facilitator's authorization address`
- `extra.settlementContract == the Kernel contract`
- `terms.max_amount == BigInt(accepted.amount)`

### 5. Amount rules (phase-dependent)

- `requirements.amount` MUST be `<= terms.max_amount`.
- At **`/verify`**, `requirements.amount` MUST additionally **equal** `terms.max_amount` (the request advertises the ceiling).
- The Buyer's authorization does not bind `actual_amount` at all (Rule 2): the entry authorizes `settle(terms)`, and the Facilitator supplies `actual_amount` as the unsigned second positional argument at settlement. The Kernel enforces `actual_amount <= terms.max_amount` on-chain.

### 6. Ledger window

- Read the latest ledger. Compute the latest acceptable expiration as `latestLedger + ceil(maxTimeoutSeconds / estimatedLedgerCloseSeconds)` plus a small tolerance (2 ledgers). Use the network's current close-time estimate when available (fallback `5` seconds).
- `terms.valid_after_ledger <= terms.deadline_ledger`.
- `terms.valid_after_ledger <= currentLedger <= terms.deadline_ledger`.
- `terms.deadline_ledger <= latestAcceptableExpiration`.

### 7. Simulation and fee ceiling

- Build the Kernel `settle(terms, max_amount)` call carrying the Buyer's entry and simulate it against the current ledger state; the simulation MUST succeed.
- The simulated `minResourceFee` MUST NOT exceed the Facilitator's `maxResourceFeeStroops` safety ceiling. If it does, reject with `invalid_upto_stellar_payload_fee_exceeds_maximum`.

### 8. Buyer authorization entry

- The payload carries exactly **one** authorization entry, the Buyer's; its address credential MUST resolve to `terms.payer`.
- Its `signatureExpirationLedger` MUST equal `terms.deadline_ledger` and MUST be `>= currentLedger` and `<= latestAcceptableExpiration`.
- The Facilitator's own co-authorization is **not** part of the payload: the Facilitator generates and signs its own entry at settlement, expiring no later than `terms.deadline_ledger`.

## Transaction Fees

In the sponsored flow (`areFeesSponsored: true`), the Facilitator fully controls settlement fees and MUST NOT use any fee bid carried by the Client's transaction.

### Facilitator (MUST)

- Rebuild the settlement on a Facilitator-controlled channel account as the transaction source, so the channel spends the [sequence number][sequence number].
- Derive Soroban resource data (footprint and `resourceFee` cap) from a fresh settle-time simulation of the actual-amount call.
- Fee-bump the rebuilt transaction with a Facilitator fee-payer key so network fees are sponsored.

### Safety ceiling: `maxResourceFeeStroops`

Facilitator implementations expose a `maxResourceFeeStroops` configuration as a circuit breaker. If the simulation-derived resource fee — at `/verify` or during the settle-time re-simulation — exceeds this ceiling, the Facilitator MUST reject with `invalid_upto_stellar_payload_fee_exceeds_maximum`.

Operators SHOULD size the ceiling for the payers and tokens they serve, not for the common case: a plain SEP-41/SAC transfer from a G-account settles well under 100,000 stroops, but a first payment through a contract token, or a contract-account (C-account) payer whose `__check_auth` runs spending-limit or payee-restriction policies, can declare a resource fee an order of magnitude higher. A ceiling tuned only to G-account SAC transfers will reject smart-account payers.

## Settlement Logic

### Phase 1: Transaction assembly

1. Read `terms` from the Buyer's authorization entry (`payload.authorization`).
2. Build the Kernel call `settle(terms, actual_amount)` with `actual_amount = requirements.amount` (the actual metered amount). The Buyer's entry authorizes `settle(terms)` only, so its signature stays valid regardless of `actual_amount`.
3. Let Soroban build the full authorization tree for the call, then **replace** the regenerated Buyer entry with the Client's **original** signed entry (preserving its nonce) and **sign** the Facilitator's own generated entry with the Facilitator authorization key, expiring at `terms.deadline_ledger`.
4. Re-simulate the authorized call; enforce the `maxResourceFeeStroops` ceiling; refresh the Soroban resource data from this simulation.
5. Assemble the final transaction with:
   - **Source account**: a Facilitator-controlled channel account (spends sequence, bears fees).
   - **Operation**: the Kernel `invokeHostFunction`, carrying the Buyer and Facilitator authorization entries.
   - **Soroban data**: refreshed from the settle-time simulation.
   - Fee-bumped by a Facilitator fee-payer key.

### Phase 2: Submission

1. Submit the fully-signed, fee-bumped transaction via RPC `sendTransaction`.
2. Confirm the status is `PENDING`, then poll for `SUCCESS` or `FAILED`.

### Phase 3: `SettlementResponse`

```json
{
  "success": true,
  "transaction": "a1b2c3d4e5f6...",
  "network": "stellar:testnet",
  "payer": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "amount": "1858"
}
```

- `transaction`: the transaction hash (64-character hex), or the empty string for a zero settlement.
- `payer`: the Buyer (`terms.payer`), not the Facilitator.
- `amount`: the actual amount settled, in atomic token units (may be `"0"`).

If the transaction broadcasts but its confirmation cannot be established (RPC error or timeout while polling), the Facilitator returns `settlement_pending` with the broadcast hash in `transaction`, so the caller can reconcile on-chain before retrying.

More generally, a settlement that may have landed on-chain MUST NOT be reported as a terminal failure. If the transaction was broadcast — or even confirmed — but the Facilitator cannot finalize its own record (a storage or bookkeeping failure), it returns the **non-terminal** `settlement_pending` carrying the hash, never a hard error (and never an HTTP 5xx), so the caller reconciles on-chain rather than retiring the payment as failed or blindly re-settling it.

### Off-chain amount source

The Kernel moves funds through the SEP-41 token as a sub-invocation, so off-chain observers — indexers, explorers, usage metering — MUST read the settled amount from the **token's own `transfer` event**, not from the envelope call arguments (which are Facilitator-supplied) and not from the signed `max_amount` (which is the ceiling, not the charge). The `amount` in the `SettlementResponse` is the Facilitator's report of the same value and MUST equal it.

### Zero settlement

If `requirements.amount == 0`, the authorization is consumed with **no on-chain transaction**: the Facilitator returns `success: true`, `transaction: ""`, `amount: "0"`. The authorization is treated as settled and cannot be reused.

### Settle-Time Verification

Because `upto` uses phase-dependent `amount` semantics, the `/settle` request carries `requirements.amount` set to the **actual** amount, which may be less than the Buyer's signed `max_amount`. The Facilitator MUST:

1. **Re-verify against `terms.max_amount`, not `requirements.amount`.** The Buyer's signature commits to `terms` (which carries `max_amount`); `actual_amount` is not part of the Buyer's authorization at all (the entry authorizes `settle(terms)` only). Verification rule §5 therefore validates only that the settle-time `requirements.amount` does not exceed `max_amount`. Comparing the signed authorization against the metered amount would reject every partial settlement.
2. **Validate `requirements.amount <= terms.max_amount`.**
3. **Substitute `requirements.amount` into `actual_amount`** and settle for that amount. The Kernel independently enforces the `<= max_amount` bound on-chain.

> **Conformance note:** A Facilitator that required `requirements.amount === terms.max_amount` at `/settle` would reject all partial settlements, breaking the core `upto` value proposition. The equality check applies only at `/verify`.

## PaymentRequirements Schema

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `scheme` | `string` | Required | Must be `"upto"`. |
| `network` | `string` | Required | CAIP-2 Stellar network (`stellar:pubnet` or `stellar:testnet`). |
| `amount` | `string` | Required | Phase-dependent: authorized maximum at `/verify`, actual amount at `/settle`. Atomic token units. |
| `asset` | `string` | Required | SEP-41 Soroban token contract id. |
| `payTo` | `string` | Required | Recipient address. |
| `maxTimeoutSeconds` | `number` | Required | Bounds the authorization's ledger validity window. An integer in `1`–`300`. |
| `extra.settlementContract` | `string` | Required | The Kernel contract id. |
| `extra.facilitator` | `string` | Required | The Facilitator authorization G-account. |
| `extra.areFeesSponsored` | `boolean` | Required | Always `true` for `upto`. |

## SettlementResponse Schema Extension

The `upto` scheme extends the base [`SettlementResponse`](../../x402-specification-v2.md#53-settlementresponse-schema) with the actual settled amount:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `success` | `boolean` | Required | Whether settlement succeeded. |
| `errorReason` | `string` | Optional | Error reason code when settlement failed. |
| `errorMessage` | `string` | Optional | Human-readable detail for `errorReason` (for logs/operators; clients match on `errorReason`, never on this text). |
| `payer` | `string` | Optional | The Buyer's address. |
| `transaction` | `string` | Required | Transaction hash; empty string for a zero settlement. |
| `network` | `string` | Required | CAIP-2 network identifier. |
| `amount` | `string` | Optional | Actual amount settled in atomic token units; present on a successful settlement (including `"0"` for a zero charge), omitted on failure. |

## Error Codes

The generic x402 error codes defined in the [x402 specification](../../x402-specification-v2.md#9-error-handling) apply. In addition, the Stellar `upto` scheme defines the following **local extension** error reasons. Implementations and reviewers MUST treat these as scheme-specific, not as standard x402 errors.

### Verification

| Error reason | Meaning |
| ------------ | ------- |
| `invalid_upto_stellar_payload_terms` | Settlement terms do not match the accepted payment, or the Kernel `terms` do not match. |
| `invalid_upto_stellar_payload_amount` | `amount` is malformed, exceeds `max_amount`, or (at `/verify`) is not equal to `max_amount`. |
| `invalid_upto_stellar_payload_malformed` | `payload.authorization` is missing or not a decodable `SorobanAuthorizationEntry`. |
| `invalid_upto_stellar_payload_wrong_kernel` | The entry's `rootInvocation` is not a `settle` call on the pinned Kernel contract. |
| `invalid_upto_stellar_payload_unsafe_source` | The entry fails Facilitator safety: the reconstructed tree does not match byte-for-byte, or `terms.payer` is the Facilitator. |
| `invalid_upto_stellar_payload_arguments` | The entry's invocation or `terms` do not parse into the expected shape. |
| `invalid_upto_stellar_payload_unsupported_credential_type` | The entry uses a delegated, source-account, or otherwise unsupported credential type. |
| `invalid_upto_stellar_payload_auth` | The Buyer authorization entry is missing, duplicated, or authorizes an unexpected address. |
| `invalid_upto_stellar_payload_expired` | The authorization entry has already expired. |
| `invalid_upto_stellar_payload_expiration` | The entry's expiration is outside the allowed window or does not match `deadline_ledger`. |
| `invalid_upto_stellar_payload_simulation_failed` | Simulation of the Kernel call failed, and no more specific reason could be decoded. |
| `invalid_upto_stellar_payload_fee_exceeds_maximum` | The simulated resource fee exceeds `maxResourceFeeStroops`. |
| `unexpected_verify_error` | An unexpected failure during verification. |

When a simulation fails, a Facilitator SHOULD decode the token/Kernel error and surface a more
specific reason instead of the catch-all `invalid_upto_stellar_payload_simulation_failed`. In
particular it SHOULD return the generic x402 `insufficient_funds` when the Buyer's balance is too low,
so a caller can distinguish "top up and retry" from a malformed payment. Token-specific conditions
(trustline not authorized, recipient/payer trustline missing, nonce already used, account missing or
archived) SHOULD likewise be surfaced as distinct reasons where the simulation identifies them.

### Settlement

| Error reason | Meaning | Kind |
| ------------ | ------- | ---- |
| `settle_upto_channel_unavailable` | No channel could be leased from the pool; nothing was broadcast. | retryable |
| `settle_upto_signing_failed` | A required signer refused or failed to sign; nothing was broadcast. | terminal |
| `settle_upto_transaction_build_failed` | The actual-amount settlement transaction could not be built. | terminal |
| `settle_upto_transaction_failed` | The settlement transaction was included but failed on-chain. | terminal |
| `settlement_pending` | The transaction broadcast (or confirmed) but the Facilitator could not finalize the outcome; `transaction` carries the hash for reconciliation. | **non-terminal** |
| `unexpected_settle_error` | An unexpected failure before broadcast, with no usable broadcast hash. | terminal |

`settlement_pending` is the only **non-terminal** reason — the payment may still be on-chain, so the
caller reconciles against the carried hash and MAY retry once rather than treating it as failed.
`settle_upto_channel_unavailable` is **retryable**: nothing was broadcast, so a retry cannot
double-pay. The rest are **terminal**. A Facilitator MUST NOT surface an internal error as an HTTP
5xx once a transaction has been broadcast: it maps such a case to `settlement_pending` with the hash
(see [Phase 3](#phase-3-settlementresponse)).

## Security Considerations

1. **Trustless Kernel as the sole trust anchor.** The Kernel cannot redirect funds or exceed the signed terms, and this is its central security property. Pinning it per network makes it the sole on-chain trust anchor for every `upto` Buyer, so its integrity rests on the reproducible-build attestation and independent review described for [The Settlement Kernel](#the-settlement-kernel), not on trusting any Facilitator; a vulnerability in the pinned contract affects every Buyer that signed for it.
2. **Maximum amount authorization.** Clients bear the risk of the full `max_amount` being charged. A dishonest Resource Server can meter up to `max_amount` regardless of actual usage; clients should authorize conservatively.
3. **Facilitator substitution is bounded.** The Facilitator can only lower `actual_amount`; the Kernel rejects any value above `max_amount`, and the Buyer's `pay_to` and `asset` are fixed in the signed `terms`.
4. **Single-use.** The Buyer authorization entry's nonce is consumed on inclusion, preventing replay.
5. **Time bounds.** `valid_after_ledger`/`deadline_ledger` and the entry expiration bound the authorization's lifetime; the Kernel enforces them **on-chain** against the live ledger sequence (`NotYetValid` / `Expired`), and the Facilitator also checks them at `/verify`.
6. **Zero settlement.** A `0` settlement consumes the authorization without an on-chain transaction, avoiding fees and ledger bloat for unused authorizations.

## Appendix

### Authorization patterns

As with `exact` on Stellar, the Client signs **authorization entries**, not the full transaction. This authorizes only the Kernel invocation (and its nested SEP-41 `approve`), spends no [sequence number][sequence number] from the Client, requires fee sponsorship, and supports both **C-accounts** and **G-accounts** for the Buyer. The Facilitator's authorization address must be a **G-account** because the Client uses it as the source account when simulating the call to produce the entry (a Client using its own address as the source would record source-account credentials and have nothing to sign).

The payload carries a **single** Buyer authorization entry. A contract-account (C-account) Buyer is therefore supported when its `__check_auth` is satisfied by that one entry; a smart account that requires additional **delegated signer** authorizations is a known limitation — the payload does not yet carry those entries. This is the natural extension point for the entry-based payload (see the delegated-signer carriage in the EVM and other Stellar `upto` proposals).

### CAP-71 V2 credentials

Protocol 28 activates the [CAP-71][CAP-71] V2 authorization arm on the network, so Clients may submit V2-signed (`sorobanCredentialsAddressV2`) entries. Recording-mode simulation still returns the legacy arm as of Protocol 28, so Facilitators MUST accept **both** the legacy and V2 arms — they share the `SorobanAddressCredentials` shape and differ only in the signed preimage.

[SEP-41]: https://stellar.org/protocol/sep-41
[CAP-71]: https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md
[sequence number]: https://developers.stellar.org/docs/learn/glossary#sequence-number
