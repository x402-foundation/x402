# Scheme: `batch-settlement` on `EVM`

## Summary

The `batch-settlement` scheme on EVM is a **capital-backed** network binding using stateless unidirectional payment channels for high-throughput, low-cost payments. Clients deposit funds into onchain channels once and sign off-chain **cumulative vouchers** per request. Servers verify vouchers with fast signature checks and claim them onchain periodically in batches, reducing both latency and gas costs drastically. A single claim transaction can cover many channels at once and only updates onchain accounting; claimed funds are later transferred to the receiver via a separate settle operation that sweeps many claims into one token transfer.

The scheme supports **dynamic pricing**: the client authorizes a maximum per-request, and the server charges the actual cost within that ceiling.

The scheme also supports two **voucher-management modes**, which differ in whether the resource server (**self-managed**, the default) or the facilitator (**facilitator-managed**) keeps the latest voucher and runs the claim/settle schedule. See [Voucher Management](#voucher-management).

---

## Channel Lifecycle

### Channel creation and deposits

A channel is created implicitly on the first deposit. The client deposits funds from the `payer` address into an onchain escrow via one of two asset transfer methods: `eip3009` for tokens that support `receiveWithAuthorization` (e.g. USDC) or `permit2` as a universal fallback for any ERC-20. Deposits are sponsored by the facilitator (gasless for the client).

Channel identity is derived from an immutable config struct:

```solidity
struct ChannelConfig {
    address payer;              // Client wallet (EOA or smart wallet)
    address payerAuthorizer;    // EOA for voucher signing, or address(0) for EIP-1271 via payer
    address receiver;           // Server's payment destination (EOA or routing contract)
    address receiverAuthorizer; // Authorizes claims and refunds via EIP-712 signatures
    address token;              // ERC-20 payment token
    uint40  withdrawDelay;      // Seconds before timed withdrawal completes (15 min – 30 days)
    bytes32 salt;               // Differentiates channels with identical parameters
}
```

with `channelId = EIP712Hash(ChannelConfig)` under the `x402 Batch Settlement` domain. The hash binds the immutable config to the EVM `chainId` and deployed `x402BatchSettlement` address, so the same config produces different IDs across chains or deployments.

### Requests and vouchers

The channel tracks two values: `balance` (total deposited minus withdrawals and refunds) and `totalClaimed` (cumulative amount claimed by the server). Each voucher the client signs carries a cumulative ceiling (`maxClaimableAmount`). The server can claim up to that ceiling. Because vouchers are monotonically increasing, old vouchers with lower ceilings are naturally superseded.

The server tracks a running total of actual charges per channel (`chargedCumulativeAmount`). For each subsequent request, the client sets the voucher's `maxClaimableAmount` to `chargedCumulativeAmount + amount`, where `amount` is the per-request maximum. 

### Claim and settle

The server claims the latest voucher per channel onchain at its discretion. `claimWithSignature(claims, signature)` allows aggregating claims from multiple channels in one call. Claiming updates `totalClaimed` per channel; no token transfer occurs.

`settle` sweeps all claimed-but-unsettled funds to the `receiver` in one transfer. 

### Refund and withdrawal

**Cooperative refund**: the receiver side can return up to `balance - totalClaimed` to the payer via two paths:
- `refund(config, amount)`: direct call by `receiver` or `receiverAuthorizer`, no signature required.
- `refundWithSignature(config, amount, nonce, sig)`: relay-friendly; anyone submits an EIP-712 `Refund` signature from `receiverAuthorizer`.

Both paths share the same internal execution: `refundNonce` is incremented **first** (before the amount cap is applied and before any token transfer), so a no-op refund (`amount > 0` but no unclaimed escrow available) still advances the nonce without emitting `Refunded` or moving tokens. A direct `refund` call therefore invalidates any pre-signed `refundWithSignature` digest for the previous nonce. If a timed withdrawal is pending, a cooperative refund **reduces** its recorded amount proportionally; it is only cancelled entirely when the refund amount meets or exceeds the pending withdrawal amount.

**Timed withdrawal** (escape hatch): the `payer` or `payerAuthorizer` calls `initiateWithdraw(config, amount)` to start a grace period. The requested `amount` must not exceed `balance - totalClaimed` at initiation time; the call reverts otherwise. During the grace period the server can claim outstanding vouchers. After the withdrawal delay elapses, `finalizeWithdraw` (also callable by `payerAuthorizer`) completes the withdrawal, capping the transferred amount to whatever unclaimed escrow remains at that point.

### Authorizer roles

**Payer authorizer** (`payerAuthorizer`): if set to a non-zero address (an EOA), vouchers are verified via ECDSA recovery against that committed key ( fast, no RPC required). If set to zero, vouchers are verified against the payer address, supporting EIP-1271 smart wallets at the cost of an RPC call.

**Receiver authorizer** (`receiverAuthorizer`): authorizes claim and refund operations via EIP-712 signatures. The server chooses this address: a server-owned EOA or smart contract (eg for key rotation), or a facilitator-provided address when the server delegates authorization. Must not be zero. Anyone can relay a `claimWithSignature` or `refundWithSignature` transaction with a valid authorization signature from the `receiverAuthorizer`.

### Channel lifecycle events

The contract emits `ChannelCreated(channelId, config)` on the first deposit into a channel (when `balance` transitions from zero with `totalClaimed == 0`). It emits `ChannelClosed(channelId, config)` when unclaimed escrow returns to zero with `totalClaimed == 0` — triggered by either a full cooperative refund or a timed withdrawal that drains all escrow. Indexers must handle `ChannelCreated` firing more than once on the same `channelId` if the channel is re-funded after being fully drained.

### Channel reuse and parameter changes

Channels are long-lived. After a refund, the client can top up and reuse the same channel. However, the channel config is immutable. If any parameter needs to change, a new channel is required. If delegating `receiverAuthorizer` to a facilitator, the server should claim all outstanding vouchers and refund remaining balances on old channels before switching to another facilitator. In facilitator-managed mode with a server-owned refund key, the `refundAuthorizer` is part of `salt`, so rotating it also requires a new channel.

---

## Voucher Management

The scheme has two voucher-management modes. They differ in who stores the latest client-signed voucher and the per-channel charge total (`chargedCumulativeAmount`, the "watermark"), and in who decides when to claim and settle onchain.

| Mode                    | `extra.voucherManager` | Voucher `/settle`            | Watermark and claim/settle schedule | Authoritative store  |
| ----------------------- | ---------------------- | ---------------------------- | ----------------------------------- | -------------------- |
| **Self-managed**        | omitted or `"server"`  | No                           | Resource server                     | Server channel store |
| **Facilitator-managed** | `"facilitator"`        | Yes — durable offchain write | Facilitator                         | Facilitator          |

In **self-managed** mode the resource server owns the per-channel state and the facilitator only verifies payloads and submits onchain transactions. In **facilitator-managed** mode the resource server is a pass-through: it calls `/verify` then `/settle` for every payload (including `voucher`) and uses the settle result as the payment response. The facilitator verifies every payload, persists vouchers, `chargedCumulativeAmount`, and a `chargeCount` (see [Payment Response Contract](#payment-response-contract)) on `/settle`, and claims and settles on a schedule (see [Claim & Settlement Strategy](#claim--settlement-strategy)). Per-channel serialization is described under [POST /verify](#post-verify).

**Selecting the mode.** A facilitator advertises the voucher-management modes it supports as `voucherManager: ["server", "facilitator"]` on `/supported`; omitting the field means `["server"]`. A facilitator offering `"facilitator"` also advertises `receiverAuthorizer` and `withdrawDelay`, and MAY advertise `delegatedRefund: true` (see [GET /supported](#get-supported)). The server picks one mode and sets the single value `voucherManager` on the 402, copying `receiverAuthorizer` and `withdrawDelay` as well; it MUST NOT override `withdrawDelay`, and MUST NOT choose a mode the facilitator did not advertise. The client echoes the value and reads it only to decide whether to pack the refund authorizer into `salt` (see [402 Response](#402-response-paymentrequirements)).

---

## 402 Response (PaymentRequirements)

The 402 response contains pricing terms and the server's channel parameters. The client maps `payTo` → `ChannelConfig.receiver`, `extra.receiverAuthorizer` → `ChannelConfig.receiverAuthorizer`, `asset` → `ChannelConfig.token`, and `extra.withdrawDelay` → `ChannelConfig.withdrawDelay`, then fills in its own `payer`, `payerAuthorizer`, and `salt` to construct the full config.

In facilitator-managed mode the server copies `receiverAuthorizer` and `withdrawDelay` from `/supported`, sets `voucherManager: "facilitator"`, and sets `refundAuthorizer` only when it signs refunds with its own key (see below).

```jsonc
{
  "scheme": "batch-settlement",
  "network": "eip155:8453",
  "amount": "100000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo": "0xServerReceiverAddress",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "receiverAuthorizer": "0xReceiverAuthorizerAddress",
    "withdrawDelay": 900,
    "name": "USDC",
    "version": "2",
    "minDeposit": "1000000"
    // Facilitator-managed only:
    // "voucherManager": "facilitator",
    // Only when the server signs refunds with its own EOA:
    // "refundAuthorizer": "0xRefundAuthorizerAddress"
  }
}
```

| Field                       | Type      | Required        | Description                                                                                      |
| --------------------------- | --------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `extra.receiverAuthorizer`  | `string`  | yes             | Address that will authorize claims/refunds                                                       |
| `extra.withdrawDelay`       | `number`  | yes             | Withdrawal delay in seconds (15 min – 30 days)                                                   |
| `extra.assetTransferMethod` | `string`  | optional        | `"eip3009"` (default) or `"permit2"`                                                             |
| `extra.name`                | `string`  | yes             | EIP-712 domain name of the token contract                                                        |
| `extra.version`             | `string`  | yes             | EIP-712 domain version of the token contract                                                     |
| `extra.minDeposit`          | `string`  | optional        | Atomic deposit target. When present, MUST be a positive integer `>= amount`.                     |
| `extra.voucherManager`      | `string`  | optional        | `"server"` (default) or `"facilitator"` manages vouchers (see [Voucher Management](#voucher-management)) |
| `extra.refundAuthorizer`    | `string`  | conditional     | Server-owned EOA that consents to cooperative refunds. Facilitator-managed mode only, and only when the server signs refunds with its own key; omitted otherwise (see below) |
| `extra.channelState`        | `object`  | optional        | Corrective-only server channel snapshot for cumulative amount resynchronization                  |
| `extra.voucherState`        | `object`  | optional        | Corrective-only signed voucher proof for cumulative amount resynchronization                     |

Clients SHOULD use a conforming `extra.minDeposit` as the deposit target, and SHOULD enforce a local maximum deposit so a 402 cannot lock unbounded escrow. Servers SHOULD NOT reject a deposit solely because `deposit.amount` is below this field. A server that applies a local minimum-deposit policy MAY reject and MUST return `invalid_batch_settlement_evm_deposit_below_min_deposit`. The facilitator MUST NOT enforce `minDeposit`.

`extra.channelState` and `extra.voucherState` appear only on a **corrective 402**, which the voucher manager returns when the client's cumulative amount is out of sync (see [Recovery After State Loss](#recovery-after-state-loss)).

**Refund authorizer (facilitator-managed mode only).** A cooperative refund bypasses the withdrawal delay, and `/settle` is otherwise unauthenticated. In self-managed mode the refund consent is the server's own `refundAuthorizerSignature`, or, when the server delegates `receiverAuthorizer`, the facilitator's authentication of the `/settle` caller (see [Security and Trust](#security-and-trust)); no `extra.refundAuthorizer` is used and the salt is never packed. In facilitator-managed mode the facilitator is always the `receiverAuthorizer` and signs the onchain refund itself, so it needs separate proof that the server consents to each refund. The 402 selects how that proof is given:

- **A server-owned EOA** (stable per receiver until rotated). The server sets `extra.refundAuthorizer` to that address and signs each refund with that key (see [Cooperative refund flow](#cooperative-refund-flow)).
- **The facilitator's `/settle` caller authentication.** The server omits `extra.refundAuthorizer`. This requires the facilitator to advertise `delegatedRefund: true` on `/supported`. No signature is needed; the facilitator authenticates the caller as the service that created the channel.

When `voucherManager` is `"facilitator"` and `extra.refundAuthorizer` is present, the client MUST set `ChannelConfig.salt = bytes12(entropy) || bytes20(refundAuthorizer)`, which binds the address into `channelId` so a `/settle` caller cannot substitute a different refund authorizer. When `extra.refundAuthorizer` is omitted, the salt is the raw client salt. Self-managed channels never pack, so their `channelId` does not depend on `extra.refundAuthorizer`. `entropy` is a 12-byte channel index: if the caller's salt has zero high 12 bytes (left-padded `0`, `1`, `2`, …), use the low 96 bits; otherwise keep the first 12 bytes of a 32-byte salt. Changing this address, like any other config parameter, requires a new channel.

---

## Client: Payment Construction

The client constructs a payment payload whose type depends on channel state:

- `deposit`: No channel exists or balance is exhausted — client signs a token authorization and voucher
- `voucher`: Channel has sufficient balance — client signs a new cumulative voucher
- `refund`: Client requests a cooperative refund — client signs a zero-charge voucher and optionally includes a refund amount

In facilitator-managed mode the payloads are identical, except that `accepted` echoes the managed 402 (including `voucherManager` and, when present, `refundAuthorizer`) and `channelConfig.salt` uses the packed layout when `refundAuthorizer` is present.

### Deposit Payload

The `deposit.authorization` field contains the token transfer authorization — exactly one of `erc3009Authorization` or `permit2Authorization` must be present.

```jsonc
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement",
    "network": "eip155:8453",
    "amount": "1000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xServerReceiverAddress",
    "maxTimeoutSeconds": 3600,
    "extra": {
      "receiverAuthorizer": "0xReceiverAuthorizerAddress",
      "withdrawDelay": 900,
      "name": "USDC",
      "version": "2"
      // Facilitator-managed only:
      // "voucherManager": "facilitator",
      // Only when the server signs refunds with its own EOA:
      // "refundAuthorizer": "0xRefundAuthorizerAddress"
    }
  },
  "payload": {
    "type": "deposit",
    "channelConfig": {
      "payer": "0xClientAddress",
      "payerAuthorizer": "0xClientPayerAuthorizerEOA",
      "receiver": "0xServerReceiverAddress",
      "receiverAuthorizer": "0xReceiverAuthorizerAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "withdrawDelay": 900,
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
      // With voucherManager "facilitator" and extra.refundAuthorizer (packed layout): bytes12(entropy) || bytes20(refundAuthorizer)
      // "salt": "0x000000000000000000000000aaaabbbbccccddddeeeeffffaaaabbbbccccdddd"
    },
    "voucher": {
      "channelId": "0xabc123...channelId",
      "maxClaimableAmount": "1000",
      "signature": "0x...EIP-712 voucher signature"
    },
    "deposit": {
      "amount": "100000",
      "authorization": {
        "erc3009Authorization": {
          "validAfter": "0",
          "validBefore": "1770000000",
          "salt": "0x...authorization salt",
          "signature": "0x...ERC-3009 signature"
        }
      }
    }
  }
}
```

### Voucher Payload

```json
{
  "x402Version": 2,
  "accepted": { "..." : "..." },
  "payload": {
    "type": "voucher",
    "channelConfig": {
      "payer": "0xClientAddress",
      "payerAuthorizer": "0xClientPayerAuthorizerEOA",
      "receiver": "0xServerReceiverAddress",
      "receiverAuthorizer": "0xReceiverAuthorizerAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "withdrawDelay": 900,
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
    },
    "voucher": {
      "channelId": "0xabc123...channelId",
      "maxClaimableAmount": "5000",
      "signature": "0x...EIP-712 voucher signature"
    }
  }
}
```

### Refund Payload

The optional `amount` requests a partial refund; omit it for a full refund. The voucher is zero-charge: `voucher.maxClaimableAmount` MUST equal the channel's current `chargedCumulativeAmount`. Before settlement, the server completes the payload with the refund nonce, claim data, and any receiver-authorizer signatures it is responsible for.

```json
{
  "x402Version": 2,
  "accepted": { "..." : "..." },
  "payload": {
    "type": "refund",
    "channelConfig": {
      "payer": "0xClientAddress",
      "payerAuthorizer": "0xClientPayerAuthorizerEOA",
      "receiver": "0xServerReceiverAddress",
      "receiverAuthorizer": "0xReceiverAuthorizerAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "withdrawDelay": 900,
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
    },
    "voucher": {
      "channelId": "0xabc123...channelId",
      "maxClaimableAmount": "3200",
      "signature": "0x...EIP-712 zero-charge voucher signature"
    },
    "amount": "1500"
  }
}
```

---

## Server: State & Forwarding

This section describes **self-managed** mode, where the server is the sole owner of per-channel state. In **facilitator-managed** mode the server is a pass-through (see [Voucher Management](#voucher-management)); only the Payment Response Contract and Cooperative refund flow below apply to it.

A facilitator-managed server MAY persist a copy of the latest voucher after a successful `/settle`, solely to enable out-of-band `claim()` / `refund()`. The replica MUST NOT drive cumulative checks, per-channel locks, or corrective 402s.

### Per-Channel State

The server must maintain per-channel state, keyed by channel ID:

| State Field               | Type            | Description                                                                                |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `channelConfig`           | `ChannelConfig` | Full channel configuration object                                                          |
| `chargedCumulativeAmount` | `uint128`       | Actual accumulated cost for this channel                                                   |
| `signedMaxClaimable`      | `uint128`       | `maxClaimableAmount` from the latest client-signed voucher                                 |
| `signature`               | `bytes`         | Client's voucher signature for the latest `signedMaxClaimable`                             |
| `balance`                 | `uint128`       | Current channel balance (mirrored from onchain)                                            |
| `totalClaimed`            | `uint128`       | Total claimed onchain (mirrored from onchain)                                              |
| `withdrawRequestedAt`     | `uint64`        | Unix timestamp when timed withdrawal was initiated, or 0 if none (mirrored from onchain)   |
| `refundNonce`             | `uint256`       | Next nonce required for `refundWithSignature` (mirrored from onchain)                      |
| `onchainSyncedAt`         | `uint64`        | Local timestamp when mirrored onchain fields were refreshed                                |
| `lastRequestTimestamp`    | `uint64`        | Timestamp of the last paid request                                                         |

### Request Processing

The server must serialize request processing per channel and must not update voucher state until the resource handler has succeeded.

1. **Verify**:
   - For `voucher` and `deposit` payloads, check that `payload.voucher.maxClaimableAmount == chargedCumulativeAmount + paymentRequirements.amount`. If this fails, reject with `invalid_batch_settlement_evm_cumulative_amount_mismatch` and return a corrective 402.
   - For refund payloads, check that `payload.voucher.maxClaimableAmount == chargedCumulativeAmount` and skip the resource handler after facilitator verification.
   - Always call facilitator `/verify` for `deposit` and `refund` payloads, as well as `voucher` payloads with EIP-1271 vouchers.
   - A plain EOA-authorized `voucher` may be verified locally when the server's mirrored onchain state is fresh. 
2. **Execute**: Run the resource handler
3. **On success** — commit state:
   - `chargedCumulativeAmount += actualPrice` (where `actualPrice <= PaymentRequirements.amount`)
   - Mirror `balance`, `totalClaimed`, `withdrawRequestedAt`, and `refundNonce` from the facilitator response
4. **On failure**: State unchanged, client can retry the same voucher.

### Payment Response Contract

Both modes produce this shape. In facilitator-managed mode the facilitator `/settle` response is the payment response.

Successful paid responses distinguish onchain transfers from offchain charges:

- Voucher-only response: `transaction` is `""`, top-level `amount` is `""`, `extra.chargedAmount` is the request charge, and `extra.channelState` carries the channel snapshot.
- Deposit response: `transaction` is the deposit transaction hash, top-level `amount` is the deposited amount, `extra.chargedAmount` is the request charge, and `extra.channelState` carries the channel snapshot.
- Refund response: `transaction` is the refund transaction hash, top-level `amount` is the refunded amount, `extra.channelState` carries the post-refund channel snapshot and `extra.chargedAmount` is omitted.

```jsonc
{
  "success": true,
  "transaction": "",
  "network": "eip155:8453",
  "payer": "0xClientAddress",
  "amount": "",
  "extra": {
    "chargedAmount": "700",
    // Facilitator-managed only:
    // "chargeCount": 4,
    "channelState": {
      "channelId": "0xabc123...channelId",
      "balance": "100000",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0,
      "refundNonce": "1",
      "chargedCumulativeAmount": "3900"
    }
  }
}
```

**Charge count.** Facilitator-managed responses (all three types) also include `extra.chargeCount`. It is the number of paid offchain commits since the last confirmed onchain claim — an unattested delta, not a lifetime total. The facilitator increments it on each `type: "voucher"` commit and on the voucher persisted with a `type: "deposit"`; zero-charge refunds and cancel settles do not increment it. Each claim attests the delta onchain (see [Claim & Settlement Strategy](#claim--settlement-strategy)).

### Cooperative refund flow

When the server receives a `type: "refund"` payload:

1. **Verify (zero-charge)**: enforce `payload.voucher.maxClaimableAmount == chargedCumulativeAmount` (no increment from `paymentRequirements.amount`). If local state is stale, emit a corrective 402 so the client can recover and retry.
2. **Bypass the protected resource.** Refund payloads are payment operations, not paid requests; the application route is not invoked.
3. **Complete the settlement payload**: resolve omitted `amount` to a full refund, validate any partial `amount`, add `refundNonce`, build `claims`, and add receiver-authorizer signatures when the server owns that key.
4. **Submit onchain**: `claimWithSignature(claims, claimSig)` (no-op when `maxClaimableAmount == totalClaimed`) followed by `refundWithSignature(config, amount, nonce, refundSig)`. The contract increments `refundNonce` before applying the amount cap; even if no tokens move (zero available escrow), the nonce advances.
5. **Update channel state**:
   - **Full refund** (refunded amount equals the remainder): delete the channel record.
   - **Partial refund**: keep the channel record, mirror the returned `balance`, `totalClaimed`, `withdrawRequestedAt`, and `refundNonce`. If a timed withdrawal was pending, its recorded amount is reduced proportionally (or cancelled if the refund covers it entirely).
6. Return the settle response in the standard `PAYMENT-RESPONSE` header.

After the server completes the refund payload, the facilitator receives:

```json
{
  "type": "refund",
  "channelConfig": { "..." : "..." },
  "voucher": {
    "channelId": "0xabc123...channelId",
    "maxClaimableAmount": "3200",
    "signature": "0x...EIP-712 zero-charge voucher signature"
  },
  "amount": "1500",
  "refundNonce": "1",
  "claims": [
    {
      "voucher": {
        "channel": { "..." : "..." },
        "maxClaimableAmount": "3200"
      },
      "signature": "0x...EIP-712 zero-charge voucher signature",
      "totalClaimed": "3200"
    }
  ],
  "refundAuthorizerSignature": "0x...refund authorization",
  "claimAuthorizerSignature": "0x...claim authorization"
}
```

`refundAuthorizerSignature` and `claimAuthorizerSignature` are included when the server owns the receiver-authorizer key. If the channel delegates receiver authorization to the facilitator, the server omits both and the facilitator signs the onchain `Refund` and `ClaimBatch` digests itself, after authenticating the `/settle` caller as the service that created the channel.

In facilitator-managed mode the facilitator always signs, so it needs proof that the server consents to the refund. That proof depends on whether the 402 carries `extra.refundAuthorizer`:

- **`extra.refundAuthorizer` present (server-owned EOA)**: the address unpacked from `channelConfig.salt` MUST equal `extra.refundAuthorizer`. The server attaches `refundAuthorizerSignature`, signed by that address over the EIP-712 `Refund` digest (`Refund(bytes32 channelId,uint256 nonce,uint128 amount)`). The facilitator recovers the signer and only then submits `refundWithSignature`.
- **`extra.refundAuthorizer` omitted**: no signature is attached. The facilitator authenticates the `/settle` caller as the service that created the channel and rejects all others. This is available only when the facilitator advertises `delegatedRefund: true`.

---

## Facilitator Interface

Uses the standard x402 facilitator interface (`/verify`, `/settle`, `/supported`).

### POST /verify

Verifies a deposit, voucher, or refund payment payload. Returns the onchain channel snapshot:

```jsonc
{
  "isValid": true,
  "payer": "0xPayerAddress",
  "extra": {
    "channelId": "0xabc123...",
    "balance": "1000000",
    "totalClaimed": "500000",
    "withdrawRequestedAt": 0,
    "refundNonce": "0"
    // Facilitator-managed only:
    // "chargedCumulativeAmount": "3900",
    // "pendingId": "0x...server-authored reservation"
  }
}
```

**Facilitator-managed `/verify`** also returns the offchain watermark (`chargedCumulativeAmount`) and `extra.pendingId`, a server-authored reservation (not a PAYMENT-RESPONSE field):

- The facilitator MUST take a short-lived exclusive lock per `channelId`, bound to the verified voucher so a replayed or guessed `pendingId` cannot admit a different voucher. A second in-flight request returns `invalid_batch_settlement_evm_channel_busy` (retryable). The facilitator SHOULD run stateless checks (`channelConfig` against the `channelId` and requirements, EOA voucher signatures) before acquiring the lock.
- The lock is not a payment commit: the watermark does not advance until `/settle`.
- A client-supplied `pendingId` or `cancel` MUST be rejected.
- Managed `deposit` and `refund` `/settle` MUST hold the channel lock from before the onchain submission until the result is persisted, so a voucher cannot commit against escrow the transaction is about to move. A reservation that lapsed before `/settle` is re-acquired; another live holder fails the settle with `invalid_batch_settlement_evm_pending_id_mismatch`.

On `invalid_batch_settlement_evm_cumulative_amount_mismatch`, managed `/verify` returns `extra.channelState` and `extra.voucherState` (same objects as the corrective 402). The resource server copies those onto `accepts[].extra`.

### POST /settle

| `payload.type` | When Used                        | Onchain Effect                                                                       |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `"deposit"`    | First request or top-up          | Deposit via the canonical ERC-3009 or Permit2 collector                              |
| `"voucher"`    | Facilitator-managed paid request | None — persist voucher; `chargedCumulativeAmount += actual`; increment `chargeCount` |
| `"claim"`      | Server batches voucher claims    | Validate vouchers, update accounting (no transfer)                                   |
| `"settle"`     | Server transfers earned funds    | Transfer unsettled amount to receiver                                                |
| `"refund"`     | Cooperative refund               | Return specified amount to payer, increment refund nonce                             |

`type: "voucher"` is valid only in facilitator-managed mode (`extra.voucherManager === "facilitator"`); self-managed `/settle` rejects it with `invalid_batch_settlement_evm_payload_type`. Its response is the voucher-only payment response (see [Payment Response Contract](#payment-response-contract)).

In facilitator-managed mode, `deposit` and `voucher` settles commit a charge as follows:

- `/verify` sees the per-request maximum, `payload.accepted.amount`. The settle-time charge `actual` is `paymentRequirements.amount` on the settle call and MAY be lower. Managed `/verify` MUST reject the payload when `payload.accepted.amount` differs from `paymentRequirements.amount`.
- `/settle` MUST reject `actual` above `payload.accepted.amount`, and MUST commit only when `chargedCumulativeAmount` equals `voucher.maxClaimableAmount - payload.accepted.amount` (so `chargedCumulativeAmount + actual <= voucher.maxClaimableAmount`).
- A repeated settle after that commit is not idempotent: it MUST leave `chargedCumulativeAmount` unchanged and return `invalid_batch_settlement_evm_cumulative_amount_mismatch`. Callers MUST NOT auto-retry `POST /settle`.
- Deposit `/settle` also persists the deposit's voucher, initializes the watermark, and increments `chargeCount`.

Facilitator-managed `/settle` MAY add two server-authored fields on the existing `deposit` / `voucher` / `refund` payload:

| Field       | Type      | When                                                                                                                                             |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pendingId` | `string`  | Echo of `extra.pendingId` from `/verify`. A live reservation with a different voucher fails the settle; an omitted `pendingId` fully re-verifies. |
| `cancel`    | `boolean` | `true` on handler cancel (`paymentRequirements.amount` is `"0"`). Facilitator releases the reservation and MUST NOT charge, deposit, or refund.  |

```json
{
  "payload": {
    "type": "voucher",
    "channelConfig": { "...": "..." },
    "voucher": { "...": "..." },
    "pendingId": "0x...server-authored reservation",
    "cancel": true
  }
}
```

Server-authored claim and settle payloads use the same `type` discriminator:

```json
{
  "type": "claim",
  "claims": [
    {
      "voucher": {
        "channel": { "..." : "..." },
        "maxClaimableAmount": "5000"
      },
      "signature": "0x...voucher signature",
      "totalClaimed": "5000"
    }
  ],
  "claimAuthorizerSignature": "0x...claim authorization"
}
```

`claimAuthorizerSignature` is included when the server owns the receiver-authorizer key. If receiver authorization is delegated to the facilitator, the server omits it and the facilitator signs before submitting the transaction.

```json
{
  "type": "settle",
  "receiver": "0xServerReceiverAddress",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
}
```

Example facilitator response for a claim:

```json
{
  "success": true,
  "transaction": "0x...transactionHash",
  "network": "eip155:8453",
  "amount": ""
}
```

`amount` is empty because claim only updates accounting; no funds move.

Example facilitator response for a settle:

```json
{
  "success": true,
  "transaction": "0x...transactionHash",
  "network": "eip155:8453",
  "amount": "5000"
}
```

`amount` is the amount transferred to the receiver; if settlement is a no-op, it is `"0"`.

Example facilitator response for a deposit (see [Payment Response Contract](#payment-response-contract) for the managed extras):

```jsonc
{
  "success": true,
  "transaction": "0x...transactionHash",
  "network": "eip155:8453",
  "payer": "0xPayerAddress",
  "amount": "100000",
  "asset": "0xAssetAddress",
  "extra": {
    // Facilitator-managed only:
    // "chargedAmount": "700",
    // "chargeCount": 4,
    "channelState": {
      "channelId": "0xabc123...",
      "balance": "100000",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0,
      "refundNonce": "1"
      // Facilitator-managed only:
      // "chargedCumulativeAmount": "3900"
    }
  }
}
```

Example facilitator response for a refund:

```jsonc
{
  "success": true,
  "transaction": "0x...transactionHash",
  "network": "eip155:8453",
  "payer": "0xPayerAddress",
  "amount": "1500",
  "extra": {
    // Facilitator-managed only:
    // "chargeCount": 4,
    "channelState": {
      "channelId": "0xabc123...",
      "balance": "98500",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0,
      "refundNonce": "2"
      // Facilitator-managed only:
      // "chargedCumulativeAmount": "3200"
    }
  }
}
```

`amount` is the amount returned to the payer.

If a `deposit`, `claim`, `settle`, or `refund` transaction broadcasts successfully but its confirmation cannot be established (e.g. a node/RPC error or timeout while waiting for the receipt), the facilitator MAY return `settlement_pending` (see [§9 Error Handling](../../x402-specification-v2.md#9-error-handling)) with the broadcast transaction hash in `transaction`, so the caller can reconcile on chain before retrying.

### GET /supported

The facilitator MAY declare a receiver authorizer whose role is to produce EIP-712 signatures for claims and refunds. The server may delegate to this address as its channel's `receiverAuthorizer`, or supply its own. Any address in `signers` may relay the resulting transactions. `extra.delegatedRefund: true` signals that the facilitator authenticates `/settle` callers and honors unsigned refunds from the service that created the channel. It replaces any address-valued refund-authorizer advertisement. A facilitator that supports it advertises `delegatedRefund: true` next to `receiverAuthorizer`. Its meaning depends on the mode:

- **Self-managed delegation:** a server that delegates `receiverAuthorizer` and sends no signatures relies on the facilitator's caller authentication, so the facilitator advertises `delegatedRefund: true`. A facilitator that advertises `delegatedRefund: false` will not honor unsigned refunds, and a server delegating to it cannot refund.
- **Facilitator-managed:** `receiverAuthorizer` alone is enough when the server brings its own refund key (`extra.refundAuthorizer` on the 402). `delegatedRefund: true` is needed only when the server omits `extra.refundAuthorizer` and relies on the facilitator's caller authentication.

A facilitator with no `/settle` caller authentication MAY advertise a `receiverAuthorizer` for facilitator-managed mode only, where servers bring their own refund key; it MUST NOT expect servers to delegate refund consent to it in self-managed mode (see [Security and Trust](#security-and-trust)). An absent `delegatedRefund` field denotes a legacy facilitator whose support is unknown; servers MUST treat it as "no information", not as `false`.

A facilitator lists the voucher-management modes it supports in `voucherManager`. Offering `"facilitator"` also requires `withdrawDelay`:

```jsonc
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "eip155:8453",
      "extra": {
        "receiverAuthorizer": "0xReceiverAuthorizerAddress",
        "delegatedRefund": true
        // Facilitator-managed only:
        // "withdrawDelay": 604800,
        // "voucherManager": ["server", "facilitator"]
      }
    }
  ],
  "extensions": [],
  "signers": {
    "eip155:*": [
      "0xSignerAddress1",
      "0xSignerAddress2"
    ]
  }
}
```

### Verification Rules

A facilitator must enforce:

1. **Channel config consistency** (deposit, voucher, and refund): the config's chain-bound EIP-712 hash must equal the claimed channel ID.
2. **Token match**: the channel token must match the payment requirements asset.
3. **Receiver match**: the channel receiver must equal the payment requirements `payTo`.
4. **Receiver authorizer match**: the channel receiver authorizer must equal `extra.receiverAuthorizer`.
5. **Withdraw delay match**: the channel withdraw delay must equal `extra.withdrawDelay`.
6. **Signature validity**: recover the signer from the EIP-712 voucher digest. If the payer authorizer is set, the signer must match it (ECDSA only). If the payer authorizer is zero, validate via `SignatureChecker` against the payer.
7. **Channel existence**: the channel must have a positive balance.
8. **Balance check** (deposit only): the client must have sufficient token balance.
9. **Deposit sufficiency**: `maxClaimableAmount` must be at most `balance` (or `balance + depositAmount` for deposit payloads).
10. **Not below claimed**: for voucher and deposit payloads, `maxClaimableAmount` must be at least onchain `totalClaimed + requirements.amount`, so every paid request advances the cumulative ceiling by at least the price. This floor is strict: `maxClaimableAmount` must also be strictly greater than `totalClaimed`, so a zero-price route cannot be satisfied by a voucher equal to `totalClaimed`. `requirements.amount` is supplied by the resource server and MUST NOT be trusted: the facilitator MUST validate it as a non-negative base-10 integer string before use and, if it is malformed or negative, MUST return an invalid response (`invalid_batch_settlement_evm_voucher_payload` for vouchers, `invalid_batch_settlement_evm_deposit_payload` for deposits) rather than throwing or lowering the floor. For refund payloads (`payload.type == "refund"`), this rule is relaxed to `maxClaimableAmount >= totalClaimed`, since refund vouchers are zero-charge and may match the already-claimed total exactly.
11. **Signed refunds**: the refund nonce must equal the onchain `refundNonce` at the time of submission; the EIP-712 `Refund` digest (`Refund(bytes32 channelId,uint256 nonce,uint128 amount)`) must bind the same `amount` submitted in the transaction. The contract increments the nonce before computing the capped transfer amount, so the nonce advances even when no tokens move.
12. **Managed watermark** (`extra.voucherManager === "facilitator"`): `maxClaimableAmount` must equal `chargedCumulativeAmount + paymentRequirements.amount`. For refund payloads, `maxClaimableAmount` must equal `chargedCumulativeAmount`. On mismatch, return `invalid_batch_settlement_evm_cumulative_amount_mismatch` with `extra.channelState` and `extra.voucherState`.
13. **Refund authorizer bind** (facilitator-managed mode): whenever `extra.refundAuthorizer` is present, the address unpacked from `channelConfig.salt` must equal it. Managed `/verify` (including deposit) MUST reject a 402 that omits `extra.refundAuthorizer` when the facilitator does not honor caller-identity refunds (`delegatedRefund` is not `true`), because neither consent path would be available.

The facilitator must return the channel snapshot (`balance`, `totalClaimed`, `withdrawRequestedAt`, `refundNonce`) in every `/verify` response `extra` field and in every `/settle` response under `extra.channelState`. In facilitator-managed mode those objects MUST also include `chargedCumulativeAmount`. If `withdrawRequestedAt` is non-zero, outstanding vouchers should be claimed promptly before the withdraw delay elapses.

---

## Claim & Settlement Strategy

In self-managed mode the server runs this strategy. In facilitator-managed mode the facilitator does — including claiming before a timed withdrawal finalizes and refunding idle channels.

`claim(voucherClaims)` validates payer voucher signatures and updates accounting for multiple channels; `msg.sender` must be `receiver` or `receiverAuthorizer` for every row. `claimWithSignature(claims, signature)` is the relay-friendly variant: anyone can submit it with a valid EIP-712 `ClaimBatch` signature from `receiverAuthorizer` covering all rows (all rows must share the same `receiverAuthorizer`). No token transfer occurs in either path.

**Claim attestation.** In facilitator-managed mode, the facilitator SHOULD attest the `chargeCount` deltas of a claim onchain by carrying them in the settlement metadata field `m` of the transaction's [ERC-8021](https://eips.ethereum.org/EIPS/eip-8021) Schema 2 calldata suffix. The contract is unchanged: it ignores trailing calldata and does not validate the suffix.

This only reuses the ERC-8021 / x402 `builder-code` suffix *format* (CBOR map with an `m` entry, followed by the ERC-8021 marker) as a carrier for facilitator-authored metadata:

- **No builder code is required.** The facilitator does not need a `w` code, and no `a` or `s` codes are involved. A suffix that carries only `m` is valid.
- **It composes with builder codes.** When the facilitator also configures a builder code, or the payment carries client/server attribution, `m` rides in the same single suffix next to `w` / `a` / `s`. The two are independent; neither changes the meaning of the other.
- **Single suffix, at the end of the top-level calldata.** ERC-8021 parsers only read the end of the transaction input, so the suffix is appended once to the outer call. Inner `multicall` legs carry no suffix.

*Encoding.* `m` has one key:

```
m = { "x402ChargeCounts": [c0, c1, ..., c(n-1)] }
```

- The array has one entry per claim row, across all `claim` / `claimWithSignature` legs of the transaction, in call order (leg order, then row order within a leg). Entry `ci` is the `chargeCount` delta of row `i`.
- Entries are unsigned integers in shortest-form CBOR: 1 byte up to 23, 2 bytes up to 255, 3 bytes up to 65,535. Zero counts stay in the array so positions remain aligned with rows.
- The key MUST be omitted when the transaction has no claim leg (refund-only, `settle`, `deposit`).
- Overhead is about 22 bytes plus 1–3 bytes per row; 100 rows fit in roughly 120–320 bytes.

Example: for rows with counts `3`, `0`, `41`, the `m` entry of the CBOR suffix map is `616d a1 70<"x402ChargeCounts"> 83 03 00 1829` (25 bytes). Together with a facilitator code the full map is `{"w":"bc_myfacilitator","m":{"x402ChargeCounts":[3,0,41]}}`.

*Row selection.* The facilitator MUST only include rows that advance `totalClaimed` (`chargedCumulativeAmount > totalClaimed`) and SHOULD NOT include the same `channelId` twice in one transaction. The contract does not reject duplicates: a row whose `totalClaimed` is not above the channel's current total is a silent no-op, so a repeated channel can leave a later row without a `Claimed` event. Every other row emits exactly one `Claimed` event, in row order, except when execution races with an out-of-band claim or the batch was already applied (a no-op row emits no `Claimed`).

*Indexer decoding (row join).* Indexers MUST join counts to rows by `(channelId, newTotalClaimed)`, never by event position, because a single no-op row would shift every later pairing and attribute counts to the wrong channels:

1. Parse the ERC-8021 suffix from the top-level transaction input and read `m.x402ChargeCounts`. If it is absent, there is no attestation.
2. ABI-decode the top-level call. Unwrap `multicall(bytes[])` and collect the rows of every `claim` / `claimWithSignature` leg in call order. If the array length does not equal the total row count, ignore the attestation.
3. Compute each row's `channelId` from its channel config (EIP-712 hash, chain-bound).
4. Match each row against the `Claimed(channelId, ...)` events emitted by `x402BatchSettlement` in the same receipt: the event whose `channelId` equals the row's and whose `newTotalClaimed` equals the row's `totalClaimed`. Each event matches at most one row. A matched row attests `chargeCounts[i]` to that channel. A row without a match was a no-op and attests nothing. For example, rows `[A, totalClaimed=8], [A, totalClaimed=5]` emit a single `Claimed(A, newTotalClaimed=8)`: only row 0 attests. If several matched rows share a `channelId`, their counts are snapshots of the same per-channel counter (which only drops after the claim confirms), so indexers MUST credit the channel with the largest of them, not their sum.
5. Authenticate the submitter. The suffix is not signed, and `claimWithSignature` can be submitted by anyone, so any account can attach counts to a valid claim. Indexers MUST honor counts only from transactions sent to `x402BatchSettlement` by a sender they trust, for example the facilitator's submitting addresses (a direct `claim` is already restricted by the contract to `receiver` / `receiverAuthorizer`; the relay path is sent by the facilitator's own signer, not the `receiverAuthorizer`). `Claimed.sender` is that sender.

Indexers that cannot ABI-decode calldata (for example SQL over events) MAY use a shortcut: if the number of `Claimed` events in the transaction equals the length of `x402ChargeCounts`, every row applied and the n-th `Claimed` event by log index takes `chargeCounts[n]`. Otherwise the pairing is ambiguous and the attestation MUST be ignored.

*After confirmation.* The facilitator subtracts the attested snapshot from the stored `chargeCount` only for rows that emitted `Claimed` (matched as above; the largest snapshot once per channel if a channel repeats); do not zero the field, or in-flight commits are lost. Counts of rows that emitted no `Claimed` (including every row of an already-applied batch) stay pending and are attested by that channel's next claim, as are charges of zero amount, which increment `chargeCount` without creating a claim row.

Facilitators claim and refund in one transaction via `multicall(bytes[])` of `[claim, refund]`; the layout above applies unchanged, with `m` on the outer suffix and a bare inner claim. Indexers MUST support a direct `claim` / `claimWithSignature` call and `multicall(bytes[])`. Other wrappers (for example Multicall3 or smart-account `execute`) can only be attested by indexers that know how to unwrap them.

`settle(receiver, token)` transfers all claimed-but-unsettled funds for a receiver+token pair to the receiver in one transfer. Permissionless.

| Strategy          | Description                                    | Trade-off                        |
| ----------------- | ---------------------------------------------- | -------------------------------- |
| **Periodic**      | Claim + settle every N minutes                 | Predictable gas costs            |
| **Threshold**     | Claim + settle when unclaimed amount exceeds T | Bounds server's risk exposure    |
| **On withdrawal** | Claim + settle when withdrawal is initiated    | Minimum gas, maximum risk window |

Outstanding vouchers must be claimed before the withdraw delay elapses. Unclaimed vouchers become unclaimable after `finalizeWithdraw()` reduces the channel balance.

---

## Client Verification Rules

### Steady State

PAYMENT-RESPONSE extra is untrusted. The client updates local state
from its own previous state plus `extra.chargedAmount` (missing is `0`).
It MUST NOT copy `extra.channelState` into that local state.

The client applies that update only when `chargedAmount <=
PaymentRequirements.amount` and, if present,
`channelState.chargedCumulativeAmount` equals `previous + chargedAmount`.
Otherwise it MUST leave local state unchanged.

The next voucher is signed from that local state. A skipped apply is
not a new charge; desync is recovered via Corrective 402.

### Recovery After State Loss

Channel identity is deterministic. The client can recompute `channelId` from the 402 response plus its own channel parameters (`payer`, `payerAuthorizer`, `salt`), then read `channels(channelId)` to recover the onchain `balance` and `totalClaimed`. In facilitator-managed mode with a server-owned refund key, `salt` carries `extra.refundAuthorizer`, so recovery must use the same address that opened the channel. Without `extra.refundAuthorizer` (the server relies on `delegatedRefund`), and in self-managed mode, `salt` is the raw client salt.

The recovery baseline is:

- Use onchain `totalClaimed` when no trusted offchain state is available.
- Use server-provided `chargedCumulativeAmount` only when the server also returns the last signed voucher (`signedMaxClaimable` and `signature`) and the client verifies that signature against its own voucher signer.

**Client cold start.** When the client has no local channel record, it reads onchain state and sets `chargedCumulativeAmount = totalClaimed`. If the next request would exceed the recovered `balance`, the client sends a deposit/top-up payload. Otherwise it signs a voucher for `totalClaimed + amount`.

**Server state loss.** If the voucher manager (server or facilitator) has no channel record, it sets `chargedCumulativeAmount = totalClaimed` as the baseline, using the `totalClaimed` returned by the facilitator's onchain read for this request. The voucher manager MUST NOT derive the baseline from the client-signed voucher. A resource server acting as voucher manager MUST reject the request if the facilitator response does not include `totalClaimed`, and MUST parse `totalClaimed` canonically: either a plain decimal string with no leading zeros (`"0"` is the only string that starts with `0`), or a JSON number that is a non-negative integer no greater than 2^53 − 1. Anything else (leading zeros, signs, whitespace, non-integers, out-of-range numbers) is treated as missing. If the voucher manager lost unclaimed vouchers, those unclaimed charges are forfeited.

**Corrective 402.** If a paid payload (`deposit` or `voucher`) is rejected because the client's cumulative amount does not match the voucher manager's `chargedCumulativeAmount`, the 402 is `invalid_batch_settlement_evm_cumulative_amount_mismatch` with `accepts[].extra.channelState` containing the channel snapshot and `accepts[].extra.voucherState` containing `signedMaxClaimable` and `signature`. The client verifies the voucher signature before adopting `chargedCumulativeAmount` and retrying. In facilitator-managed mode the 402 also carries the managed `extra` fields (`voucherManager`, and `refundAuthorizer` when the server owns the refund key).

```jsonc
{
  "x402Version": 2,
  "error": "invalid_batch_settlement_evm_cumulative_amount_mismatch",
  "accepts": [
    {
      "scheme": "batch-settlement",
      "extra": {
        "receiverAuthorizer": "0xReceiverAuthorizerAddress",
        "withdrawDelay": 900,
        "name": "USDC",
        "version": "2",
        // Facilitator-managed only:
        // "voucherManager": "facilitator",
        // Only when the server owns the refund key:
        // "refundAuthorizer": "0xRefundAuthorizerAddress",
        "channelState": {
          "channelId": "0xabc123...channelId",
          "balance": "100000",
          "totalClaimed": "500",
          "withdrawRequestedAt": 0,
          "refundNonce": "1",
          "chargedCumulativeAmount": "3200"
        },
        "voucherState": {
          "signedMaxClaimable": "3200",
          "signature": "0x...last voucher signature"
        }
      }
    }
  ]
}
```

---

## Error Codes

| Error Code                                                               | Description                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `invalid_batch_settlement_evm_authorizer_address_mismatch`               | Authorizer address does not match the expected receiver authorizer           |
| `invalid_batch_settlement_evm_channel_busy`                              | Another request holds the per-channel lock; client should retry shortly      |
| `invalid_batch_settlement_evm_channel_id_mismatch`                       | Channel config does not hash to the claimed channel ID                       |
| `invalid_batch_settlement_evm_channel_not_found`                         | No channel with positive balance for the given channel ID                    |
| `invalid_batch_settlement_evm_channel_state_read_failed`                 | Facilitator failed to read onchain channel state                             |
| `invalid_batch_settlement_evm_charge_exceeds_signed_cumulative`          | Committing the charge would exceed the voucher's signed `maxClaimableAmount` |
| `invalid_batch_settlement_evm_claim_payload`                             | Claim payload is malformed                                                   |
| `invalid_batch_settlement_evm_claim_simulation_failed`                   | Claim simulation failed                                                      |
| `invalid_batch_settlement_evm_claim_transaction_failed`                  | Onchain claim transaction failed                                             |
| `invalid_batch_settlement_evm_cumulative_amount_mismatch`               | Corrective 402: client's cumulative voucher ceiling does not match the server's tracked `chargedCumulativeAmount` |
| `invalid_batch_settlement_evm_cumulative_below_claimed`                  | Voucher `maxClaimableAmount` violates monotonicity vs onchain `totalClaimed` (voucher and deposit verify: must be at least `totalClaimed + requirements.amount` and strictly greater than `totalClaimed`; refund: must not be strictly below `totalClaimed`) |
| `invalid_batch_settlement_evm_cumulative_exceeds_balance`                | Voucher `maxClaimableAmount` exceeds effective onchain balance               |
| `invalid_batch_settlement_evm_deposit_below_min_deposit`                 | Server rejected a deposit below its local `extra.minDeposit` policy          |
| `invalid_batch_settlement_evm_deposit_payload`                           | Deposit payload is malformed                                                 |
| `invalid_batch_settlement_evm_deposit_simulation_failed`                 | Deposit simulation failed                                                    |
| `invalid_batch_settlement_evm_deposit_transaction_failed`                | Onchain deposit transaction failed                                           |
| `invalid_batch_settlement_evm_eip2612_amount_mismatch`                   | EIP-2612 permit amount does not match the requested authorization          |
| `invalid_batch_settlement_evm_eip2612_asset_mismatch`                    | EIP-2612 permit asset does not match the payment asset                       |
| `invalid_batch_settlement_evm_eip2612_deadline_expired`                  | EIP-2612 permit deadline has expired                                         |
| `invalid_batch_settlement_evm_eip2612_invalid_format`                    | EIP-2612 permit segment is malformed                                         |
| `invalid_batch_settlement_evm_eip2612_invalid_signature`                 | EIP-2612 permit signature is invalid                                         |
| `invalid_batch_settlement_evm_eip2612_owner_mismatch`                    | EIP-2612 permit owner does not match the payer                               |
| `invalid_batch_settlement_evm_eip2612_spender_mismatch`                  | EIP-2612 permit spender does not match the expected spender                  |
| `invalid_batch_settlement_evm_erc20_approval_asset_mismatch`             | ERC-20 approval asset does not match the payment asset                       |
| `invalid_batch_settlement_evm_erc20_approval_broadcast_failed`           | Facilitator failed to broadcast the pre-signed ERC-20 approval transaction   |
| `invalid_batch_settlement_evm_erc20_approval_from_mismatch`              | ERC-20 approval signer does not match the payer                              |
| `invalid_batch_settlement_evm_erc20_approval_invalid_format`             | ERC-20 approval segment is malformed                                         |
| `invalid_batch_settlement_evm_erc20_approval_unavailable`                | ERC-20 approval gas sponsorship is unavailable                               |
| `invalid_batch_settlement_evm_erc20_approval_wrong_spender`              | ERC-20 approval spender is not Permit2                                       |
| `invalid_batch_settlement_evm_erc3009_authorization_required`            | Deposit payload is missing the required `erc3009Authorization`               |
| `invalid_batch_settlement_evm_insufficient_balance`                    | Client token balance is insufficient for the deposit                         |
| `invalid_batch_settlement_evm_missing_channel`                           | Resource server has no channel session for the payload's channel ID          |
| `invalid_batch_settlement_evm_missing_eip712_domain`                     | Token EIP-712 domain (`name`, `version`) is missing from payment requirements |
| `invalid_batch_settlement_evm_network_mismatch`                          | Payment payload `accepted.network` does not match `paymentRequirements.network` on the verify request |
| `invalid_batch_settlement_evm_payload_authorization_valid_after`         | ERC-3009 authorization `validAfter` is still in the future                   |
| `invalid_batch_settlement_evm_payload_authorization_valid_before`        | ERC-3009 authorization `validBefore` has already passed                    |
| `invalid_batch_settlement_evm_payload_type`                              | Payload `type` is not valid for the current verify/settle operation          |
| `invalid_batch_settlement_evm_pending_id_mismatch`                       | `/settle` echoed a `pendingId` whose voucher does not match the live reservation |
| `invalid_batch_settlement_evm_permit2_allowance_required`                | Permit2 allowance is required before deposit                                 |
| `invalid_batch_settlement_evm_permit2_amount_mismatch`                   | Permit2 authorization amount does not match the requested deposit amount   |
| `invalid_batch_settlement_evm_permit2_authorization_required`            | Deposit payload is missing the required Permit2 authorization              |
| `invalid_batch_settlement_evm_permit2_deadline_expired`                  | Permit2 authorization deadline has expired                                   |
| `invalid_batch_settlement_evm_permit2_invalid_signature`                 | Permit2 authorization signature is invalid                                   |
| `invalid_batch_settlement_evm_permit2_invalid_spender`                   | Permit2 authorization spender is not the expected spender                  |
| `invalid_batch_settlement_evm_receive_authorization_signature`           | ERC-3009 `receiveWithAuthorization` signature is invalid                     |
| `invalid_batch_settlement_evm_receiver_authorizer_mismatch`              | Channel receiver authorizer does not match `extra.receiverAuthorizer`        |
| `invalid_batch_settlement_evm_receiver_mismatch`                         | Channel receiver does not match `payTo`                                      |
| `invalid_batch_settlement_evm_refund_amount_invalid`                     | Refund `amount` is non-numeric or non-positive                               |
| `invalid_batch_settlement_evm_refund_authorizer_mismatch`                | Address unpacked from `channelConfig.salt` does not match `extra.refundAuthorizer` |
| `invalid_batch_settlement_evm_refund_authorizer_signature`               | `refundAuthorizerSignature` is missing or does not recover to `extra.refundAuthorizer` |
| `invalid_batch_settlement_evm_refund_no_balance`                         | Cooperative refund requested but no refundable balance remains |
| `invalid_batch_settlement_evm_refund_payload`                            | Refund payload is malformed                                                  |
| `invalid_batch_settlement_evm_refund_simulation_failed`                  | Refund simulation failed                                                     |
| `invalid_batch_settlement_evm_refund_transaction_failed`                 | Onchain refund transaction failed                                            |
| `invalid_batch_settlement_evm_rpc_read_failed`                           | Facilitator failed to read required onchain data                             |
| `invalid_batch_settlement_evm_scheme`                                    | `scheme` is not `batch-settlement`                                           |
| `invalid_batch_settlement_evm_settle_payload`                            | Settle payload is malformed                                                  |
| `invalid_batch_settlement_evm_nothing_to_settle`                         | Receiver/token pair has no claimed-but-unsettled funds |
| `invalid_batch_settlement_evm_settle_simulation_failed`                  | Settle simulation failed                                                     |
| `invalid_batch_settlement_evm_settle_transaction_failed`                 | Onchain settle transaction failed                                            |
| `invalid_batch_settlement_evm_token_mismatch`                            | Channel token does not match the payment requirements asset                  |
| `invalid_batch_settlement_evm_transaction_reverted`                      | Submitted transaction reverted                                               |
| `invalid_batch_settlement_evm_unexpected_cancel`                         | Client supplied server-authored `cancel`                                     |
| `invalid_batch_settlement_evm_unexpected_pending_id`                     | Client supplied server-authored `pendingId`                                  |
| `invalid_batch_settlement_evm_unknown_settle_action`                     | Settle payload requested an unknown action                                   |
| `invalid_batch_settlement_evm_voucher_payload`                           | Voucher payload is malformed                                                 |
| `invalid_batch_settlement_evm_voucher_signature`                         | EIP-712 voucher signature does not recover to the expected signer          |
| `invalid_batch_settlement_evm_wait_for_receipt_failed`                   | Facilitator failed while waiting for the transaction receipt                 |
| `invalid_batch_settlement_evm_withdraw_delay_mismatch`                   | Channel withdraw delay does not match `extra.withdrawDelay`                  |
| `invalid_batch_settlement_evm_withdraw_delay_out_of_range`               | Withdraw delay is outside the 15 min - 30 day bounds                         |
| `settlement_pending`                                                     | Broadcast succeeded but confirmation could not be established — **non-terminal**; carries the broadcast `transaction` hash so the caller can reconcile on chain before retrying |

---

## Security and Trust

1. **Capital risk and cumulative replay protection**: Clients bear risk up to the signed `maxClaimableAmount`; the receiver authorizer determines actual `totalClaimed` onchain within that bound. Over-claiming is a trust violation, not a protocol violation. The cumulative model makes nonces unnecessary. As `totalClaimed` only increases, and old vouchers are naturally superseded.

2. **Withdrawal delay as escape hatch**: The 15 min – 30 day bounds prevent a server from indefinitely trapping client funds while giving the server a fair window to claim outstanding vouchers. Cooperative refund returns unclaimed balance immediately when the server cooperates; timed withdrawal is the unilateral fallback. Servers bear the risk of vouchers left unclaimed when `finalizeWithdraw` completes.

3. **Cross-function replay prevention**: `Voucher`, `Refund`, and `ClaimBatch` use distinct EIP-712 type hashes so a signature for one cannot be replayed as another. Refunds additionally carry a per-channel nonce.

4. **Voucher expiry via escrow depletion**: Vouchers carry no expiry field. A voucher remains claimable as long as `balance - totalClaimed > 0`; `finalizeWithdraw` and `refundWithSignature` close the claim window by draining available escrow. The ERC-3009 `validBefore`/`validAfter` fields bound only the deposit authorization, not the voucher.

5. **Refund authorization**: A cooperative refund bypasses the timed-withdrawal delay, so it must carry receiver-side consent. In self-managed mode, when the server supplies its own `refundAuthorizerSignature` that signature is the consent; when the server delegates `receiverAuthorizer` to the facilitator, the facilitator MUST authenticate that each `refund` request originates from the service that created the channel (e.g. SIWX, JWT, or API credential bound at channel-creation time) and reject all others. In facilitator-managed mode the consent is the `refundAuthorizerSignature` from `extra.refundAuthorizer`, or out-of-band `/settle` caller authentication when the 402 omits `extra.refundAuthorizer` and the facilitator advertises `delegatedRefund: true` (see [Cooperative refund flow](#cooperative-refund-flow)).

6. **Admission reservation**: `/verify` and `/settle` that carry a `pendingId` SHOULD run over an authenticated facilitator channel. A facilitator that exposes `/settle` to untrusted callers MUST NOT treat `pendingId` as authorization.

---

## Reference Implementation: `x402BatchSettlement`

The `batch-settlement` scheme is implemented by the `x402BatchSettlement` contract alongside the `ERC3009DepositCollector` and `Permit2DepositCollector` deposit collector contracts. Each contract is deployed to a deterministic address across all supported EVM chains via CREATE2.

| Contract | Canonical Address |
| -------- | ------- |
| `x402BatchSettlement` | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` |
| `ERC3009DepositCollector` | `0x4020806089470a89826cB9fB1f4059150b550004` |
| `Permit2DepositCollector` | `0x4020425FAf3B746C082C2f942b4E5159887B0005` |

The `x402BatchSettlement` contract uses `ReentrancyGuardTransient` (EIP-1153 transient storage) and must only be deployed on chains where that opcode is supported.

---

## Version History

| Version | Date       | Changes       | Authors                 |
| ------- | ---------- | ------------- | ----------------------- |
| v1.1    | 2026-10-06 | Facilitator-managed vouchers mode | @phdargen @CarsonRoscoe |
| v1.0    | 2025-04-28 | Initial draft | @phdargen @CarsonRoscoe @ilikesymmetry |