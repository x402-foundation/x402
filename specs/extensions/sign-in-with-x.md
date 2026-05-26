# Extension: `sign-in-with-x`

## Summary

The `sign-in-with-x` extension enables [CAIP-122](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-122.md) compliant wallet-based authentication for x402-protected resources. Clients prove control of a wallet address by signing a challenge message, allowing servers to identify returning users and skip payment for addresses that have previously paid.

This is a **Server ↔ Client** extension. The Facilitator is not involved in the authentication flow.

## PaymentRequired

A Server advertises SIWX support by including the `sign-in-with-x` key in the `extensions` object of the `402 Payment Required` response.

```json
{
  "x402Version": "2",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "extensions": {
    "sign-in-with-x": {
      "info": {
        "domain": "api.example.com",
        "uri": "https://api.example.com/premium-data",
        "version": "1",
        "nonce": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
        "issuedAt": "2024-01-15T10:30:00.000Z",
        "expirationTime": "2024-01-15T10:35:00.000Z",
        "statement": "Sign in to access premium data",
        "resources": ["https://api.example.com/premium-data"]
      },
      "supportedChains": [
        {
          "chainId": "eip155:8453",
          "type": "eip191"
        }
      ],
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "domain": { "type": "string" },
          "address": { "type": "string" },
          "statement": { "type": "string" },
          "uri": { "type": "string", "format": "uri" },
          "version": { "type": "string" },
          "chainId": { "type": "string" },
          "type": { "type": "string" },
          "nonce": { "type": "string" },
          "issuedAt": { "type": "string", "format": "date-time" },
          "expirationTime": { "type": "string", "format": "date-time" },
          "notBefore": { "type": "string", "format": "date-time" },
          "requestId": { "type": "string" },
          "resources": { "type": "array", "items": { "type": "string", "format": "uri" } },
          "signature": { "type": "string" }
        },
        "required": [
          "domain",
          "address",
          "uri",
          "version",
          "chainId",
          "type",
          "nonce",
          "issuedAt",
          "signature"
        ]
      }
    }
  }
}
```

### Multi-Chain Support

Servers supporting multiple chains (e.g., both EVM and Solana) can include multiple entries in `supportedChains`:

```json
{
  "x402Version": "2",
  "accepts": [...],
  "extensions": {
    "sign-in-with-x": {
      "info": {
        "domain": "api.example.com",
        "uri": "https://api.example.com/premium-data",
        "version": "1",
        "nonce": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
        "issuedAt": "2024-01-15T10:30:00.000Z",
        "expirationTime": "2024-01-15T10:35:00.000Z",
        "statement": "Sign in to access premium data",
        "resources": ["https://api.example.com/premium-data"]
      },
      "supportedChains": [
        {
          "chainId": "eip155:8453",
          "type": "eip191"
        },
        {
          "chainId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          "type": "ed25519"
        }
      ],
      "schema": {...}
    }
  }
}
```

Clients match their wallet's `chainId` against `supportedChains` and use the first matching entry. The same `nonce` is shared across all chains, preventing replay attacks when authenticating with different wallets.

---

## Client Request

To authenticate, the Client signs the challenge message and sends the proof in the `SIGN-IN-WITH-X` HTTP header as base64-encoded JSON.

```http
GET /premium-data HTTP/1.1
Host: api.example.com
SIGN-IN-WITH-X: eyJkb21haW4iOiJhcGkuZXhhbXBsZS5jb20iLCJhZGRyZXNzIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidXJpIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwidmVyc2lvbiI6IjEiLCJjaGFpbklkIjoiZWlwMTU1Ojg0NTMiLCJ0eXBlIjoiZWlwMTkxIiwibm9uY2UiOiJhMWIyYzNkNGU1ZjY3ODkwYTFiMmMzZDRlNWY2Nzg5MCIsImlzc3VlZEF0IjoiMjAyNC0wMS0xNVQxMDozMDowMC4wMDBaIiwiZXhwaXJhdGlvblRpbWUiOiIyMDI0LTAxLTE1VDEwOjM1OjAwLjAwMFoiLCJzdGF0ZW1lbnQiOiJTaWduIGluIHRvIGFjY2VzcyBwcmVtaXVtIGRhdGEiLCJyZXNvdXJjZXMiOlsiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIl0sInNpZ25hdHVyZVNjaGVtZSI6ImVpcDE5MSIsInNpZ25hdHVyZSI6IjB4MmQ2YTc1ODhkNmFjY2E1MDVjYmYwZDlhNGEyMjdlMGM1MmM2YzM0MDA4YzhlODk4NmExMjgzMjU5NzY0MTczNjA4YTJjZTY0OTY2NDJlMzc3ZDZkYThkYmJmNTgzNmU5YmQxNTA5MmY5ZWNhYjA1ZGVkM2Q2MjkzYWYxNDhiNTcxYyJ9
```

The base64 header decodes to:

```json
{
  "domain": "api.example.com",
  "address": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "uri": "https://api.example.com/premium-data",
  "version": "1",
  "chainId": "eip155:8453",
  "type": "eip191",
  "nonce": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "issuedAt": "2024-01-15T10:30:00.000Z",
  "expirationTime": "2024-01-15T10:35:00.000Z",
  "statement": "Sign in to access premium data",
  "resources": ["https://api.example.com/premium-data"],
  "signatureScheme": "eip191",
  "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c"
}
```

---

## Server-Declared Fields

### Message Metadata (`info`)

The Server includes these fields in `extensions["sign-in-with-x"].info`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | `string` | Required | Server's domain (e.g., `"api.example.com"`). MUST match the request host. |
| `uri` | `string` | Required | Full resource URI being accessed. |
| `version` | `string` | Required | CAIP-122 version. Always `"1"`. |
| `nonce` | `string` | Required | Cryptographic nonce (32 hex characters). Server MUST generate this. |
| `issuedAt` | `string` | Required | ISO 8601 timestamp when challenge was created. |
| `statement` | `string` | Optional | Human-readable purpose for signing. |
| `expirationTime` | `string` | Optional | ISO 8601 timestamp when challenge expires. Default: 5 minutes from `issuedAt`. |
| `notBefore` | `string` | Optional | ISO 8601 timestamp before which the signature is not valid. |
| `requestId` | `string` | Optional | Correlation ID for the request. |
| `resources` | `string[]` | Optional | URIs associated with the request. |

### Authentication Methods (`supportedChains[]`)

The Server declares supported authentication methods in `extensions["sign-in-with-x"].supportedChains`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chainId` | `string` | Required | CAIP-2 chain identifier (e.g., `"eip155:8453"`, `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`). |
| `type` | `string` | Required | Signature algorithm: `"eip191"` for EVM, `"ed25519"` for Solana. |
| `signatureScheme` | `string` | Optional | Hint for client signing UX: `"eip191"`, `"eip1271"`, `"eip6492"`, or `"siws"`. |

Clients select the first entry in `supportedChains` that matches their wallet's chain.

---

## Client Proof Fields

The Client echoes all server fields and adds:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `address` | `string` | Required | Wallet address that signed the message. Checksummed for EVM, Base58 for Solana. |
| `signature` | `string` | Required | Cryptographic signature. Hex-encoded (`0x...`) for EVM, Base58 for Solana. |

---

## Supported Chains

### EVM (`eip155:*`)

- **Type**: `eip191`
- **Signature Schemes**: `eip191` (EOA), `eip1271` (smart contract wallet), `eip6492` (counterfactual wallet)
- **Message Format**: [EIP-4361 (SIWE)](https://eips.ethereum.org/EIPS/eip-4361)
- **Chain ID Examples**: `eip155:1` (Ethereum), `eip155:8453` (Base), `eip155:137` (Polygon)

### Solana (`solana:*`)

- **Type**: `ed25519`
- **Signature Scheme**: `siws`
- **Message Format**: [Sign-In With Solana](https://github.com/phantom/sign-in-with-solana)
- **Chain ID Examples**: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet)

---

## Message Format

### EVM (SIWE/EIP-4361)

```
api.example.com wants you to sign in with your Ethereum account:
0x857b06519E91e3A54538791bDbb0E22373e36b66

Sign in to access premium data

URI: https://api.example.com/premium-data
Version: 1
Chain ID: 8453
Nonce: a1b2c3d4e5f67890a1b2c3d4e5f67890
Issued At: 2024-01-15T10:30:00.000Z
Expiration Time: 2024-01-15T10:35:00.000Z
Resources:
- https://api.example.com/premium-data
```

### Solana (SIWS)

```
api.example.com wants you to sign in with your Solana account:
BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW

Sign in to access premium data

URI: https://api.example.com/premium-data
Version: 1
Chain ID: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
Nonce: a1b2c3d4e5f67890a1b2c3d4e5f67890
Issued At: 2024-01-15T10:30:00.000Z
Expiration Time: 2024-01-15T10:35:00.000Z
Resources:
- https://api.example.com/premium-data
```

---

## Verification Logic

When the Server receives a request with the `SIGN-IN-WITH-X` header:

### 1. Parse Header

Base64 decode the header value and JSON parse the result.

### 2. Validate Message Fields

- **Domain**: `domain` MUST match the request host exactly.
- **URI**: `uri` MUST start with the expected resource origin.
- **Issued At**: `issuedAt` MUST be recent (default: < 5 minutes) and MUST NOT be in the future.
- **Expiration**: If `expirationTime` is present, it MUST be in the future.
- **Not Before**: If `notBefore` is present, it MUST be in the past.
- **Nonce**: MUST be unique. Server SHOULD track used nonces to prevent replay attacks.

### 3. Verify Signature

Route verification by `chainId` prefix:

- **`eip155:*`**: Reconstruct SIWE message, verify using ECDSA recovery (EOA) or on-chain verification (EIP-1271/EIP-6492 for smart wallets).
- **`solana:*`**: Reconstruct SIWS message, verify Ed25519 signature.

### 4. Check Payment History

If signature is valid, the Server checks whether the recovered `address` has previously paid for the requested resource. This is application-specific logic.

---

## Security Considerations

- **Domain Binding**: The `domain` field prevents signature reuse across different services.
- **Nonce Uniqueness**: Each challenge MUST have a unique nonce to prevent replay attacks.
- **Temporal Bounds**: The `issuedAt`, `expirationTime`, and `notBefore` fields constrain signature validity windows.
- **Chain-Specific Verification**: Signatures are verified using chain-appropriate algorithms, preventing cross-chain signature reuse.
- **Smart Wallet Support**: EIP-1271 and EIP-6492 verification requires an RPC call to the wallet contract.

---

## References

- [CAIP-122: Sign-In With X](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-122.md)
- [EIP-4361: Sign-In With Ethereum (SIWE)](https://eips.ethereum.org/EIPS/eip-4361)
- [Sign-In With Solana](https://github.com/phantom/sign-in-with-solana)
- [CAIP-2: Blockchain ID Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
- [Core x402 Specification](../x402-specification-v2.md)
