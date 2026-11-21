# Scheme: `exact` on `Hyperliquid`

## Summary

The `exact` scheme on Hyperliquid uses EIP-712 signed `SendAsset` actions combined with API-based settlement. The key distinction of this scheme is that the facilitator does not need to maintain a funded wallet or pay gas fees—it simply verifies the client's signature and submits the action to the Hyperliquid exchange API endpoint for execution.

## Protocol Sequencing

The following outlines the flow of the `exact` scheme on Hyperliquid:

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a payment required signal containing `PaymentRequirements`.
3. **Client** constructs an EIP-712 typed `SendAsset` action specifying the transfer details.
4. **Client** signs the action using EIP-712 signature with the Hyperliquid domain.
5. **Client** sends a new request to the **Resource Server** with the `PaymentPayload` containing the signed action and signature components (r, s, v).
6. **Resource Server** receives the request and forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator Server's** `/verify` endpoint.
7. **Facilitator** decodes the action and signature.
8. **Facilitator** verifies the EIP-712 signature is valid and recovers the signer's address.
9. **Facilitator** validates the action parameters match the payment requirements (amount, destination, asset, nonce freshness).
10. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
11. **Resource Server**, upon successful verification, forwards the payload to the facilitator's `/settle` endpoint.
12. **Facilitator Server** submits the signed action to the Hyperliquid exchange API (`/exchange` endpoint).
13. **Facilitator Server** queries the Hyperliquid info API (`/info` endpoint) to retrieve the transaction hash from the ledger.
14. Upon successful settlement, the **Facilitator Server** responds with a `SettlementResponse` to the **Resource Server**.
15. **Resource Server** grants the **Client** access to the resource in its response.

## Network Identifiers

**V2 Networks** (CAIP-2 format):

- `hyperliquid:mainnet` - Hyperliquid Mainnet
- `hyperliquid:testnet` - Hyperliquid Testnet

**V1 Networks**: Not supported

## Asset Support

Supports any Hyperliquid spot token using the `{tokenName}:0x{identifier}` format.

**Example — USDH (Hyperliquid USD):**

- **Asset Identifier**: `USDH:0x54e00a5988577cb0b0c9ab0cb6ef7f4b`
- **Decimals**: 8
- **Example**: `$0.01` = `1000000` raw units

## `PaymentRequirements` for `exact`

Standard x402 `PaymentRequirements` fields:

```json
{
  "scheme": "exact",
  "network": "hyperliquid:mainnet",
  "amount": "1000000",
  "asset": "USDH:0x54e00a5988577cb0b0c9ab0cb6ef7f4b",
  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  "maxTimeoutSeconds": 60,
  "extra": {
    "destinationDex": "spot"
  }
}
```

The `extra` field supports the following optional fields:

| Field            | Type   | Default  | Description                                                        |
| ---------------- | ------ | -------- | ------------------------------------------------------------------ |
| `destinationDex` | string | `"spot"` | The DEX where the recipient receives funds. `"spot"` or `"perp"`.  |

If `destinationDex` is omitted from `extra`, it defaults to `"spot"`.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

- `action`: The EIP-712 typed `SendAsset` action object
- `signature`: Object containing `r`, `s`, and `v` signature components

Example `payload`:

```json
{
  "action": {
    "type": "sendAsset",
    "hyperliquidChain": "Mainnet",
    "signatureChainId": "0x3e7",
    "destination": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "sourceDex": "spot",
    "destinationDex": "spot",
    "token": "USDH:0x54e00a5988577cb0b0c9ab0cb6ef7f4b",
    "amount": "0.01000000",
    "fromSubAccount": "",
    "nonce": 1738697234567
  },
  "signature": {
    "r": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173",
    "s": "0x608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b5",
    "v": 27
  }
}
```

Full `PaymentPayload` object:

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
    "network": "hyperliquid:mainnet",
    "amount": "1000000",
    "asset": "USDH:0x54e00a5988577cb0b0c9ab0cb6ef7f4b",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "destinationDex": "spot"
    }
  },
  "payload": {
    "action": {
      "type": "sendAsset",
      "hyperliquidChain": "Mainnet",
      "signatureChainId": "0x3e7",
      "destination": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "sourceDex": "spot",
      "destinationDex": "spot",
      "token": "USDH:0x54e00a5988577cb0b0c9ab0cb6ef7f4b",
      "amount": "0.01000000",
      "fromSubAccount": "",
      "nonce": 1738697234567
    },
    "signature": {
      "r": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173",
      "s": "0x608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b5",
      "v": 27
    }
  }
}
```

## EIP-712 Signature Details

### Domain

```json
{
  "name": "HyperliquidSignTransaction",
  "version": "1",
  "chainId": 999,
  "verifyingContract": "0x0000000000000000000000000000000000000000"
}
```

The `chainId` field is required by the Hyperliquid API for action deserialization but does not identify any specific blockchain. Hypercore is not an EVM chain, and the `signatureChainId` in the action cannot be replayed on other chains because the signed payload includes `hyperliquidChain` (Mainnet/Testnet). The value is therefore arbitrary and any integer is accepted by the API.

Recommended values: `999` (HyperEVM mainnet) for `hyperliquid:mainnet`, `998` (HyperEVM testnet) for `hyperliquid:testnet`. These are used in the `action.signatureChainId` field as hex strings (`"0x3e7"` and `"0x3e6"` respectively) and as the `chainId` in the EIP-712 domain when signing and recovering.

### Primary Type

`HyperliquidTransaction:SendAsset`

### Type Definition

```typescript
{
  "HyperliquidTransaction:SendAsset": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationDex", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "fromSubAccount", type: "string" },
    { name: "nonce", type: "uint64" }
  ]
}
```

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`-scheme Hyperliquid payment MUST enforce all of the following checks:

### 1. Network Validation

- The `network` field MUST be either `hyperliquid:mainnet` or `hyperliquid:testnet`.
- The `action.hyperliquidChain` MUST match the network: `"Mainnet"` for `hyperliquid:mainnet`, `"Testnet"` for `hyperliquid:testnet`.

### 2. Action Type Validation

- The `action.type` field MUST equal `"sendAsset"`.

### 3. Signature Structure Validation

- The `signature` object MUST contain `r`, `s`, and `v` fields.
- `r` and `s` MUST be 66-character hex strings (including `0x` prefix).
- `v` MUST be either `27` or `28`.

### 4. Signature Recovery and Verification

- The facilitator MUST recover the signer's address from the EIP-712 signature using the domain and typed data.
- The signature MUST be valid according to EIP-712 standards.
- The recovered address will be used for ledger queries after settlement.

### 5. Destination Validation

- The `action.destination` MUST equal the `PaymentRequirements.payTo` address exactly (case-insensitive).

### 6. Amount Validation

- The `action.amount` MUST be a decimal string representation with exactly 8 decimals (e.g., `"0.01000000"` for 0.01 USD). The conversion MUST be performed using string operations only (no floating-point arithmetic).
- The resulting `action.amount` MUST equal the expected string exactly.

### 7. Asset/Token Validation

- The `action.token` MUST equal the `PaymentRequirements.asset` exactly.
- The token format MUST be `{tokenName}:0x{identifier}`.

### 8. Nonce Freshness Validation

- The `action.nonce` MUST be a timestamp in milliseconds since Unix epoch.
- The nonce MUST NOT be older than 1 hour (3600 seconds) from the current time.
- Formula: `current_time_ms - action.nonce <= 3600000`

### 9. DEX Validation

- `action.sourceDex` MUST be either `"spot"` or `"perp"`. The client chooses which balance to pay from.
- `action.destinationDex` MUST equal the `PaymentRequirements.extra.destinationDex` value. If `extra.destinationDex` is not specified, it MUST equal `"spot"`.
- If either `action.sourceDex` or `action.destinationDex` is `"perp"`, the `action.token` MUST be a USDC-equivalent token. Non-USDC tokens with a perp DEX MUST be rejected.

### 10. Fixed Field Validation

- `action.fromSubAccount` MUST be an empty string `""`.

### 11. Balance Verification

- The facilitator MUST verify that the payer has sufficient balance of the specified token to cover the transfer amount.
- For spot transfers (`sourceDex` is `"spot"`), query `POST /info` with `{"type": "spotClearinghouseState", "user": "<payer_address>"}` and inspect the token balances.
- For perp transfers (`sourceDex` is `"perp"`), query `POST /info` with `{"type": "clearinghouseState", "user": "<payer_address>"}` and inspect the account balances.
- Unlike EVM and SVM, the Hyperliquid API does not support transaction simulation, so an explicit balance check is the only way to catch insufficient funds before settlement. Since the resource handler executes between `/verify` and `/settle`, balance verification protects the server from doing unnecessary work for requests that will fail at settlement.

These checks ensure that:

- The action cannot be replayed on different chains
- The facilitator cannot be tricked into executing unintended transfers
- Stale signatures are rejected to prevent replay attacks
- The exact payment amount and destination are enforced

## Settlement

Settlement is performed via API submission to the Hyperliquid exchange endpoint:

### Settlement Flow

1. **API Submission**: The facilitator submits the signed action to `POST /exchange` with:

   ```json
   {
     "action": {
       "type": "sendAsset",
       "hyperliquidChain": "Mainnet",
       "destination": "0x...",
       "sourceDex": "spot",
       "destinationDex": "spot",
       "token": "USDH:0x...",
       "amount": "0.01000000",
       "fromSubAccount": "",
       "nonce": 1738697234567
     },
     "signature": {
       "r": "0x...",
       "s": "0x...",
       "v": 27
     }
   }
   ```

2. **API Response**: The Hyperliquid API returns:

   ```json
   {
     "status": "ok",
     "response": {
       "type": "default"
     }
   }
   ```

   Or an error response if submission fails.

   > **Note on Duplicate Settlement**: Hyperliquid enforces nonce uniqueness natively — the 100 highest nonces are stored per address, and previously used nonces are rejected. This means duplicate submissions of the same signed action will fail at the API level, and no facilitator-side deduplication cache is required (unlike SVM).

3. **Transaction Hash Retrieval**: After 1.5 seconds (to allow ledger indexing), the facilitator queries the ledger:
   - Endpoint: `POST /info` with `{"type": "userNonFundingLedgerUpdates", "user": "<payer_address>"}`
   - Filters for entries where `delta.type` is `"send"`, then matches by `delta.nonce` and `delta.destination`
   - Extracts the transaction hash from the matched entry
   - Retries up to 2 times with 1-second delays if not found
   - If the transaction hash is NOT found after all retries, the facilitator MUST return a settlement failure response with `success: false`

4. **Settlement Response**: The facilitator returns:
   ```json
   {
     "success": true,
     "transaction": "0xabcd...1234",
     "network": "hyperliquid:mainnet",
     "payer": "0x..."
   }
   ```

### Error Handling

In addition to the shared x402 error codes defined in the [x402 v2 specification](../x402-specification-v2.md) (e.g., `insufficient_funds`, `invalid_network`, `invalid_transaction_state`), this scheme defines the following Hyperliquid-specific error codes:

| Error Code                                              | Description                          | HTTP Status |
| ------------------------------------------------------- | ------------------------------------ | ----------- |
| `invalid_exact_hyperliquid_payload_action_type`         | Action type is not `sendAsset`       | 400         |
| `invalid_exact_hyperliquid_payload_recipient_mismatch`  | Destination doesn't match `payTo`    | 400         |
| `invalid_exact_hyperliquid_payload_amount`              | Amount doesn't match required amount | 400         |
| `invalid_exact_hyperliquid_payload_token_mismatch`      | Token doesn't match required asset   | 400         |
| `invalid_exact_hyperliquid_payload_nonce`               | Nonce is more than 1 hour old        | 400         |
| `invalid_exact_hyperliquid_payload_signature_structure` | Signature is missing r, s, or v      | 400         |
| `invalid_exact_hyperliquid_payload_signature`           | Signature verification failed        | 400         |
| `invalid_exact_hyperliquid_payload_dex`                 | Invalid DEX value or token/DEX mismatch | 400      |

## API Constraints

- **Rate Limits**: Refer to the [Hyperliquid API documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api) for current rate limits and usage guidelines.
- **Nonce Validity Window**: Hyperliquid requires nonces to be within `(T - 2 days, T + 1 day)` where T is the block's unix millisecond timestamp. This scheme's 1-hour freshness constraint (see Nonce Freshness Validation) is a stricter subset of this window.

## Appendix

### Key Differences from EVM/SVM

| Feature                  | EVM                  | SVM                  | Hyperliquid                           |
| ------------------------ | -------------------- | -------------------- | ------------------------------------- |
| **Settlement**           | On-chain transaction | On-chain transaction | API submission                        |
| **Facilitator Wallet**   | Required + gas       | Required + SOL       | Not required                          |
| **Gas Fees**             | ETH                  | SOL                  | None                                  |
| **Signature Type**       | EIP-3009 / Permit2   | Ed25519 SPL          | EIP-712 SendAsset                     |
| **Nonce Format**         | Sequential           | Recent blockhash     | Timestamp (ms)                        |
| **Confirmation**         | Block inclusion      | Block inclusion      | Ledger query                          |
| **Stateful Facilitator** | No                   | Deduplication cache  | No (nonce uniqueness enforced by API) |

### Nonce Timestamp Format

Unlike sequential nonces (EVM) or blockhash-based nonces (SVM), Hyperliquid uses timestamp-based nonces:

- **Format**: Milliseconds since Unix epoch (`int(time.time() * 1000)`)
- **Uniqueness**: Millisecond precision prevents collisions in normal usage
- **Freshness**: Must be within 1 hour of current time

### API-Based Settlement Advantages

1. **No Facilitator Wallet**: Facilitators don't need to manage private keys or maintain funded accounts
2. **No Gas Fees**: Eliminates operational costs for payment processing
3. **Instant Verification**: Signature verification is deterministic without RPC calls
4. **Simplified Operations**: No transaction construction or gas estimation needed

### Security Considerations

1. **Signature Replay Prevention**: Timestamp-based nonces with 1-hour expiry prevent replay attacks
2. **Cross-Chain Safety**: `hyperliquidChain` prevents cross-network replay
3. **Amount Precision**: 8-decimal string format prevents floating-point precision issues
4. **Destination Integrity**: EIP-712 signature covers destination, preventing redirects
5. **API Trust**: Facilitators must trust the Hyperliquid API for settlement (no on-chain verification)

### Implementation Notes

1. **Signature Recovery**: Use standard EIP-712 libraries (eth-account for Python, viem for TypeScript)
2. **Amount Conversion**: Always use string arithmetic for 8-decimal conversions to avoid precision loss
3. **Ledger Querying**: Wait 1.5 seconds after submission before querying ledger for transaction hash
4. **Retry Logic**: Implement retry with exponential backoff for ledger queries (recommended: 2 retries with 1s delay)
5. **Error Handling**: Distinguish between client errors (400) and settlement errors (500) for proper user feedback

### Future Extensions

Potential future enhancements to the Hyperliquid exact scheme:

1. **Sub-Account Transfers**: Support transfers from user sub-accounts (`fromSubAccount` non-empty)
2. **Batch Settlement**: Submit multiple actions in a single API call for efficiency

### API Endpoints

**Mainnet**:

- Exchange API: `https://api.hyperliquid.xyz/exchange`
- Info API: `https://api.hyperliquid.xyz/info`

**Testnet**:

- Exchange API: `https://api.hyperliquid-testnet.xyz/exchange`
- Info API: `https://api.hyperliquid-testnet.xyz/info`
