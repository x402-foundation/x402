# Scheme: `exact` on `NEAR`

## Summary

The `exact` scheme on NEAR lets a client pay an exact amount of a NEP-141 token while a facilitator-sponsored relayer submits the on-chain transaction.

The client signs a NEP-366 `SignedDelegateAction` that authorizes one exact `ft_transfer` call. The facilitator verifies that payload against `PaymentRequirements`, then submits it through a relayer account selected from facilitator configuration.

NEAR account keys and signatures may use either `ed25519` or `secp256k1`; implementers should account for both when validating signed delegate actions.

## Versions Supported

This specification supports **x402 v2 only**.

- `x402Version` in `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` MUST be `2`.
- v1 fields and headers are out of scope.

## Supported Networks

NEAR networks MUST use CAIP-style identifiers:

- `near:mainnet`
- `near:testnet`

Implementations MAY support additional `near:*` identifiers, but this spec defines behavior for the two canonical networks above.

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
- `extra`, when present, MUST NOT alter the required transfer target, amount, nonce, expiry, or settlement semantics.

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
