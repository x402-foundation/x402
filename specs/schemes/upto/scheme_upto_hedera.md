# Scheme: `upto` on `Hedera`

## Summary

The `upto` scheme on Hedera enables usage-based payments where the client authorizes a **maximum amount** and the facilitator settles the **actual amount used** at the end of the request. It is the scheme for variable-cost resources — LLM token generation, bandwidth metering, dynamic compute — where the final price is not knowable until after the work is done.

This is the first non-EVM implementation of [`upto`](./scheme_upto.md). Hedera already contributes the [`exact`](../exact/scheme_exact_hedera.md) scheme; `exact` requires the price to be fixed before the work is done, so a metered seller must quote a worst case and keep the difference, or absorb the overage. `upto` closes that gap.

| AssetTransferMethod | Use Case | Notes |
| :--- | :--- | :--- |
| **`X402UptoProxy`** | HTS fungible tokens. Client signs a maximum with EIP-712; facilitator settles the actual. | Admin-less, immutable contract. The Hedera counterpart of the EVM scheme's `x402UptoPermit2Proxy`. |

> **Note**: Native **HBAR** (`asset: "0.0.0"`) is **not supported** for the `upto` scheme and MUST be rejected. An HBAR allowance is not reachable from a contract through the HTS ERC-20 facade; it requires the Hedera Account Service path (`hbarApprove` / `hbarAllowance`, [HIP-906](https://hips.hedera.com/hip/hip-906)) and a `cryptoTransfer` with the approval flag set. `upto` on Hedera is a stablecoin-metering scheme; a future revision MAY add native HBAR.

## Use Cases

- **LLM token generation**: client authorizes up to $0.50, actual charge based on tokens generated.
- **Bandwidth / data transfer**: pay per byte transferred in a single request, up to a cap.
- **Dynamic compute**: authorize a maximum cost, charge based on actual resources consumed.

## Prerequisites

1. **The client account MUST be ECDSA (secp256k1) with an EVM alias.** `ecrecover` recovers the alias-form address, and on Hedera the long-zero address of an alias-bearing account does not resolve in HTS calls (`INVALID_ALLOWANCE_OWNER_ID` as a sender, `INVALID_ALIAS_KEY` as a recipient). An ED25519 account cannot sign an `upto` authorization.
2. The client MUST be associated with the `asset` and hold a balance.
3. `payTo` MUST be associated with the `asset`, or hold an available auto-association slot.
4. **One time, per (client, token):** the client grants `X402UptoProxy` an HTS allowance covering the ceilings it intends to sign (see Phase 1).

## Protocol Flow

1. **Client** requests a protected resource.
2. **Resource Server** responds `402` with `PaymentRequirements` where `scheme: "upto"` and `amount` is the authorized **maximum**.
3. **Client** constructs an `Authorization` and signs it with EIP-712. No transaction is submitted.
4. **Client** re-requests with the `PaymentPayload`.
5. **Resource Server** forwards the payload to the facilitator's `/verify`, with `requirements.amount` = the **maximum**.
6. **Facilitator** verifies the signature, the bindings, the time bounds, the nonce, and the on-chain preconditions.
7. **Resource Server** performs the work and computes the **actual** amount consumed (≤ maximum).
8. **Resource Server** calls `/settle` with `requirements.amount` = the **actual** amount.
9. **Facilitator** re-verifies the signature **against the authorized maximum**, asserts `actual ≤ maximum`, and submits `X402UptoProxy.capture(authorization, signature, actual)` as the transaction fee payer.
10. **`X402UptoProxy`** enforces every invariant, consumes the nonce, and executes `transferFrom(from, payTo, actual)` via the HTS facade.
11. **Facilitator** returns a `SettlementResponse` carrying `amount` = the actual amount settled.
12. **Resource Server** grants access.

---

## 1. AssetTransferMethod: `X402UptoProxy`

On EVM, [`upto`](./scheme_upto_evm.md) uses **Permit2**: the client grants a blanket token approval to a canonical contract, then authorizes each payment with an off-chain EIP-712 signature carrying a witness that binds the recipient. A dedicated proxy enforces the scheme's invariants.

Hedera needs the same shape, for the same reason. A bare HTS allowance ([HIP-336](https://hips.hedera.com/hip/hip-336)) **cannot** satisfy this scheme: allowances are not single-use, they do not expire, and they do not bind a recipient — an allowance holder may move the owner's funds anywhere, up to the limit. That is precisely why Permit2 exists on EVM, and why an equivalent contract must exist here.

**`X402UptoProxy`** is that contract. The mechanism it relies on is native to Hedera:

- [HIP-336](https://hips.hedera.com/hip/hip-336) lets an account grant an HTS token allowance to **a contract**.
- [HIP-376](https://hips.hedera.com/hip/hip-376) exposes `approve` / `allowance` / `transferFrom` on an HTS token's ERC-20 facade, where `transferFrom` *"moves `amount` tokens from `from` to `to` using the allowance mechanism"* and the amount is *"deducted from **the caller's** allowance"* — the caller being the contract.

So an allowance granted with the SDK is spendable by the proxy, and the proxy — not the facilitator, not the resource server — enforces the scheme.

| | EVM | Hedera |
| :--- | :--- | :--- |
| Enforcement contract | `x402UptoPermit2Proxy` (+ Permit2) | `X402UptoProxy` |
| One-time approval | `approve(Permit2)` | `AccountAllowanceApproveTransaction` (HIP-336) |
| Per-payment authorization | EIP-712 `PermitWitnessTransferFrom` | EIP-712 `Authorization` |
| Settlement pull | `permitWitnessTransferFrom` | `transferFrom` via the ERC-20 facade (HIP-376) |
| Who pays the network fee | facilitator (sponsored) | facilitator (submits `capture`) |

### Phase 1: One-Time Allowance

The client grants `X402UptoProxy` an HTS allowance for the token, covering the sum of ceilings it intends to sign. This is the analogue of Permit2's one-time approval.

```ts
new AccountAllowanceApproveTransaction()
  .approveTokenAllowance(TOKEN_ID, CLIENT_ID, PROXY_CONTRACT_ID, MAX_TOTAL)
```

- The client MAY partially sign this transaction and have a facilitator pay the fee.
- It is **revocable at any time** by re-approving `0`.
- After this, **the client never sends another transaction and never pays another network fee.** Every subsequent payment costs it exactly one off-chain signature.

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field of the `PaymentPayload` contains:

- `signature`: a 65-byte secp256k1 signature (`r ‖ s ‖ v`) over the EIP-712 digest of `authorization`.
- `authorization`: the fields needed to reconstruct that digest.

All addresses are EVM addresses. **Accounts MUST use their EVM alias** — the form `ecrecover` returns and the only form HTS resolves. **Tokens and contracts use their long-zero address** (they have no alias).

**Facilitator address discovery.** The facilitator announces its address via the `/supported` endpoint, in the `extra` field of each supported scheme (`facilitatorEvm`). The client MUST bind this into `authorization.facilitator` when signing. This binds the authorization to a specific facilitator, preventing settlement by any other party.

**Example `PaymentRequired` (402 response):**

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "upto",
      "network": "hedera:testnet",
      "amount": "500000",
      "asset": "0.0.429274",
      "payTo": "0.0.1234",
      "maxTimeoutSeconds": 300,
      "extra": {
        "feePayer": "0.0.5678",
        "facilitatorEvm": "0xFacilitatorAliasAddress00000000000000000",
        "proxy": "0x000000000000000000000000000000000091d3f3",
        "proxyContractId": "0.0.9556979",
        "verifyingContract": "0x000000000000000000000000000000000091d3f3",
        "chainId": 296,
        "domainName": "x402-upto-hedera",
        "domainVersion": "1"
      }
    }
  ]
}
```

**Example `PaymentPayload` (client request):**

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
    "network": "hedera:testnet",
    "amount": "500000",
    "asset": "0.0.429274",
    "payTo": "0.0.1234",
    "maxTimeoutSeconds": 300,
    "extra": { "facilitatorEvm": "0xFacilitatorAliasAddress00000000000000000" }
  },
  "payload": {
    "signature": "0x…65 bytes (r‖s‖v)…",
    "authorization": {
      "token":        "0x0000000000000000000000000000000000068cda",
      "from":         "0x…client EVM alias…",
      "payTo":        "0x…payTo EVM alias…",
      "facilitator":  "0xFacilitatorAliasAddress00000000000000000",
      "maxAmount":    "500000",
      "validAfter":   "1784000000",
      "deadline":     "1784000300",
      "nonce":        "0x…32 bytes…",
      "resourceHash": "0x…32 bytes…"
    }
  }
}
```

#### EIP-712 typed data

```
domain = {
  name:              "x402-upto-hedera",
  version:           "1",
  chainId:           296,          // 295 on mainnet — a testnet signature is worthless on mainnet
  verifyingContract: <X402UptoProxy long-zero address>
}
```

```
Authorization(address token,address from,address payTo,address facilitator,uint256 maxAmount,uint256 validAfter,uint256 deadline,bytes32 nonce,bytes32 resourceHash)
```

The field order is normative — it determines the struct hash. `X402UptoProxy.hashAuthorization(a)` returns the same digest on-chain, so a client or facilitator MAY cross-check its off-chain construction against the contract's own.

#### `resourceHash`

With no terms, `keccak256(utf8(resourceUrl))`. When the resource server presents signed terms, they are joined to the URL with a `|` delimiter before hashing: `keccak256(utf8(resourceUrl + "|" + terms.join("|")))`, where each term is a compact JWS.

The contract emits `resourceHash` in its `Captured` event. Any signed document hashed into it therefore becomes **non-repudiable and publicly checkable**: a resource server cannot present one set of terms to the client and a different set to an auditor, because the published terms must hash to the value the chain records the client having signed. This composes with the [`offer-receipt`](../../extensions/extension-offer-and-receipt.md) extension (see [§5](#5-verifiable-receipts)).

### Phase 3: Verification Logic

The facilitator MUST execute these checks. On any failure it MUST return the corresponding error code (see [§4](#4-error-codes)) and MUST NOT settle.

1. **Requirements parity.**
   - `payload.accepted.scheme == requirements.scheme == "upto"`.
   - `payload.accepted.network == requirements.network`, a supported Hedera CAIP-2 identifier (`hedera:testnet` / `hedera:mainnet`).
   - `payload.accepted.asset`, `payTo`, and `maxTimeoutSeconds` MUST equal `requirements`'.
   - `requirements.asset` MUST be a valid HTS fungible token id and MUST NOT be `"0.0.0"`.

   > ⚠️ **The one rule that differs from `exact`.** The `exact` scheme requires `payload.accepted.amount == requirements.amount`. **`upto` MUST NOT** enforce this at settle time. These are two phases of one payment: `payload.accepted.amount` is the maximum the client signed; `requirements.amount` is what the server now wants to charge. The facilitator MUST assert `requirements.amount <= payload.accepted.amount` and MUST verify the signature against the **maximum** — never against the settlement amount. See [Settle-Time Verification](#settle-time-verification).

2. **Authorization integrity.**
   - Every field of `authorization` MUST be present and well-formed.
   - `authorization.maxAmount` MUST equal `payload.accepted.amount`. *(Otherwise a server could advertise a ceiling of $0.10, obtain a signature over $100, and settle $100.)*
   - `authorization.token` MUST resolve to `requirements.asset`.
   - `authorization.payTo` MUST resolve to `requirements.payTo`.
   - `authorization.facilitator` MUST be an address this facilitator controls.
   - `ecrecover(EIP-712 digest, signature)` MUST equal `authorization.from`, and `authorization.from` MUST be the EVM alias of a real, ECDSA Hedera account.
   - `validAfter <= now <= deadline`, within a documented clock-skew tolerance.

3. **On-chain state (fail closed).**
   - `X402UptoProxy.nonceUsed(from, nonce)` MUST be `false`.
     > Read this from a **consensus node** (e.g. a mirror-node contract-call or a consensus-node query), not from `eth_call` on a JSON-RPC relay. Relays simulate against slightly stale state, and a nonce burned seconds ago can still read as free. Replay protection MUST NOT be decided on stale data.
   - The client's allowance to the proxy MUST cover **the authorized maximum**, not merely today's charge.
   - The client's balance MUST cover the settlement amount.
   - `payTo` MUST be able to receive the asset (associated, or with an auto-association slot).

### Phase 4: Settlement Logic

Settlement is performed by calling `X402UptoProxy.capture(authorization, signature, amount)` with the **actual amount** to charge. The server determines that amount from resource consumption during the request (tokens generated, bytes transferred, time elapsed).

**Settlement amount rules:**

- The settled `amount` MUST be `<=` the authorized maximum (`authorization.maxAmount`).
- The settled `amount` MAY be `0` — the nonce is still consumed and no transfer occurs, so the authorization cannot be replayed.
- The settled `amount` is determined by the resource server, not the client.
- The facilitator MUST be the transaction fee payer for `capture`.

#### Settle-Time Verification

Before executing an on-chain settlement, the facilitator MUST re-verify the client's signature. Because the `upto` scheme uses phase-dependent `amount` semantics (see [§2](#2-paymentrequirements-schema)), the `/settle` request carries `paymentRequirements.amount` set to the **actual settlement amount**, which may be less than `paymentPayload.payload.authorization.maxAmount` (the **authorized maximum** the client signed).

The facilitator MUST handle this as follows:

1. **Verify the signature against `authorization.maxAmount`** — NOT against `paymentRequirements.amount`. The client signed for the ceiling; recovering against the metered amount would always fail for partial settlements.
2. **Validate** `paymentRequirements.amount <= authorization.maxAmount`.
3. **Submit** `capture(authorization, signature, paymentRequirements.amount)`. The contract independently re-checks all four MUSTs, the facilitator binding (`msg.sender == authorization.facilitator`), and `amount <= maxAmount`, then transfers the actual amount.

> **Conformance note**: A facilitator that enforces `paymentRequirements.amount === authorization.maxAmount` at settle time will reject all partial settlements, breaking the core `upto` value proposition. The Phase 3 equality check (`authorization.maxAmount === payload.accepted.amount`) constrains the *signed ceiling against the advertised ceiling*, not the settlement amount.

**Example settle request wire shape** (partial settlement):

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "upto", "network": "hedera:testnet", "amount": "500000", "asset": "0.0.429274", "payTo": "0.0.1234" },
    "payload": {
      "signature": "0x…",
      "authorization": {
        "token": "0x0000000000000000000000000000000000068cda",
        "from": "0x…client…", "payTo": "0x…payTo…",
        "facilitator": "0x…facilitator…",
        "maxAmount": "500000", "validAfter": "1784000000", "deadline": "1784000300",
        "nonce": "0x…", "resourceHash": "0x…"
      }
    }
  },
  "paymentRequirements": {
    "scheme": "upto", "network": "hedera:testnet",
    "asset": "0.0.429274", "payTo": "0.0.1234",
    "amount": "73100"
  }
}
```

In this example the client signed for up to `500000` atomic units. The resource server consumed `73100` units of work. The facilitator verifies the signature against `maxAmount` (`500000`), confirms `73100 <= 500000`, then submits `capture(authorization, signature, 73100)`.

**Example `SettlementResponse`:**

```json
{
  "success": true,
  "transaction": "0.0.5678@1784000123.000000000",
  "network": "hedera:testnet",
  "payer": "0.0.1111",
  "amount": "73100"
}
```

`transaction` carries the Hedera transaction ID of the `capture` call; `payer` is the client (`from`); `amount` is the actual amount settled, in atomic units.

---

## 2. PaymentRequirements Schema

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `scheme` | `string` | Required | Must be `"upto"`. |
| `network` | `string` | Required | Hedera CAIP-2 identifier (`hedera:testnet` / `hedera:mainnet`). |
| `amount` | `string` | Required | Phase-dependent: **maximum** at verification, **actual** at settlement. |
| `asset` | `string` | Required | HTS fungible token id (`0.0.x`). MUST NOT be `"0.0.0"` (HBAR). |
| `payTo` | `string` | Required | Recipient Hedera account id. |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion. |
| `extra` | `object` | Required | Scheme-specific fields (below). |

`extra` fields:

| Field | Description |
| :--- | :--- |
| `feePayer` | Hedera account id that pays the `capture` network fee — typically the facilitator. |
| `facilitatorEvm` | The facilitator's EVM alias, bound into `authorization.facilitator`. Only this facilitator may settle. |
| `proxy` / `verifyingContract` | The `X402UptoProxy` long-zero EVM address, and the EIP-712 `verifyingContract`. |
| `proxyContractId` | The proxy's Hedera contract id (`0.0.x`). |
| `chainId` | `296` (testnet) or `295` (mainnet). |
| `domainName` / `domainVersion` | `"x402-upto-hedera"` / `"1"`. |

> **Note**: As in the base scheme, the `amount` field is **phase-dependent** for server-to-facilitator communication: at *verification* time it is the **maximum** the client authorizes; at *settlement* time it is the **actual amount to settle**, which MUST be `<=` the previously authorized maximum. See [`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements).

## 3. SettlementResponse Schema Extension

The `upto` scheme extends the base [`SettlementResponse`](../../x402-specification-v2.md#53-settlementresponse-schema) with the actual settled amount:

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `success` | `boolean` | Required | Whether settlement succeeded. |
| `errorReason` | `string` | Optional | Error reason if settlement failed. |
| `transaction` | `string` | Required | Hedera transaction id of the `capture` call (empty string if `amount` was `0`). |
| `network` | `string` | Required | Hedera CAIP-2 identifier. |
| `payer` | `string` | Optional | The client account (`from`). |
| `amount` | `string` | Required | Actual amount charged, in atomic token units (may be `0`). |

## 4. Error Codes

The `upto` scheme on Hedera uses the standard x402 error codes defined in the [x402 specification](../../x402-specification-v2.md#9-error-handling) for shared conditions (`unsupported_scheme`, `network_mismatch`, `accepted_payment_requirements_mismatch`, `transaction_failed`).

It defines the following scheme-specific codes:

```
invalid_upto_hedera_payload_could_not_be_decoded
invalid_upto_hedera_payload_signature_invalid
invalid_upto_hedera_payload_from_not_ecdsa_alias
invalid_upto_hedera_amount_exceeds_authorized_max      # settlement amount > signed maximum
invalid_upto_hedera_max_amount_mismatch                # signed ceiling != advertised ceiling
invalid_upto_hedera_nonce_already_used
invalid_upto_hedera_authorization_expired
invalid_upto_hedera_authorization_not_yet_valid
invalid_upto_hedera_facilitator_not_managed
invalid_upto_hedera_recipient_mismatch
invalid_upto_hedera_asset_not_hts_fungible             # includes asset == "0.0.0" (HBAR)
invalid_upto_hedera_insufficient_allowance
invalid_upto_hedera_insufficient_balance
invalid_upto_hedera_pay_to_not_associated
```

## 5. Verifiable Receipts

`resourceHash` (Phase 2) turns the authorization into an audit anchor. When the resource server signs its **offer** (which commits `maxAmount`) and a **price schedule** (which commits the unit price) and hashes them into `resourceHash`, the chain's `Captured` event records the hash of the exact terms the client signed. Publishing a signed **meter reading** alongside — the units consumed and the resulting `amount` — makes the final bill *arithmetic anyone can check*: `unitPrice × units` must equal the captured `amount`, and the terms must hash to the on-chain `resourceHash`, or the discrepancy is on the public record.

This composes with the [`offer-receipt`](../../extensions/extension-offer-and-receipt.md) extension.

> **Note for `upto` generally, on every network.** The canonical `offer-receipt` payloads carry **no meter reading** — the offer commits `amount` (here, the maximum) and the receipt commits `payer`, `issuedAt`, and `transaction`. Neither commits the **unit price** or the **units consumed**. An `upto` receipt is therefore unverifiable as written: the server alone decides the final charge, and nothing in the artifacts lets anyone check it. Implementations that care SHOULD sign a price schedule alongside the offer and a meter reading alongside the receipt, and bind both into `resourceHash`. This is arguably a gap in the extension rather than in this scheme, and applies to `upto` on EVM as much as on Hedera.

## Annex

### Reference Implementation: `X402UptoProxy`

- **Contract** — [`X402UptoProxy.sol`](https://github.com/Madhav-Gupta-28/Tally/blob/main/contracts/X402UptoProxy.sol). Admin-less and immutable: no owner, no pause, no upgrade path. It never custodies the asset (it needs no association) and holds no balance. The facilitator permitted to settle a given payment is named in the *client's signature*, not in contract storage, so the proxy stays permissionless. Effects precede interactions (the nonce burns before the transfer), and the high-`s` signature twin is rejected, so each authorization has exactly one valid signature.
- **Packages** — [`x402-hedera-upto`](https://www.npmjs.com/package/x402-hedera-upto) (client / resource-server / facilitator scheme implementations against `@x402/core`) and [`x402-hedera-receipts`](https://www.npmjs.com/package/x402-hedera-receipts) (the offer/schedule/meter signing and the audit).
- **Deployment** — the reference proxy is deployed and verified on Hedera **testnet** at contract id `0.0.9556979` (long-zero `0x000000000000000000000000000000000091d3f3`). Its invariants are asserted against the live deployment, and each negative case is checked twice: that the transaction reverted on-chain, and that the revert names the expected custom error. `capture()` costs 81,308 gas.

### Contract errors

`X402UptoProxy` reverts with typed custom errors that correspond to the facilitator codes above: `NonceUsed`, `Expired`, `NotYetValid`, `AmountExceedsMax`, `BadSignature`, `NotFacilitator`, `TransferFailed`, `ZeroAddress`.

## Security Considerations

1. **The proxy has no privileged party.** There is nobody to compromise and no key to steal that would let anyone move a client's funds. The only thing that can move them is a signature the client produced, and only to the address it named.
2. **The allowance is the blast radius.** A client that approves the proxy for 20 USDC is exposed to at most 20 USDC across all outstanding authorizations, and can revoke instantly by re-approving `0`. This is the same trade Permit2 makes on EVM.
3. **The facilitator cannot steal.** It can decline to settle, and it can settle for less than the server asked. It cannot settle for more than the client signed, cannot redirect the funds, and cannot settle an authorization that names a different facilitator.
4. **The resource server chooses the final amount below the ceiling.** This is inherent to `upto` on every network — clients bear the risk of the full authorized amount being charged, and should authorize accordingly. §5 describes how to make that choice auditable rather than merely trusted.
5. **Signature malleability is rejected.** Signatures with `s` above `secp256k1n / 2` are refused, so an authorization has exactly one valid signature. The nonce already prevents replay; this is defence in depth.
6. **Time bounds limit exposure.** `validAfter` / `deadline` are inside the signed struct and enforced on-chain, bounding the lifetime of an unused authorization.
