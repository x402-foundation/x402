# Scheme: `batch-settlement` on `EVM`

## Summary

The `batch-settlement` scheme on EVM is a **capital-backed** network binding using stateless unidirectional payment channels for high-throughput, low-cost payments. Clients deposit funds into onchain channels once and sign off-chain **cumulative vouchers** per request. Servers verify vouchers with fast signature checks and claim them onchain periodically in batches, reducing both latency and gas costs drastically. A single claim transaction can cover many channels at once and only updates onchain accounting; claimed funds are later transferred to the receiver via a separate settle operation that sweeps many claims into one token transfer.

The scheme supports **dynamic pricing**: the client authorizes a maximum per-request, and the server charges the actual cost within that ceiling.

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

Channels are long-lived. After a refund, the client can top up and reuse the same channel. However, the channel config is immutable. If any parameter needs to change, a new channel is required. If delegating `receiverAuthorizer` to a facilitator, the server should claim all outstanding vouchers and refund remaining balances on old channels before switching to another facilitator.

---

## 402 Response (PaymentRequirements)

The 402 response contains pricing terms and the server's channel parameters. The client maps `payTo` → `ChannelConfig.receiver`, `extra.receiverAuthorizer` → `ChannelConfig.receiverAuthorizer`, `asset` → `ChannelConfig.token`, and `extra.withdrawDelay` → `ChannelConfig.withdrawDelay`, then fills in its own `payer`, `payerAuthorizer`, and `salt` to construct the full config.

```json
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
    "version": "2"
  }
}
```

| Field                       | Type     | Required | Description                                            |
| --------------------------- | -------- | -------- | ------------------------------------------------------ |
| `extra.receiverAuthorizer`  | `string` | yes      | Address that will authorize claims/refunds             |
| `extra.withdrawDelay`       | `number` | yes      | Withdrawal delay in seconds (15 min – 30 days)         |
| `extra.assetTransferMethod` | `string` | optional | `"eip3009"` (default) or `"permit2"`                   |
| `extra.name`                | `string` | yes      | EIP-712 domain name of the token contract              |
| `extra.version`             | `string` | yes      | EIP-712 domain version of the token contract           |
| `extra.channelState`        | `object` | optional | Corrective-only server channel snapshot for cumulative amount resynchronization |
| `extra.voucherState`        | `object` | optional | Corrective-only signed voucher proof for cumulative amount resynchronization |

---

## Client: Payment Construction

The client constructs a payment payload whose type depends on channel state:

- `deposit`: No channel exists or balance is exhausted — client signs a token authorization and voucher
- `voucher`: Channel has sufficient balance — client signs a new cumulative voucher
- `refund`: Client requests a cooperative refund — client signs a zero-charge voucher and optionally includes a refund amount

### Deposit Payload

The `deposit.authorization` field contains the token transfer authorization — exactly one of `erc3009Authorization` or `permit2Authorization` must be present.

```json
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

The server is the sole owner of per-channel state.

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

Successful paid responses distinguish onchain transfers from offchain charges:

- Voucher-only response: `transaction` is `""`, top-level `amount` is `""`, `extra.chargedAmount` is the request charge, and `extra.channelState` carries the channel snapshot.
- Deposit response: `transaction` is the deposit transaction hash, top-level `amount` is the deposited amount, `extra.chargedAmount` is the request charge, and `extra.channelState` carries the channel snapshot.
- Refund response: `transaction` is the refund transaction hash, top-level `amount` is the refunded amount, `extra.channelState` carries the post-refund channel snapshot and `extra.chargedAmount` is omitted.

```json
{
  "success": true,
  "transaction": "",
  "network": "eip155:8453",
  "payer": "0xClientAddress",
  "amount": "",
  "extra": {
    "chargedAmount": "700",
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

`refundAuthorizerSignature` and `claimAuthorizerSignature` are included when the server owns the receiver-authorizer key. If the channel delegates receiver authorization to the facilitator, the server omits them and the facilitator signs before submitting the transaction.

---

## Facilitator Interface

Uses the standard x402 facilitator interface (`/verify`, `/settle`, `/supported`).

### POST /verify

Verifies a deposit, voucher, or refund payment payload. Returns the onchain channel snapshot:

```json
{
  "isValid": true,
  "payer": "0xPayerAddress",
  "extra": {
    "channelId": "0xabc123...",
    "balance": "1000000",
    "totalClaimed": "500000",
    "withdrawRequestedAt": 0,
    "refundNonce": "0"
  }
}
```

### POST /settle

| `payload.type` | When Used                     | Onchain Effect                                        |
| -------------- | ----------------------------- | ----------------------------------------------------- |
| `"deposit"`    | First request or top-up       | Deposit via the canonical ERC-3009 or Permit2 collector |
| `"claim"`      | Server batches voucher claims | Validate vouchers, update accounting (no transfer)    |
| `"settle"`     | Server transfers earned funds | Transfer unsettled amount to receiver                 |
| `"refund"`     | Cooperative refund            | Return specified amount to payer, increment refund nonce |

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

Example facilitator response for a deposit:

```json
{
  "success": true,
  "transaction": "0x...transactionHash",
  "network": "eip155:8453",
  "payer": "0xPayerAddress",
  "amount": "100000",
  "asset": "0xAssetAddress",
  "extra": {
    "channelState": {
      "channelId": "0xabc123...",
      "balance": "100000",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0,
      "refundNonce": "1"
    }
  }
}
```

Example facilitator response for a refund:

```json
{
  "success": true,
  "transaction": "0x...transactionHash",
  "network": "eip155:8453",
  "payer": "0xPayerAddress",
  "amount": "1500",
  "extra": {
    "channelState": {
      "channelId": "0xabc123...",
      "balance": "98500",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0,
      "refundNonce": "2"
    }
  }
}
```

`amount` is the amount returned to the payer.

### GET /supported

The facilitator declares a receiver authorizer whose role is to produce EIP-712 signatures for claims and refunds. The server may delegate to this address as its channel's `receiverAuthorizer`, or supply its own. Any address in `signers` may relay the resulting transactions.

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "eip155:8453",
      "extra": {
        "receiverAuthorizer": "0xReceiverAuthorizerAddress"
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
10. **Not below claimed**: `maxClaimableAmount` must exceed onchain `totalClaimed`. For refund payloads (`payload.type == "refund"`), this rule is relaxed to `maxClaimableAmount >= totalClaimed`, since refund vouchers are zero-charge and may match the already-claimed total exactly.
11. **Signed refunds**: the refund nonce must equal the onchain `refundNonce` at the time of submission; the EIP-712 `Refund` digest (`Refund(bytes32 channelId,uint256 nonce,uint128 amount)`) must bind the same `amount` submitted in the transaction. The contract increments the nonce before computing the capped transfer amount, so the nonce advances even when no tokens move.

The facilitator must return the channel snapshot (`balance`, `totalClaimed`, `withdrawRequestedAt`, `refundNonce`) in every `/verify` response `extra` field and in every `/settle` response under `extra.channelState`. If `withdrawRequestedAt` is non-zero, the server should claim outstanding vouchers promptly before the withdraw delay elapses.

---

## Claim & Settlement Strategy

`claim(voucherClaims)` validates payer voucher signatures and updates accounting for multiple channels; `msg.sender` must be `receiver` or `receiverAuthorizer` for every row. `claimWithSignature(claims, signature)` is the relay-friendly variant: anyone can submit it with a valid EIP-712 `ClaimBatch` signature from `receiverAuthorizer` covering all rows (all rows must share the same `receiverAuthorizer`). No token transfer occurs in either path.

`settle(receiver, token)` transfers all claimed-but-unsettled funds for a receiver+token pair to the receiver in one transfer. Permissionless.

| Strategy          | Description                                    | Trade-off                        |
| ----------------- | ---------------------------------------------- | -------------------------------- |
| **Periodic**      | Claim + settle every N minutes                 | Predictable gas costs            |
| **Threshold**     | Claim + settle when unclaimed amount exceeds T | Bounds server's risk exposure    |
| **On withdrawal** | Claim + settle when withdrawal is initiated    | Minimum gas, maximum risk window |

The server must claim all outstanding vouchers before the withdraw delay elapses. Unclaimed vouchers become unclaimable after `finalizeWithdraw()` reduces the channel balance.

---

## Client Verification Rules

### Steady State

Before signing the next voucher, the client must verify from the payment response:

1. `extra.chargedAmount <= PaymentRequirements.amount`
2. `extra.channelState.chargedCumulativeAmount == previous + extra.chargedAmount`
3. `extra.channelState.balance` is consistent with the client's expectation
4. `extra.channelState.channelId` matches

If any check fails, the client must not sign further vouchers and should initiate withdrawal.

### Recovery After State Loss

Channel identity is deterministic. The client can recompute `channelId` from the 402 response plus its own channel parameters (`payer`, `payerAuthorizer`, `salt`), then read `channels(channelId)` to recover the onchain `balance` and `totalClaimed`.

The recovery baseline is:

- Use onchain `totalClaimed` when no trusted offchain state is available.
- Use server-provided `chargedCumulativeAmount` only when the server also returns the last signed voucher (`signedMaxClaimable` and `signature`) and the client verifies that signature against its own voucher signer.

**Client cold start.** When the client has no local channel record, it reads onchain state and sets `chargedCumulativeAmount = totalClaimed`. If the next request would exceed the recovered `balance`, the client sends a deposit/top-up payload. Otherwise it signs a voucher for `totalClaimed + amount`.

**Server state loss.** If the server has no local channel record, it sets `chargedCumulativeAmount = totalClaimed` as the baseline. If the server lost unclaimed vouchers, those unclaimed charges are forfeited by the server.

**Corrective 402.** If the server has local channel state and rejects a paid payload (`deposit` or `voucher`) because the client's cumulative amount does not match the server's channel state, it returns `invalid_batch_settlement_evm_cumulative_amount_mismatch` with `accepts[].extra.channelState` containing the channel snapshot and `accepts[].extra.voucherState` containing `signedMaxClaimable` and `signature`.  The client verifies the voucher signature before adopting `chargedCumulativeAmount` and retrying.

```json
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
| `invalid_batch_settlement_evm_cumulative_below_claimed`                  | Voucher `maxClaimableAmount` violates monotonicity vs onchain `totalClaimed` (non-refund: must be greater than `totalClaimed`; refund: must not be strictly below `totalClaimed`; deposit verify: must not be strictly below `totalClaimed`) |
| `invalid_batch_settlement_evm_cumulative_exceeds_balance`                | Voucher `maxClaimableAmount` exceeds effective onchain balance               |
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
| `invalid_batch_settlement_evm_permit2_allowance_required`                | Permit2 allowance is required before deposit                                 |
| `invalid_batch_settlement_evm_permit2_amount_mismatch`                   | Permit2 authorization amount does not match the requested deposit amount   |
| `invalid_batch_settlement_evm_permit2_authorization_required`            | Deposit payload is missing the required Permit2 authorization              |
| `invalid_batch_settlement_evm_permit2_deadline_expired`                  | Permit2 authorization deadline has expired                                   |
| `invalid_batch_settlement_evm_permit2_invalid_signature`                 | Permit2 authorization signature is invalid                                   |
| `invalid_batch_settlement_evm_permit2_invalid_spender`                   | Permit2 authorization spender is not the expected spender                  |
| `invalid_batch_settlement_evm_receive_authorization_signature`           | ERC-3009 `receiveWithAuthorization` signature is invalid                     |
| `invalid_batch_settlement_evm_receiver_authorizer_mismatch`              | Channel receiver authorizer does not match `extra.receiverAuthorizer`        |
| `invalid_batch_settlement_evm_receiver_mismatch`                         | Channel receiver does not match `payTo`                                      |                         |
| `invalid_batch_settlement_evm_refund_amount_invalid`                     | Refund `amount` is non-numeric or non-positive                               |
| `invalid_batch_settlement_evm_refund_no_balance`                         | Cooperative refund requested but no refundable balance remains             |
| `invalid_batch_settlement_evm_refund_payload`                            | Refund payload is malformed                                                  |
| `invalid_batch_settlement_evm_refund_simulation_failed`                  | Refund simulation failed                                                     |
| `invalid_batch_settlement_evm_refund_transaction_failed`                 | Onchain refund transaction failed                                            |
| `invalid_batch_settlement_evm_rpc_read_failed`                           | Facilitator failed to read required onchain data                             |
| `invalid_batch_settlement_evm_scheme`                                    | `scheme` is not `batch-settlement`                                           |
| `invalid_batch_settlement_evm_settle_payload`                            | Settle payload is malformed                                                  |
| `invalid_batch_settlement_evm_settle_simulation_failed`                  | Settle simulation failed                                                     |
| `invalid_batch_settlement_evm_settle_transaction_failed`                 | Onchain settle transaction failed                                            |
| `invalid_batch_settlement_evm_token_mismatch`                            | Channel token does not match the payment requirements asset                  |
| `invalid_batch_settlement_evm_transaction_reverted`                      | Submitted transaction reverted                                               |
| `invalid_batch_settlement_evm_unknown_settle_action`                     | Settle payload requested an unknown action                                   |
| `invalid_batch_settlement_evm_voucher_payload`                           | Voucher payload is malformed                                                 |
| `invalid_batch_settlement_evm_voucher_signature`                         | EIP-712 voucher signature does not recover to the expected signer          |
| `invalid_batch_settlement_evm_wait_for_receipt_failed`                   | Facilitator failed while waiting for the transaction receipt                 |
| `invalid_batch_settlement_evm_withdraw_delay_mismatch`                   | Channel withdraw delay does not match `extra.withdrawDelay`                  |
| `invalid_batch_settlement_evm_withdraw_delay_out_of_range`               | Withdraw delay is outside the 15 min - 30 day bounds                         |

---

## Security and Trust

1. **Capital risk and cumulative replay protection**: Clients bear risk up to the signed `maxClaimableAmount`; the receiver authorizer determines actual `totalClaimed` onchain within that bound. Over-claiming is a trust violation, not a protocol violation. The cumulative model makes nonces unnecessary. As `totalClaimed` only increases, and old vouchers are naturally superseded.

2. **Withdrawal delay as escape hatch**: The 15 min – 30 day bounds prevent a server from indefinitely trapping client funds while giving the server a fair window to claim outstanding vouchers. Cooperative refund returns unclaimed balance immediately when the server cooperates; timed withdrawal is the unilateral fallback. Servers bear the risk of vouchers left unclaimed when `finalizeWithdraw` completes.

3. **Cross-function replay prevention**: `Voucher`, `Refund`, and `ClaimBatch` use distinct EIP-712 type hashes so a signature for one cannot be replayed as another. Refunds additionally carry a per-channel nonce.

4. **Voucher expiry via escrow depletion**: Vouchers carry no expiry field. A voucher remains claimable as long as `balance - totalClaimed > 0`; `finalizeWithdraw` and `refundWithSignature` close the claim window by draining available escrow. The ERC-3009 `validBefore`/`validAfter` fields bound only the deposit authorization, not the voucher.

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
| v1.0    | 2025-04-28 | Initial draft | @phdargen @CarsonRoscoen @ilikesymmetry |