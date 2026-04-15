# Scheme: `session` on `EVM`

## Summary

The `session` scheme on EVM enables streaming payment channels where the Client (user) deposits funds into an on-chain escrow contract and signs cumulative off-chain EIP-712 vouchers authorizing increasing payment amounts. The Server (resource provider) settles periodically or at session close. This is ideal for metered services such as LLM inference, data streaming, or multi-request API sessions.

The scheme uses an **escrow contract** as the sole on-chain primitive. Two opening modes are supported:

| OpenMode | Use Case | Gas Payer | Notes |
| :--- | :--- | :--- | :--- |
| **Client-Broadcast** (`feePayer: false`) | Client has native token for gas | Client | Client calls `approve()` + `open()` on escrow |
| **Server-Submitted** (`feePayer: true`) | Gasless client experience | Server | Client signs EIP-3009 off-chain, server calls `openWithAuthorization()` |

> **Note**: EIP-3009 (`transferWithAuthorization`) is the only authorization mechanism for server-submitted opens because the escrow contract's `openWithAuthorization` function is designed around it. For client-broadcast mode, the client may use any mechanism (Permit2, multicall, UserOp, etc.) to fund the escrow — they simply submit the txHash.

---

## Use Cases

- **LLM Token Streaming**: Charge per output token over SSE; client deposits once, signs vouchers as tokens stream, pays exactly for what was generated
- **Multi-Request API Sessions**: Charge per API call over a persistent session without requiring a new payment signature per request
- **Data Streaming / Bandwidth Metering**: Charge per byte or per chunk across a series of streaming responses
- **Long-Running Compute Jobs**: Periodic billing based on time or resources consumed, with mid-job top-up capability

---

## Encoding Conventions

| Type | Format | Example |
| :--- | :--- | :--- |
| Addresses | EIP-55 mixed-case checksum, 0x-prefixed | `"0x742d35Cc6634C0532925a3b844Bc9E7595f8fE00"` |
| Byte strings | Lowercase hex, 0x-prefixed | `"0xabcdef..."` |
| Numeric amounts | Decimal string (no leading zeros except `"0"`) | `"5000000"` |
| Timestamps | Unix seconds as decimal string | `"1743523500"` |
| Basis points | JSON number (not string) | `500` |
| Boolean flags | JSON boolean | `true` |

All amounts are in **base units** (smallest indivisible token unit). For USDC (6 decimals): 1 USDC = `"1000000"`.

---

## Protocol Flow Overview

### Happy Path — Client-Broadcast (`feePayer: false`)

```
   Client (Payer)                  Resource Server (Payee)            Escrow Contract
      |                                    |                                |
      |  (1) GET /resource                 |                                |
      |----------------------------------->|                                |
      |                                    |                                |
      |  (2) 402 PaymentRequired           |                                |
      |      scheme="session"              |                                |
      |      extra.feePayer=false           |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  (3) approve(escrow, deposit)      |                                |
      |------------------------------------------------------------------->|
      |                                    |                                |
      |  (4) open(payee, token, deposit,   |                                |
      |      salt, authorizedSigner,       |                                |
      |      splits)                       |                                |
      |------------------------------------------------------------------->|
      |      channelId, txHash             |                                |
      |<-------------------------------------------------------------------|
      |                                    |                                |
      |  (5) Sign initial voucher          |                                |
      |      (channelId, cumAmt=0)         |                                |
      |                                    |                                |
      |  (6) PAYMENT-SIGNATURE             |                                |
      |      action="open"                 |                                |
      |      type="hash"                   |                                |
      |      hash=txHash                   |                                |
      |      signature=voucherSig          |                                |
      |----------------------------------->|                                |
      |                                    |  (7) verify channel state      |
      |                                    |------------------------------->|
      |                                    |      payee, token, deposit OK  |
      |                                    |<-------------------------------|
      |                                    |                                |
      |  (8) 200 OK + payment-receipt      |                                |
      |      {channelId}                   |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  ======= Active Session ========   |                                |
      |                                    |                                |
      |  (9) Sign voucher                  |                                |
      |      (channelId, cumAmt=N)         |                                |
      |                                    |                                |
      |  (10) PAYMENT-SIGNATURE            |                                |
      |       action="voucher"             |                                |
      |       cumulativeAmount=N           |                                |
      |       signature=voucherSig         |                                |
      |----------------------------------->|                                |
      |                                    |  (11) verify sig, persist,     |
      |                                    |       deduct cost              |
      |  (12) 200 SSE stream               |                                |
      |       (data chunks...)             |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  (13) SSE: payment-need-voucher    |                                |
      |       {requiredCumulative,         |                                |
      |        acceptedCumulative,         |                                |
      |        deposit}                    |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  (14) Sign voucher                 |                                |
      |       (channelId, cumAmt=M)        |                                |
      |                                    |                                |
      |  (15) PAYMENT-SIGNATURE            |                                |
      |       action="voucher"             |                                |
      |       cumulativeAmount=M           |                                |
      |----------------------------------->|                                |
      |                                    |                                |
      |  (16) 200 SSE stream continues     |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  (17) SSE: payment-receipt         |                                |
      |       {spent, acceptedCumulative,  |                                |
      |        units}                      |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  ======= Cooperative Close ======  |                                |
      |                                    |                                |
      |  (18) Sign final voucher           |                                |
      |       (channelId, cumAmt=final)    |                                |
      |                                    |                                |
      |  (19) PAYMENT-SIGNATURE            |                                |
      |       action="close"               |                                |
      |       cumulativeAmount=final       |                                |
      |       signature=voucherSig         |                                |
      |----------------------------------->|                                |
      |                                    |  (20) close(channelId,         |
      |                                    |       final, sig)              |
      |                                    |------------------------------->|
      |                                    |      settle + refund           |
      |                                    |<-------------------------------|
      |                                    |                                |
      |  (21) 200 + payment-receipt        |                                |
      |       {transaction: txHash}        |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
```

### Happy Path — Server-Submitted (`feePayer: true`)

```
   Client (Payer)                  Resource Server (Payee)            Escrow Contract
      |                                    |                                |
      |  (1) GET /resource                 |                                |
      |----------------------------------->|                                |
      |                                    |                                |
      |  (2) 402 PaymentRequired           |                                |
      |      scheme="session"              |                                |
      |      extra.feePayer=true            |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  (3) Sign EIP-3009                 |                                |
      |      transferWithAuthorization     |                                |
      |      (from, to=escrow, value,      |                                |
      |       nonce, ...)                  |                                |
      |                                    |                                |
      |  (4) Sign initial voucher          |                                |
      |      (channelId, cumAmt=0)         |                                |
      |                                    |                                |
      |  (5) PAYMENT-SIGNATURE             |                                |
      |      action="open"                 |                                |
      |      type="transaction"            |                                |
      |      authorization={eip3009}       |                                |
      |      signature=eip3009Sig          |                                |
      |      voucherSignature=voucherSig   |                                |
      |----------------------------------->|                                |
      |                                    |  (6) openWithAuthorization(    |
      |                                    |      payee, token, deposit,    |
      |                                    |      salt, ..., eip3009Sig,    |
      |                                    |      splits)                   |
      |                                    |------------------------------->|
      |                                    |      channelId                 |
      |                                    |<-------------------------------|
      |                                    |                                |
      |                                    |  (7) verify initial voucher    |
      |                                    |      signature                 |
      |                                    |                                |
      |  (8) 200 OK + payment-receipt      |                                |
      |      {channelId}                   |                                |
      |<-----------------------------------|                                |
      |                                    |                                |
      |  Steps (9)–(21): identical to      |                                |
      |  Client-Broadcast flow above       |                                |
      |                                    |                                |
```

### Forced Close (Non-Cooperative)

```
   Client (Payer)                  Resource Server (Payee)            Escrow Contract
      |                                    |                                |
      |  Server unresponsive               |                                |
      |                                    |                                |
      |  (1) requestClose(channelId)       |                                |
      |------------------------------------------------------------------->|
      |                                    |      closeRequestedAt = now    |
      |<-------------------------------------------------------------------|
      |                                    |                                |
      |  ======= Grace Period ==========  |                                |
      |  (ref: 15 min L2, 60 min L1)      |                                |
      |                                    |                                |
      |                                    |  (2) settle(channelId,         |
      |                                    |      lastVoucherAmt, sig)      |
      |                                    |------------------------------->|
      |                                    |      earned revenue settled    |
      |                                    |<-------------------------------|
      |                                    |                                |
      |  ======= After Grace Period ====   |                                |
      |                                    |                                |
      |  (3) withdraw(channelId)           |                                |
      |------------------------------------------------------------------->|
      |      remaining deposit refunded    |                                |
      |      channel finalized             |                                |
      |<-------------------------------------------------------------------|
      |                                    |                                |
```

---

## 1. PaymentRequirements Schema

The `session` scheme uses the following `PaymentRequirements` schema:

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `scheme` | `string` | Required | Must be `"session"` |
| `network` | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., `"eip155:196"`) |
| `amount` | `string` | Required | Price per unit of service in base units (not total charge). Total cost = `amount * units_consumed`. Note: this differs from `exact` (total amount) and `upto` (maximum authorized) |
| `asset` | `string` | Required | ERC-20 token contract address |
| `payTo` | `string` | Required | Recipient wallet address (server/payee) |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for channel open confirmation |
| `extra` | `object` | Required | Session-specific additional information (see below) |

### `extra` Fields

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `escrowContract` | `string` | Required | Address of the channel escrow contract |
| `unitType` | `string` | Optional | Unit being priced (e.g., `"llm_token"`, `"byte"`, `"request"`) |
| `suggestedDeposit` | `string` | Optional | Suggested channel deposit amount in base units |
| `channelId` | `string` | Optional | Channel ID if resuming an existing channel |
| `minVoucherDelta` | `string` | Optional | Minimum amount increase between vouchers in base units. Default `"0"` |
| `feePayer` | `boolean` | Optional | If `true`, server pays gas for open/topUp. Default `false` |
| `splits` | `array` | Optional | Ratio-based payment splits (see Split Payments section) |

**Example PaymentRequired (402 Response):**

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/v1/chat/completions",
    "description": "LLM inference endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "session",
      "network": "eip155:196",
      "amount": "100",
      "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
      "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
      "maxTimeoutSeconds": 300,
      "extra": {
        "escrowContract": "0x1234567890abcdef1234567890abcdef12345678",
        "unitType": "llm_token",
        "suggestedDeposit": "5000000",
        "minVoucherDelta": "10000",
        "feePayer": false
      }
    }
  ]
}
```

This requests 0.0001 USDC per LLM token on X Layer, with a suggested deposit of 5.00 USDC (~50,000 tokens). The `minVoucherDelta` of 10,000 base units (0.01 USDC) means vouchers must cover at least 100 tokens each.

---

## 2. PaymentPayload Schema

The `session` scheme uses an `action` discriminator in the `payload` field to support multiple lifecycle operations over a single channel.

### Common Payload Structure

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | One of `"open"`, `"topUp"`, `"voucher"`, `"close"` |

The remaining fields depend on the `action` value.


### Signature Field Reference

The `signature` field is overloaded: in `feePayer: true` open/topUp payloads it carries the EIP-3009 authorization signature, while in all other contexts it carries the EIP-712 voucher signature. The `voucherSignature` field only appears when both signature types are needed in the same payload.

| Action | `feePayer` | `signature` contains | `voucherSignature` contains |
| :--- | :--- | :--- | :--- |
| `open` | `false` | EIP-712 voucher signature | N/A (not present) |
| `open` | `true` | EIP-3009 `transferWithAuthorization` signature | EIP-712 voucher signature |
| `topUp` | `false` | N/A (not present — client submits txHash) | N/A |
| `topUp` | `true` | EIP-3009 `transferWithAuthorization` signature | N/A |
| `voucher` | N/A | EIP-712 voucher signature | N/A |
| `close` | N/A | EIP-712 voucher signature | N/A |

All signatures are 65 bytes (`r ‖ s ‖ v`), encoded as 0x-prefixed lowercase hex (132 characters).

### 2.1 Open Payload (`feePayer: false`)

Client broadcasts `approve()` + `open()` on-chain and submits the txHash.

> **Smart Wallet Support (ERC-4337)**: When the client is a smart contract wallet (e.g., ERC-4337 account), it cannot produce ECDSA voucher signatures directly. The client MUST set `authorizedSigner` to an EOA that will sign vouchers on its behalf. The smart wallet MAY batch `approve()` + `open()` into a single UserOperation via the EntryPoint contract. The `authorizedSigner` is registered at channel open time and cannot be changed afterward.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/chat/completions",
    "description": "LLM inference endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678",
      "unitType": "llm_token",
      "suggestedDeposit": "5000000",
      "minVoucherDelta": "10000",
      "feePayer": false
    }
  },
  "payload": {
    "action": "open",
    "type": "hash",
    "from": "0xaabbccddee11223344556677889900aabbccddee",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "hash": "0x9f8e7d6c5b4a39281700abcdef1234567890abcdef1234567890abcdef123456",
    "salt": "0xaaaa1234bbbb5678cccc9012dddd3456eeee7890ffff1234aaaa5678bbbb9012",
    "authorizedSigner": "0x0000000000000000000000000000000000000000",
    "cumulativeAmount": "0",
    "signature": "0xabcdef1234567890..."
  }
}
```

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | `"open"` |
| `type` | `string` | Required | `"hash"` |
| `from` | `string` | Required | Payer's EVM address |
| `channelId` | `string` | Required | Channel identifier (hex bytes32) |
| `hash` | `string` | Required | Tx hash of the on-chain `open()` call |
| `salt` | `string` | Required | Random bytes32 hex used for channelId computation |
| `authorizedSigner` | `string` | Optional | Delegated voucher signer address. `address(0)` or omitted = payer signs |
| `cumulativeAmount` | `string` | Required | Initial cumulative amount (typically `"0"`) |
| `signature` | `string` | Required | EIP-712 voucher signature for the initial amount |

### 2.2 Open Payload (`feePayer: true`)

Client signs EIP-3009 authorization off-chain. Server calls `openWithAuthorization()`.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/chat/completions",
    "description": "LLM inference endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678",
      "unitType": "llm_token",
      "suggestedDeposit": "5000000",
      "minVoucherDelta": "10000",
      "feePayer": true
    }
  },
  "payload": {
    "action": "open",
    "type": "transaction",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "authorization": {
      "type": "eip-3009",
      "from": "0xaabbccddee11223344556677889900aabbccddee",
      "to": "0x1234567890abcdef1234567890abcdef12345678",
      "value": "5000000",
      "validAfter": "0",
      "validBefore": "1743523500",
      "nonce": "0xaaaa1234bbbb5678cccc9012dddd3456eeee7890ffff1234aaaa5678bbbb9012"
    },
    "signature": "0xabcdef...eip3009sig",
    "salt": "0xaaaa1234bbbb5678cccc9012dddd3456eeee7890ffff1234aaaa5678bbbb9012",
    "authorizedSigner": "0x0000000000000000000000000000000000000000",
    "cumulativeAmount": "0",
    "voucherSignature": "0x123456...vouchersig"
  }
}
```

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | `"open"` |
| `type` | `string` | Required | `"transaction"` |
| `channelId` | `string` | Required | Channel identifier (hex bytes32) |
| `authorization` | `object` | Required | EIP-3009 authorization parameters (see below) |
| `signature` | `string` | Required | EIP-3009 `transferWithAuthorization` signature (65 bytes, 0x-prefixed hex). Note: in `feePayer: true` payloads, `signature` is the EIP-3009 signature and `voucherSignature` is the EIP-712 voucher signature. In `feePayer: false` payloads (Section 2.1), `signature` is the voucher signature |
| `salt` | `string` | Required | Random bytes32 hex for channelId computation |
| `authorizedSigner` | `string` | Optional | Delegated voucher signer. `address(0)` or omitted = payer |
| `cumulativeAmount` | `string` | Required | Initial cumulative amount (typically `"0"`) |
| `voucherSignature` | `string` | Required | EIP-712 voucher signature for the initial amount |

**EIP-3009 Authorization Fields:**

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `type` | `string` | Required | Authorization mechanism. Must be `"eip-3009"` |
| `from` | `string` | Required | Payer address |
| `to` | `string` | Required | Escrow contract address (= `extra.escrowContract`) |
| `value` | `string` | Required | Deposit amount in base units |
| `validAfter` | `string` | Required | Unix timestamp, valid from. `"0"` = immediately |
| `validBefore` | `string` | Required | Unix timestamp, expires. Must exceed `maxTimeoutSeconds` |
| `nonce` | `string` | Required | Random bytes32 hex. EIP-3009 nonce, unique per token per authorizer |

### 2.3 TopUp Payload

Adds funds to an existing channel. Resets any pending forced close timer.

**`feePayer: false` (client broadcasts):**

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | `"topUp"` |
| `type` | `string` | Required | `"hash"` |
| `channelId` | `string` | Required | Channel ID |
| `hash` | `string` | Required | Tx hash of the on-chain `topUp()` call |
| `additionalDeposit` | `string` | Required | Additional amount deposited in base units |

**Example (`feePayer: false`):**

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678"
    }
  },
  "payload": {
    "action": "topUp",
    "type": "hash",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "hash": "0xbbbbcccc1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    "additionalDeposit": "5000000"
  }
}
```

**`feePayer: true` (server submits):**

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | `"topUp"` |
| `type` | `string` | Required | `"transaction"` |
| `channelId` | `string` | Required | Channel ID |
| `authorization` | `object` | Required | EIP-3009 authorization parameters (includes `type: "eip-3009"`, see Section 2.2) |
| `signature` | `string` | Required | EIP-3009 signature |
| `additionalDeposit` | `string` | Required | Additional amount to deposit in base units |

**Example (`feePayer: true`):**

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678"
    }
  },
  "payload": {
    "action": "topUp",
    "type": "transaction",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "authorization": {
      "type": "eip-3009",
      "from": "0xaabbccddee11223344556677889900aabbccddee",
      "to": "0x1234567890abcdef1234567890abcdef12345678",
      "value": "5000000",
      "validAfter": "0",
      "validBefore": "1743610000",
      "nonce": "0xbbbb1234cccc5678dddd9012eeee3456ffff7890aaaa1234bbbb5678cccc9012"
    },
    "signature": "0xfedcba...eip3009sig",
    "additionalDeposit": "5000000"
  }
}
```

### 2.4 Voucher Payload

Submits an updated cumulative voucher authorizing additional payment.

**Example (voucher only):**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/chat/completions",
    "description": "LLM inference endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678"
    }
  },
  "payload": {
    "action": "voucher",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "cumulativeAmount": "250000",
    "signature": "0xabcdef1234567890..."
  }
}
```

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | `"voucher"` |
| `channelId` | `string` | Required | Channel identifier |
| `cumulativeAmount` | `string` | Required | Cumulative amount authorized (must be > previous) |
| `signature` | `string` | Required | EIP-712 voucher signature |
| `deposit` | `object` | Optional | Deposit extension for merging topUp with voucher (see below) |

**Deposit Merge Extension:**

Vouchers MAY carry an optional `deposit` field to merge a deposit authorization with the voucher update in a single round-trip. This is useful when the client's balance is running low and they want to top up AND authorize more spending in one HTTP round-trip.

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `deposit.action` | `string` | Required | `"open"` or `"topUp"` |
| `deposit.authorization` | `object` | Required | EIP-3009 authorization parameters (includes `type: "eip-3009"`, see Section 2.2) |
| `deposit.signature` | `string` | Required | EIP-3009 signature (65 bytes hex) |
| `deposit.salt` | `string` | Conditional | Required when `deposit.action` is `"open"` |
| `deposit.authorizedSigner` | `string` | Optional | Delegated voucher signer. Only for `deposit.action: "open"` |

When `deposit` is present, the server processes the deposit first (`openWithAuthorization` or `topUpWithAuthorization`), then validates and accepts the voucher.

**Example (voucher + deposit merge — topUp while authorizing more spend):**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/chat/completions",
    "description": "LLM inference endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678"
    }
  },
  "payload": {
    "action": "voucher",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "cumulativeAmount": "8000000",
    "signature": "0xabcdef...vouchersig",
    "deposit": {
      "action": "topUp",
      "authorization": {
        "type": "eip-3009",
        "from": "0xaabbccddee11223344556677889900aabbccddee",
        "to": "0x1234567890abcdef1234567890abcdef12345678",
        "value": "5000000",
        "validAfter": "0",
        "validBefore": "1743610000",
        "nonce": "0xcccc1234dddd5678eeee9012ffff3456aaaa7890bbbb1234cccc5678dddd9012"
      },
      "signature": "0x789abc...eip3009sig"
    }
  }
}
```

In this example, the client had an initial deposit of 5,000,000 and has consumed most of it. They simultaneously top up 5,000,000 more (via the `deposit` field) and authorize spending up to 8,000,000 cumulative (via the voucher). The server first calls `topUpWithAuthorization` on-chain, then accepts the voucher against the new deposit of 10,000,000.

> **Partial-failure semantics**: If the on-chain deposit succeeds but the voucher validation subsequently fails (e.g., invalid signature, `cumulativeAmount` exceeds new deposit), the server MUST still acknowledge the deposit (funds are already on-chain and the channel state has changed). The server MUST return an error response indicating the voucher was rejected, along with the updated channel deposit. The client can then retry with a corrected voucher.

### 2.5 Close Payload

Requests the server to close the channel and settle on-chain.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/chat/completions",
    "description": "LLM inference endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "session",
    "network": "eip155:196",
    "amount": "100",
    "asset": "0x74b7F16337b8972027F6196A17a631ac6dE26d22",
    "payTo": "0x742d35cc6634c0532925a3b844bc9e7595f8fe00",
    "maxTimeoutSeconds": 300,
    "extra": {
      "escrowContract": "0x1234567890abcdef1234567890abcdef12345678"
    }
  },
  "payload": {
    "action": "close",
    "channelId": "0x6d0f4fdf1f2f6a1f6c1b0fbd6a7d5c2c0a8d3d7b1f6a9c1b3e2d4a5b6c7d8e9f",
    "cumulativeAmount": "3750000",
    "signature": "0xabcdef1234567890..."
  }
}
```

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Required | `"close"` |
| `channelId` | `string` | Required | Channel identifier |
| `cumulativeAmount` | `string` | Required | Final cumulative amount |
| `signature` | `string` | Required | EIP-712 voucher signature |

---

## 3. Voucher Signing Format

Vouchers use EIP-712 typed structured data signing.

### Type Definitions

```json
{
  "Voucher": [
    { "name": "channelId", "type": "bytes32" },
    { "name": "cumulativeAmount", "type": "uint128" }
  ]
}
```

### Domain Separator

| Field | Type | Value |
| :--- | :--- | :--- |
| `name` | string | `"EVM Payment Channel"` |
| `version` | string | `"1"` |
| `chainId` | uint256 | EVM chain ID (e.g., `196`) |
| `verifyingContract` | string | Escrow contract address |

### Signing Procedure

1. Construct the domain separator hash using EIP-712 `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`
2. Construct the struct hash using `Voucher(bytes32 channelId,uint128 cumulativeAmount)`
3. Compute signing hash: `keccak256("\x19\x01" || domainSeparator || structHash)`
4. Sign with ECDSA using secp256k1 curve
5. Encode signature as 65-byte `r || s || v` where `v` is 27 or 28

---

## 4. Channel Escrow Contract

### Channel State

Each channel is identified by a unique `channelId` computed as:

```
channelId = keccak256(abi.encode(payer, payee, token, salt, authorizedSigner, address(this), block.chainid))
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `payer` | address | User who deposited funds |
| `payee` | address | Server authorized to withdraw |
| `token` | address | ERC-20 token address |
| `authorizedSigner` | address | Delegated voucher signer (see note below) |
| `deposit` | uint128 | Total amount deposited |
| `settled` | uint128 | Cumulative amount already withdrawn by payee |
| `closeRequestedAt` | uint64 | Timestamp when close was requested (0 if not) |
| `finalized` | bool | Whether channel is closed |
| `splitRecipients` | address[] | Split recipient addresses (empty if no splits) |
| `splitBps` | uint16[] | Corresponding basis points per recipient |

> **`authorizedSigner` semantics**: When `authorizedSigner` is `address(0)`, the payer signs vouchers directly. The escrow contract MUST store `address(0)` as-is (not replace it with the payer address), so that the `channelId` computation remains deterministic. During voucher signature verification, the contract MUST check: if `channel.authorizedSigner == address(0)`, recover and verify against `channel.payer`; otherwise verify against `channel.authorizedSigner`. This allows the `channelId` to be computed off-chain before the channel is opened, using `address(0)` as a known constant for self-signed channels.

> **`channelId` off-chain computation**: The `channelId` formula uses `address(this)` (the escrow contract address) and `block.chainid`. Clients compute these from `extra.escrowContract` and the chain ID derived from the `network` field (CAIP-2 format). For example, `network: "eip155:196"` yields `chainId = 196`.

### Contract Functions

| Function | Caller | Description |
| :--- | :--- | :--- |
| `open(payee, token, deposit, salt, authorizedSigner, splitRecipients, splitBps)` | Anyone | Creates channel; caller becomes payer. Requires prior `approve(escrow, deposit)` |
| `openWithAuthorization(payee, token, deposit, salt, authorizedSigner, from, validAfter, validBefore, nonce, v, r, s, splitRecipients, splitBps)` | Anyone (typically server) | Creates channel via EIP-3009; `from` becomes payer |
| `settle(channelId, cumulativeAmount, signature)` | Payee only | Withdraws funds using voucher without closing channel |
| `topUp(channelId, additionalDeposit)` | Payer only | Adds funds. Resets pending close timer |
| `topUpWithAuthorization(channelId, additionalDeposit, from, validAfter, validBefore, nonce, v, r, s)` | Anyone (typically server) | Adds funds via EIP-3009 |
| `close(channelId, cumulativeAmount, signature)` | Payee only | Final settle + refund remainder to payer |
| `requestClose(channelId)` | Payer only | Initiates forced close, starts grace period |
| `withdraw(channelId)` | Payer only | Withdraws remaining funds after grace period |

### Settlement Delta Computation

When `settle()` or `close()` is called:

```
delta = cumulativeAmount - channel.settled
```

If no splits: `delta` transferred to payee.
If splits registered:
1. `splitAmount = delta * bps / 10000` for each split recipient
2. Remainder (`delta - sum(splitAmounts)`) transferred to payee
3. All transfers atomic

---

## 5. Concurrency Model

A channel supports **one active session at a time**. The cumulative voucher semantics ensure correctness — each voucher advances a single monotonic counter. The channel itself is the unit of concurrency; no additional session-level locking is required.

**Concurrent request handling:**

- When a client sends a new streaming request on a channel that already has an active streaming response, the server SHOULD terminate the previous stream and start a new one.
- Voucher updates MAY arrive on separate HTTP connections (including HTTP/2 streams) and MUST be processed **atomically** with respect to balance updates (`acceptedCumulative` and `spent`).
- Servers MUST serialize voucher acceptance and spend deduction to prevent race conditions (e.g., two concurrent requests both checking `available` before either deducts).

**Multiple channels:**

- A client MAY maintain multiple channels to the same server (different `channelId`s). Each operates independently.

**Sequential sessions:**

A single channel MAY support multiple sequential sessions without closing and reopening. After one logical session ends (e.g., an LLM conversation completes), the client can start a new session on the same channel by sending new requests with vouchers that continue the same cumulative counter. The cumulative counter does NOT reset between sessions, and the server's `spent` counter continues from where the previous session left off. This avoids the gas cost of close + reopen for repeat customers.

---

## 6. Split Payments

Session splits use **basis points (bps)** because the total session cost is unknown upfront and grows with consumption. This differs from the `exact` scheme which uses fixed amounts.

### Split Entry Schema

Each entry in `extra.splits`:

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `recipient` | `string` | Required | Recipient EVM address |
| `bps` | `number` | Required | Basis points (1 bps = 0.01%). Range: 1-9999 |
| `memo` | `string` | Optional | Human-readable label (max 256 chars) |

### Constraints

- Sum of all `splits[].bps` MUST be strictly less than 10000 (100%)
- Primary recipient (`payTo`) MUST always receive non-zero remainder
- Split ratios are **immutable** once registered at channel `open()` time
- Servers SHOULD enforce a maximum split count (e.g., 10) appropriate for the target chain's gas limits to prevent gas DoS via excessive split arrays
- Clients do NOT sign per-split — vouchers authorize the total. The escrow contract distributes according to registered splits

### Example

```json
"extra": {
  "escrowContract": "0x...",
  "splits": [
    { "recipient": "0xPlatform...", "bps": 500, "memo": "platform fee" }
  ]
}
```

5% platform fee. When server settles 3,750,000 base units (3.75 USDC): platform receives 187,500 (0.1875 USDC), primary recipient receives 3,562,500 (3.5625 USDC).

---

## 7. Verification Logic

### 7.1 Open Verification

**When `type="hash"`:**

1. Verify txHash via `eth_getTransactionReceipt`
2. Verify the transaction caused `open()` on the expected escrow contract
3. Query escrow: channel exists, `payee` matches server, `token` matches `asset`, `deposit >= suggestedDeposit`, not finalized
4. Verify initial voucher signature (see Voucher Verification)
5. Initialize server-side accounting state

**When `type="transaction"`:**

1. Verify EIP-3009 authorization parameters (from, to = escrow, validBefore > now)
2. Verify EIP-3009 signature via `ecrecover`
3. Call `openWithAuthorization()` on escrow contract
4. Verify channel state as above
5. Verify initial voucher signature
6. Initialize server-side accounting state

### 7.2 Voucher Verification

> **Note**: Steps are ordered from cheapest to most expensive to minimize DoS attack surface. Steps 1–7 are pure arithmetic/comparison checks; steps 8–9 involve expensive `ecrecover` cryptographic operations.

1. If `cumulativeAmount <= acceptedCumulative`: return success without state change (idempotent)
2. Verify `channel.closeRequestedAt == 0` (no pending close)
3. If `deposit` field present: process deposit first (open or topUp)
4. Verify `cumulativeAmount > acceptedCumulative` (monotonicity)
5. Verify `(cumulativeAmount - acceptedCumulative) >= minVoucherDelta`
6. Verify `cumulativeAmount <= channel.deposit` (deposit cap)
7. Verify `cumulativeAmount <= 2^128 - 1` (uint128 bound)
8. Recover signer from EIP-712 signature; verify matches expected signer
9. Verify signature uses canonical low-s values
10. Persist voucher to durable storage BEFORE providing service
11. Update `acceptedCumulative = cumulativeAmount`

### 7.3 TopUp Verification

**When `type="hash"`:**

1. Verify txHash via `eth_getTransactionReceipt`
2. Verify the transaction called `topUp(channelId, additionalDeposit)` on the expected escrow contract
3. Verify `channelId` matches an existing, non-finalized channel where `payee` is this server
4. Verify `additionalDeposit` matches the `additionalDeposit` field in the payload
5. Update server-side deposit tracking: `knownDeposit += additionalDeposit`

**When `type="transaction"`:**

1. Verify EIP-3009 authorization parameters (`from` = channel payer, `to` = escrow contract, `validBefore > now`)
2. Verify EIP-3009 signature via `ecrecover`
3. Call `topUpWithAuthorization()` on escrow contract
4. Verify on-chain deposit increased by `additionalDeposit`
5. Update server-side deposit tracking

**Common post-conditions:**

- If a `requestClose` was pending, the escrow contract resets `closeRequestedAt` to 0
- Server SHOULD re-evaluate available balance: `available = acceptedCumulative - spent` (deposit increase allows higher future vouchers)

### 7.4 Close Verification

1. Verify `cumulativeAmount >= spent` (covers all delivered service)
2. Verify voucher signature
3. Call `close(channelId, cumulativeAmount, signature)` on escrow
4. Return receipt with transaction hash

---

## 8. Settlement Logic

### Settlement Timing

Servers MAY settle at any time:

- Periodically (every N seconds or M base units)
- When `action="close"` is received
- When unsettled amount exceeds a threshold
- Based on gas cost optimization

### Cooperative Close

1. Client sends `action="close"` with final voucher
2. Server verifies `cumulativeAmount >= spent`
3. Server calls `close(channelId, cumulativeAmount, signature)` on escrow
4. Contract settles delta (distributing to split recipients if applicable) and refunds remainder to payer
5. Server returns receipt with transaction hash

### Forced Close

1. Client calls `requestClose(channelId)` on-chain
2. Grace period begins (contract-defined; reference value: 15 minutes, minimum: 10 minutes)
3. Server can still `settle()` or `close()` during grace period
4. After grace period, client calls `withdraw(channelId)`
5. Client receives remaining (unsettled) funds

---

## 9. Server-Side Accounting

### Per-Session State

| Field | Type | Description |
| :--- | :--- | :--- |
| `acceptedCumulative` | uint128 | Highest valid voucher amount accepted |
| `spent` | uint128 | Cumulative amount charged for delivered service |
| `settledOnChain` | uint128 | Last cumulative amount settled on-chain |

Available balance: `available = acceptedCumulative - spent`

### Per-Request Processing

1. **Voucher acceptance**: Verify and persist new `acceptedCumulative`
2. **Balance check**: If `available < cost`, return payment required
3. **Charge and deliver**: Persist `spent := spent + cost` BEFORE delivering service
4. **Receipt generation**: Include balance state in receipt

### Insufficient Balance During Streaming

When balance is exhausted during a streaming response:

1. Server MUST stop delivering additional metered content
2. Server MUST signal the client to submit a new voucher

**SSE signal:**

```
event: payment-need-voucher
data: {"channelId":"0x6d0f...","requiredCumulative":"250025","acceptedCumulative":"250000","deposit":"500000"}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `channelId` | string | Required | Channel identifier |
| `requiredCumulative` | string | Required | Minimum next voucher amount |
| `acceptedCumulative` | string | Required | Current highest accepted |
| `deposit` | string | Required | Current on-chain deposit |

When `requiredCumulative > deposit`, the client MUST submit a `topUp` before sending a new voucher.

### Receipt Delivery During Streaming

For non-streaming responses, the `SettlementResponse` (Section 10) is returned in the HTTP response body. For streaming responses (SSE), the HTTP response has already started, so the server MUST deliver receipts via SSE events.

**SSE receipt event:**

```
event: payment-receipt
data: {"success":true,"transaction":"","network":"eip155:196","amount":"50000","extensions":{"session":{"channelId":"0x6d0f...","acceptedCumulative":"250000","spent":"237500","units":500}}}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `success` | boolean | Required | Whether the payment was accepted |
| `transaction` | string | Required | On-chain tx hash (empty if voucher-only) |
| `network` | string | Required | CAIP-2 network identifier |
| `amount` | string | Optional | Amount charged for this request (delta) |
| `extensions.session` | object | Required | Session state (see Section 10) |

The `payment-receipt` event data follows the same schema as the `SettlementResponse` (Section 10). Servers MUST emit a `payment-receipt` event:

- After accepting an `open` or `topUp` payload during streaming
- As the final SSE event when a streaming response completes, containing the cumulative charge for that response
- After accepting a `close` payload, with the on-chain transaction hash in `transaction`

> **Note**: The SSE event types `payment-need-voucher` and `payment-receipt` are defined by this specification.

### Cost Calculation

The server determines the cost of each request based on the `amount` field in `PaymentRequirements` (price per unit) and actual resource consumption:

```
cost = amount × units_consumed
```

Where:

- `amount` is from the `PaymentRequirements` (e.g., `"100"` = 0.0001 USDC per token)
- `units_consumed` is measured by the server (e.g., 500 LLM tokens)
- The result is in base units (e.g., `100 × 500 = 50000` = 0.05 USDC)

The server MUST verify `cost <= available` before delivering service. If `cost > available`, the server MUST request a new voucher before continuing.

### Request Idempotency

Clients SHOULD include an `Idempotency-Key` header (UUID v4) on requests that carry voucher or deposit payloads. The idempotency key is scoped per-channel (the server MUST key on `(channelId, Idempotency-Key)`). Servers MUST:

- Store the `(channelId, Idempotency-Key)` → response mapping after processing
- Return the cached response for duplicate keys without re-processing
- If a duplicate key arrives with different payload content, return `409 Conflict`
- Expire idempotency records after a reasonable period (e.g., 24 hours)

This prevents double-charging when clients retry due to network errors.

### Crash Safety

- Persist `spent` increments BEFORE delivering service
- Persist `acceptedCumulative` BEFORE relying on new balance
- Use transactional storage or write-ahead logging
- On restart: server holds last voucher signature, can call `settle()` to recover

---

## 10. SettlementResponse Schema Extension

The `session` scheme extends the base [`SettlementResponse`](../../x402-specification-v2.md#53-settlementresponse-schema) with session-specific fields in the `extensions` object.

**Base fields (from x402 v2):**

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `success` | `boolean` | Required | Whether settlement was successful |
| `errorReason` | `string` | Optional | Error reason if failed |
| `payer` | `string` | Optional | Payer's wallet address |
| `transaction` | `string` | Required | On-chain tx hash (empty if voucher-only, no on-chain settlement) |
| `network` | `string` | Required | CAIP-2 network identifier |
| `amount` | `string` | Optional | Amount charged for this request in base units (delta, not cumulative). Omitted for voucher-only responses with no charge |

**Session extension fields (in `extensions.session`):**

| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `channelId` | `string` | Required | Channel identifier |
| `acceptedCumulative` | `string` | Required | Highest voucher accepted |
| `spent` | `string` | Required | Total cumulative amount charged |
| `units` | `number` | Optional | Units consumed this request |

**Example (per-request receipt):**

```json
{
  "success": true,
  "transaction": "",
  "network": "eip155:196",
  "payer": "0xaabbccddee11223344556677889900aabbccddee",
  "amount": "50000",
  "extensions": {
    "session": {
      "channelId": "0x6d0f4fdf...",
      "acceptedCumulative": "250000",
      "spent": "237500",
      "units": 500
    }
  }
}
```

**Example (on close):**

```json
{
  "success": true,
  "transaction": "0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890",
  "network": "eip155:196",
  "payer": "0xaabbccddee11223344556677889900aabbccddee",
  "amount": "3750000",
  "extensions": {
    "session": {
      "channelId": "0x6d0f4fdf...",
      "acceptedCumulative": "3750000",
      "spent": "3750000"
    }
  }
}
```

---

## 11. Error Codes

The `session` scheme uses the standard x402 error codes defined in the [x402 specification](../../x402-specification-v2.md#9-error-handling).

### Scheme-Specific Error Codes

| Error Code | Description |
| :--- | :--- |
| `invalid_session_evm_voucher_signature` | Voucher signature invalid or signer mismatch |
| `invalid_session_evm_voucher_not_increasing` | `cumulativeAmount` not greater than previous |
| `invalid_session_evm_voucher_delta_too_small` | Increment below `minVoucherDelta` |
| `invalid_session_evm_amount_exceeds_deposit` | `cumulativeAmount` exceeds on-chain deposit |
| `invalid_session_evm_channel_not_found` | No channel with provided channelId |
| `invalid_session_evm_channel_finalized` | Channel already closed |
| `invalid_session_evm_insufficient_balance` | `available` balance too low for requested service |
| `invalid_session_evm_open_failed` | On-chain open transaction failed or invalid |

---

## 12. Security Considerations

1. **Replay Prevention**: Vouchers are bound to a specific channel and contract via `channelId` in the voucher message, `verifyingContract` and `chainId` in the EIP-712 domain, and cumulative semantics (can only increase).

2. **Cross-Chain Replay**: The EIP-712 domain separator includes `chainId`, making voucher signatures invalid on other chains.

3. **Signature Malleability**: The escrow contract MUST enforce canonical (low-s) ECDSA signatures. Signatures MUST have `s <= secp256k1_order / 2`.

4. **Deposit Cap**: Server MUST verify `cumulativeAmount <= channel.deposit`. The escrow contract enforces this on-chain as well.

5. **Overflow Protection**: Server MUST verify `cumulativeAmount <= 2^128 - 1`. The escrow contract enforces the same constraint via uint128 type.

6. **Denial of Service**: Rate limit voucher submissions (SHOULD limit to 10/second/session). Enforce `minVoucherDelta`. Enforce minimum deposit thresholds. When `feePayer: true`, servers SHOULD enforce minimum deposit to prevent gas griefing.

7. **Front-Running Protection**: `channelId` includes payer address, so front-runners produce different IDs. When `feePayer: true`, the EIP-3009 `to` field MUST be the escrow contract address, preventing signature extraction and fund diversion.

8. **Chain Reorganization**: Servers SHOULD use sufficient confirmation depth before accepting open/topUp. Reference values: L2 rollups ~1 block, Ethereum mainnet ~12 blocks. Voucher-based payments are not affected (off-chain).

9. **No Voucher Expiry**: Vouchers remain valid until the channel closes. Channels have no automatic expiry. Servers SHOULD settle and close channels inactive for extended periods (e.g., 30+ days).

10. **ERC-20 Approval Front-Running (feePayer: false)**: When the client sends separate `approve()` and `open()` transactions, a front-runner could exploit the approval window. Clients SHOULD batch `approve + open` in a single transaction (or use atomic multicall / ERC-4337 UserOp) to prevent this.

11. **Escrow Contract Guarantees**: The escrow contract is the sole custodian of deposited funds. It MUST enforce: (a) only the payee can call `settle()` and `close()`, (b) `cumulativeAmount <= deposit`, (c) voucher signature verification on-chain, (d) split distribution atomicity. Client and server security depends on correct contract implementation.

12. **Disconnection Handling**: If the client disconnects mid-session, the server holds the last accepted voucher and can call `settle()` unilaterally to recover earned revenue. Servers MUST persist the latest voucher signature to durable storage to survive crashes. If the server disappears, the client can `requestClose()` → wait grace period → `withdraw()` to recover unspent funds.

13. **EIP-3009 Authorization Security (feePayer: true)**: The `authorization.to` field MUST equal the escrow contract address. This prevents an attacker from extracting the EIP-3009 signature and redirecting the `transferWithAuthorization` to a different contract. The escrow contract's `openWithAuthorization` atomically receives and locks the funds, leaving no window for extraction.

---

## Annex

### Reference Escrow Contract Interface

```solidity
interface ISessionEscrow {
    function open(
        address payee, address token, uint128 deposit, bytes32 salt,
        address authorizedSigner, address[] calldata splitRecipients, uint16[] calldata splitBps
    ) external returns (bytes32 channelId);

    function openWithAuthorization(
        address payee, address token, uint128 deposit, bytes32 salt,
        address authorizedSigner, address from,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s,
        address[] calldata splitRecipients, uint16[] calldata splitBps
    ) external returns (bytes32 channelId);

    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata signature) external;

    function topUp(bytes32 channelId, uint128 additionalDeposit) external;

    function topUpWithAuthorization(
        bytes32 channelId, uint128 additionalDeposit, address from,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;

    function close(bytes32 channelId, uint128 cumulativeAmount, bytes calldata signature) external;

    function requestClose(bytes32 channelId) external;

    function withdraw(bytes32 channelId) external;
}
```

> **Requirement**: This contract will be deployed to the same address across all supported EVM chains using `CREATE2` to ensure consistent behavior and simpler integration.
