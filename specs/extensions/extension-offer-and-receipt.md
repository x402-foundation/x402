# Offer and Receipt Extension

**1. Overview**

The Offer and Receipt Extension adds **server-side signatures** to x402, enabling:

1. **Signed offers**: the resource server can cryptographically commit to the payment terms it presents in `accepts[]`.
2. **Signed receipts**: after successful payment and service delivery, the resource server can return a signed receipt confirming the transaction.

This extension supports downstream use cases including:

- dispute evidence and auditability,
- user-review attestations (e.g., "I paid and received service"),
- verifiable proof of commercial interactions for reputation systems.

The signed offer and receipt payloads are **x402 version-agnostic** and work identically for both x402 v1 and v2.

**2. Status, Evolution, and Forward Compatibility**

This extension is specified as an optional, composable addition to x402. The x402 ecosystem may introduce additional extensions over time.

Accordingly:

- **Wire shape and field placement are not considered stable** and may change to align with x402 canonical extension architecture once standardized.
- **Behavioral requirements are stable**: the payload structures, signature formats, and verification rules in this document are normative and MUST be implemented as written, independent of serialization details.
- Implementers SHOULD design with forward compatibility in mind and SHOULD treat unknown extension-specific fields as unsupported rather than attempting best-effort interpretation.

**3. Signed Artifact Structure**

This extension defines exactly two signed artifacts:

1. **Offer** — placed in the `extensions` field, corresponding to `accepts[]` entries
2. **Receipt** — returned only on success

Both artifacts use the same top-level structure, differing only in their payload fields.

**3.1 Common Object Shape**

Both `offer` and `receipt` objects MUST have the following structure:

| Field        | Type    | Required     | Description                                              |
| ------------ | ------- | ------------ | -------------------------------------------------------- |
| `format`     | string  | Yes          | `"eip712"` or `"jws"`                                    |
| `payload`    | object  | EIP-712 only | The canonical payload fields (omit for JWS)              |
| `signature`  | string  | Yes          | The signature (format-specific encoding)                 |
| `acceptIndex`| integer | No           | Index into `accepts[]` (offers only)                     |

See §4.1.1 for `acceptIndex` usage and verification requirements.

**3.1.1 Format-Specific Rules**

**When `format = "eip712"`:**
- `payload` is REQUIRED and contains the canonical payload fields
- `signature` is a hex-encoded ECDSA signature (`0x`-prefixed, 65 bytes: r+s+v)
- `network` MUST be `eip155:<chainId>` and `payTo` MUST be a valid EVM address

**When `format = "jws"`:**
- `payload` MUST be omitted (the JWS compact string already contains the payload)
- `signature` is a JWS Compact Serialization string (`header.payload.signature`)

The `payload` field is omitted for JWS to avoid duplication and ambiguity — the payload is already encoded inside the JWS compact string.

**3.2 EIP-712 Domain**

All EIP-712 signatures in this extension use the following domain structure:

```javascript
{
  name: "<artifact-specific name>",
  version: "1",
  chainId: 1
}
```

Where `name` is:
- `"x402 offer"` for signed offers
- `"x402 receipt"` for receipts

The `chainId` is hardcoded to `1` (Ethereum mainnet) for all EIP-712 signatures in this extension. This is intentional: EIP-712 is used here purely as an off-chain signing format, not for on-chain transaction submission. The payment network is already identified by the `network` field in the payload. Using a constant `chainId` ensures EIP-712 signing works uniformly regardless of the payment network (including non-EVM networks like Solana).

> **Versioning note:** EIP-712 artifacts have two distinct version fields:
> - **Domain `version`** (string `"1"`): Indicates the EIP-712 schema version. Changing the canonical `types` or `primaryType` requires bumping this version.
> - **Payload `version`** (integer `1`): Indicates the offer/receipt semantic version. This field is part of the signed payload and travels with the artifact for use outside x402.

**3.2.1 EIP-712 Schema Is Normative and Not Transmitted**

For `format = "eip712"`, the signing digest is computed using the EIP-712 domain, the message (the artifact payload), and the canonical `types` and `primaryType` defined in this specification.

- The canonical `types` and `primaryType` definitions MUST NOT be included in transmitted x402 messages (offers/receipts).
- Signers MUST use the canonical `types` and `primaryType` definitions from this specification when producing EIP-712 signatures.
- Verifiers MUST obtain and use the same canonical `types` and `primaryType` definitions from this specification when verifying EIP-712 signatures.
- Because EIP-712 hashes the schema into the signature, any change to the canonical `types` or `primaryType` constitutes a breaking change and MUST be accompanied by explicit versioning (e.g., bumping the EIP-712 domain `version` or publishing a new spec version).

> **Non-normative note:** Conceptually, EIP-712 maps to JWS as follows: `domain` ≈ signing context (like a header), `message` ≈ payload, `signature` ≈ signature. The EIP-712 schema (`types` and `primaryType`) is "implicit" only in the sense that it is not transmitted on the wire — it is not optional.

> **Interoperability note:** Some ecosystems represent EIP-712 signatures as `{ domain, message, signature }`. This extension transmits EIP-712 artifacts as `{ format, payload, signature }`, where `payload` corresponds to the EIP-712 `message`. Implementations may wrap or translate these fields for use in external proof or attestation formats.

**3.3 JWS Header Requirements**

For JWS format, the header MUST include:

| Field | Type   | Required | Description                                 |
| ----- | ------ | -------- | ------------------------------------------- |
| `alg` | string | Yes      | Signing algorithm (e.g., `ES256K`, `EdDSA`) |
| `kid` | string | Yes      | Key identifier (DID URL) for key lookup     |


**4. Signed Offer**

A signed offer is a cryptographic commitment by the resource server to the payment terms presented in an `accepts[]` entry.

**4.1 Placement**

Signed offers are placed in the `extensions` field of the payment requirements response, following the v2 extension structure:

```
extensions["offer-receipt"].info.offers[]
```

Each offer in the `info.offers` array corresponds to an entry in `accepts[]`. Servers SHOULD maintain the same ordering between `offers[]` and `accepts[]` as a convenience, but clients MUST match offers to `accepts[]` entries by comparing payload fields (`network`, `asset`, `payTo`, `amount`, etc.) rather than relying on array index ordering. For JWS format, clients extract the payload by base64url-decoding the JWS payload component.

See §6.1 for complete examples.

**4.1.1 acceptIndex Handling**

Servers SHOULD include `acceptIndex` as an unsigned convenience field to help clients match offers to `accepts[]` entries. It is NOT part of the signed payload and MUST NOT be relied upon for integrity or binding.

**Within the x402 session (clients):**

When `acceptIndex` is present, clients SHOULD:
- Check that `acceptIndex` is in-range for the `accepts[]` array
- Validate that `accepts[acceptIndex]` terms match the signed payload fields (`network`, `asset`, `payTo`, `amount`, etc.)

Clients MUST NOT treat `acceptIndex` as authoritative — field matching against the signed payload is the source of truth.

**Outside the x402 session (external verifiers):**

When an offer is stored or transmitted outside the x402 negotiation context (e.g., in attestations or reputation systems), `acceptIndex` MAY be omitted without affecting signature verification. External verifiers SHOULD ignore `acceptIndex` since the corresponding `accepts[]` list is not available.

**4.2 Offer Payload Fields**

Each element of the offers[] array contains the following fields:

| Field         | Type   | Required | Description                                                        |
| ------------- | ------ | -------- | ------------------------------------------------------------------ |
| `version`     | number | Yes      | Offer payload schema version (currently `1`)                       |
| `resourceUrl` | string | Yes      | The paid resource URL                                              |
| `scheme`      | string | Yes      | Payment scheme identifier (e.g., "exact")                          |
| `network`     | string | Yes      | Blockchain network identifier (CAIP-2 format, e.g., "eip155:8453") |
| `asset`       | string | Yes      | Token contract address or "native"                                 |
| `payTo`       | string | Yes      | Recipient wallet address                                           |
| `amount`      | string | Yes      | Required payment amount                                            |
| `validUntil`  | number | Optional | Unix timestamp (seconds) when the offer expires                    |

**Note**: For x402 v1, servers copy `maxAmountRequired` to `amount` when constructing the offer payload. Servers MUST convert v1 network identifiers (e.g., "base-sepolia") to CAIP-2 format (e.g., "eip155:84532") in the offer payload.

**4.3 EIP-712 Types for Offer (Normative Schema)**

The following `types` and `primaryType` are the canonical EIP-712 schema for offers. Per §3.2.1, these definitions are used for signing and verification but MUST NOT be transmitted on the wire.

```javascript
{
  "primaryType": "Offer",
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" }
    ],
    "Offer": [
      { "name": "version", "type": "uint256" },
      { "name": "resourceUrl", "type": "string" },
      { "name": "scheme", "type": "string" },
      { "name": "network", "type": "string" },
      { "name": "asset", "type": "string" },
      { "name": "payTo", "type": "string" },
      { "name": "amount", "type": "string" },
      { "name": "validUntil", "type": "uint256" }
    ]
  }
}
```

For the optional `validUntil` field, implementations MUST set unused fields to `0`. This rule applies only to EIP-712 signing, where fixed schemas require all fields to be present. Verifiers MUST treat zero-value optional fields as equivalent to absence.

**4.4 Offer Examples**

**EIP-712 format:**

```json
{
  "format": "eip712",
  "acceptIndex": 0,
  "payload": {
    "version": 1,
    "resourceUrl": "https://api.example.com/premium-data",
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "amount": "10000",
    "validUntil": 1703123516
  },
  "signature": "0x1234567890abcdef..."
}
```

**JWS format:**

```json
{
  "format": "jws",
  "acceptIndex": 0,
  "signature": "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzIiwiYXNzZXQiOiIweDgzMzU4OWZDRDZlRGI2RTA4ZjRjN0MzMkQ0ZjcxYjU0YmRBMDI5MTMiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsImFtb3VudCI6IjEwMDAwIiwidmFsaWRVbnRpbCI6MTcwMzEyMzUxNn0.sig"
}
```

**4.5 Offer Verification**

**For EIP-712:**
1. Extract `offer.payload` and `offer.signature`
2. Check `payload.version` to select the appropriate EIP-712 types (currently only version `1` is defined; see §4.3)
3. Construct the EIP-712 typed data hash using the domain (`name: "x402 offer"`, `version: "1"`, `chainId: 1`) and the types for the payload version. The `offer.payload` object MUST be used exactly as transmitted; verifiers MUST NOT reconstruct or infer payload fields from surrounding x402 context.
4. Verify the signature and recover the signer address
5. Confirm the signer is authorized to sign for the service identified by `payload.resourceUrl` (see §4.5.1)

**For JWS:**
1. Parse the JWS compact string from `offer.signature`
2. Extract `kid` from the JWS header; extract the payload by base64url-decoding the JWS payload component
3. Check the payload's `version` to determine how to interpret the remaining fields (currently only version `1` is defined)
4. Resolve `kid` to a public key
5. Verify the JWS signature over the complete payload
6. Confirm the key is authorized to sign for the service identified by the payload's `resourceUrl` (see §4.5.1)

**4.5.1 Signer Authorization**

Verifiers MUST confirm that the signing key is authorized to act on behalf of the service identified by `resourceUrl`. This specification does not mandate a specific authorization mechanism. Common approaches include:

- **`payTo` address signing**: The simplest approach — the service signs with the private key corresponding to the `payTo` address. Verifiers accept the signature if the recovered signer matches `payTo`.
- **External key registry**: An external system (e.g., DID documents, on-chain attestations, or other key binding mechanisms) maps the signing key or `kid` to the service identity.

**4.6 Offer Expiration**

If `validUntil` is present and non-zero, the resource server MAY reject payment attempts where:

```
now > validUntil
```

This allows servers to limit how long they commit to specific pricing or terms. Clients SHOULD check expiration before paying to avoid rejected payments, but the enforcement decision rests with the resource server.


**5. Receipt**

A receipt is a signed statement returned by the resource server **only on success**, confirming that payment was received and service was delivered.

**5.1 Placement**

On success, the `SettlementResponse` MAY include a receipt in the `extensions` field, following the v2 extension structure:

```
extensions["offer-receipt"].info.receipt
```

This placement is the same for both x402 v1 and v2.

See §6.2 and §6.3 for complete examples.

**5.2 Receipt Payload Fields**

The canonical receipt payload contains the following fields:

| Field         | Type   | Required | Description                                                        |
| ------------- | ------ | -------- | ------------------------------------------------------------------ |
| `version`     | number | Yes      | Receipt payload schema version (currently `1`)                     |
| `network`     | string | Yes      | Blockchain network identifier (CAIP-2 format, e.g., "eip155:8453") |
| `resourceUrl` | string | Yes      | The paid resource URL                                              |
| `payer`       | string | Yes      | Payer identifier (commonly a wallet address)                       |
| `issuedAt`    | number | Yes      | Unix timestamp (seconds) when receipt was issued                   |
| `transaction` | string | Optional | Blockchain transaction hash                                        |

The receipt is **privacy-minimal** by default and intentionally omits transaction references to reduce correlation risk. Servers MAY include the optional `transaction` field when stronger verifiability is preferred over privacy. If `transaction` is included, verifiers can look up the payment amount on-chain.

**Note**: Servers MUST convert v1 network identifiers (e.g., "base-sepolia") to CAIP-2 format (e.g., "eip155:84532") in the receipt payload.

**5.3 EIP-712 Types for Receipt (Normative Schema)**

The following `types` and `primaryType` are the canonical EIP-712 schema for receipts. Per §3.2.1, these definitions are used for signing and verification but MUST NOT be transmitted on the wire.

```javascript
{
  "primaryType": "Receipt",
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" }
    ],
    "Receipt": [
      { "name": "version", "type": "uint256" },
      { "name": "network", "type": "string" },
      { "name": "resourceUrl", "type": "string" },
      { "name": "payer", "type": "string" },
      { "name": "issuedAt", "type": "uint256" },
      { "name": "transaction", "type": "string" }
    ]
  }
}
```

For the optional `transaction` field, implementations MUST set unused fields to empty string `""`. This rule applies only to EIP-712 signing, where fixed schemas require all fields to be present. Verifiers MUST treat empty-string optional fields as equivalent to absence.

**5.4 Receipt Examples**

**EIP-712 format (privacy-minimal):**

```json
{
  "format": "eip712",
  "payload": {
    "version": 1,
    "network": "eip155:8453",
    "resourceUrl": "https://api.example.com/premium-data",
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "issuedAt": 1703123456,
    "transaction": ""
  },
  "signature": "0x1234567890abcdef..."
}
```

**EIP-712 format (with transaction for verifiability):**

```json
{
  "format": "eip712",
  "payload": {
    "version": 1,
    "network": "eip155:8453",
    "resourceUrl": "https://api.example.com/premium-data",
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "issuedAt": 1703123456,
    "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
  },
  "signature": "0x1234567890abcdef..."
}
```

**JWS format:**

```json
{
  "format": "jws",
  "signature": "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInBheWVyIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzOGI5MWJEYmIwRTIyMzczZTM2YjY2IiwiaXNzdWVkQXQiOjE3MDMxMjM0NTZ9.sig"
}
```

**5.5 Receipt Verification**

**For EIP-712:**
1. Extract `receipt.payload` and `receipt.signature`
2. Check `payload.version` to select the appropriate EIP-712 types (currently only version `1` is defined; see §5.3)
3. Construct the EIP-712 typed data hash using the domain (`name: "x402 receipt"`, `version: "1"`, `chainId: 1`) and the types for the payload version. The `receipt.payload` object MUST be used exactly as transmitted; verifiers MUST NOT reconstruct or infer payload fields from surrounding x402 context.
4. Verify the signature and recover the signer address
5. Confirm the signer is authorized to sign for the service identified by `payload.resourceUrl` (see §4.5.1)
6. Confirm `issuedAt` is within acceptable verifier policy
7. If `transaction` is present and non-empty, verifiers MAY check the blockchain to confirm the transaction exists and matches expected parameters

**For JWS:**
1. Parse the JWS compact string from `receipt.signature`
2. Extract `kid` from the JWS header; extract the payload by base64url-decoding the JWS payload component
3. Check the payload's `version` to determine how to interpret the remaining fields (currently only version `1` is defined)
4. Resolve `kid` to a public key
5. Verify the JWS signature over the complete payload
6. Confirm the key is authorized to sign for the service identified by the payload's `resourceUrl` (see §4.5.1)
7. Confirm `issuedAt` (from the payload) is within acceptable verifier policy
8. If `transaction` is present, verifiers MAY check the blockchain to confirm the transaction exists


**6. Protocol Integration Examples**

This section provides complete examples showing how signed offers and receipts integrate with x402 protocol messages. A server would typically use one signature format consistently (EIP-712 or JWS), so examples are shown separately.

Note: x402 v1 uses human-readable network identifiers (e.g., "base") in the protocol messages, but the offer and receipt payloads MUST use CAIP-2 format (e.g., "eip155:8453") for portability and EIP-712 domain construction.

**6.1 Payment Requirements with Signed Offers (EIP-712, x402 v2)**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "offer-receipt": {
      "info": {
        "offers": [
          {
            "format": "eip712",
            "acceptIndex": 0,
            "payload": {
              "version": 1,
              "resourceUrl": "https://api.example.com/premium-data",
              "scheme": "exact",
              "network": "eip155:8453",
              "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
              "amount": "10000",
              "validUntil": 1703123516
            },
            "signature": "0x1234567890abcdef..."
          }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "offers": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "format": { "type": "string", "const": "eip712" },
                "acceptIndex": { "type": "integer" },
                "payload": {
                  "type": "object",
                  "properties": {
                    "version": { "type": "integer" },
                    "resourceUrl": { "type": "string" },
                    "scheme": { "type": "string" },
                    "network": { "type": "string" },
                    "asset": { "type": "string" },
                    "payTo": { "type": "string" },
                    "amount": { "type": "string" },
                    "validUntil": { "type": "integer" }
                  },
                  "required": ["version", "resourceUrl", "scheme", "network", "asset", "payTo", "amount"]
                },
                "signature": { "type": "string" }
              },
              "required": ["format", "payload", "signature"]
            }
          }
        },
        "required": ["offers"]
      }
    }
  }
}
```

**6.2 Payment Requirements with Signed Offers (EIP-712, x402 v1)**

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "resource": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "offer-receipt": {
      "info": {
        "offers": [
          {
            "format": "eip712",
            "acceptIndex": 0,
            "payload": {
              "version": 1,
              "resourceUrl": "https://api.example.com/premium-data",
              "scheme": "exact",
              "network": "eip155:8453",
              "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
              "amount": "10000",
              "validUntil": 1703123516
            },
            "signature": "0x1234567890abcdef..."
          }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "offers": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "format": { "type": "string", "const": "eip712" },
                "acceptIndex": { "type": "integer" },
                "payload": {
                  "type": "object",
                  "properties": {
                    "version": { "type": "integer" },
                    "resourceUrl": { "type": "string" },
                    "scheme": { "type": "string" },
                    "network": { "type": "string" },
                    "asset": { "type": "string" },
                    "payTo": { "type": "string" },
                    "amount": { "type": "string" },
                    "validUntil": { "type": "integer" }
                  },
                  "required": ["version", "resourceUrl", "scheme", "network", "asset", "payTo", "amount"]
                },
                "signature": { "type": "string" }
              },
              "required": ["format", "payload", "signature"]
            }
          }
        },
        "required": ["offers"]
      }
    }
  }
}
```

**6.3 Payment Requirements with Signed Offers (JWS, x402 v2)**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "offer-receipt": {
      "info": {
        "offers": [
          {
            "format": "jws",
            "acceptIndex": 0,
            "signature": "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzIiwiYXNzZXQiOiIweDgzMzU4OWZDRDZlRGI2RTA4ZjRjN0MzMkQ0ZjcxYjU0YmRBMDI5MTMiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsImFtb3VudCI6IjEwMDAwIiwidmFsaWRVbnRpbCI6MTcwMzEyMzUxNn0.sig"
          }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "offers": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "format": { "type": "string", "const": "jws" },
                "acceptIndex": { "type": "integer" },
                "signature": { "type": "string", "description": "JWS compact serialization containing the offer payload" }
              },
              "required": ["format", "signature"]
            }
          }
        },
        "required": ["offers"]
      }
    }
  }
}
```

**6.4 Payment Requirements with Signed Offers (JWS, x402 v1)**

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "resource": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "offer-receipt": {
      "info": {
        "offers": [
          {
            "format": "jws",
            "acceptIndex": 0,
            "signature": "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzIiwiYXNzZXQiOiIweDgzMzU4OWZDRDZlRGI2RTA4ZjRjN0MzMkQ0ZjcxYjU0YmRBMDI5MTMiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsImFtb3VudCI6IjEwMDAwIiwidmFsaWRVbnRpbCI6MTcwMzEyMzUxNn0.sig"
          }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "offers": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "format": { "type": "string", "const": "jws" },
                "acceptIndex": { "type": "integer" },
                "signature": { "type": "string", "description": "JWS compact serialization containing the offer payload" }
              },
              "required": ["format", "signature"]
            }
          }
        },
        "required": ["offers"]
      }
    }
  }
}
```

**6.5 Success Response with Receipt (EIP-712, x402 v2)**

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "offer-receipt": {
      "info": {
        "receipt": {
          "format": "eip712",
          "payload": {
            "version": 1,
            "network": "eip155:8453",
            "resourceUrl": "https://api.example.com/premium-data",
            "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            "issuedAt": 1703123456,
            "transaction": ""
          },
          "signature": "0x1234567890abcdef..."
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "receipt": {
            "type": "object",
            "properties": {
              "format": { "type": "string", "const": "eip712" },
              "payload": {
                "type": "object",
                "properties": {
                  "version": { "type": "integer" },
                  "network": { "type": "string" },
                  "resourceUrl": { "type": "string" },
                  "payer": { "type": "string" },
                  "issuedAt": { "type": "integer" },
                  "transaction": { "type": "string" }
                },
                "required": ["version", "network", "resourceUrl", "payer", "issuedAt"]
              },
              "signature": { "type": "string" }
            },
            "required": ["format", "payload", "signature"]
          }
        },
        "required": ["receipt"]
      }
    }
  }
}
```

**6.6 Success Response with Receipt (EIP-712, x402 v1)**

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "base",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "offer-receipt": {
      "info": {
        "receipt": {
          "format": "eip712",
          "payload": {
            "version": 1,
            "network": "eip155:8453",
            "resourceUrl": "https://api.example.com/premium-data",
            "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            "issuedAt": 1703123456,
            "transaction": ""
          },
          "signature": "0x1234567890abcdef..."
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "receipt": {
            "type": "object",
            "properties": {
              "format": { "type": "string", "const": "eip712" },
              "payload": {
                "type": "object",
                "properties": {
                  "version": { "type": "integer" },
                  "network": { "type": "string" },
                  "resourceUrl": { "type": "string" },
                  "payer": { "type": "string" },
                  "issuedAt": { "type": "integer" },
                  "transaction": { "type": "string" }
                },
                "required": ["version", "network", "resourceUrl", "payer", "issuedAt"]
              },
              "signature": { "type": "string" }
            },
            "required": ["format", "payload", "signature"]
          }
        },
        "required": ["receipt"]
      }
    }
  }
}
```

**6.7 Success Response with Receipt (JWS, x402 v2)**

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "offer-receipt": {
      "info": {
        "receipt": {
          "format": "jws",
          "signature": "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInBheWVyIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzOGI5MWJEYmIwRTIyMzczZTM2YjY2IiwiaXNzdWVkQXQiOjE3MDMxMjM0NTYsInRyYW5zYWN0aW9uIjoiIn0.sig"
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "receipt": {
            "type": "object",
            "properties": {
              "format": { "type": "string", "const": "jws" },
              "signature": { "type": "string", "description": "JWS compact serialization containing the receipt payload" }
            },
            "required": ["format", "signature"]
          }
        },
        "required": ["receipt"]
      }
    }
  }
}
```

**6.8 Success Response with Receipt (JWS, x402 v1)**

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "base",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "offer-receipt": {
      "info": {
        "receipt": {
          "format": "jws",
          "signature": "eyJhbGciOiJFUzI1NksiLCJraWQiOiJkaWQ6d2ViOmFwaS5leGFtcGxlLmNvbSNrZXktMSJ9.eyJ2ZXJzaW9uIjoxLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJyZXNvdXJjZVVybCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3ByZW1pdW0tZGF0YSIsInBheWVyIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzOGI5MWJEYmIwRTIyMzczZTM2YjY2IiwiaXNzdWVkQXQiOjE3MDMxMjM0NTYsInRyYW5zYWN0aW9uIjoiIn0.sig"
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "receipt": {
            "type": "object",
            "properties": {
              "format": { "type": "string", "const": "jws" },
              "signature": { "type": "string", "description": "JWS compact serialization containing the receipt payload" }
            },
            "required": ["format", "signature"]
          }
        },
        "required": ["receipt"]
      }
    }
  }
}
```

**7. Key Discovery and Trust**

This extension does not mandate a specific trust system for mapping the server's signing key to an identity. See §4.5.1 for signer authorization options.

For EIP-712 signatures, the signer address is recovered from the signature. The simplest deployment uses the `payTo` address as the signing key.

For JWS signatures, the `kid` header field provides the key identifier for lookup.

**8. Use Cases (Non-Normative)**

This extension defines signed offers and signed receipts that can be carried alongside x402 flows. These artifacts are designed to be portable and independently verifiable, enabling optional trust and audit layers without changing payment execution or settlement semantics.

- **Attestation-backed discovery and trust for paid endpoints**: Signed offers and receipts can be embedded as evidence in attestations (e.g., user reviews). Those attestations can support discovery, filtering, and reputation scoring for paid API/service endpoints — an area that typically lacks the trust provided by user reviews in app stores and ecommerce sites.

- **Auditability and dispute/feedback evidence**: Signed artifacts provide verifiable evidence of what terms were presented and, when applicable, that service was delivered. This supports auditing, customer support, and dispute workflows, including scenarios involving automated purchasers (agents) and enterprise procurement.

- **Agent-to-agent commerce**: Autonomous agents making purchasing decisions need machine-verifiable proof of terms and delivery. Signed offers let an agent's principal (human or system) audit what deals the agent accepted; receipts prove the agent received the promised service.

- **Why offers matter even without receipts**: A signed offer can be used as evidence even when no receipt is available (e.g., the user did not complete payment, the service did not return a receipt, or the user wants to provide feedback about pricing/terms). Offers prove the server's stated terms at a point in time; receipts prove successful service delivery.

**9. Integration with Proof Systems**

The `offer` and `receipt` objects defined in this extension are designed to be usable as proof artifacts in attestation systems. These objects are intentionally self-contained so they can be lifted verbatim into external proof or attestation formats without reconstruction.

**10. Security Considerations**

- Implementations MUST ensure canonicalization rules are applied consistently (JCS for JWS payloads, EIP-712 rules for EIP-712).
- Servers MUST NOT include the `signature` field in the payload being signed to avoid circularity.
- Servers should consider replay implications of long-lived signed offers; including `validUntil` can reduce risk.
- Receipts and offers are transferable artifacts; possession of a valid server signature is sufficient for verification. Transport-layer security (HTTPS) is essential.

**11. Privacy Considerations**

- Receipts are minimal by default — they omit transaction references to reduce correlation risk.
- Servers MAY include the optional `transaction` field when verifiability is more important than privacy for their use case.
- Offers reveal economic terms (amount, asset, payTo address).
- Attestations MAY include either offers, receipts, or both.
- Implementations SHOULD consider privacy implications when deciding which artifacts to include in public attestations.

**12. Version History**

| Version | Date       | Changes                                                        | Author     |
| ------- | ---------- | -------------------------------------------------------------- | ---------- |
| 0.6     | 2026-02-04 | Make EIP-712 chain-agnostic: chainId=1, payTo type=string.     | Alfred Tom |
| 0.5     | 2026-01-29 | First approved release.                                        | Alfred Tom |
| 0.4     | 2026-01-26 | Add acceptIndex as unsigned envelope field.                    | Alfred Tom |
| 0.3     | 2026-01-22 | Add validUntil for offer expiration. Move version to payload.  | Alfred Tom |
| 0.2     | 2026-01-20 | Move offers/receipt to extensions. Add network to receipt.     | Alfred Tom |
| 0.1     | 2025-12-22 | Initial extension draft.                                       | Alfred Tom |
