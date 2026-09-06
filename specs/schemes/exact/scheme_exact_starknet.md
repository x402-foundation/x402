# Scheme: `exact` on `Starknet`

## Summary

The `exact` scheme on Starknet transfers a specific amount of a token (e.g., USDC) from the client to the resource server using [SNIP-9 Outside Execution](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-9.md). The client signs a [SNIP-12](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-12.md) typed-data message authorizing exactly one `transfer` call from its own account contract. The facilitator causes that authorization to execute on-chain via `execute_from_outside_v2` on the client's account — from its own account or a forwarder it routes through — and pays all gas.

- **No token approvals and no client gas**: the signed message contains the exact transfer calldata; the client never submits a transaction. There is no `approve`/`transfer_from` step and no spender allowance.
- **On-chain replay protection**: SNIP-9 nonces are single-use, independent of the account's transaction nonce, and enforced by the client's account contract; the facilitator needs no persistent state.
- **Account-abstraction native**: signature validity is checked via the account's own [SNIP-6](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-6.md) `is_valid_signature`, so any account implementation (standard, multisig, hardware-backed) works.

## Versions supported

- ❌ `v1`
- ✅ `v2` — `x402Version` MUST be `2`.

Only SNIP-9 version 2 (`execute_from_outside_v2`, SNIP-12 revision `1`) is supported; v1 outside executions (revision `0`) MUST be rejected.

## Supported Networks

Starknet networks MUST use [CAIP-2](https://namespaces.chainagnostic.org/starknet/caip2) identifiers:

- `starknet:SN_MAIN` — Starknet mainnet
- `starknet:SN_SEPOLIA` — Starknet Sepolia testnet

The CAIP-2 reference is the string form of the chain id returned by `starknet_chainId` (`SN_MAIN` = `0x534e5f4d41494e`, `SN_SEPOLIA` = `0x534e5f5345504f4c4941`). The namespace registry document predates the Goerli→Sepolia migration and lists only `SN_MAIN`/`SN_GOERLI`; `starknet:SN_SEPOLIA` follows the namespace's chain-id resolution rule.

## Terminology

- **Client**: The end user initiating the payment; owner of the payer account contract (`payload.from`).
- **Merchant**: The resource server receiving payment, identified by `payTo`.
- **Sponsor**: The entity that pays the gas for settlement and causes the `OutsideExecution` to execute on-chain — the **facilitator**, which MAY be operated by the merchant itself or by a third party. The client never communicates with it directly; all facilitator interaction is proxied through the resource server.
- **Fee Payer (`feePayer`)**: The Starknet address the client MUST set as the SNIP-9 `Caller`, and which will therefore be the on-chain caller of `execute_from_outside_v2` — the sponsor's own executor account, or a forwarder it routes through. The name is aligned with the sibling network specs; note that on Starknet this address is the *submission authority* the payer's account checks. It is the account that pays gas only in the direct-executor case — when the sponsor routes through a forwarder, the `Caller` is a contract and the fee is paid by the sponsor's relayer behind it. Which of the two the sponsor uses is a sponsor-local implementation detail that never reaches the client.

## Protocol Flow

The protocol flow for `exact` on Starknet is client-driven: the client builds and signs the `OutsideExecution` itself and never communicates with the facilitator directly — every facilitator interaction is proxied through the resource server. Before serving a `402`, the resource server takes `extra.feePayer` from its facilitator's `/supported` entry for that network.

1. Client requests a resource; the server responds `402` with a `PaymentRequired` object whose Starknet `exact` entry carries `extra.feePayer`, identifying the sponsor.
2. Client selects a Starknet `exact` entry from `accepts` and builds a single `transfer(recipient, amount)` call against the `asset` token contract, where `recipient = payTo` and the u256 `amount` equals `amount` from the requirements.
3. Client wraps the call in a SNIP-9 `OutsideExecution` with a fresh nonce, `Caller` set to `extra.feePayer`, and time bounds per the Timeout Mapping (`Execute Before = now + maxTimeoutSeconds`).
4. Client signs the typed data with its account key(s) via the wallet's SNIP-12 typed-data signing operation, producing a felt-array signature.
5. Client resends the request with the `PaymentPayload` attached.
6. Resource server forwards the payload and requirements to the facilitator's `/verify` endpoint; the facilitator enforces the verification rules below.
7. On `isValid: true`, the resource server requests settlement via `/settle`. The facilitator re-verifies, executes `execute_from_outside_v2` on the client's account, and waits for confirmation.
8. Resource server returns the response with the `SettlementResponse` attached.

## `PaymentRequirements` for `exact`

`PaymentRequirements` follows the core v2 schema; in addition to the standard fields, the `exact` scheme on Starknet requires one field inside `extra`: `feePayer`.

```json
{
  "scheme": "exact",
  "network": "starknet:SN_SEPOLIA",
  "amount": "10000",
  "asset": "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
  "payTo": "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81"
  }
}
```

### Field Notes

- `network`: CAIP-2 Starknet network identifier.
- `amount`: required payment amount in the token's atomic units, as a base-10 string (e.g., `"10000"` = 0.01 USDC with 6 decimals).
- `asset`: Starknet contract address of a [SNIP-2](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-2.md) token. The token MUST expose the standard `transfer(recipient: ContractAddress, amount: u256)` entry point and a balance getter — `balance_of`, or the camelCase `balanceOf` SNIP-2 recommends for backwards compatibility.
- `payTo`: recipient's Starknet address.
- `extra.feePayer` (REQUIRED): the Starknet address the client MUST set as the SNIP-9 `Caller` of the `OutsideExecution` it signs. It is the address that will call `execute_from_outside_v2` at settlement — the sponsor's own executor account, or a forwarder it routes through — and therefore the address the payer's account observes as the `Caller`. Resource servers MUST take this value verbatim from the `extra.feePayer` of their facilitator's `/supported` entry for the same `network` (see Facilitator `/supported` Entry). Binding the `Caller` to it means only the sponsor can execute the authorization (see Security Considerations).
- `extra.feePayer` MUST be a concrete address: it MUST NOT be zero, MUST NOT equal `payload.from`, and MUST NOT be the SNIP-9 any-caller sentinel `0x414e595f43414c4c4552` (the short string `ANY_CALLER`), which the payer's account treats as a wildcard and which would silently turn a bound authorization back into a bearer one that anyone could submit. It MAY equal `payTo` (merchant-sponsored settlement). Clients MUST refuse to sign against a forbidden value; facilitators MUST reject it (rules 1 and 4).
- Because `extra.feePayer` is required, every payment in this scheme is sponsored and the client never needs gas funds. How the sponsor settles behind that address — its own account, a forwarder, or a SNIP-29 paymaster — is facilitator-local configuration, MUST NOT be required from the client-facing `PaymentRequirements`, and MUST NOT require any client↔facilitator interaction: the client builds and signs the `OutsideExecution` from the `PaymentRequirements` alone. Whatever assembles the typed data on the client side, the signer MUST verify the final message against its own intent before signing — exactly one `Call` with `To` = the requirements' `asset`, `Selector` = `sn_keccak("transfer")`, `Calldata` = `[payTo, amount_low, amount_high]` for the exact required amount, `Caller` = `extra.feePayer`, and time bounds per the Timeout Mapping — since the signature authorizes exactly what the message says.

### Timeout Mapping: `maxTimeoutSeconds` → Time Bounds

SNIP-9 time bounds are Unix seconds checked strictly (`Execute After < block_timestamp < Execute Before`) against the sequencer's block timestamp, which can lag wall clock. Facilitators MUST absorb that lag with a skew margin `skewMargin` (SHOULD be ≤ 60 seconds, an upper bound on observed sequencer timestamp lag) wherever it could flip a check:

- Client signing rule: `Execute Before = now + maxTimeoutSeconds`; `Execute After` SHOULD be well in the past (e.g., `1`).
- Facilitator verification rules (at `/verify`):
  - MUST reject if `Execute After >= now - skewMargin` (`invalid_payload`).
  - MUST reject if `Execute Before < now + maxTimeoutSeconds - skewMargin` (`outside_execution_expired`) — the authorization MUST remain valid for the full advertised settlement window, so a stale signature (or one signed against a smaller window) is rejected up front rather than left to expire mid-settlement.
  - MUST reject if `Execute Before > now + maxTimeoutSeconds + skewMargin` (`outside_execution_window_exceeds_max_timeout`).
  - With the client signing rule, these bound `Execute Before` to `now + maxTimeoutSeconds ± skewMargin`: a payload is only accepted within `skewMargin` of signing.
- At **both** `/verify` and settlement-time re-verification: MUST reject if `Execute Before <= now + minSettleMargin` (RECOMMENDED ≥ 30 seconds, covering broadcast-to-inclusion latency) so a settlement transaction cannot expire in flight (`outside_execution_expired`). This floor is the binding lower bound when `maxTimeoutSeconds` is small; servers SHOULD advertise `maxTimeoutSeconds` comfortably above `skewMargin + minSettleMargin`.
- At settlement-time re-verification the freshness lower bound (`Execute Before >= now + maxTimeoutSeconds - skewMargin`) does not re-apply — remaining validity necessarily shrinks while the resource server prepares settlement; only the minimum-remaining-window floor and the upper bound are enforced.

## `PaymentPayload` `payload` Field

The `payload` field of `PaymentPayload` is:

```json
{
  "from": "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24",
  "outsideExecution": {
    "typedData": { "...": "SNIP-12 typed data, see below" },
    "signature": ["0x0721...", "0x05fa..."]
  }
}
```

- `from`: the payer's Starknet account contract address. Required because the signer's address is not part of the SNIP-12 message; it determines which account contract validates the signature and executes the calls.
- `outsideExecution.typedData`: the complete SNIP-12 typed-data object the client signed. The facilitator MUST derive the transfer's recipient, amount, and token from `typedData.message.Calls` and MUST NOT rely on any other field for payment intent.
- `outsideExecution.signature`: the signature as an array of hex-encoded felts, passed verbatim to `is_valid_signature`. For standard single-key accounts this is `[r, s]`; other account implementations (multisig, guardians) MAY produce longer arrays.

### SNIP-12 Typed Data Structure

The typed data MUST be a SNIP-12 revision `1` `OutsideExecution` (SNIP-9 version 2):

```json
{
  "types": {
    "StarknetDomain": [
      { "name": "name", "type": "shortstring" },
      { "name": "version", "type": "shortstring" },
      { "name": "chainId", "type": "shortstring" },
      { "name": "revision", "type": "shortstring" }
    ],
    "OutsideExecution": [
      { "name": "Caller", "type": "ContractAddress" },
      { "name": "Nonce", "type": "felt" },
      { "name": "Execute After", "type": "u128" },
      { "name": "Execute Before", "type": "u128" },
      { "name": "Calls", "type": "Call*" }
    ],
    "Call": [
      { "name": "To", "type": "ContractAddress" },
      { "name": "Selector", "type": "selector" },
      { "name": "Calldata", "type": "felt*" }
    ]
  },
  "primaryType": "OutsideExecution",
  "domain": {
    "name": "Account.execute_from_outside",
    "version": "2",
    "chainId": "0x534e5f5345504f4c4941",
    "revision": "1"
  },
  "message": {
    "Caller": "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81",
    "Nonce": "0x71b7b56b17c8e0f4dcd0d9427c30d0a8bfa3c53f4d95a3b26f6cf14f3d0f8e2",
    "Execute After": "1",
    "Execute Before": "1768312445",
    "Calls": [
      {
        "To": "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
        "Selector": "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
        "Calldata": [
          "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57",
          "0x2710",
          "0x0"
        ]
      }
    ]
  }
}
```

`Caller` is `extra.feePayer` from the `PaymentRequirements`. `Selector` is `sn_keccak("transfer")`. `Calldata` is the Starknet ABI serialization of `(recipient: ContractAddress, amount: u256)`: exactly three felts `[recipient, amount_low, amount_high]`.

> **Hash-encoding note (SNIP-9/SNIP-12 exception):** when computing the SNIP-12 domain hash, `version` MUST encode as the felt integer `2` (not the short string `'2'` = `0x32`) and `revision` MUST encode as the felt integer `1` (not `'1'` = `0x31`), despite both fields being typed `shortstring`. `chainId` encodes as the short-string felt. Standard SNIP-12 implementations handle this exception.

### Full `PaymentPayload` Example

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "starknet:SN_SEPOLIA",
    "amount": "10000",
    "asset": "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
    "payTo": "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81"
    }
  },
  "payload": {
    "from": "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24",
    "outsideExecution": {
      "typedData": { "...": "as above" },
      "signature": ["0x0721...", "0x05fa..."]
    }
  }
}
```

## Facilitator Verification Rules (MUST)

A facilitator MUST enforce all of the following before returning `isValid: true`. If any check cannot be safely determined (RPC failure, unparsable value), verification MUST fail closed.

All felt/address comparisons MUST be performed numerically (as field elements), never as strings: Starknet addresses and felts have no canonical hex padding or case.

### 1. Version, Scheme, and Network

- `PaymentPayload.x402Version` MUST be `2`.
- `accepted.scheme` MUST be `exact` and `accepted.network` MUST be a supported `starknet:*` identifier.
- `accepted` MUST match the `PaymentRequirements` supplied by the resource server to the facilitator — never the client's echo — field-by-field (`scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds`, and `extra.feePayer`). A mismatch MUST be rejected with `invalid_payload` (`invalid_scheme`/`invalid_network` for those two fields).
- The server-supplied requirements themselves MUST be well-formed: `amount` a base-10 integer string, `maxTimeoutSeconds` a finite positive number, and `extra.feePayer` present and a valid non-zero Starknet address that is neither the any-caller sentinel nor equal to `payload.from`. The facilitator MUST additionally reject a `feePayer` it cannot itself settle through — a stale or foreign value would produce an authorization only some other party could execute. Malformed or incomplete requirements MUST be rejected (`invalid_payment_requirements`) — implementations MUST NOT let a missing field silently disable a dependent check (e.g., a NaN window bound, or an absent `feePayer` turning the caller binding into a no-op).

### 2. Typed Data Canonicalization

- The facilitator MUST NOT compute the signature hash from the client-supplied `typedData` as received. It MUST parse `domain.chainId` and the five message fields (`Caller`, `Nonce`, `Execute After`, `Execute Before`, `Calls`), reconstruct the canonical SNIP-9 v2 typed data defined above from those values, and compute the SNIP-12 message hash from its own reconstruction. Unknown or missing keys in `domain` or `message` MUST be rejected (`invalid_payload`).
- `domain.chainId` MUST equal the chain id of `accepted.network` (`SN_MAIN` ↔ `starknet:SN_MAIN`, `SN_SEPOLIA` ↔ `starknet:SN_SEPOLIA`), comparing the short-string felt numerically.

### 3. Signature Verification

- Compute the SNIP-12 message hash of the reconstructed typed data for the account `payload.from`.
- Call `is_valid_signature(hash, signature)` on `payload.from` and require the SNIP-6 magic value `VALID` (`0x56414c4944`). Failure: `invalid_exact_starknet_payload_signature`.
- The signature array MUST be passed to the account verbatim; facilitators MUST NOT assume a two-element `[r, s]` shape.
- The account contract MUST be deployed: if its class hash cannot be resolved, fail closed with `account_not_deployed`; if the `is_valid_signature` call reverts, fail closed with `invalid_exact_starknet_payload_signature`.

### 4. Caller Binding

- `message.Caller` MUST equal `accepted.extra.feePayer`. Any other value MUST be rejected (`invalid_exact_starknet_payload_caller`) — settlement would revert on-chain.
- There is no sentinel branch and no trusted-forwarder exception. Rule 1 has already rejected any requirement whose `feePayer` is the any-caller sentinel, so a payload reaching this rule is always bound to a concrete address; a facilitator MUST NOT accept a `Caller` merely because it appears in local configuration.

### 5. Execution Time Window

- The time bounds MUST satisfy the Timeout Mapping rules above: the freshness band at `/verify`, the minimum-remaining-window floor at both phases.

### 6. Replay Protection

- Call `is_valid_outside_execution_nonce(message.Nonce)` on `payload.from`; the nonce MUST be unused, and a failed call (e.g. an account without SNIP-9 v2 support) fails closed — both with `nonce_already_used`. SNIP-9 nonces are single-use and enforced by the account contract at execution time, so no facilitator-side nonce storage is required.

### 7. Payment Intent and Exactness

- `message.Calls` MUST contain exactly one call. No additional calls are permitted.
- `Calls[0].To` MUST equal `accepted.asset` (`invalid_exact_starknet_payload_asset_mismatch`).
- `Calls[0].Selector` MUST equal `sn_keccak("transfer")` (`0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e`).
- `Calls[0].Calldata` MUST be exactly three felts `[recipient, amount_low, amount_high]`, with `amount_low < 2^128` and `amount_high < 2^128`.
- `recipient` MUST equal `accepted.payTo` (`invalid_exact_starknet_payload_recipient_mismatch`).
- `amount_low + (amount_high << 128)` MUST equal `accepted.amount` exactly. Overpayment and underpayment MUST both be rejected (`invalid_exact_starknet_payload_amount_mismatch`).

### 8. Chain-State Preflight

- The payer's `accepted.asset` balance MUST be a valid u256 (via `balance_of` or `balanceOf`) greater than or equal to `accepted.amount`, else `insufficient_funds`; a token exposing neither getter fails closed (`invalid_payment_requirements`).
- The facilitator MUST simulate the settlement via `starknet_simulateTransactions` (skip-validate, skip-fee-charge, v3 `INVOKE`) and MUST fail closed (`simulation_failed`) unless the trace shows exactly one `Transfer` emitted by `accepted.asset`, from `payer` to `payTo`, for exactly `accepted.amount`. An event that cannot be attributed to the `asset` contract (via its enclosing call frame) MUST NOT count as proof of payment. For both this rule and settlement step 4, a `Transfer` is an event emitted by `accepted.asset` whose first key is `sn_keccak("Transfer")`; facilitators MUST recognize both standard layouts — keyed (`keys = [selector, from, to]`, `data = [amount_low, amount_high]`) and legacy unkeyed (`keys = [selector]`, `data = [from, to, amount_low, amount_high]`) — and MUST fail closed on a matching-key event that fits neither layout. Simulating the full `execute_from_outside_v2` call tree is preferred, and facilitators SHOULD therefore advertise a `feePayer` they can originate a simulation from; when `extra.feePayer` is a forwarder the facilitator cannot originate from, the facilitator MAY instead simulate the `transfer` from the payer and rely on rules 3–6 plus the paymaster's own estimation at settlement.

### 9. Facilitator Safety

- The submitting executor account MUST be selected from trusted facilitator configuration, never from client-supplied payload fields, and MUST NOT be `payload.from`.
- A facilitator MUST only announce as `feePayer` an address it can settle through **and** from which only it can cause a call into the payer's account — its own executor account, or a forwarder that restricts who may invoke it. A permissionlessly-invokable forwarder satisfies the payer account's `Caller` check for any invoker, and announcing one would leave the rule 4 binding in place while providing none of its protection.
- The executor MUST only ever sign the `INVOKE` wrapping `execute_from_outside_v2`.
- `payer` MUST only be included on a response once the payer's signature has been verified; it MUST NOT be echoed from unverified client input.

Unlike chains where the client sets the transaction fee, here the client signs only the inner OutsideExecution and the facilitator/paymaster alone sets the outer `INVOKE` fee — so a client cannot directly inflate the sponsored gas. The residual risk is gas spent on settlements that fail the effect check or revert despite passing verification (e.g. an account whose `is_valid_signature` and execution paths diverge, or an account upgraded between verify and settle). To bound it, facilitators SHOULD cap the sponsored settlement fee (reject when an estimate exceeds a configured bound) and apply per-payer rate limits, and — because settlement spends sponsored gas — SHOULD restrict which resource servers may request settlement. The mandatory simulation (rule 8) confirms on either simulation path that the only `asset` `Transfer` is payer → `payTo`; only the full call tree additionally exercises the account's execution path — the transfer-only fallback leaves exactly the residual gas risk described above. No balance change accrues to the facilitator's executor beyond the transaction fee.

### Error Codes

`invalidReason` and `errorReason` MUST be stable enum tokens (below) so consumers can switch on them; human-readable context MUST NOT be appended to the code, and MUST be carried in a separate diagnostic field if the response schema provides one. Standard v2 codes (`insufficient_funds`, `invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `invalid_network`, `invalid_x402_version`, `invalid_transaction_state`, `unexpected_verify_error`, `unexpected_settle_error`) apply as usual. Starknet-specific values:

| Code | Meaning |
| ---- | ------- |
| `invalid_exact_starknet_payload_signature` | `is_valid_signature` did not return `VALID` |
| `invalid_exact_starknet_payload_asset_mismatch` | `Calls[0].To` ≠ `asset` |
| `invalid_exact_starknet_payload_recipient_mismatch` | transfer recipient ≠ `payTo` |
| `invalid_exact_starknet_payload_amount_mismatch` | transfer amount ≠ `amount` |
| `invalid_exact_starknet_payload_caller` | `message.Caller` ≠ `extra.feePayer` |
| `account_not_deployed` | payer account contract not deployed |
| `outside_execution_expired` | `Execute Before` has passed or leaves less than the required window (freshness band at `/verify`; `minSettleMargin` floor at both phases) |
| `outside_execution_window_exceeds_max_timeout` | window exceeds `maxTimeoutSeconds` budget |
| `nonce_already_used` | SNIP-9 nonce already consumed |
| `simulation_failed` | settlement simulation reverted or showed unexpected transfers |
| `duplicate_settlement` | same nonce already submitted by this facilitator |
| `settlement_pending` | broadcast succeeded but confirmation is not yet established — **non-terminal**; deliberately carries a non-empty `transaction` with `success: false` so the caller can reconcile on-chain before retrying |

The `amount` in `PaymentRequirements` MUST be a base-10 integer string; hex/octal/binary/signed/whitespace forms MUST be rejected (`invalid_payment_requirements`). Facilitators SHOULD bound the `PaymentPayload` signature array length (e.g. reject beyond ~32 felts) so an oversized signature cannot amplify resource use.

### Implementing Verification with Starknet JSON-RPC

All checks are implementable against a stock public Starknet JSON-RPC node:

| Check | Method |
| ----- | ------ |
| Account deployment (§3) | `starknet_getClassHashAt` (class-resolution failure → `account_not_deployed`) |
| Signature (§3) | `starknet_call` → `is_valid_signature` on the account |
| Nonce (§6) | `starknet_call` → `is_valid_outside_execution_nonce` on the account |
| Balance (§8) | `starknet_call` → `balance_of`/`balanceOf` on the token |
| Simulation (§8) | `starknet_simulateTransactions` |
| Current time (§5) | wall clock, optionally cross-checked with the latest block timestamp via `starknet_getBlockWithTxHashes` |

## Settlement

1. Re-run all verification rules, including simulation. The facilitator MUST NOT trust a prior `/verify` result.
2. Execute the outside execution: cause a call to `execute_from_outside_v2(outside_execution, signature)` on `payload.from` whose on-chain caller is `extra.feePayer`. Whether the facilitator submits that `INVOKE` from its own funded account or routes it through a forwarder/[SNIP-29](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-29.md) paymaster whose forwarder contract is the announced `feePayer` is a sponsor-local implementation detail invisible to the client.
3. Wait for the transaction to reach finality status `ACCEPTED_ON_L2` (or `ACCEPTED_ON_L1`). `ACCEPTED_ON_L2` is a sequencer commitment prior to L1 finality and can, in rare cases, be reverted in an L2 reorg; waiting for `ACCEPTED_ON_L1` removes that risk at the cost of hours-scale latency.
4. Check the receipt's `execution_status` AND its effect. Settlement succeeds only if `execution_status` is `SUCCEEDED` **and** the receipt emits exactly the expected `Transfer` (exactly one `Transfer` emitted by `accepted.asset`, from `payer` to `payTo`, for exactly `accepted.amount` — the same criterion as rule 8). A `SUCCEEDED` transaction that does not emit that transfer MUST be reported as failure (`invalid_transaction_state` — the payment did not verifiably occur) — because `execute_from_outside_v2` runs inside the payer's own (possibly adversarial) account, a non-reverting transaction is not by itself proof the payment executed. A `REVERTED` transaction MUST also fail (`invalid_transaction_state`); a revert rolls back the SNIP-9 nonce, so the authorization remains valid and the facilitator SHOULD allow the same payment to be retried. If post-broadcast confirmation cannot be established (RPC failure after the transaction was submitted), the facilitator MUST NOT report success and MUST NOT report a plain terminal failure either: the transfer may still land. It MUST return the non-terminal `settlement_pending` code with the transaction hash in the `transaction` field so the caller reconciles on-chain before retrying, and, while that outcome is unresolved, MUST NOT re-broadcast the same `(payload.from, Nonce)` authorization and MUST reject repeat settlement requests for it with `duplicate_settlement`. While the guard holds, a blind retry is rejected with `duplicate_settlement`; after eviction, a retry re-enters verification, fails the minimum-remaining-window check (`outside_execution_expired`), and resolves via the consumed-nonce rule in step 5.
5. If the nonce turns out to be already consumed — settlement re-verification fails with `nonce_already_used`, a post-eviction retry fails re-verification with `outside_execution_expired`, or the settlement transaction reverts for that reason — the facilitator SHOULD locate the consuming transaction; if it executed the identical `OutsideExecution` (same hash) **and** its receipt shows `execution_status` `SUCCEEDED` and **contains** the expected `Transfer` (emitted by `accepted.asset`, from `payer` to `payTo`, for exactly `accepted.amount`; containment, not step 4's exactly-one — the consuming transaction was submitted outside this settlement attempt, so its full contents are not under this facilitator's control) — i.e., the payment itself verifiably landed on-chain — the facilitator SHOULD report `success: true` with that transaction hash, otherwise `nonce_already_used`. This makes a duplicate or concurrent settlement of the same authorization — a post-eviction retry, or a race between replicas of one facilitator sharing the announced `feePayer` — a no-op rather than a paid-but-denied outcome. Implementations that match by (payer, payTo, amount) Transfer events MUST additionally confirm the consuming transaction carries this payload's SNIP-9 nonce, so a different same-amount payment cannot be mistaken for this one.
6. Return the `SettlementResponse` with the transaction hash. RPC acceptance or pending status is not sufficient for `success: true`; the protected resource MUST only be released after the transfer has succeeded on-chain.
7. Facilitators MUST NOT leak raw paymaster/RPC exception text to clients; client-facing error text MUST be generic.

On `success: false`, `payer` MUST only be included if independently verified by the facilitator.

### Facilitator `/supported` Entry

The facilitator announces the address that will be the on-chain caller in the `extra` of its `/supported` kind; resource servers copy it verbatim into `PaymentRequirements.extra.feePayer`.

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "starknet:SN_SEPOLIA",
  "extra": { "feePayer": "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81" }
}
```

`extra.feePayer` is REQUIRED on every Starknet `exact` kind; a facilitator that cannot commit to a submitting address MUST NOT advertise the kind. A facilitator that rotates its `feePayer` MUST continue to settle authorizations bound to the retired address for at least `maxTimeoutSeconds + skewMargin` after removing it from `/supported`, and resource servers SHOULD keep serving a retired `feePayer` for the same grace window, so authorizations already signed against it remain settleable. Facilitators SHOULD also list under a `starknet:*` key in the `/supported` response's `signers` map the accounts that actually sign the settlement `INVOKE` — which equals `feePayer` in the direct-executor case, but is the relayer behind the forwarder when routing through a paymaster.

## `SettlementResponse` Example

```json
{
  "success": true,
  "transaction": "0x02c92a2967d6963a4bd75897facef1e131b2379a8fbfbd05e5fac48e0a09a30e",
  "network": "starknet:SN_SEPOLIA",
  "payer": "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24"
}
```

Failure:

```json
{
  "success": false,
  "errorReason": "duplicate_settlement",
  "transaction": "",
  "network": "starknet:SN_SEPOLIA"
}
```

## Duplicate Settlement Mitigation (RECOMMENDED)

### Vulnerability

If the same `PaymentPayload` is submitted to `/settle` twice in quick succession (retry, or a race between servers sharing a facilitator), both submissions can pass verification before the first execution consumes the SNIP-9 nonce, causing the second to revert on-chain and burn executor gas.

### Recommended Mitigation

Facilitators SHOULD keep a short-lived cache keyed by `(payload.from, message.Nonce)`:

1. On `/settle`, reject immediately with `duplicate_settlement` if the key is present.
2. Insert the key before broadcasting; evict it on definitive broadcast failure or a definitively reverted execution (the revert rolls back the SNIP-9 nonce, so the authorization remains retryable) so legitimate retries are not blocked.
3. Evict entries once `Execute Before + skewMargin` has passed, after which the authorization can no longer execute even with sequencer-timestamp lag.
4. The key intentionally covers any payload sharing the nonce — only one of them can ever execute on-chain.

The pre-broadcast dedup cache is an optimization only; the SNIP-9 nonce remains the authoritative replay protection. The observable requirement in settlement step 4 — never re-broadcasting an authorization whose outcome is unresolved — is normative regardless of how it is tracked. A per-process cache does not protect horizontally scaled facilitators — those need a shared store, or accept the residual race (safe on-chain; only gas is at stake).

## Appendix

### Account compatibility

Current versions of the major Starknet account contracts (Argent/Ready, Braavos, and OpenZeppelin's SRC9 component) implement SNIP-9 v2; older non-upgraded deployments may not; the nonce preflight (rule 6) fails closed for such accounts, and full call-tree simulation (rule 8) detects them.

### Security Considerations

- **Replay**: prevented on-chain by the single-use SNIP-9 nonce (§6), bounded by the `Execute Before` deadline (§5).
- **Authorization scope**: the signature covers the exact calls, caller, nonce, and window; the single-call rule (§7) prevents call smuggling under sponsored gas.
- **Submission binding**: `Caller` = `extra.feePayer` (§4) means only the sponsor can execute the authorization, so a third party that observes the signed payload cannot submit it, and cannot grief the payer's SNIP-9 nonce or burn the sponsor's gas on a guaranteed-revert transaction. This holds only when the announced `feePayer` is an address from which only the sponsor can cause a call (§9); a permissionlessly-invokable forwarder would re-open it.
- **Settlement atomicity**: `execute_from_outside_v2` executes the transfer in the same transaction that consumes the nonce; a revert rolls back both.

### References

- [x402 v2 Specification](../../x402-specification-v2.md)
- [Exact Scheme Overview](./scheme_exact.md)
- [SNIP-9: Outside Execution](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-9.md)
- [SNIP-12: Off-chain Typed Data Hashing and Signing](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-12.md)
- [SNIP-6: Standard Account Interface](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-6.md)
- [SNIP-2: Starknet Token Standard](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-2.md)
- [SNIP-29: Applicative Paymaster API Standard](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-29.md)
- [CAIP-2 Starknet Namespace](https://namespaces.chainagnostic.org/starknet/caip2)
