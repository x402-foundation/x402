# Scheme: `exact` on `NEAR`

## Summary

The `exact` scheme on NEAR lets a client pay an exact amount of a NEP-141 token while a facilitator-sponsored relayer submits the on-chain transaction.

The client signs a NEP-366 `SignedDelegateAction` that authorizes one exact `ft_transfer` call. The facilitator verifies that payload against `PaymentRequirements`, then submits it through a relayer account selected from facilitator configuration.

NEAR account keys and signatures may use either `ed25519` or `secp256k1`; implementers should account for both when validating signed delegate actions.

## Asset Transfer Methods

NEAR `exact` payments are implemented via one of two asset transfer methods:

| AssetTransferMethod | Mechanism | Payer universe | Networks |
| :--- | :--- | :--- | :--- |
| **1. `delegate`** (default) | NEP-366 `SignedDelegateAction` wrapping one exact `ft_transfer`; a facilitator relayer submits and sponsors gas | A NEAR account holding the token, signing with a **full-access** key | `near:mainnet`, `near:testnet` |
| **2. `intents-verifier`** | A [NEAR Intents](https://docs.near-intents.org) multi-standard signed payload settled directly through the Verifier contract `intents.near` | Standards supported by both facilitator and Verifier — at minimum `nep413` and `erc191`, including EVM keys with **no NEAR account at all** | `near:mainnet` only |

If no `assetTransferMethod` is specified in the selected `PaymentRequirements.extra`, clients should default to `"delegate"`. Payment payloads that use a non-default transfer method should echo the selected `assetTransferMethod` in `accepted.extra`.

The sections from `PaymentRequirements` through `Settlement` below define the default `delegate` method. The `intents-verifier` method is defined in [its own section](#asset-transfer-method-intents-verifier).

## Versions Supported

This specification supports **x402 v2 only**.

- `x402Version` in `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` MUST be `2`.
- v1 fields and headers are out of scope.

## Supported Networks

NEAR networks MUST use CAIP-style identifiers:

- `near:mainnet`
- `near:testnet`

Implementations MAY support additional `near:*` identifiers, but this spec defines behavior for the two canonical networks above.

The `intents-verifier` asset transfer method is defined for `near:mainnet` only — no testnet Verifier deployment exists (see its section below).

## Protocol Flow

1. Client requests a protected resource.
2. Resource server responds `402 Payment Required` with a `PAYMENT-REQUIRED` header containing a v2 `PaymentRequired` object.
3. Client selects one `accepts[]` entry and constructs a NEAR `SignedDelegateAction` for one exact `ft_transfer`.
4. Client retries with `PAYMENT-SIGNATURE`, carrying a v2 `PaymentPayload`.
5. Resource server calls facilitator `verify` with the `PaymentPayload` and selected `PaymentRequirements`.
6. If verification succeeds, resource server calls facilitator `settle`.
7. Facilitator relayer submits the delegate action to NEAR and waits until the inner `ft_transfer` receipt has finished executing on chain (succeeded or failed) before returning `SettlementResponse`.
8. Resource server returns the protected response and includes `PAYMENT-RESPONSE`.

## `PaymentRequirements` for `exact`

`PaymentRequirements` follows the core v2 schema. NEAR exact payments do not require any scheme-specific `extra` field.

The client does not need a sponsoring account identifier to create the signed payload. The NEAR relayer is not part of `SignedDelegateAction`; it is selected by the facilitator when building the outer relayer transaction.

```json
{
  "scheme": "exact",
  "network": "near:testnet",
  "amount": "1000000",
  "asset": "usdc.testnet",
  "payTo": "merchant.testnet",
  "maxTimeoutSeconds": 60
}
```

### Field Notes

- `amount`: exact token quantity in atomic units as a decimal string.
- `asset`: NEP-141 token contract account ID.
- `payTo`: recipient NEAR account ID that must receive the transfer.
- `maxTimeoutSeconds`: positive integer timeout budget in seconds.
- `extra` MAY contain additional metadata, but unknown keys MUST NOT change verification of amount, recipient, asset, nonce, or expiry.
- `extra.assetTransferMethod` selects the asset transfer method; when absent, the default `delegate` method defined here applies (see Asset Transfer Methods).
- Relayer account selection is facilitator-local configuration and MUST NOT be required from the client-facing `PaymentRequirements`.

### Timeout Mapping: `maxTimeoutSeconds` -> `max_block_height`

To remove implementation-defined divergence, NEAR exact implementations MUST use the following mapping:

- `estimatedBlockSeconds = 1` for both `near:mainnet` and `near:testnet`.
- `timeoutBlocks = max(1, ceil(maxTimeoutSeconds / estimatedBlockSeconds))`.

Client signing rule:

- `max_block_height = current_block_height + timeoutBlocks`.

Facilitator verification rule:

- `remainingBlocks = delegate_action.max_block_height - current_block_height`.
- MUST reject if `remainingBlocks <= 0` (expired).
- MUST reject if `remainingBlocks > timeoutBlocks` (window exceeds x402 timeout budget).

Example:

- If `maxTimeoutSeconds = 60`, then `timeoutBlocks = 60` on both `near:mainnet` and `near:testnet`.

## `PAYMENT-SIGNATURE` Payload

The NEAR exact payload object is:

```json
{
  "signedDelegateAction": "base64-borsh-signed-delegate-action"
}
```

`signedDelegateAction` is a base64-encoded Borsh `SignedDelegateAction` whose delegate action represents exactly one NEP-141 `ft_transfer`.

### Signature Curve Support

- NEAR protocol-level key/signature support includes both `ed25519` and `secp256k1`.
- Facilitators MUST verify signatures using the algorithm implied by the delegate key type.
- Implementations SHOULD support both curves for interoperability.
- If an implementation intentionally supports only a subset of curves, it MUST document that behavior and reject unsupported key types deterministically.

Full `PaymentPayload` example:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "near:testnet",
    "amount": "1000000",
    "asset": "usdc.testnet",
    "payTo": "merchant.testnet",
    "maxTimeoutSeconds": 60
  },
  "payload": {
    "signedDelegateAction": "AQAAA...<base64>..."
  }
}
```

## Facilitator Verification Rules (MUST)

A facilitator verifying a NEAR `exact` payment MUST reject any payload that fails any rule below.

### 1. Version, Scheme, and Network

- `payload.x402Version` MUST equal `2`.
- `payload.accepted.scheme` and required scheme MUST both be `exact`.
- `payload.accepted.network` MUST equal `PaymentRequirements.network`.
- Network MUST be a NEAR CAIP identifier for this scheme (`near:mainnet` or `near:testnet`).

### 2. Requirement Consistency

- `asset`, `payTo`, and `amount` in `payload.accepted` MUST exactly match `PaymentRequirements`.
- `maxTimeoutSeconds` MUST be an integer greater than `0`.
- `extra`, when present, MUST NOT alter the required transfer target, amount, nonce, or expiry. `extra.assetTransferMethod` alone selects which asset transfer method's settlement semantics apply (see Asset Transfer Methods).

### 3. Relayer Sponsorship Abuse Prevention

- Facilitator MUST select the relayer account from trusted local configuration, not from client-supplied payment payload fields.
- Relayer account MUST NOT equal the payer (`delegate_action.sender_id`).
- Facilitator MUST apply policy controls to relayer usage (for example relayer allowlists, budgets, gas limits, and rate limits).
- Facilitator MUST NOT sponsor payloads that would require relayer funds beyond the `Action::Delegate` gas and the exact attached deposits permitted by this spec.

### 4. SignedDelegateAction Integrity

- `PaymentPayload.payload.signedDelegateAction` MUST decode as a valid [Borsh](https://borsh.io) `SignedDelegateAction`.
- Signature type and key type MUST be valid NEAR-supported types (`ed25519` or `secp256k1`).
- Signature verification MUST use the matching curve for the declared key type.
- Signature MUST verify against the exact encoded `delegate_action` bytes and the included public key.

### 5. Replay and Expiry Protection

- Facilitator MUST compute timeout bounds using the deterministic timeout mapping in this specification.
- `remainingBlocks = delegate_action.max_block_height - current_block_height`.
- Facilitator MUST reject if `remainingBlocks <= 0` (for example `delegate_action_expired`).
- Facilitator MUST reject if `remainingBlocks > timeoutBlocks` (for example `delegate_action_timeout_window_exceeds_maxTimeout`).
- Facilitator MUST query current on-chain access-key state for `(delegate_action.sender_id, delegate_action.public_key)` and reject if the key does not exist.
- Facilitator MUST reject if `delegate_action.nonce <= access_key.nonce` (for example `delegate_action_nonce_already_used`).
- Facilitator MUST reject if `delegate_action.nonce >= current_block_height * 1_000_000`, matching NEAR's delegate-action nonce upper bound.
- These nonce checks use NEAR's on-chain access-key nonce and do not require persistent facilitator nonce storage.
- If current block height or access-key nonce state cannot be safely determined, verification MUST fail closed.

### 6. Delegated Action Safety (No Extra Actions)

- `delegate_action.actions` MUST contain exactly one action.
- The only allowed action kind is `FunctionCall`.
- `FunctionCall.methodName` MUST be `ft_transfer`.
- No extra delegated actions are permitted.

### 7. Token Transfer Intent and Exactness

- `delegate_action.receiver_id` MUST equal `PaymentRequirements.asset`.
- Parsed `ft_transfer.args.receiver_id` MUST equal `PaymentRequirements.payTo`.
- Parsed `ft_transfer.args.amount` MUST equal `PaymentRequirements.amount` exactly.
- Attached deposit MUST be exactly `1` yoctoNEAR.
- Sponsored gas MUST be within facilitator policy bounds.
- The `1` yoctoNEAR attached deposit is the NEP-141 security marker that forces `ft_transfer` to be authorized by a full-access key: `FunctionCall` access keys cannot attach a positive NEAR deposit, so the requirement rules them out (see Access-Key Permission Safety below). The client's signed delegate action commits to `deposit: 1` on the inner `FunctionCall`, but the actual yoctoNEAR is prepaid by the facilitator relayer when the outer transaction is submitted — nearcore's runtime states: ["Relayer prepaid all fees and all things required by actions: attached deposits and attached gas"](https://github.com/near/nearcore/blob/crates-0.35.0/runtime/runtime/src/actions.rs#L509) (see also the [NEAR meta-transaction docs](https://docs.near.org/protocol/transactions/meta-tx#balance-refunds-in-meta-transactions)). The client therefore never needs to hold NEAR for this flow. The NEP-141 token amount is separately debited from `delegate_action.sender_id` by the token contract.

### 8. Access-Key Permission Safety

- Facilitator MUST query `view_access_key` for `(delegate_action.sender_id, delegate_action.public_key)` before returning a valid verification result.
- `FullAccess` keys are compatible only after all structural, exact-transfer, nonce, expiry, and chain-state preflight checks in this section pass.
- Standard NEAR `FunctionCall` access keys MUST be rejected for this `ft_transfer` flow because NEAR function-call keys cannot attach a positive NEAR deposit, while NEP-141 `ft_transfer` requires exactly `1` yoctoNEAR.
- Implementations MUST reject unknown or unsupported access-key permission variants unless they can apply nearcore-equivalent validation for the exact delegated action.

### 9. Chain-State Preflight

Public NEAR RPC does not expose a transaction-simulation API equivalent to EVM's `eth_call` or Solana's `simulateTransaction` for the delegate-action execution path. NEAR runs contract calls asynchronously through cross-contract receipts (see Settlement below), so a complete simulation would have to run the runtime forward across shard boundaries — something the public RPC does not do. Facilitators therefore MUST perform targeted chain-state checks against current on-chain state before returning a valid verification result. Each check below maps to a specific failure mode that would otherwise burn relayer gas without delivering payment:

- Sender account (`delegate_action.sender_id`) MUST exist.
- Delegate public key MUST exist for the sender account and pass the nonce and permission checks above.
- Token contract account (`PaymentRequirements.asset`) MUST exist and have contract code deployed.
- `ft_balance_of({"account_id": delegate_action.sender_id})` on the token contract MUST return a decimal-string balance greater than or equal to `PaymentRequirements.amount`.
- If the token contract supports NEP-145 storage management, `storage_balance_of({"account_id": PaymentRequirements.payTo})` MUST return a non-null value.
- If any required preflight query fails, returns an unparsable value, or cannot be safely determined, verification MUST fail closed.

These checks reduce relayer gas sponsorship risk, but they cannot guarantee success if on-chain state changes between verification and settlement.

### 10. Duplicate Settlement Mitigation (RECOMMENDED)

**Vulnerability.** A race condition exists in the settlement flow: if the same verified payment payload is submitted to the facilitator's `/settle` endpoint multiple times before the first submission has finished executing on chain, each call may return a successful-looking response. NEAR's on-chain access-key nonce ensures the delegated action executes at most once on chain — the second attempt is rejected by nearcore as `DelegateActionInvalidNonce` — but the facilitator may still observe each outer transaction reach a "successful" RPC state independently and could otherwise return `success: true` to each caller. A malicious client could exploit this to obtain access to multiple resources while only paying once. This is the same race condition the [SVM scheme documents](./scheme_exact_svm.md#duplicate-settlement-mitigation-recommended); only the chain-specific time window differs.

**Recommended Mitigation.** Facilitators and/or resource servers SHOULD maintain a short-term, in-memory cache of delegate-action payloads currently being settled:

1. After verification succeeds, derive a cache key from the exact `signedDelegateAction` bytes — for example a cryptographic hash of the base64-decoded payload.
2. If the key is already present, reject settlement with `duplicate_settlement`.
3. If the key is not present, insert it before submitting the outer relayer transaction.
4. Evict the key after `delegate_action.max_block_height` has passed (the delegate action can no longer land), or after the facilitator observes the inner `ft_transfer` receipt has finished executing on chain (the outcome is now authoritatively known).

This is a NEAR-flavored adaptation of the SVM mitigation — same in-memory-cache pattern, with eviction tied to NEAR's `max_block_height` instead of Solana's blockhash lifetime. It requires no external storage or long-lived state, only an in-process map with the eviction triggers above. It preserves the facilitator's otherwise-stateless design while closing the duplicate-settlement attack vector.

### Implementing Verification with NEAR RPC

The checks in §5, §8, and §9 use only standard methods on the [NEAR JSON-RPC API](https://docs.near.org/api/rpc/introduction). No custom endpoints are required. Each verification item below maps to the RPC method that produces the answer:

- **Current block height** (for the nonce upper bound and `max_block_height` comparison): [`block`](https://docs.near.org/api/rpc/block-chunk) with `{"finality": "final"}`; read `header.height`. Optimistic finality MUST NOT be used here — it would re-open the replay window.
- **Account existence and contract-code presence** (sender account, token contract): [`query`](https://docs.near.org/api/rpc/contracts) with `request_type: "view_account"`. A non-existent account returns `UNKNOWN_ACCOUNT`; an account with no deployed contract has `code_hash = "11111111111111111111111111111111"`.
- **Access-key existence, nonce, and permission**: [`query`](https://docs.near.org/api/rpc/access-keys) with `request_type: "view_access_key"`, supplying `account_id` and `public_key`. Returns `nonce` and `permission` (`FullAccess`, `FunctionCall { allowance, receiver_id, method_names }`, etc.); a non-existent key returns `UNKNOWN_ACCESS_KEY`. Replay protection uses the returned `nonce` directly — no facilitator state required.
- **`ft_balance_of(sender_id)` and `storage_balance_of(payTo)` on the token contract**: [`query`](https://docs.near.org/api/rpc/contracts) with `request_type: "call_function"`, `method_name` set accordingly, and `args_base64` set to the base64 of `{"account_id": <id>}`. `ft_balance_of` returns a JSON string in atomic units — parse and compare as `u128`, not lexicographically. `storage_balance_of` returns `null` when the recipient is not registered for NEP-145 storage; a non-null `{"total":"...","available":"..."}` object is sufficient.
- **Settlement — waiting for the inner `ft_transfer` receipt to finish executing**: [`tx`](https://docs.near.org/api/rpc/transactions) or `EXPERIMENTAL_tx_status` with `wait_until: "FINAL"`. Inspect `receipts_outcome` after the response and return `success: true` only when the inner `ft_transfer` receipt's status is `SuccessValue`.
- **Finality consistency**: all preflight queries MUST pin the same finality level (typically `final`) to avoid TOCTOU windows where one query reads optimistic state and another reads final. Where supported, fix `block_id` across queries so every check reads against the same block.

These methods together cover everything §5 / §8 / §9 require and are sufficient to implement verification on a stock public NEAR RPC node — no archival access, no custom indexer, no relayer-side state.

## Settlement

NEAR runs contract calls asynchronously through cross-contract receipts: the outer relayer transaction can be accepted, and may even succeed on its own, before the inner `ft_transfer` receipt has actually executed. Settlement therefore waits for the inner receipt to finish before reporting `success: true`.

After successful verification, settlement proceeds as follows:

1. Select relayer from facilitator-managed configuration for the requested NEAR network.
2. Decode `signedDelegateAction`.
3. Build an outer relayer transaction containing `Action::Delegate`.
4. Sign outer transaction with relayer key.
5. Submit to the NEAR RPC endpoint for the selected network.
6. Wait until the outer transaction and all of its spawned receipts have finished executing on chain — that is, until the transaction's final status (success or failure) is known.
7. Return `success: true` only if the delegated `ft_transfer` receipt itself succeeded; otherwise return `success: false`.

If submission or delegated execution fails, facilitator returns `success: false` with an implementation-specific `errorReason` and empty `transaction`.

An RPC acknowledgement, mempool acceptance, or outer transaction inclusion is not sufficient for `success: true` — and even outer-transaction success is not sufficient if the inner `ft_transfer` receipt is still pending or has failed. The protected resource MUST only be released after the inner `ft_transfer` receipt has succeeded on chain.

On `success: false`, `payer` MUST be omitted unless it has been independently verified by the facilitator. `payer` MUST NOT be included based only on untrusted client-claimed payload fields.

## `PAYMENT-RESPONSE` (`SettlementResponse`) Example

Success:

```json
{
  "success": true,
  "transaction": "F7p8QyW8tWnL1QhP9j8uV1q2rM5aZ6xC3e4kT9mN2pR",
  "network": "near:testnet",
  "payer": "alice.testnet"
}
```

Failure:

```json
{
  "success": false,
  "errorReason": "duplicate_settlement",
  "transaction": "",
  "network": "near:testnet"
}
```

## Asset Transfer Method: `intents-verifier`

The `intents-verifier` method settles the exact payment directly through the NEAR Intents Verifier contract — `intents.near` on `near:mainnet` — instead of a signed delegate action. The name distinguishes this same-chain Verifier settlement from other NEAR Intents products, including 1Click cross-chain settlement. The payer signs a Verifier intent payload in one of the Verifier's supported signature standards; the facilitator submits it via `execute_intents` from its own account and pays the gas. The signature alone carries the payment authority, so any account may submit it.

What this method changes relative to `delegate`:

- **Payer universe.** The Verifier accepts multiple signature standards (`nep413`, `erc191`, `tip191`, `raw_ed25519`, `webauthn`, `tonconnect`, `sep53`). In particular, an EVM key signing `erc191` (exactly what `personal_sign` / Circle's `signMessage` emits) pays a NEAR merchant with **no NEAR account, no access key, and no gas** — the Verifier derives an implicit signer id from the recovered key.
- **Custody.** The payer's funds must already sit in the Verifier's internal ledger. Custody is transferred to the shared `intents.near` contract, and any key authorized for the signer can move that signer's whole deposited balance. This is a blast-radius trade the `delegate` method does not make; implementations SHOULD keep standing Verifier balances near a single payment (just-in-time deposits).
- **No relayer/payer distinction.** The facilitator's own account submits `execute_intents`; there is no `Action::Delegate` and no 1 yoctoNEAR requirement, and the payer's key type is never inspected on chain — full-access vs function-call does not apply.

### Network Constraint

- This method is defined for **`near:mainnet` only**. No testnet Verifier deployment exists; facilitators MUST NOT advertise `assetTransferMethod: "intents-verifier"` for `near:testnet`.

### Account Preconditions

- The payer MUST already hold ≥ `amount` of `nep141:<asset>` in the Verifier's internal ledger. Deposits are made out of band by calling `ft_transfer_call` on the token contract with `receiver_id: "intents.near"` (`msg: ""` credits the sender; `msg: "<account>"` credits that account). The deposit flow is outside x402.
- A **named** NEAR account MUST have registered its signing key with the Verifier (`add_public_key`) before its signatures are accepted. **Implicit** signers need no registration: an `ed25519` key maps to the 64-hex NEAR implicit account, and an `erc191`/ECDSA key maps to the implicit-Eth address (`0x…`) — the derived id MUST equal the payload's `signer_id`.
- For wallet delivery (default, below), `payTo` MUST be NEP-145 storage-registered on the token contract.

### `PaymentRequirements` for `intents-verifier`

```json
{
  "scheme": "exact",
  "network": "near:mainnet",
  "amount": "1000",
  "asset": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "payTo": "merchant.near",
  "maxTimeoutSeconds": 120,
  "extra": {
    "assetTransferMethod": "intents-verifier"
  }
}
```

- `extra.assetTransferMethod` (required for this method): MUST be `"intents-verifier"`.
- `extra.delivery` (optional): `"wallet"` (default) or `"internal"`, see Intent Binding below. Servers advertising `"internal"` are declaring that they knowingly accept payment as Verifier-ledger balance.

### `PAYMENT-SIGNATURE` Payload

The payload object carries the Verifier's signed payload verbatim as native JSON (the Verifier's `execute_intents` input element, sometimes called a multi-standard payload):

```json
{
  "signedIntent": {
    "standard": "nep413",
    "payload": {
      "message": "{\"signer_id\":\"alice.near\",\"deadline\":\"2026-08-01T00:00:00.000Z\",\"intents\":[{\"intent\":\"ft_withdraw\",\"token\":\"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\",\"receiver_id\":\"merchant.near\",\"amount\":\"1000\"}]}",
      "nonce": "<base64 of 32 random bytes>",
      "recipient": "intents.near"
    },
    "public_key": "ed25519:...",
    "signature": "ed25519:..."
  }
}
```

Per-standard shapes (facilitators MUST accept `nep413` and `erc191`; other Verifier standards MAY be accepted; unsupported standards MUST be rejected deterministically):

- **`nep413`** — envelope form. `payload.message` is the intent JSON **string** with the minimal fields `{signer_id, deadline, intents}`; `payload.nonce` (base64, 32 bytes) and `payload.recipient` (MUST be `"intents.near"`) live in the envelope, not the message. The signature is `ed25519` over the NEP-413 prehash: `sha256(u32_le(2^31 + 413) || borsh { message, nonce: [u8;32], recipient, callback_url: None })`.
- **`erc191`** — flat form: `{ "standard": "erc191", "payload": "<JSON string>", "signature": "secp256k1:<base58 of 65 bytes r||s||v>" }`. There is no envelope: the signed JSON string itself carries `signer_id`, `verifying_contract: "intents.near"`, `deadline`, `nonce`, and `intents`. The digest is EIP-191 `personal_sign` over the exact payload string bytes; the signer is recovered from the signature (`v` of 27/28 MUST be normalized to 0/1). Reference vector: the accepted `execute_intents` args of mainnet transaction [`ALqQDmeTUouVv6vqG8bqbwBo7RzxBuB7gufPwtcLyw6E`](https://nearblocks.io/txns/ALqQDmeTUouVv6vqG8bqbwBo7RzxBuB7gufPwtcLyw6E).

For the rules below, the **decoded intent document** is the JSON object obtained by parsing the application JSON string that the selected standard signs:

- for `nep413`, parse the exact `signedIntent.payload.message` string;
- for `erc191`, parse the exact `signedIntent.payload` string.

The signature MUST be verified over the original standard-specific signing bytes before any decoded field is trusted. The signed application JSON string MUST be carried byte-identical from signing through submission — no re-serialization, key reordering, or whitespace changes. The decoded intent document is only a semantic view for validation; it is never a replacement for the original signed string. Any additionally supported standard MUST define an equally unambiguous mapping to its signed application JSON string, signer, nonce, and decoded intent document.

### Intent Binding (Exactness)

The decoded intent document's `intents` array MUST contain exactly one intent, bound to the requirements by delivery mode:

- **`delivery: "wallet"`** (default): the intent MUST have exactly the fields `{intent: "ft_withdraw", token: asset, receiver_id: payTo, amount: amount}`. Every optional or unknown field — including `memo`, `msg`, `storage_deposit`, and `min_gas` — MUST be absent. In particular, `msg` would change delivery to `ft_transfer_call`, whose receiver may partially accept the amount and cause the remainder to be refunded. With the closed shape, the Verifier debits the payer's internal balance and transfers exactly `amount` of real tokens to `payTo` on the token contract, equivalent in effect to the `delegate` method's `ft_transfer`.
- **`delivery: "internal"`**: the intent MUST have exactly the fields `{intent: "transfer", receiver_id: payTo, tokens: {"nep141:<asset>": amount}}`. Every optional or unknown field — including `memo` and the flattened notification fields `msg`, `state_init`, and `min_gas` — MUST be absent. This keeps the ledger move synchronous and prevents an asynchronous receiver callback from accepting only part of the transfer. The merchant must withdraw the internal balance separately. Servers MUST NOT advertise this mode unless the merchant operates a Verifier balance.
- `token_diff` (the Verifier's swap primitive) is out of scope for `exact`: its fill amounts are quote-dependent, which breaks exact-amount semantics. Cross-asset payment belongs in a different scheme.

### Deadline Mapping: `maxTimeoutSeconds` -> `deadline`

- Client signing rule: `deadline = signing_time + maxTimeoutSeconds`, ISO-8601 UTC (milliseconds permitted).
- Facilitator verification rule: MUST reject if `deadline <= now + settlementMargin` (expired or too tight to settle) or `deadline > now + maxTimeoutSeconds` (window exceeds the x402 timeout budget).

### Facilitator Verification Rules (MUST)

1. **Version, scheme, network, method.** `x402Version == 2`; scheme `exact` on both sides; `accepted.network == PaymentRequirements.network == "near:mainnet"`; `accepted.extra.assetTransferMethod == PaymentRequirements.extra.assetTransferMethod == "intents-verifier"`. The selected `delivery` value (default `"wallet"`) MUST also agree between `accepted.extra` and `PaymentRequirements.extra`.
2. **Standard allowlist.** `signedIntent.standard` MUST be a supported standard; reject others deterministically.
3. **Signature.** Recompute the signing bytes per standard (NEP-413 prehash for `nep413`; EIP-191 digest for `erc191`) and verify the signature. For recovery-based standards, the recovered key defines the signer.
4. **Signer authorization.** For implicit signers, the id derived from the (recovered or declared) public key MUST equal the decoded intent document's `signer_id`. For named accounts, the Verifier MUST report the key as registered for that `signer_id` (`has_public_key` view). NEAR account access keys are NOT the authority here — the Verifier's own key registry is.
5. **Nonce.** The standard-specific authorization nonce — the `nep413` envelope nonce or the `erc191` decoded-document nonce — MUST be 32 bytes and unused: `is_nonce_used(signer_id, nonce)` MUST return `false`. The Verifier enforces single-use per signer on chain. Facilitators still SHOULD track the `(Verifier, signer_id, nonce)` anchor while settlement is in flight to coalesce concurrent attempts and retain indeterminate outcomes.
6. **Deadline bounds** per the mapping above.
7. **Intent binding.** Exactly one intent, with the exact closed field set and token/receiver/amount equality required by the selected delivery mode.
8. **Balance preflight.** `mt_balance_of(signer_id, "nep141:<asset>")` on the Verifier MUST be ≥ `amount`. A signed intent does not lock that balance: another valid intent or withdrawal can consume it after a passing preflight. Settlement MUST repeat the check as late as practical before submission, but implementations MUST still handle an insufficient-balance race as a settlement failure.
9. **Delivery preflight.** For wallet delivery, `storage_balance_of(payTo)` on the token contract MUST be non-null.
10. **Simulation.** `simulate_intents([signedIntent])` (a read-only Verifier view taking the same input as `execute_intents`) MUST complete without panic and without an invariant violation. Implementations MUST validate the returned DIP-4 report, not merely the absence of a panic:
    - both modes require the expected `intents_executed` entry for `signer_id`, the authorization nonce, and the signed intent hash;
    - wallet delivery requires exactly one signer-attributed `ft_withdraw` event with the closed field set and exact token, receiver, and amount;
    - internal delivery requires exactly one signer-attributed `transfer` event with the closed field set and exact receiver and token amount.

    Simulation reads mutable state and excludes external asynchronous effects, so it cannot show the wallet's spawned token transfer or prove that `payTo` received funds. It MUST NOT replace signature verification (rule 3) or post-settlement receipt validation. The deployed defuse v0.4.2 contract reports `state.fee`, but its [fee application](https://github.com/near/intents/blob/defuse/v0.4.2/core/src/intents/token_diff.rs#L54-L76) is part of `token_diff`, which this method forbids; plain `transfer` and `ft_withdraw` are instead checked through their exact simulated events. If a deployed contract version changes these event or fee semantics so exactness cannot be established, verification MUST fail closed.
11. **Fail closed** on any RPC error, unparsable value, unexpected simulation event, or undeterminable state.

### Settlement

1. The facilitator submits `execute_intents({ "signed": [signedIntent] })` on `intents.near` from its own configured account, with gas within facilitator policy and no attached deposit.
2. Wait until the transaction and all spawned receipts finish executing.
3. Classify the authoritative outcome:
   - A synchronous `execute_intents` failure (including an insufficient-balance race) rolls back that receipt's Verifier state changes, including nonce consumption. Return `success: false`. Implementations MUST NOT infer retryability merely because the nonce remains unused; any later attempt must comply with the facilitator's durable-submission rules and fully reverify the authorization.
   - For **wallet** delivery, return `success: true` only when the exact `ft_withdraw`'s spawned token-contract `ft_transfer` receipt has status `SuccessValue` — outer `execute_intents` success and nonce consumption are not sufficient. If the asynchronous token transfer fails, the Verifier resolver refunds the debit to the payer's Verifier balance while the authorization nonce remains consumed. Return `success: false`; that signed payload is dead and the client MUST obtain a fresh 402 response and sign a new payload with a fresh nonce.
   - For **internal** delivery, the closed intent shape forbids notifications, so the ledger move is synchronous. A successful `execute_intents` receipt with the matching intent event is authoritative.
4. `payer` in `SettlementResponse` is the decoded intent document's verified `signer_id`.
5. Duplicate-settlement mitigation follows §10 of the `delegate` method, replacing the delegate-byte cache key with the verified chain-enforced anchor `(near:mainnet, intents.near, signer_id, raw 32-byte nonce)`. A second request with that anchor is an idempotent retry only when it binds the same standard-specific signed authorization; otherwise it is a conflicting replay. Implementations MUST compare the original signed application string and every signature-bound envelope field, key, and signature without making outer JSON object key order part of the identity. The Verifier's nonce guarantees at-most-once execution, **not successful delivery**. Because any account may submit the signed payload, recovery MUST bind the exact `signedIntent` to authoritative transaction, event, and (for wallet delivery) receipt evidence. `is_nonce_used == true` without that effect evidence is indeterminate: it MUST NOT produce `success: true`, trigger a replacement submission, or permit the dead payload to be treated as fresh. Retain the in-flight anchor until the terminal effect is authoritatively observed, or until the deadline passes with the nonce still unused.

### Comparison to the `delegate` Method

| | `delegate` (default) | `intents-verifier` |
| :--- | :--- | :--- |
| Payer needs a NEAR account | Yes, holding the token | No — any supported signature standard; implicit signers derived |
| Payer key constraint | Full-access key required (1 yocto rule) | Any registered/derivable key; key type not inspected |
| Custody before settlement | Payer's own token balance | Shared Verifier ledger (deposit required; blast radius = deposited balance) |
| Merchant receives | `ft_transfer` on the token contract | `ft_withdraw` to wallet (default) or Verifier-ledger credit (`internal`) |
| Testnet | Yes | No (mainnet-only Verifier) |
| Circle Developer-Controlled Wallets | NEAR wallet (`signDelegateAction`) | EVM wallet (`signMessage` emits exact `erc191` bytes) |

## Appendix

### Transport Header Mapping (HTTP v2)

- `PAYMENT-REQUIRED`: carries `PaymentRequired`.
- `PAYMENT-SIGNATURE`: carries `PaymentPayload`.
- `PAYMENT-RESPONSE`: carries `SettlementResponse`.

### References

- [x402 Core Specification v2](../../x402-specification-v2.md)
- [HTTP Transport v2](../../transports-v2/http.md)
- [Exact Scheme Overview](./scheme_exact.md)
- [NEP-141 Fungible Token Standard](https://nomicon.io/Standards/Tokens/FungibleToken/Core)
- [NEP-366 Delegate Action](https://nomicon.io/Standards/ChainAbstraction/MetaTransactions)
- [NEP-413 Signed Message Standard](https://nomicon.io/Standards/Wallets/WalletSignMessage)
- [NEAR Intents Verifier documentation](https://docs.near-intents.org)
- [NEAR Intents Verifier contract (defuse)](https://github.com/near/intents)
