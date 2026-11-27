# Exact Payment Scheme for Stacks (`exact`)

This document specifies the `exact` payment scheme for the x402 protocol on the Stacks blockchain.

This scheme facilitates payments of a specific amount of STX (native token) or [SIP-010](https://github.com/stacksgov/sips/blob/main/sips/sip-010/sip-010-fungible-token-standard.md) fungible tokens (sBTC, USDCx, etc.) on Stacks. Assets are identified using [CAIP-19](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip19.md) notation.

## Scheme Name

`exact`

## Protocol Flow

The protocol flow for `exact` on Stacks is client-driven with facilitator settlement.

1.  **Client** makes a request to a **Resource Server**.
2.  **Resource Server** responds with HTTP 402 containing `PaymentRequirements`.
3.  **Client** creates and fully signs a Stacks transaction:
    - For STX: A native `token-transfer` transaction
    - For SIP-010 tokens: A `contract-call` to the token's `transfer` function
4.  **Client** includes the payment request nonce in the transaction memo (up to 34 bytes) for correlation.
5.  **Client** serializes the signed transaction as a hex string.
6.  **Client** sends a new request to the resource server with the `PaymentPayload` containing the signed transaction hex in the `X-PAYMENT` header.
7.  **Resource Server** receives the request and forwards the `PaymentPayload` and `PaymentRequirements` to a **Facilitator Server's** `/verify` endpoint (optional pre-check) or directly to `/settle`.
8.  **Facilitator** decodes and deserializes the transaction.
9.  **Facilitator** inspects the transaction to ensure it matches the payment requirements.
10. **Facilitator** broadcasts the transaction to the Stacks network.
11. **Facilitator** waits for transaction confirmation (anchored in a Bitcoin block).
12. Upon successful on-chain settlement, the **Facilitator Server** responds with a `SettlementResponse` to the **Resource Server**.
13. **Resource Server** grants the **Client** access to the resource and returns the settlement details in `X-PAYMENT-RESPONSE` header.

## `PaymentRequirements` for `exact`

The `exact` scheme on Stacks uses the following `PaymentRequirements` structure:

```json
{
  "scheme": "exact",
  "network": "stacks:1",
  "amount": "1000000",
  "asset": "slip44:5757",
  "payTo": "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
  "maxTimeoutSeconds": 300,
  "extra": {
    "nonce": "a1b2c3d4e5f6",
    "expiresAt": "2024-01-15T12:00:00Z",
    "tokenType": "STX"
  }
}
```

### Field Descriptions

- `network`: Network identifier. Use `stacks:1` for mainnet, `stacks:2147483648` for testnet (following [CAIP-2](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip2.md) convention with Stacks chain IDs).
- `amount`: Amount in base units (microSTX for STX, satoshis for sBTC, smallest unit for other tokens).
- `asset`: [CAIP-19](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip19.md) asset identifier. For native STX, use `"slip44:5757"`. For [SIP-010](https://github.com/stacksgov/sips/blob/main/sips/sip-010/sip-010-fungible-token-standard.md) tokens, use `"sip010:{address}.{contract}.{token}"` (e.g., `"sip010:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token.sbtc-token"`).
- `payTo`: The Stacks address to receive the payment.
- `extra.nonce`: Unique identifier for this payment request, included in transaction memo for correlation.
- `extra.expiresAt`: ISO 8601 timestamp when this payment request expires.
- `extra.tokenType`: Token type identifier: `"STX"`, `"sBTC"`, or `"USDCx"`.
- `extra.tokenContract` (for SIP-010): Object with `address` and `name` of the token contract.

### Example with SIP-010 Token (sBTC)

```json
{
  "scheme": "exact",
  "network": "stacks:1",
  "amount": "100000",
  "asset": "sip010:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token.sbtc-token",
  "payTo": "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
  "maxTimeoutSeconds": 300,
  "extra": {
    "nonce": "a1b2c3d4e5f6",
    "expiresAt": "2024-01-15T12:00:00Z",
    "tokenType": "sBTC",
    "tokenContract": {
      "address": "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
      "name": "sbtc-token"
    }
  }
}
```

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains the fully-signed transaction:

```json
{
  "signedTransaction": "00000000010400..."
}
```

- `signedTransaction`: Hex-encoded, serialized, fully-signed Stacks transaction.

### Full `PaymentPayload` Example (STX)

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium data endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "stacks:1",
    "amount": "1000000",
    "asset": "slip44:5757",
    "payTo": "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
    "maxTimeoutSeconds": 300,
    "extra": {
      "nonce": "a1b2c3d4e5f6",
      "expiresAt": "2024-01-15T12:00:00Z",
      "tokenType": "STX"
    }
  },
  "payload": {
    "signedTransaction": "00000000010400a1b2c3..."
  }
}
```

## Transaction Construction

### STX Native Transfer

Clients construct a `token-transfer` transaction using the Stacks transaction format:

```typescript
import { makeSTXTokenTransfer } from '@stacks/transactions';

const transaction = await makeSTXTokenTransfer({
  recipient: paymentRequirements.payTo,
  amount: BigInt(paymentRequirements.amount),
  senderKey: privateKey,
  network: stacksNetwork,
  memo: paymentRequirements.extra.nonce.substring(0, 34),
  anchorMode: AnchorMode.Any,
});
```

### SIP-010 Token Transfer

For SIP-010 tokens (sBTC, USDCx), clients construct a `contract-call` transaction:

```typescript
import { makeContractCall, uintCV, principalCV, someCV, bufferCVFromString } from '@stacks/transactions';

const transaction = await makeContractCall({
  contractAddress: tokenContract.address,
  contractName: tokenContract.name,
  functionName: 'transfer',
  functionArgs: [
    uintCV(amount),
    principalCV(senderAddress),
    principalCV(recipient),
    someCV(bufferCVFromString(memo)),
  ],
  senderKey: privateKey,
  network: stacksNetwork,
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
});
```

## `SettlementResponse`

The `SettlementResponse` for the exact scheme on Stacks:

```json
{
  "success": true,
  "tx_id": "0x1234567890abcdef...",
  "network": "stacks:1",
  "sender_address": "SP1234...",
  "recipient_address": "SP5678...",
  "amount": 1000000,
  "status": "confirmed",
  "block_height": 150000
}
```

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`-scheme Stacks payment MUST enforce all of the following checks before broadcasting:

### 1. Transaction Type Validation

- For STX payments: Transaction MUST be a `token-transfer` type.
- For SIP-010 payments: Transaction MUST be a `contract-call` type calling the `transfer` function.

### 2. Recipient Validation

- For STX: The `recipient` field MUST equal `PaymentRequirements.payTo`.
- For SIP-010: The recipient argument in the `transfer` call MUST equal `PaymentRequirements.payTo`.

### 3. Amount Validation

- The transfer amount MUST be greater than or equal to `PaymentRequirements.amount`.

### 4. Asset Validation

- For SIP-010: The contract being called MUST match the expected token contract from `PaymentRequirements.asset` or `extra.tokenContract`.

### 5. Memo/Nonce Correlation (RECOMMENDED)

- If `extra.nonce` is provided, the transaction memo SHOULD contain this nonce for payment correlation.

### 6. Expiration Check

- If `extra.expiresAt` is provided, the facilitator MUST reject payments submitted after this timestamp.

### 7. Sender Balance Validation

- The sender MUST have sufficient balance to cover the transfer amount plus transaction fees.

### 8. Transaction Simulation (RECOMMENDED)

- Before broadcasting, facilitators SHOULD simulate the transaction to verify it will succeed.

## Security Considerations

### Fully-Signed Transactions

Unlike EVM (EIP-3009 authorizations) or SVM (partially-signed transactions), Stacks payments use fully-signed transactions. This means:

- The client pays transaction fees (no fee sponsorship by default)
- The facilitator cannot modify the transaction, only broadcast it
- Transaction can only be broadcast once (nonce prevents replay)

### Post-Conditions

For SIP-010 token transfers, implementations SHOULD use appropriate post-conditions to ensure the exact amount is transferred and prevent unexpected token movements.

### Network Confirmation

Stacks transactions are anchored in Bitcoin blocks. Facilitators should wait for sufficient confirmations based on the payment amount and risk tolerance.

## Supported Assets

| Token | CAIP-19 Asset ID | Amount Unit |
|-------|------------------|-------------|
| STX | `slip44:5757` | microSTX (1 STX = 1,000,000 microSTX) |
| sBTC | `sip010:SM3VDX...sbtc-token.sbtc-token` | satoshis (1 sBTC = 100,000,000 sats) |
| USDCx | `sip010:SP120S...usdcx.usdcx-token` | micro-USDCx (1 USDCx = 1,000,000 micro-USDCx) |

SIP-010 is the [Stacks fungible token standard](https://github.com/stacksgov/sips/blob/main/sips/sip-010/sip-010-fungible-token-standard.md), analogous to ERC-20 on EVM chains.

### Token Contract Addresses

| Token | Network | CAIP-19 Asset ID | Clarity Contract Identifier |
|-------|---------|------------------|----------------------------|
| STX | mainnet/testnet | `slip44:5757` | Native (no contract) |
| sBTC | mainnet | `sip010:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token.sbtc-token` | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token` |
| sBTC | testnet | `sip010:ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token.sbtc-token` | `ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token::sbtc-token` |
| USDCx | mainnet | `sip010:SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx.usdcx-token` | `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token` |
| USDCx | testnet | Not yet deployed | (aeUSDC from Allbridge available as alternative) |

> **Note:** CAIP-19 uses `.` separators while Clarity uses `::` between contract name and token name. See [CAIP-19 Stacks namespace](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip19.md) for the full specification.

## Reference Implementation

- TypeScript SDK: [x402-stacks](https://github.com/x402Stacks/x402-stacks-sdk) (x402-stacks on npm)
- Python SDK: [x402-stacks-python](https://github.com/x402Stacks/x402-stacks-python)
- Go SDK: [x402-stacks-go](https://github.com/x402Stacks/x402-stacks-go)
- Facilitator: [x402-stacks-facilitator](https://github.com/x402Stacks/x402-stacks-facilitator)
- Registry: [x402StacksScan](https://scan.stacksx402.com)

---

## Annex: Transaction Wire Format

This section documents the low-level transaction encoding for implementers who need to work without SDK abstractions. All multi-byte fields are big-endian.

### Network Identifiers (CAIP-2)

The x402 protocol uses [CAIP-2](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip2.md) chain identifiers:

| Network | CAIP-2 Identifier | Chain ID (hex) | Version Byte |
|---------|-------------------|----------------|--------------|
| Mainnet | `stacks:1` | `0x00000001` | `0x00` |
| Testnet | `stacks:2147483648` | `0x80000000` | `0x80` |

The testnet chain ID (`2147483648` = `0x80000000`) follows the convention of setting the highest bit to distinguish test networks. The version byte in serialized transactions similarly uses the high bit (`0x80`) for testnet.

### Transaction Structure

A Stacks transaction is serialized as:

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 1 | Version | `0x00` mainnet, `0x80` testnet |
| 1 | 4 | Chain ID | `0x00000001` mainnet, `0x80000000` testnet |
| 5 | var | Authorization | Spending conditions and signatures |
| var | 1 | Anchor Mode | `0x01` on-chain, `0x02` microblock, `0x03` any |
| var | 1 | Post-Condition Mode | `0x01` allow, `0x02` deny |
| var | var | Post-Conditions | 4-byte count + encoded conditions |
| var | var | Payload | Transaction-type-specific data |

### Payload Types

| Type ID | Name | x402 Usage |
|---------|------|------------|
| `0x00` | Token Transfer | STX payments |
| `0x02` | Contract Call | SIP-010 token payments |

#### Token Transfer Payload (`0x00`)

```
[1 byte]  Payload type: 0x00
[1 byte]  Principal type: 0x05 (standard) or 0x06 (contract)
[1 byte]  Address version
[20 bytes] Address hash (Hash160)
[8 bytes] Amount in microSTX (big-endian)
[1 byte]  Memo type: 0x03 (no memo) or 0x04 (with memo)
[34 bytes] Memo content (if type 0x04)
```

#### Contract Call Payload (`0x02`)

```
[1 byte]  Payload type: 0x02
[1 byte]  Contract address version
[20 bytes] Contract address hash
[1 byte]  Contract name length
[n bytes] Contract name (ASCII)
[1 byte]  Function name length
[n bytes] Function name (ASCII, e.g., "transfer")
[4 bytes] Argument count
[var]     Serialized Clarity values
```

### Clarity Value Encoding

| Type ID | Clarity Type | Payload |
|---------|--------------|---------|
| `0x00` | `int` | 16 bytes, big-endian signed |
| `0x01` | `uint` | 16 bytes, big-endian unsigned |
| `0x02` | `buff` | 4-byte length + data |
| `0x03` | `true` | (no payload) |
| `0x04` | `false` | (no payload) |
| `0x05` | `principal` (standard) | 1-byte version + 20-byte hash |
| `0x06` | `principal` (contract) | version + hash + 1-byte name len + name |
| `0x09` | `none` | (no payload) |
| `0x0a` | `some` | nested Clarity value |
| `0x0d` | `string-ascii` | 4-byte length + ASCII bytes |

#### SIP-010 `transfer` Arguments

For `(transfer uint principal principal (optional (buff 34)))`:

```
Arg 0: uint (amount)     → 0x01 + 16-byte big-endian
Arg 1: principal (from)  → 0x05 + version + hash
Arg 2: principal (to)    → 0x05 + version + hash
Arg 3: optional memo     → 0x0a + 0x02 + 4-byte len + data
                         → 0x09 (if none)
```

### Authorization Structure

#### Standard Authorization (`0x04`)

Used when the sender pays their own transaction fees (current x402 implementation).

```
[1 byte]  Auth type: 0x04
[1 byte]  Hash mode: 0x00 (P2PKH single-sig)
[20 bytes] Signer address hash (Hash160 of public key)
[8 bytes] Nonce (big-endian)
[8 bytes] Fee in microSTX (big-endian)
[1 byte]  Key encoding: 0x00 (compressed) or 0x01 (uncompressed)
[65 bytes] Recoverable ECDSA signature
```

#### Sponsored Authorization (`0x05`)

Enables a third party (sponsor) to pay transaction fees on behalf of the origin account. This is relevant for gasless/sponsored transaction support.

```
[1 byte]  Auth type: 0x05

# Origin spending condition (sender)
[1 byte]  Hash mode: 0x00 (P2PKH single-sig)
[20 bytes] Origin address hash
[8 bytes] Origin nonce
[8 bytes] Origin fee (typically 0 for sponsored)
[1 byte]  Key encoding
[65 bytes] Origin signature

# Sponsor spending condition (fee payer)
[1 byte]  Hash mode: 0x00 (P2PKH single-sig)
[20 bytes] Sponsor address hash
[8 bytes] Sponsor nonce
[8 bytes] Sponsor fee (actual fee paid)
[1 byte]  Key encoding
[65 bytes] Sponsor signature
```

**Signing Order for Sponsored Transactions:**

1. Origin signs first with sponsor fields set to a "signing sentinel" (zero-filled)
2. Sponsor signs second, committing to the origin's signature
3. Both signatures are required for the transaction to be valid

**x402 Sponsored Flow (Future Extension):**

```
1. Client constructs transaction with auth type 0x05
2. Client signs as origin (fee=0, sponsor fields=sentinel)
3. Client sends partially-signed transaction to facilitator
4. Facilitator validates, sets sponsor fee, signs as sponsor
5. Facilitator broadcasts fully-signed transaction
```

#### Signature Format

The 65-byte recoverable ECDSA secp256k1 signature:

```
[1 byte]  Recovery ID (0x00-0x03)
[32 bytes] r coordinate
[32 bytes] s coordinate (must use lower s-value per BIP-146)
```

The recovery ID allows public key recovery from the signature, eliminating the need to transmit the public key separately.

### Post-Conditions

Post-conditions protect against unexpected token transfers. Facilitators SHOULD verify post-conditions match expected payment behavior.

#### STX Post-Condition (`0x00`)

```
[1 byte]  Type: 0x00
[1 byte]  Principal type: 0x02 (standard)
[1 byte]  Address version
[20 bytes] Address hash
[1 byte]  Condition code (see below)
[8 bytes] Amount in microSTX
```

#### Fungible Token Post-Condition (`0x01`)

```
[1 byte]  Type: 0x01
[1 byte]  Principal type
[1 byte]  Address version
[20 bytes] Address hash
[1 byte]  Asset address version
[20 bytes] Asset address hash
[1 byte]  Asset name length
[n bytes] Asset contract name
[1 byte]  Token name length
[n bytes] Token name
[1 byte]  Condition code
[8 bytes] Amount
```

#### Condition Codes

| Code | Meaning |
|------|---------|
| `0x01` | Sent exactly |
| `0x02` | Sent greater than |
| `0x03` | Sent greater than or equal |
| `0x04` | Sent less than |
| `0x05` | Sent less than or equal |

### Example: STX Transfer (Annotated Hex)

```
00                          # Version: mainnet
00000001                    # Chain ID: mainnet
04                          # Auth type: standard
00                          # Hash mode: P2PKH
<20 bytes>                  # Signer address hash
<8 bytes>                   # Nonce
<8 bytes>                   # Fee (microSTX)
00                          # Key encoding: compressed
<65 bytes>                  # Signature
03                          # Anchor mode: any
01                          # Post-condition mode: allow
00000000                    # Post-conditions: 0 count
00                          # Payload type: token-transfer
05                          # Recipient: standard principal
16                          # Address version (0x16 = mainnet P2PKH)
<20 bytes>                  # Recipient address hash
<8 bytes>                   # Amount (microSTX)
03                          # Memo type: none
```

### Example: SIP-010 Transfer (sBTC, Annotated Hex)

```
00                          # Version: mainnet
00000001                    # Chain ID: mainnet
04                          # Auth type: standard
00                          # Hash mode: P2PKH
<20 bytes>                  # Signer address hash
<8 bytes>                   # Nonce
<8 bytes>                   # Fee (microSTX)
00                          # Key encoding: compressed
<65 bytes>                  # Signature
03                          # Anchor mode: any
02                          # Post-condition mode: deny (recommended for token transfers)
00000001                    # Post-conditions: 1 condition

# Fungible token post-condition
01                          # Post-condition type: fungible token
02                          # Principal type: standard
16                          # Sender address version
<20 bytes>                  # Sender address hash
16                          # Asset contract address version
<20 bytes>                  # Asset contract address hash (SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4)
0a                          # Contract name length: 10
736274632d746f6b656e        # Contract name: "sbtc-token"
0a                          # Token name length: 10
736274632d746f6b656e        # Token name: "sbtc-token"
01                          # Condition code: sent exactly
<8 bytes>                   # Amount (satoshis)

# Contract call payload
02                          # Payload type: contract-call
16                          # Contract address version
<20 bytes>                  # Contract address hash
0a                          # Contract name length: 10
736274632d746f6b656e        # Contract name: "sbtc-token"
08                          # Function name length: 8
7472616e73666572            # Function name: "transfer"
00000004                    # Argument count: 4

# Arg 0: amount (uint)
01                          # Clarity type: uint
<16 bytes>                  # Amount in big-endian (e.g., 100000 sats)

# Arg 1: sender (principal)
05                          # Clarity type: standard principal
16                          # Address version
<20 bytes>                  # Sender address hash

# Arg 2: recipient (principal)
05                          # Clarity type: standard principal
16                          # Address version
<20 bytes>                  # Recipient address hash

# Arg 3: memo (optional buff)
0a                          # Clarity type: some
02                          # Clarity type: buff
00000006                    # Buffer length: 6
<6 bytes>                   # Memo content (nonce)
```

### Address Versions

| Version | Network | Type |
|---------|---------|------|
| `0x16` (22) | Mainnet | P2PKH (standard) |
| `0x15` (21) | Mainnet | P2SH (multisig) |
| `0x1a` (26) | Testnet | P2PKH (standard) |
| `0x19` (25) | Testnet | P2SH (multisig) |

### References

- [SIP-005: Blocks and Transactions](https://github.com/stacksgov/sips/blob/main/sips/sip-005/sip-005-blocks-and-transactions.md)
- [SIP-010: Fungible Token Standard](https://github.com/stacksgov/sips/blob/main/sips/sip-010/sip-010-fungible-token-standard.md)
- [Stacks.js Transaction Serialization](https://stacks.js.org/functions/_stacks_transactions.serializeTransaction)
- [CAIP-2: Stacks Chain Identifiers](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip2.md)
- [CAIP-19: Stacks Asset Identifiers](https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip19.md)
