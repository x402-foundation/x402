# Stellar `upto` Scheme: Vellar Implementation Specification

> **What this document is.** A normative specification for the x402 `upto`
> payment scheme on Stellar, derived from the deployed `upto-vellar` contract
> (`CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN`, MIT,
> [Vellar-Wallet/vellar-facilitator](https://github.com/Vellar-Wallet/vellar-facilitator)).
> It picks winners on all five open questions named in
> [`scheme_upto_stellar_interop.md`](./scheme_upto_stellar_interop.md). Where
> this spec's approach differs from alternatives, the reasoning is stated. The
> TSC may adopt, amend, or supersede any of these decisions.
>
> **Relationship to other proposals.**
> [#3134](https://github.com/x402-foundation/x402/pull/3134) (stateless
> `UptoSettlement`) and
> [#3098](https://github.com/x402-foundation/x402/pull/3098) (stateful, Periplo)
> are both open. This spec takes positions where they diverge.
> [`scheme_upto_stellar_interop.md`](./scheme_upto_stellar_interop.md) documents
> where all three agree.

## 1. Overview

The `upto` scheme lets a buyer authorize a spending ceiling with one signature.
The facilitator settles the actual metered amount. The contract enforces
`actual <= ceiling` on-ledger before moving any funds.

The buyer signs the ceiling, not the charge. This is the core property that
distinguishes `upto` from `exact`.

## 2. Contract interface

The deployed reference contract is:

| Field | Value |
|---|---|
| Contract ID (testnet) | `CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN` |
| Wasm sha256 | `92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8` |
| License | MIT |
| Source | `contracts/upto-vellar/` in `Vellar-Wallet/vellar-facilitator` |
| Toolchain | rustc 1.96.0, stellar-cli 26.1.0, `wasm32v1-none` |

Entry points: `settle` (7 arguments), `is_used` (read-only).

### 2.1 `settle` arguments

Exact order, no hook argument:

```
settle(
  token: Address,
  from: Address,
  to: Address,
  max_amount: i128,
  expiration_ledger: u32,
  nonce: BytesN<32>,
  actual_amount: i128,
)
```

A conforming implementation MUST NOT include a hook argument. An argument that
is parsed but never honoured is a surface callers can reason wrongly about.

A conforming facilitator MUST reject any payload whose argument count is not
exactly 7.

### 2.2 `is_used`

```
is_used(
  from: Address,
  nonce: BytesN<32>,
) -> bool
```

Read-only. No auth required. Returns `true` if the nonce has been consumed.
Returns `false` for expired nonces, because the expiry check in §4 refuses those
settlements regardless.

## 3. Authorization model

The buyer's Soroban auth entry MUST authorize the `settle` invocation over
exactly these fields:

```
(token, from, to, max_amount, expiration_ledger, nonce)
```

The auth entry MUST NOT cover `actual_amount`. The facilitator supplies
`actual_amount` at settlement time. The contract's only guarantees about it are
that it does not exceed `max_amount` and is not negative.

A client MUST use `require_auth_for_args` bound to these six fields. A bare
`require_auth` leaves the entry unbound to any argument values and MUST NOT be
used.

## 4. On-ledger enforcement

The contract MUST enforce these checks in order before any state change or
transfer:

1. `actual_amount >= 0`
2. `actual_amount <= max_amount`
3. current ledger `<= expiration_ledger`
4. `(from, nonce)` not already consumed

If any check fails, the invocation MUST panic with a descriptive error. No funds
MUST move on any failure.

### 4.1 Why `actual_amount >= 0` is explicit

[SEP-41] implementations are not uniformly required to reject negative transfer
amounts. A negative value would invert the ceiling comparison in step 2 and pass
while moving value the wrong way. The explicit check closes this.

## 5. Transfer mechanism

A conforming implementation MUST use `approve` and `transfer_from`, not a direct
`transfer`.

```
# Step 1: buyer signs this
approve(from, contract, max_amount, expiration_ledger)

# Step 2: contract executes as spender
transfer_from(contract, from, to, actual_amount)
```

### 5.1 Why not direct transfer

A direct `transfer(from, to, actual_amount)` fails when `actual != ceiling`. The
buyer's Soroban auth entry commits to exact argument values at simulation time.
A transfer signed for the ceiling is rejected by the host when the facilitator
submits it for the actual amount.

The `approve` and `transfer_from` pattern resolves this: the buyer signs
`approve` for `max_amount` (known at signing time); the contract draws
`actual_amount` as spender (no buyer signature required for the draw). This is
the mechanism that makes `actual != ceiling` possible without a second buyer
signature.

### 5.2 Cost

The `approve` and `transfer_from` approach requires two cross-contract calls
versus one for a direct transfer. Independent measurements in
[#3134](https://github.com/x402-foundation/x402/pull/3134) and from LumenGate
suggest this adds roughly 10 to 15 percent to the fee charged. Measured fee for
an `upto` settlement through the Vellar facilitator: 40,144 stroops (ledger
4587956).

This spec accepts that cost because the alternative cannot handle
`actual != ceiling` at the auth level. Implementations that reduce the approve
overhead while preserving the auth model MAY do so.

## 6. Nonce management

### 6.1 Storage class

Nonces MUST be stored in Soroban temporary storage, keyed by `(from, nonce)`.
Temporary storage ensures state is cleaned up by the ledger without operator
intervention.

### 6.2 TTL

The TTL MUST be set to `expiration_ledger` with no buffer.

After `expiration_ledger`, step 3 of §4 refuses any `settle` invocation
regardless of nonce state. A buffer would retain nonce state past the point
where it can ever be used, wasting rent for no security gain.

### 6.3 Nonce keying

Nonces MUST be keyed by `(from, nonce)`, not by `nonce` alone. A nonce keyed
only by its value allows one payer to consume another payer's nonce space.

## 7. Settlement event

The contract MUST emit an event on every successful settlement:

```
topics: ("upto_settled",)
data: (
  payer: Address,
  recipient: Address,
  ceiling: i128,
  actual: i128,
  nonce: BytesN<32>,
)
```

Both `ceiling` and `actual` MUST be included. `ceiling` alone loses the
information that `actual` was less than what was authorized. `actual` alone
loses the authorized bound.

## 8. Reading the settled amount

Indexers and explorers MUST read `actual_amount` from the token contract's
emitted `transfer` event, NOT from the `settle` invocation's envelope arguments.

The envelope carries `max_amount`, which is what the buyer signed at simulation
time. The facilitator supplies `actual_amount` when it rebuilds the transaction
for submission. An indexer reading the envelope args will always see the
ceiling, never the actual charge.

This requirement is grounded in a confirmed false negative: the vellar-explorer
v2 classifier read envelope args and attributed every `upto` settlement to the
ceiling amount. v3 reads the token's emitted `transfer` event and is correct.

## 9. Facilitator requirements

A conforming facilitator MUST:

- Advertise `uptoContract` in `/supported` with `areFeesSponsored: true`
- Verify at `/verify` by re-simulating the full transaction, including
  `__check_auth`
- Supply `actual_amount` when rebuilding the transaction for `/settle`
- Return the settlement hash in the settle response
- Reject any payload whose argument count is not exactly 7
- Never relay the buyer's unsigned envelope as-is

A conforming facilitator SHOULD:

- Return `isValid: false` with a non-null reason on rejection, rather than an
  HTTP 4xx

## 10. Deployed reference

Verify the reference implementation:

```bash
# Build from source
cd contracts/upto-vellar
stellar contract build
shasum -a 256 target/wasm32v1-none/release/x402_upto_vellar.wasm
# 92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8

# Verify on-chain
stellar contract fetch \
  --id CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --out-file fetched.wasm
shasum -a 256 fetched.wasm
# must match above

# Verify first settlement
curl -s "https://horizon-testnet.stellar.org/transactions/be33bb71b0a2c74c465bf0243c45e081bc7c5b66a337e2d8a5c0bbb82f54ede6" \
  | python3 -c \
  "import json,sys; \
  d=json.load(sys.stdin); \
  print('successful:', d['successful']); \
  print('ledger:', d['ledger'])"
# successful: True
# ledger: 4587956
# ceiling: 0.05 USDC / actual: 0.01 USDC
```

[SEP-41]: https://stellar.org/protocol/sep-41
