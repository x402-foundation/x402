# Scheme: `upto` on `Stellar`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:

- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The `upto` scheme on Stellar lets a client authorize a **maximum amount** of a [SEP-41] token (including every Stellar Asset Contract) and lets the facilitator settle the **actual amount**, from `0` up to that maximum, after the resource has been served. The facilitator sponsors every fee and never holds the client's funds. Muxed (`M…`) recipients are not supported.

A Soroban authorization binds a call's exact arguments, so a signed `token.transfer` (as in [`exact`](../exact/scheme_exact_stellar.md)) fixes the amount, and a bare `approve` binds no recipient and is reusable. Instead, the client signs `settle(terms)` on a small, immutable settlement contract, with one nested `approve` that only that contract can use. The terms name the recipient, token, maximum, validity window and the facilitator's **settlement authority**, which picks the amount; the contract enforces the rest.

Example use cases: LLM tokens up to a cap, metered bandwidth or compute, tool calls priced by their input.

## Roles

- **Client (payer):** a `G…` account or `C…` contract account; signs the terms.
- **Resource server:** paid at `payTo` (`G…` or `C…`); sets the amount after serving.
- **Facilitator:** transaction-source accounts and an optional fee-bump sponsor; verifies, submits and pays fees.
- **Settlement authority (F):** a facilitator address announced as `extra.facilitatorAddress`; the only one that can choose the amount.
- **Settlement contract (`C_UPTO`):** one canonical deployment per network; enforces the cap and window and moves the funds.

## Core properties

How the [`upto` core properties](./scheme_upto.md#core-properties-must) are enforced:

1. **Single use:** the host consumes the client's nonce; a replay fails with `Error(Auth, ExistingValue)`.
2. **Time bound:** `signatureExpirationLedger` (host), `terms.valid_after_ledger` and `terms.expiration_ledger` (contract), and the `approve` expiring at the same ledger. Ledgers close in order at a target time (currently 5 seconds), so no clock is trusted.
3. **Recipient binding:** `terms.recipient` is signed; the contract pays only it.
4. **Maximum:** `terms.max_amount` is signed; the contract refuses larger and negative amounts, and the signed `approve` caps what it can pull.
5. **Phase-dependent `amount`:** `/verify` simulates the maximum; `/settle` settles `requirements.amount` after checking the signed terms against the accepted maximum.

The contract calls `terms.facilitator.require_auth()` over `(payer, terms, amount)`, the counterpart of `witness.facilitator` in [`scheme_upto_evm.md`](./scheme_upto_evm.md).

## Settlement contract

The contract is immutable and stateless: no admin, no upgrade path, no storage, no constructor. Its source is [`contracts/stellar/upto`](../../../contracts/stellar/upto), built reproducibly ([appendix](#reproducible-build-and-verification)).

```rust
#[contracttype]
pub struct UptoTerms {            // on the wire: an ScMap with exactly these keys, in this order
    pub expiration_ledger: u32,   // last ledger (inclusive) at which the terms can be settled
    pub facilitator: Address,     // the settlement authority, extra.facilitatorAddress
    pub max_amount: i128,         // the maximum, in atomic units of `token`; positive
    pub recipient: Address,       // payTo (G… or C…)
    pub token: Address,           // SEP-41 token contract, the requirements' asset
    pub valid_after_ledger: u32,  // first ledger (inclusive) at which the terms can be settled; clients send 0
}

fn settle(env: Env, payer: Address, terms: UptoTerms, amount: i128) -> Result<i128, UptoError>;
fn version(env: Env) -> u32; // 1
```

`settle` does, in this order, rolling back everything (the payer's nonce included) on any failure:

1. Refuses `max_amount ≤ 0` (`#1 InvalidMaxAmount`), `amount < 0` (`#2 NegativeAmount`), `amount > max_amount` (`#3 AmountExceedsMax`), a ledger before `valid_after_ledger` (`#4 NotYetValid`) or after `expiration_ledger` (`#5 Expired`), and `recipient` equal to the contract (`#6 InvalidRecipient`).
2. `payer.require_auth_for_args((terms,))`: the client's signed root.
3. `terms.facilitator.require_auth()`: the settlement authority, over `(payer, terms, amount)`.
4. If `amount > 0`: `token.approve(payer, C_UPTO, max_amount, expiration_ledger)` (the client's signed child), then `token.transfer_from(C_UPTO, payer, recipient, amount)`. A zero amount makes no token calls.
5. Emits `upto_settled` (topics `["upto_settled", payer, recipient]`, data `{amount, facilitator, max_amount, token}`) and returns `amount`.

A Stellar Asset Contract uses the same numbers for its own errors, so implementations MUST attribute an `Error(Contract, #n)` by the contract that raised it ([rule 10](#10-simulation)).

### Deployments

The address derives from the deployer and the salt `sha256("x402-upto-stellar/v1.1")` (`379714072c27ad068d175a4e64017065e569fb9fd33b9c7c8b59428741f7330b`); any contract change is a new salt, address and SDK constant.

| Network           | Contract                                                   | WASM sha256                                                        | Record                                                                            |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `stellar:testnet` | `CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U` | `cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797` | [`deployments/testnet.json`](../../../contracts/stellar/deployments/testnet.json) |
| `stellar:pubnet`  | reserved; not deployed                                     | —                                                                  | —                                                                                 |

The deployer has no power over a deployment. Address and WASM hash are per-network constants of each implementation, not negotiated in `extra`: a client MUST NOT sign for a contract named at runtime.

## Protocol Flow

The core `authorization` flow ([x402 v2 §6.1](../../x402-specification-v2.md)) with a single asset transfer method, so `extra` carries neither `assetTransferMethod` nor `paymentFlow`:

1. The resource server answers `402`; `amount` is the maximum and `extra` comes from the facilitator's `/supported` kind.
2. The client reads the latest ledger, computes the expiration ledger `E`, signs the entry and resends the request with the `PaymentPayload`.
3. `/verify` (`amount` = maximum): the facilitator runs the [rules](#facilitator-verification-rules-must) and simulates `settle(payer, terms, max)`, writing nothing.
4. After serving, the resource server calls `/settle` with the same payload and the actual `amount` (for example via `setSettlementOverrides`).
5. The facilitator re-runs every rule for that amount, submits the settlement and returns the `SettlementResponse`, `amount` always set.

## `/supported`

One kind per network. The settlement authority SHOULD also be listed under the network's `signers`.

```json
{
  "x402Version": 2,
  "scheme": "upto",
  "network": "stellar:testnet",
  "extra": {
    "areFeesSponsored": true,
    "facilitatorAddress": "GAUTHORITY…"
  }
}
```

## `PaymentRequirements`

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "amount": "1000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": true,
    "facilitatorAddress": "GAUTHORITY…"
  }
}
```

- `amount`: phase-dependent, as in [`scheme_upto.md`](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements); an integer string of atomic units. The maximum MUST be positive.
- `asset`: the SEP-41 token contract (`C…`). `payTo`: a `G…` or `C…` address.
- `maxTimeoutSeconds`: how long the authorization stays settleable. `/settle` re-runs [rule 7](#7-the-expiration-window), so resource servers SHOULD set it to at least the handler's worst-case time plus about three ledgers (15 seconds).
- `extra.areFeesSponsored` MUST be `true`; `extra.facilitatorAddress` is the settlement authority.

## `PaymentPayload` `payload` field

```json
{
  "authorization": "AAAAAQAAAAAAAAAA…",
  "signerAuthorizations": ["AAAAAQAAAAAAAAAB…"]
}
```

- `authorization` (required): base64 XDR of the client's signed `SorobanAuthorizationEntry` for `settle(terms)`.
- `signerAuthorizations` (optional, at most 4): base64 XDR entries of delegated signers that a contract-account payer requires ([Smart accounts](#smart-accounts)).

The payload is an entry, not `exact`'s `{ transaction }`: the amount is unknown when the client pays.

```text
credentials   ADDRESS or ADDRESS_V2 (CAP-71): address = payer, nonce = random i64,
              signatureExpirationLedger = E, signature
rootInvocation
  C_UPTO.settle(terms)                                          terms = { E, F, max, payTo, asset, 0 }
  └── asset.approve(payer, C_UPTO, max: i128, E: u32)           exactly one child, no grandchildren
```

`E = latestLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`; implementations SHOULD use the current network estimate and fall back to `5`. `terms.expiration_ledger` MUST equal `signatureExpirationLedger`.

**Full `PaymentPayload`:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "stellar:testnet",
    "amount": "1000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    "maxTimeoutSeconds": 60,
    "extra": {
      "areFeesSponsored": true,
      "facilitatorAddress": "GAUTHORITY…"
    }
  },
  "payload": {
    "authorization": "AAAAAQAAAAAAAAAA…"
  }
}
```

### Client (MUST)

Before signing, a client MUST check that the scheme is `upto`, the network is a supported Stellar network, `amount` is a positive integer within `i128`, `asset` is a `C…` address, `payTo` and `extra.facilitatorAddress` are valid `G…` or `C…` addresses other than the payer, and `extra.areFeesSponsored` is `true`. It signs for the network's canonical contract (or one its own configuration names), never one from the requirements, with a nonce from a cryptographically secure random source.

A client SHOULD refuse a `maxTimeoutSeconds` above a bound of its own (the reference client: 300 seconds), since the authorization can be settled for any amount up to the maximum until `E`. A `C…` authority authorizes through its own `__check_auth`; clients MAY accept only `G…` authorities.

## Facilitator Verification Rules (MUST)

`/verify` and `/settle` both run every rule below, in order, for the phase amount: the maximum at `/verify`, `requirements.amount` at `/settle`. `/settle` MUST NOT assume a prior `/verify`, and `/verify` MUST NOT write anything. A repeated `/settle` is answered from the facilitator's record before rule 7 ([Duplicates](#duplicates)).

### 1. Protocol

- `x402Version` is `2`; `payload.accepted.scheme` and `requirements.scheme` are `"upto"`; `payload.accepted.network` equals `requirements.network`; the facilitator serves that network.

### 2. Requirements

- `asset` is a `C…` address accepted by the facilitator's asset policy, if any.
- `payTo` is a `G…` or `C…` address other than a facilitator address, `C_UPTO` and `asset`. An `M…` address is refused.
- `maxTimeoutSeconds` is a positive integer within the facilitator's limit. A facilitator SHOULD refuse values shorter than `margin + 1` ledgers (15 seconds), which can never pass rule 7, with `invalid_upto_stellar_requirements_timeout_out_of_range`.
- `extra.areFeesSponsored` is `true` and `extra.facilitatorAddress` is this facilitator's settlement authority.
- `payload.accepted` agrees with the requirements on `network`, `asset`, `payTo`, `maxTimeoutSeconds` and every key of `requirements.extra`.
- `payload.accepted.amount` (the maximum) is a positive integer within `i128`. At `/verify`, `requirements.amount` equals it; at `/settle`, `0 ≤ requirements.amount ≤` it, and a larger amount is `invalid_upto_stellar_payload_settlement_exceeds_amount`.

### 3. The entry

- `payload.authorization` decodes to exactly one canonical `SorobanAuthorizationEntry`. Implementations SHOULD bound its size (the reference implementation: 8 KiB of base64).
- Its credentials are `sorobanCredentialsAddress` or `sorobanCredentialsAddressV2` of a `G…` or `C…` address, the payer, and carry a signature (not `void`, not an empty vector).

### 4. The root invocation

- The root calls `C_UPTO.settle` with exactly one argument that decodes to the six-key `UptoTerms` map with exactly the types above and re-encodes canonically to the same bytes.

### 5. The terms

- `terms.recipient == payTo`, `terms.token == asset`, `terms.facilitator ==` the settlement authority, `terms.max_amount == payload.accepted.amount`, `terms.expiration_ledger == signatureExpirationLedger`, and `terms.valid_after_ledger ≤ currentLedger + 1`.

### 6. The tree

- The root has exactly one sub-invocation, XDR-equal to `asset.approve(payer, C_UPTO, max_amount, expiration_ledger)`, which has none.

### 7. The expiration window

- `currentLedger + margin ≤ E ≤ currentLedger + ceil(maxTimeoutSeconds / min(estimatedLedgerSeconds, 5)) + 2`, with `margin ≥ 1` (the reference implementation: `2`) so that a submitted settlement can still be included. `5` is the target close time: a client that estimated 5 seconds signs a later `E` than a facilitator estimating 6 would allow. An `E` below the current ledger is `invalid_upto_stellar_signature_expired`.

### 8. The payer

- The payer is not a facilitator address and not `C_UPTO`. A payer equal to `payTo` SHOULD be refused.

### 9. Signer authorizations

- `signerAuthorizations` is absent or at most 4 distinct entries, only for a `C…` payer. Each is signed, has address credentials of an address other than the payer and the facilitator's, and has root `payer.__check_auth(…)` without sub-invocations.

### 10. Simulation

- The facilitator builds the settlement transaction ([Settlement](#settlement)) for the phase amount and simulates it in **enforcing** mode. The simulation MUST succeed.
- Failures are classified by the contract that raised them (table below); an error naming no contract is classified by its host error type and message, never by number alone. `Error(Auth, ExistingValue)` is `invalid_upto_stellar_payload_nonce_already_used`; a failed signature `invalid_upto_stellar_payload_invalid_signature`; an error from a contract-account payer or its verifiers or policies `invalid_upto_stellar_payload_smart_account_rejected`.
- A failed signature MUST NOT be reported as an expiry. A bad `G…` signature surfaces as `Error(Contract, #5)` in `C_UPTO`'s frame followed by `Error(Auth, InvalidAction)` "failed account authentication"; with the latter present, the result is `…_invalid_signature` (`G…` payer) or `…_smart_account_rejected` (`C…` payer).
- If archived entries need restoring, the facilitator MUST refuse rather than pay for it: `invalid_upto_stellar_settlement_contract_archived` for `C_UPTO`'s instance or code, `invalid_upto_stellar_payload_archived_state` otherwise.

| Raised by | Error                                                      | Code                                                                                                                           |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `C_UPTO`  | `#1` `InvalidMaxAmount`                                    | `invalid_upto_stellar_payload_invalid_terms`                                                                                   |
| `C_UPTO`  | `#2` `NegativeAmount`                                      | `invalid_upto_stellar_requirements_invalid_amount`                                                                             |
| `C_UPTO`  | `#3` `AmountExceedsMax`                                    | `invalid_upto_stellar_payload_settlement_exceeds_amount`                                                                       |
| `C_UPTO`  | `#4` `NotYetValid`                                         | `invalid_upto_stellar_payload_not_yet_valid`                                                                                   |
| `C_UPTO`  | `#5` `Expired`                                             | `invalid_upto_stellar_signature_expired`, unless account authentication failed (above)                                         |
| `C_UPTO`  | `#6` `InvalidRecipient`                                    | `invalid_upto_stellar_requirements_invalid_pay_to`                                                                             |
| `asset`   | `#6` (Stellar Asset Contract `AccountMissingError`)        | `invalid_upto_stellar_payload_account_missing`                                                                                 |
| `asset`   | `#10` (Stellar Asset Contract `BalanceError`)              | `insufficient_funds`                                                                                                           |
| `asset`   | `#11` (Stellar Asset Contract `BalanceDeauthorizedError`)  | `invalid_upto_stellar_payload_trustline_not_authorized`                                                                        |
| `asset`   | `#13` (Stellar Asset Contract `TrustlineMissingError`)     | `invalid_upto_stellar_payload_recipient_trustline_missing` when the error names `payTo`, otherwise `…_payer_trustline_missing` |
| `asset`   | `#100` (OpenZeppelin fungible token `InsufficientBalance`) | `insufficient_funds`                                                                                                           |
| `asset`   | any other error                                            | `invalid_upto_stellar_payload_simulation_failed`                                                                               |

An implementation MAY apply the token rows to any SEP-41 token (the reference implementation does). The reason of `invalid_upto_stellar_payload_simulation_failed` SHOULD name the error and the contract that raised it.

### 11. Fee

- The sponsor's maximum charge, `minResourceFee + inclusionFee` plus one more `inclusionFee` for a fee bump, MUST NOT exceed the facilitator's ceiling (`invalid_upto_stellar_payload_fee_exceeds_maximum`), which MAY be exposed as `maxTransactionFeeStroops`. Operators SHOULD size it for the payers and tokens they serve: on testnet a Stellar Asset Contract payment declares about 40,000–50,000 stroops, a first payment through a contract token or a smart-account payer with policies 0.9–2.7 million. The reference default is 500,000.

### 12. 🚨 Events and custody

In the successful simulation:

- There is exactly one balance-changing event (`transfer`, `mint`, `burn` or `clawback`) when `amount > 0`, and none when `amount == 0`: a `transfer` from `asset`, from the payer to `payTo`, of exactly `amount`, in the Stellar Asset Contract's shape `[transfer, from, to, asset]` or SEP-41's `[transfer, from, to]`, with data an `i128` or a map holding `amount`.
- No balance-changing event involves a facilitator address.
- There is exactly one `upto_settled` event from `C_UPTO` whose payer, recipient, token, facilitator, amount and maximum match. Other events are allowed.

## Settlement

At `/settle`, the facilitator checks the client's terms against `payload.accepted.amount`, the signed maximum (rules 2 and 5), and settles `requirements.amount`, never the other way round.

### The settlement transaction

```text
FeeBumpTransaction (optional)   fee source: the facilitator's sponsor
  Transaction                   source: a facilitator account (its sequence number)
                                fee: minResourceFee + inclusion fee (≥ 100 stroops)
                                ledgerBounds.maxLedger = E + 1 (exclusive), sorobanData from the settle-time simulation
    InvokeHostFunction          operation source: the settlement authority F
      C_UPTO.settle(payer, terms, amount)
      auth: [ payload.authorization, ...payload.signerAuthorizations,
              { credentials: SOURCE_ACCOUNT, root: C_UPTO.settle(payer, terms, amount), no children } ]
```

- The authority authorizes as the operation source (`SOURCE_ACCOUNT` entry, no nonce write); the transaction is signed by its source and, when different, the authority. A facilitator MAY instead use a `C…` authority with an address-credential entry.
- The client's entries are submitted unchanged; fee and resource data come from the settle-time simulation.
- A facilitator expecting concurrent settlements SHOULD keep several source accounts; on `txBAD_SEQ`, which moves nothing, it MAY rebuild and resubmit.
- The facilitator computes the hash, submits and polls until `SUCCESS` or `FAILED`. When confirmation cannot be established, including when `sendTransaction` fails without an answer, it returns `settlement_pending` with the hash.
- A facilitator MUST NOT report a submitted settlement as failed or expired while it could have landed; a rebroadcast refused as too late proves nothing. Anyone can re-wrap the signed inner transaction in a fee bump, so before finishing a settlement whose hash is not found it SHOULD check the inner hash or the payer's nonce entry, and report the hash it landed under.

### Zero settlement

`amount = 0` is submitted on-chain by default: it consumes the nonce, emits `upto_settled` with amount `0`, moves nothing and returns a hash. A facilitator MAY instead record it off-chain and return `transaction: ""`, since only its authority can settle and the authorization expires at `E`. It MUST then never settle that authorization later, so the record MUST be durable and shared by every process holding the authority until `E`; otherwise zero is settled on-chain.

### Duplicates

The facilitator MUST NOT broadcast one authorization in more than one settlement transaction, except after a proven on-chain failure. Records are keyed by `(network, payer, nonce)` and consulted before rule 7, so a repeat near or after `E` gets the recorded result.

- Same entries (`authorization`, `signerAuthorizations`) and amount: the first result; a pending one is polled again.
- Different amount or signer entries: `settle_upto_stellar_idempotency_conflict` with the original hash. An original not yet broadcast can still fail harmlessly, so the facilitator SHOULD wait for it and treat the request as new if it failed.
- A settlement that failed before broadcast MAY be forgotten.
- A transaction proven `FAILED` on chain rolled back the nonce too; the facilitator MAY settle afresh until `E`, never on a timeout, `NOT_FOUND` or a refused rebroadcast alone; otherwise repeats get the original failure.

Processes that share a settlement authority share these records.

### `SettlementResponse`

```json
{
  "success": true,
  "transaction": "2b6d365a944acf85f0306f15fc80c2249629e9a30c3c99bf0731f001504f8f5b",
  "network": "stellar:testnet",
  "payer": "GALUL4US36TAOCHX3QY54TZBRRXTLCOUG3SV5XR5IIHKQDKEXESKMMOD",
  "amount": "10000"
}
```

`transaction` is the submitted hash (the fee bump's, if any), or `""` for a zero settlement recorded off-chain. `amount` is always present and may be `"0"`.

## Error codes

The x402 v2 codes ([§9](../../x402-specification-v2.md)) apply: `invalid_x402_version`, `unsupported_scheme` and `invalid_network` (rule 1), `insufficient_funds` (rule 10), `settlement_pending` ([Settlement](#the-settlement-transaction)), and `unexpected_verify_error` / `unexpected_settle_error`; `invalid_payload` and `invalid_payment_requirements` MAY be returned for unreadable bodies. `network_mismatch` (rule 1) is not a §9 code. Every refusal has a stable code, and a message alongside it (`invalidMessage`, `errorMessage`) SHOULD be specific.

Scheme-specific codes:

| Code                                                                                                                                                                                                                                                        | When                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `invalid_upto_stellar_requirements_fees_not_sponsored`, `…_facilitator_mismatch`, `…_invalid_pay_to`, `…_invalid_amount`, `…_asset_not_accepted`, `…_timeout_out_of_range`                                                                                  | rule 2 (`invalid_amount` also for contract `#2`, `invalid_pay_to` for contract `#6`)             |
| `invalid_upto_stellar_payload_accepted_mismatch`                                                                                                                                                                                                            | rule 2: `accepted` differs from the requirements                                                 |
| `invalid_upto_stellar_payload_settlement_exceeds_amount`                                                                                                                                                                                                    | the amount to settle exceeds the signed maximum (rule 2, contract `#3`)                          |
| `invalid_upto_stellar_payload_unsupported_recipient`                                                                                                                                                                                                        | `payTo` is a muxed (`M…`) address                                                                |
| `invalid_upto_stellar_payload_malformed`, `…_too_large`, `…_unsupported_credential_type`, `…_missing_payer_signature`                                                                                                                                       | rule 3                                                                                           |
| `invalid_upto_stellar_payload_wrong_contract`, `…_wrong_function`, `…_invalid_terms`                                                                                                                                                                        | rule 4 (`invalid_terms` also for contract `#1`)                                                  |
| `invalid_upto_stellar_payload_wrong_recipient`, `…_wrong_asset`, `…_wrong_amount`, `…_facilitator_mismatch`, `…_expiration_mismatch`, `…_not_yet_valid`                                                                                                     | rule 5 (`not_yet_valid` also for contract `#4`)                                                  |
| `invalid_upto_stellar_payload_invalid_authorization_tree`                                                                                                                                                                                                   | rule 6                                                                                           |
| `invalid_upto_stellar_signature_expired`, `…_expiration_too_soon`, `…_expiration_too_far`                                                                                                                                                                   | rule 7 (`expired` also for contract `#5` and host expiry, never for a failed signature: rule 10) |
| `invalid_upto_stellar_payload_facilitator_is_payer`, `…_self_payment`                                                                                                                                                                                       | rule 8                                                                                           |
| `invalid_upto_stellar_payload_invalid_signer_authorization`                                                                                                                                                                                                 | rule 9                                                                                           |
| `invalid_upto_stellar_payload_simulation_failed`, `…_nonce_already_used`, `…_invalid_signature`, `…_smart_account_rejected`, `…_payer_trustline_missing`, `…_recipient_trustline_missing`, `…_trustline_not_authorized`, `…_account_missing`, `…_archived_state` | rule 10                                                                                          |
| `invalid_upto_stellar_settlement_contract_archived`                                                                                                                                                                                                         | rule 10: `C_UPTO`'s instance or code is archived                                                 |
| `invalid_upto_stellar_payload_fee_exceeds_maximum`                                                                                                                                                                                                          | rule 11                                                                                          |
| `invalid_upto_stellar_payload_unexpected_balance_change`, `invalid_upto_stellar_payload_settlement_event_mismatch`                                                                                                                                          | rule 12                                                                                          |
| `settle_upto_stellar_transaction_signing_failed`, `…_fee_bump_signing_failed`, `…_transaction_submission_failed`, `…_transaction_failed`, `…_transaction_expired`                                                                                            | submission                                                                                       |
| `settle_upto_stellar_idempotency_conflict`                                                                                                                                                                                                                  | [duplicates](#duplicates)                                                                        |

A facilitator MAY add `invalid_upto_stellar_requirements_*` codes for its own amount policy, and retryable `settle_upto_stellar_*` codes for its own temporarily unavailable accounts.

## Smart accounts

A `C…` payer's `__check_auth` sees two contexts, `C_UPTO.settle(terms)` and `asset.approve(payer, C_UPTO, max, E)`, neither carrying the settled amount, so a budget enforced there reserves the full maximum, even for a zero settlement.

- The client signs in the account's own format through a caller-supplied entry signer; delegated signers travel in `signerAuthorizations` (rule 9).
- A spending-limit policy has to budget the `approve` amount (`args[2]`); one that only knows `transfer` refuses the payment.
- A policy that restricts payees MUST read `terms.recipient` from the `settle` context; `approve` names only `C_UPTO`.
- A session or agent key SHOULD be allowed only on rules carrying such a policy; with the budget on `approve` and none on `C_UPTO.settle`, the amount is counted once.

## Security considerations

1. **What the settlement authority can do.** Choose `amount ∈ [0, max]`, or not settle. It cannot change the recipient or token, exceed the maximum, settle twice, move other accounts' funds, or replay the entry on another contract or network (the network ID is signed, and contract addresses differ per network): the trust a client gives the facilitator on EVM.
2. **Custody.** Funds move only by `transfer_from(C_UPTO, payer, payTo, amount)` inside the settlement, and rule 12 checks that no facilitator account changes balance. The contract holds nothing.
3. **Residual allowance.** At most `max − amount` stays approved until `E`. Only `C_UPTO` can spend it, and only after a new client signature whose `approve` overwrites it.
4. **Fee sponsorship.** The facilitator pays only for transactions it builds, under a ceiling, and never restores archived state inside a payment. It still pays for settlements that fail when applied and for on-chain zero settlements, at no cost to the client. Facilitators SHOULD rate-limit `/settle` per payer and per `payTo`, keep an aggregate fee budget, or both.
5. **Contract TTL.** The contract never extends its own instance or code. Operators SHOULD keep both live with `ExtendFootprintTTL` and restore them if archived; anyone may.
6. **Rotating the settlement authority.** Operators SHOULD keep settling for an old authority until its authorizations have expired and resource servers, which often read `/supported` once at startup, have refreshed.
7. **Who names the amount.** The first `/settle` accepted for an authorization fixes the amount, so anyone holding the payload can settle any amount in `[0, max]` to `payTo` first. Payloads SHOULD travel only from client to resource server, encrypted and kept out of logs; resource servers SHOULD settle before releasing metered output; facilitators SHOULD authenticate `/settle` callers where this matters.
8. **Payment after service.** Verification locks nothing: until settlement, the client can move its funds or consume the authorization elsewhere. The risk covers one request; a short `maxTimeoutSeconds` and prompt settlement keep it small.
9. **Events are as trustworthy as the token.** A token that does not implement SEP-41 faithfully can return without moving funds and emit any events, so anyone counting payments from them (rule 12 included) trusts the token; the payer's other assets are not at risk. Facilitators SHOULD settle only allowlisted assets on pubnet.

## Appendix

### Test vectors

[`upto-stellar-vectors.json`](../../../typescript/packages/mechanisms/stellar/test/fixtures/upto-stellar-vectors.json) is generated by [`upto-stellar-vectors.ts`](../../../typescript/packages/mechanisms/stellar/test/fixtures/upto-stellar-vectors.ts) from test-only seeds (payer `0x01×32`, authority `0x02×32`, recipient `0x03×32`), a fixed test contract, `max = 1000000`, `E = 123456` and nonce `42` on testnet. It has the terms and invocations, V1 and V2 preimages, hashes, signatures and entries, the `settle` arguments and authority entry for amounts `1000000`, `300000` and `0` for `G…` and contract-account payers, a delegated signer's entry, and negative vectors with their expected codes.

### Reproducible build and verification

[`contracts/stellar/upto`](../../../contracts/stellar/upto) is the complete build input. `stellar contract build --optimize` (stellar-cli 28.1.0, Rust 1.98.0) with [SEP-55] `source_repo` metadata naming the repository it is attested from, in the digest-pinned image of the contract [README](../../../contracts/stellar/README.md), reproduces the WASM hash in the [deployments](#deployments) table, as does `stellar contract fetch --id <contract> --network testnet | sha256sum`.

[SEP-41]: https://stellar.org/protocol/sep-41
[SEP-55]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0055.md
