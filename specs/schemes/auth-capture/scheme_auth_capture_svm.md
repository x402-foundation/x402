# Scheme: `auth-capture` on `SVM`

## Summary

This is the SVM (Solana Virtual Machine) binding of [`auth-capture`](./scheme_auth_capture.md). It specifies the instructions, wire fields, signatures, and facilitator logic that realize the scheme on SVM chains (Solana Mainnet, Eclipse, Soon, Sonic, and other SVM-compatible chains).

The binding uses SPL Token's native `Approve` / `TransferChecked` / `Revoke` instructions:

- **Hold (authorize)**: The client signs an `Approve` instruction delegating up to `requirements.amount` tokens from their ATA to the facilitator's delegate authority. The delegate is committed onchain as the payment's operator.
- **Capture**: The facilitator, acting as delegate, submits `TransferChecked` from the payer's ATA to the merchant's ATA, signed by the delegate. Amount may be at most the held ceiling.
- **Void**: The facilitator submits `Revoke` to release the delegate, returning any unspent hold to the payer's full control.
- **Refund**: The facilitator submits `TransferChecked` from the merchant's ATA back to the payer's ATA, funded by the merchant (refund liquidity comes from the receiver, never the facilitator).

The client produces exactly one signature: the `Approve` instruction. Facilitator-relayed `capture`, `void`, and `refund` each require an additional signature appropriate to the operation (delegate signature for capture, owner signature for void, merchant signature for refund).

## PaymentRequirements

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "auth-capture",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "1000000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyBADt1",
      "payTo": "0xReceiverAddress",
      "maxTimeoutSeconds": 60,
      "extra": {
        "delegate": "0xDelegateAddress",
        "captureDeadline": 1740758554,
        "refundDeadline": 1741276954,
        "feeRecipient": "0xFeeRecipientAddress",
        "minFeeBps": 0,
        "maxFeeBps": 0,
        "paymentFlow": "escrow",
        "memo": "optional-memo",
        "transactionVersions": [0, 1]
      }
    }
  ]
}
```

### `extra` fields

| Field                 | Required | Type                           | Description                                                                                                                                                                                                                                       |
| --------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate`            | Yes      | `string` (base58 address)      | The facilitator's delegate authority. Committed as the payment's operator. The client approves this address to spend up to `requirements.amount`. Must be an address the facilitator controls and signs from. |
| `captureDeadline`     | Yes      | `uint48`                       | Absolute Unix seconds; capture must occur before this. After this passes, the client may reclaim (unilateral, off-facilitator).                                                                                                                     |
| `refundDeadline`      | Yes      | `uint48`                       | Absolute Unix seconds; refunds are allowed until this.                                                                                                                                                                                            |
| `feeRecipient`        | Yes      | `string` (base58 address)      | Fee recipient for fees taken at capture or charge.                                                                                                                                                                                                |
| `minFeeBps`           | Yes      | `uint16`                       | Fee floor in basis points; `0` for none.                                                                                                                                                                                                          |
| `maxFeeBps`           | Yes      | `uint16`                       | Fee ceiling in basis points.                                                                                                                                                                                                                      |
| `paymentFlow`         | No       | `"escrow"` \| `"authorization"` | Which lifecycle applies. Default `"escrow"`. `"authorization"` means the client's payload settles as a terminal `charge` (no hold, no capture/void/reclaim).                                                                                        |
| `memo`                | No       | `string`                       | Optional memo that must appear exactly once in the transaction's Memo instructions. Used for replay protection.                                                                                                                                    |
| `transactionVersions` | No       | `number[]`                     | Transaction message versions the facilitator accepts, e.g. `[0, 1]`. Default `[0, 1]`.                                                                                                                                                              |

Where `network` is a CAIP-2 SVM identifier such as `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet-beta).

## Client payment payload

The client signs one `Approve` instruction and sends it with the payment payload. From that plus the payment requirements, the facilitator reconstructs the whole payment authorization with no stored state of its own.

### Payload structure

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/resource", "method": "GET" },
  "accepted": { "scheme": "auth-capture", "network": "solana:...", "...": "..." },
  "payload": {
    "transaction": "base64-encoded-partially-signed-transaction",
    "delegate": "0xDelegateAddress"
  }
}
```

| Payload field | Derived from                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `transaction` | Base64-encoded transaction containing an `Approve` instruction plus optional Memo |
| `delegate`    | `extra.delegate` — the facilitator's delegate authority                      |

### Transaction construction

The client builds a Solana transaction containing:

1. **`Approve`** (SPL Token or Token-2022): source = payer's ATA, delegate = `extra.delegate`, amount = `requirements.amount`. Signed by the payer (token account owner).
2. **Memo** (optional): if `extra.memo` is set, exactly one Memo instruction carrying `extra.memo`. If absent, a random nonce memo is included for replay protection.
3. **Compute budget** (optional): `SetComputeUnitLimit` and/or `SetComputeUnitPrice` to bound the facilitator's fee exposure.
4. **Lifetime**: `recentBlockhash` (expires in ~60-90s) or durable nonce (does not expire). Both are accepted.

The transaction is partially signed by the payer. The facilitator adds its own fee-payer signature at settle time.

### Durable nonce vs blockhash

`recentBlockhash` expires after ~60-90s. A durable nonce does not expire. The client must handle both; the sponsor (facilitator) must accept both. The transaction's lifetime is set via `setTransactionMessageLifetimeUsingBlockhash` for blockhash-based transactions, or via a nonce account for durable nonces.

## Verification

### Client payment payload

The operation is `authorize` (hold) or `charge` (direct) according to `extra.paymentFlow`, which defaults to `"escrow"` when omitted. A resource server first sends the client-authored payload to `/verify`. The facilitator performs these checks in order:

1. **Scheme match**: `requirements.scheme` and `payload.accepted.scheme` are both `auth-capture`.
2. **Network match**: `payload.accepted.network === requirements.network`, in `solana:<caip2>` form.
3. **Extra validation**: `requirements.extra` carries `delegate`, `captureDeadline`, `refundDeadline`, `feeRecipient`, `minFeeBps`, `maxFeeBps`. `delegate` must be an address the facilitator controls and signs from.
4. **Deadline ordering**: `refundDeadline >= captureDeadline`, `now + maxTimeoutSeconds <= captureDeadline`, `captureDeadline > now + 6s`.
5. **Transaction decode**: The payload's `transaction` decodes to a valid Solana transaction.
6. **Transaction version**: The message version is in `extra.transactionVersions` (default `[0, 1]`). Any other version is rejected with `unsupported_transaction_version`.
7. **Fee payer**: Account 0 (fee payer) matches `extra.feePayer` from requirements. The fee payer must be an address the facilitator manages.
8. **Signer count**: `numSignerAccounts <= maxRequiredSignatures` (default 2: payer + fee payer).
9. **Required signatures**: Every required signer except index 0 (fee payer, filled at settle) has a valid Ed25519 signature over `transaction.messageBytes`.
10. **Instruction layout**: The transaction contains exactly one `Approve` instruction at the expected position (after optional ComputeBudget prefix), plus optional Memo and ComputeBudget instructions. No other programs may appear at the top level.
11. **Approve validation**: The `Approve` delegates `requirements.amount` from the payer's ATA to `extra.delegate`, for the correct mint (`requirements.asset`). The delegate must not be a facilitator signer (fee-payer isolation).
12. **Memo validation**: If `extra.memo` is set, exactly one Memo instruction carries `extra.memo`. If `extra.memo` is absent, the random nonce memo is accepted.
13. **Mint match**: The `Approve`'s mint matches `requirements.asset`. Both SPL Token and Token-2022 programs are accepted.
14. **Amount match**: The approved amount equals `requirements.amount`.
15. **Simulation**: Simulate the transaction (with `sigVerify` off, since the fee-payer slot is unsigned) and require success. Catches insufficient balance, invalid accounts, etc.

Path 1 (static layout) is used for standard wallets. Path 2 (simulation-based) is opt-in via `enableSmartWalletVerification` and handles smart wallets (Squads, Swig, SPL Governance) where the `Approve` is executed via CPI. Semantic failures (amount/mint/delegate mismatch) must NOT fall through to Path 2.

## Settlement

Settlements are `/settle` calls with `payload.type` naming the operation: `"capture"`, `"void"`, or `"refund"`. `authorize`/`charge` are the initial collect settle (no `type` field).

### `capture`

The facilitator submits `TransferChecked` from the payer's ATA to the merchant's ATA, signed by the delegate (`extra.delegate`). The amount may be at most the held ceiling (`requirements.amount`).

The delegate was approved for up to `requirements.amount` at authorize time, so any capture amount `<=` that ceiling is valid. Partial captures are allowed; each capture reduces the remaining hold.

**Post-settlement verification (mandatory)**: After capture, confirm on-chain `TransferChecked` from payer ATA → merchant ATA via inner instructions + balance-delta fallback. Simulation alone is insufficient (TOCTOU defense).

### `void`

The facilitator submits `Revoke` to release the delegate's authority over the payer's ATA. This returns any unspent hold to the payer's full control.

Void requires the token account owner (payer) to sign the `Revoke` instruction. The client pre-signs the `Revoke` as part of the authorize payload, and the facilitator holds it for later submission.

**Post-settlement verification**: After void, confirm the `Revoke` succeeded — the delegate authority is cleared and no further `TransferChecked` by the delegate is possible.

### `refund`

The facilitator submits `TransferChecked` from the merchant's ATA back to the payer's ATA, signed by the merchant (token account owner). Refund liquidity comes from the receiver; the facilitator must not be an unexpected source of value.

The amount may be at most the amount captured and not yet refunded.

**Post-settlement verification**: After refund, confirm on-chain `TransferChecked` from merchant ATA → payer ATA.

### Duplicate settlement mitigation

Each settlement is keyed by the transaction message hash. A duplicate settlement for the same transaction returns `duplicate_settlement`. A `SettlementCache` with a 120s TTL covers the Solana blockhash lifetime with margin.

A pending-settlement fast path reconciles against an already-broadcast signature when `confirmTransaction` times out, preventing double-spend on resend.

## Security invariants

1. **Fee-payer isolation**: The fee payer never appears as authority/source/delegate in any instruction. The fee payer only pays the transaction fee.
2. **Delegate authority**: Only `extra.delegate` (an address the facilitator controls) may be the `Approve` delegate. The delegate must not be a facilitator signer address.
3. **Single memo**: Exactly one Memo instruction may appear, and it must match `extra.memo` when set.
4. **Amount cap**: The approved amount equals `requirements.amount`; captures may not exceed it.
5. **Token-2022 compatibility**: All `TransferChecked` logic works with both SPL Token and Token-2022 programs. Transfer hooks, confidential transfers, and interest-bearing tokens are handled via the standard `TransferChecked` instruction.
6. **Post-settlement verification**: After capture/void/refund, on-chain effects are confirmed via inner instructions + balance-delta fallback. TOCTOU is defended.
7. **Durable nonce**: Both `recentBlockhash` and durable nonce transactions are accepted; expired blockhashes are rejected by the runtime.

## Network bindings

- This document — SVM (SPL Token `Approve` + `TransferChecked` + `Revoke`)
- [`scheme_auth_capture_evm.md`](./scheme_auth_capture_evm.md) — EVM (commerce-payments escrow contracts)

## Version History

| Version | Date       | Changes                                    | Authors   |
| ------- | ---------- | ------------------------------------------ | --------- |
| v1.0    | 2026-11-03 | Initial SVM binding for auth-capture       |           |
