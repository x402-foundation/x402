# Scheme: `exact` — AssetTransferMethod: `txid`

## Summary

The `txid` asset transfer method enables x402 payments using **any transferable asset on any blockchain**, without requiring the asset to implement a specialized "transfer-with-authorization" or permit interface.

Unlike EIP-3009 and Permit2 — where the facilitator submits the on-chain transaction — with TXID the payer executes the on-chain transfer directly. The client then proves payment to the resource server by presenting:

- a **transaction reference** (`txRef`) identifying the on-chain transfer, and
- a **payer signature** demonstrating that the entity requesting the resource controls the account that funded the transaction.

| AssetTransferMethod | Use Case                                                        | Notes                                           |
| :------------------ | :-------------------------------------------------------------- | :---------------------------------------------- |
| **txid**            | Any transferable asset on any blockchain. Client prepays.       | No facilitator gas. Supports native tokens.     |

This asset transfer method allows x402 to support:

- tokens and native assets that do not implement standardized authorization-based transfer interfaces,
- non-EVM chains and heterogeneous execution environments,
- payment flows where the payer submits the transaction and pays network fees directly, including with the native token of the chain, although existing gas subsidy tools can still be used.

TXID deliberately shifts responsibility from protocol-enforced guarantees to facilitator-side correctness. In exchange for supporting payments in any transferable asset on any chain, TXID requires facilitators to correctly implement additional verification and state-management logic. Unlike facilitator-submitted asset transfer methods — where replay protection for fund movement is enforced by on-chain mechanisms — TXID requires facilitators to enforce replay protection for **service delivery**. This includes:

- maintaining persistent state to de-duplicate accepted transaction references,
- aligning transaction acceptance rules with transaction-reference retention policies.

In return, TXID enables resource servers to accept payments for assets that do not support standardized authorization-based transfer interfaces, including:

- native assets of a chain (e.g. ETH),
- tokens without permit or transfer-with-authorization functionality.

---

## 1. Payment Requirements (Server → Client)

When a resource server accepts payment via TXID, it responds with payment requirements containing `extra.assetTransferMethod: "txid"`.

### 1.1 x402 v1 Payment Requirements Example

```json
{
  "x402Version": 1,
  "error": "Payment required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:1",
      "maxAmountRequired": "10000",
      "asset": "native",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "resource": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json",
      "outputSchema": null,
      "maxTimeoutSeconds": 60,
      "extra": {
        "assetTransferMethod": "txid"
      }
    }
  ]
}
```

### 1.2 x402 v2 Payment Requirements Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:1",
      "amount": "10000",
      "asset": "native",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "assetTransferMethod": "txid"
      }
    }
  ],
  "extensions": {}
}
```

### 1.3 Payment Requirements Fields (v1)

| Field Name          | Type     | Required | Description                                                              |
| ------------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `scheme`            | `string` | Required | Payment scheme identifier (e.g., "exact")                                |
| `network`           | `string` | Required | Blockchain network identifier (e.g., "base-sepolia", "eip155:1")         |
| `maxAmountRequired` | `string` | Required | Required payment amount in atomic token units (e.g., Wei or Lamport)     |
| `asset`             | `string` | Required | Token contract address, or "native" for the native token of "network"    |
| `payTo`             | `string` | Required | Recipient wallet address for the payment                                 |
| `resource`          | `string` | Required | URL of the protected resource                                            |
| `description`       | `string` | Required | Human-readable description of the resource                               |
| `mimeType`          | `string` | Optional | MIME type of the expected response                                       |
| `outputSchema`      | `object` | Optional | JSON schema describing the response format                               |
| `maxTimeoutSeconds` | `number` | Optional | Maximum time allowed for payment completion (payment offer expiration)   |
| `extra`             | `object` | Required | Must contain `assetTransferMethod: "txid"`                               |

### 1.4 Payment Requirements Fields (v2 Differences)

v2 uses the same fields as v1 with the following differences:

| Field Name          | Change                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `network`           | Uses CAIP-2 format (e.g., "eip155:84532") instead of human-readable identifiers             |
| `amount`            | Replaces `maxAmountRequired`                                                                |
| `resource`          | Moved to top-level `resource` object (not in each payment requirement)                      |
| `description`       | Moved to top-level `resource.description`                                                   |
| `mimeType`          | Moved to top-level `resource.mimeType`                                                      |
| `outputSchema`      | Removed from payment requirements                                                           |
| `maxTimeoutSeconds` | Now Required (was Optional in v1)                                                           |

**Note on `maxTimeoutSeconds`**: For TXID, `maxTimeoutSeconds` is an advisory payment offer lifetime and is not cryptographically enforced, because the resource server does not commit to the quoted terms on-chain or via signature. It indicates the window during which the client can reasonably expect the quoted terms to remain valid; after this window, the resource server MAY reject the payment proof if pricing or policy has changed. Future extensions could introduce signed offers.

---

## 2. Payment Payload (Client → Server)

For TXID, the client returns a payment proof containing the transaction reference and a signature binding it to the payment terms.

### 2.1 x402 v1

#### 2.1.1 Payment Payload Fields (v1)

| Field Name    | Type     | Required | Description                                                              |
| ------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `x402Version` | `number` | Required | Protocol version identifier (1)                                          |
| `scheme`      | `string` | Required | Payment scheme identifier (e.g., "exact")                                |
| `network`     | `string` | Required | Blockchain network identifier (e.g., "base-sepolia", "eip155:1")         |
| `payload`     | `object` | Required | Payment proof object                                                     |

In v1, the client includes the `paymentRequirements` directly in the payment proof payload. This is the same object the resource server supplies to the facilitator `/verify` API. The field is named `offer` in the payload; this refers directly to the `paymentRequirements` object and does not introduce a new semantic layer.

The `payload` field for v1 contains:

| Field Name            | Type     | Required | Description                                                             |
| --------------------- | -------- | -------- | ----------------------------------------------------------------------- |
| `type`                | `string` | Required | Proof type (`"payment-proof"` for TXID)                                 |
| `alg`                 | `string` | Required | Cryptographic algorithm used for signing (e.g., "ES256K", "Ed25519")    |
| `format`              | `string` | Required | Signing convention/serialization (e.g., "eip712", "solana-signmessage") |
| `txRef`               | `string` | Required | Transaction reference linking to the on-chain payment                   |
| `from`                | `string` | Required | Payer's wallet address                                                  |
| `offer`               | `object` | Required | The PaymentRequirements object as defined in Verify Request Example (v1)|
| `signature`           | `string` | Required | Serialized signature over `txRef` and `paymentRequirements`             |

The `signature` field is the result of the `from` private key signing the following object (see Signature Binding for encoding details):

```json
{
  "txRef": "<txRef>",
  "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "offer": { /* the paymentRequirements object */ }
}
```

#### 2.1.2 Payment Payload Example (v1)

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "eip155:1",
  "payload": {
    "type": "payment-proof",
    "alg": "ES256K",
    "format": "eip712",
    "txRef": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "offer": {
      "scheme": "exact",
      "network": "eip155:1",
      "maxAmountRequired": "10000",
      "resource": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "asset": "native",
      "extra": {
        "assetTransferMethod": "txid"
      }
    },
    "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef01"
  }
}
```

### 2.2 x402 v2

In v2, the payment proof payload is minimal — it contains only `txRef`, `from`, and `signature`. The `resource` and `accepted` fields are already present at the top level of the payment payload (per base x402 v2), so they are not duplicated inside the proof.

#### 2.2.1 Payment Payload Fields (v2 Differences)

v2 restructures the payment payload with the following differences:

| Field Name    | Type     | Required | Description                                                              |
| ------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `x402Version` | `number` | Required | Protocol version identifier (2)                                          |
| `resource`    | `object` | Required | Top-level object with `url`, `description`, `mimeType`                   |
| `accepted`    | `object` | Required | Top-level field echoing the chosen entry from `accepts[]`                |
| `payload`     | `object` | Required | Payment proof object                                                     |
| `extensions`  | `object` | Optional | New field for protocol extensions data                                   |

The `payload` field for v2 contains:

| Field Name            | Type     | Required | Description                                                             |
| --------------------- | -------- | -------- | ----------------------------------------------------------------------- |
| `type`                | `string` | Required | Proof type (`"payment-proof"` for TXID)                                 |
| `alg`                 | `string` | Required | Cryptographic algorithm used for signing (e.g., "ES256K", "Ed25519")    |
| `format`              | `string` | Required | Signing convention/serialization (e.g., "eip712", "solana-signmessage") |
| `txRef`               | `string` | Required | Transaction reference linking to the on-chain payment                   |
| `from`                | `string` | Required | Payer's wallet address                                                  |
| `signature`           | `string` | Required | Serialized signature over `txRef` and `paymentRequirements`             |

The `signature` field is the result of the `from` private key signing the following object (see Signature Binding for encoding details):

```json
{
  "txRef": "<txRef>",
  "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "resource": { /* top-level resource object */ },
  "accepted": { /* top-level accepted object */ }
}
```

#### 2.2.2 Payment Payload Example (v2)

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
    "network": "eip155:1",
    "amount": "10000",
    "asset": "native",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "txid"
    }
  },
  "payload": {
    "type": "payment-proof",
    "alg": "ES256K",
    "format": "eip712",
    "txRef": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef01"
  },
  "extensions": {}
}
```

---

## 3. Signature Binding

For TXID, the client MUST include a payer signature that cryptographically commits to the transaction reference and the payment terms. The signing object differs between v1 and v2.

Including `from` in the signing object prevents identity substitution and ensures the signature is bound to the payer account referenced by the on-chain transaction.

Signing objects MUST contain only the fields defined in this specification for the applicable version and format.

### 3.1 Supported Signature Formats

The `format` field specifies how the signing object is encoded and signed. The required format is determined by the network's virtual machine type:

| Network Type | Required Format       | Required Algorithm |
| ------------ | --------------------- | ------------------ |
| EVM          | `eip712`              | `ES256K`           |
| Solana       | `solana-signmessage`  | `Ed25519`          |

Clients MUST use the format corresponding to the `network` specified in the payment requirements. Facilitators MUST reject payment proofs that use an incorrect format for the network.

### 3.2 Canonicalization

Implementations MUST use deterministic canonicalization when signing. The canonicalization method depends on the signing format:

| Format              | Canonicalization Method                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `eip712`            | EIP-712 typed data encoding (native EIP-712 canonicalization)          |
| `solana-signmessage`| RFC 8785 (JCS) canonical JSON, then UTF-8 encode                       |

**Important**: EIP-712 provides its own deterministic canonicalization and domain separation. JSON canonicalization (RFC 8785 / JCS) MUST NOT be applied when using EIP-712. The two signing paths are distinct and MUST NOT be combined.

#### 3.2.1 EIP-712 (Ethereum Structured Data Signing)

**Format identifier**: `"eip712"`

**Domain:**

```javascript
{
  name: "x402 Payment Proof",
  version: "1",
  chainId: <network chainId>
}
```

**Primary Type and Message Structure (v1):**

```javascript
{
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }
    ],
    PaymentProof: [
      { name: "txRef", type: "string" },
      { name: "from", type: "address" },
      { name: "offer", type: "Offer" }
    ],
    Offer: [
      { name: "scheme", type: "string" },
      { name: "assetTransferMethod", type: "string" },
      { name: "network", type: "string" },
      { name: "maxAmountRequired", type: "string" },
      { name: "asset", type: "string" },
      { name: "payTo", type: "address" },
      { name: "resource", type: "string" },
      { name: "description", type: "string" },
      { name: "mimeType", type: "string" },
      { name: "maxTimeoutSeconds", type: "uint256" }
    ]
  },
  primaryType: "PaymentProof",
  message: {
    txRef: "<txRef>",
    from: "<from address>",
    offer: { /* the offer object */ }
  }
}
```

**Primary Type and Message Structure (v2):**

```javascript
{
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }
    ],
    PaymentProof: [
      { name: "txRef", type: "string" },
      { name: "from", type: "address" },
      { name: "resource", type: "Resource" },
      { name: "accepted", type: "Accepted" }
    ],
    Resource: [
      { name: "url", type: "string" },
      { name: "description", type: "string" },
      { name: "mimeType", type: "string" }
    ],
    Accepted: [
      { name: "scheme", type: "string" },
      { name: "assetTransferMethod", type: "string" },
      { name: "network", type: "string" },
      { name: "amount", type: "string" },
      { name: "asset", type: "string" },
      { name: "payTo", type: "address" },
      { name: "maxTimeoutSeconds", type: "uint256" }
    ]
  },
  primaryType: "PaymentProof",
  message: {
    txRef: "<txRef>",
    from: "<from address>",
    resource: { /* top-level resource object */ },
    accepted: { /* top-level accepted object */ }
  }
}
```

**Signature encoding**: Hex-encoded ECDSA signature (0x-prefixed, 65 bytes: r + s + v)

**Verification**: Use EIP-712 typed data hashing and ECDSA signature verification. Support EIP-1271 for smart contract wallets.

**Complete EIP-712 Example (v2, with populated values):**

```javascript
{
  domain: {
    name: "x402 Payment Proof",
    version: "1",
    chainId: 1
  },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }
    ],
    PaymentProof: [
      { name: "txRef", type: "string" },
      { name: "from", type: "address" },
      { name: "resource", type: "Resource" },
      { name: "accepted", type: "Accepted" }
    ],
    Resource: [
      { name: "url", type: "string" },
      { name: "description", type: "string" },
      { name: "mimeType", type: "string" }
    ],
    Accepted: [
      { name: "scheme", type: "string" },
      { name: "assetTransferMethod", type: "string" },
      { name: "network", type: "string" },
      { name: "amount", type: "string" },
      { name: "asset", type: "string" },
      { name: "payTo", type: "address" },
      { name: "maxTimeoutSeconds", type: "uint256" }
    ]
  },
  primaryType: "PaymentProof",
  message: {
    txRef: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    resource: {
      url: "https://api.example.com/premium-data",
      description: "Access to premium market data",
      mimeType: "application/json"
    },
    accepted: {
      scheme: "exact",
      assetTransferMethod: "txid",
      network: "eip155:1",
      amount: "10000",
      asset: "native",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60
    }
  }
}
```

#### 3.2.2 Solana signMessage (JCS-based)

**Format identifier**: `"solana-signmessage"`

For non-EVM networks like Solana, the signing object is serialized as JSON, canonicalized using JCS (RFC 8785), and then signed.

**Encoding**: The signing object is serialized using JCS (RFC 8785) and UTF-8 encoded with a prefix:

```
x402 Payment Proof\n<JCS(signing object)>
```

**Signing object (v1):**
```json
{
  "txRef": "<txRef>",
  "from": "<from address>",
  "offer": { /* the offer/paymentRequirements object, including extra.assetTransferMethod */ }
}
```

**Signing object (v2):**
```json
{
  "txRef": "<txRef>",
  "from": "<from address>",
  "resource": { /* top-level resource object */ },
  "accepted": { /* top-level accepted object, including extra.assetTransferMethod */ }
}
```

**Signature encoding**: Base58-encoded Ed25519 signature (64 bytes)

**Verification**: Use Ed25519 signature verification with the public key derived from `from`.

Although the signing object is not transmitted verbatim, it is fully and deterministically derived from fields already present in the message, consistent with established protocol patterns such as EIP-712 and TLS transcript signing.

---

## 4. Verification Logic

When a resource server receives a TXID payment proof from a client, it MUST perform the verification procedure before delivering the requested service. The resource server may implement this verification by interfacing with a **facilitator service** or by self-hosting the verification logic directly (see Section 10, Self-Hosted Verification). x402 defines two REST APIs for facilitators:

| Endpoint       | Purpose                                                                 | Required for TXID |
| -------------- | ----------------------------------------------------------------------- | ----------------- |
| `POST /verify` | Validates the payment proof                                             | **Required**      |
| `POST /settle` | Ensures payment transactions are finalized                              | No                |

**TXID vs EIP-3009/Permit2**: Unlike EIP-3009 and Permit2 — where the resource server calls both `/verify` (to validate the signature) and `/settle` (to execute the on-chain transfer) — TXID only requires `/verify`. The on-chain transfer has already been executed by the client, so there is no settlement transaction for the facilitator to submit. The `/settle` endpoint is available for resource servers that want explicit settlement tracking, but `/verify` alone is sufficient for TXID.

### 4.1 POST /verify

Verifies a TXID payment proof. The resource server calls this endpoint with both the payment payload (from the client) and the original payment requirements (that the server issued).

#### 4.1.1 Verify Request Example (v1)

```json
{
  "paymentPayload": {
    "x402Version": 1,
    "scheme": "exact",
    "network": "eip155:1",
    "payload": {
      "type": "payment-proof",
      "alg": "ES256K",
      "format": "eip712",
      "txRef": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "offer": {
        "scheme": "exact",
        "network": "eip155:1",
        "maxAmountRequired": "10000",
        "asset": "native",
        "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "resource": "https://api.example.com/premium-data",
        "description": "Access to premium market data",
        "mimeType": "application/json",
        "maxTimeoutSeconds": 60,
        "extra": {
          "assetTransferMethod": "txid"
        }
      },
      "signature": "0x1234567890abcdef..."
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:1",
    "maxAmountRequired": "10000",
    "resource": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "asset": "native",
    "extra": {
      "assetTransferMethod": "txid"
    }
  }
}
```

#### 4.1.2 Verify Request Example (v2)

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json"
    },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:1",
      "amount": "10000",
      "asset": "native",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "assetTransferMethod": "txid"
      }
    },
    "payload": {
      "type": "payment-proof",
      "alg": "ES256K",
      "format": "eip712",
      "txRef": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "signature": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef01"
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:1",
    "amount": "10000",
    "asset": "native",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "txid"
    }
  }
}
```

#### 4.1.3 Verification Steps

The verification implementation performs the following steps. The `paymentRequirements` object is provided by the resource server and represents the original payment terms.

1. **Reserve the txRef (atomic)**
   - Atomically attempt to reserve the tuple `(network, txRef)` where `network` is from the payment requirements and `txRef` is `paymentPayload.payload.txRef`
   - If `(network, txRef)` is already reserved or consumed, reject immediately
   - This MUST happen first to prevent race conditions where concurrent requests with the same proof could both proceed past this check
   - If any subsequent step fails, release the reservation

2. **Validate signature format matches network**
   - `paymentPayload.payload.format` MUST be `eip712` for EVM networks, `solana-signmessage` for Solana
   - `paymentPayload.payload.alg` MUST be `ES256K` for EVM, `Ed25519` for Solana

3. **Construct the signing object**
   - **For v1**: Construct `{ "txRef": <txRef>, "from": <from>, "offer": <payload.offer> }`
   - **For v2**: Construct `{ "txRef": <txRef>, "from": <from>, "resource": <top-level resource>, "accepted": <top-level accepted> }`

4. **Verify the payment proof signature**
   - **For EVM (EIP-712)**: Encode the signing object as EIP-712 typed data (do NOT use JCS). Compute the EIP-712 hash. Use `ecrecover` with the hash and `paymentPayload.payload.signature` to recover the signer address. The recovered address MUST match `paymentPayload.payload.from`.
   - **For Solana (JCS-based)**: Canonicalize the signing object using JCS (RFC 8785), UTF-8 encode with prefix. Decode `paymentPayload.payload.from` to get the public key. Verify `paymentPayload.payload.signature` against the hash using `ed25519_verify`. Verification MUST succeed.

5. **Validate payment terms binding**
   - **For v1**: `paymentPayload.payload.offer` MUST match the `paymentRequirements` provided by the resource server
   - **For v2**: The top-level `accepted` object MUST match the payment requirements
   - `extra.assetTransferMethod` MUST be `"txid"`
   - `resource` MUST match the expected resource identifier
   - Payment-relevant fields (`network`, `asset`, `payTo`, amount) MUST match

6. **Fetch and validate the on-chain transaction**
   - Locate the transaction identified by `paymentPayload.payload.txRef`
   - Transaction MUST be confirmed to the required confirmation depth
   - Transaction payer/authority (e.g., `tx.from` on EVM, or the equivalent payer/authority account on other networks) MUST match `paymentPayload.payload.from`

7. **Validate the payment transfer against payment terms**
   - Transaction MUST have transferred at least the amount specified in `paymentRequirements.maxAmountRequired` (v1) or `accepted.amount` (v2)
   - Asset MUST match `paymentRequirements.asset` (v1) or `accepted.asset` (v2)
   - Transfer recipient MUST match `paymentRequirements.payTo` (v1) or `accepted.payTo` (v2)
   - Transaction timestamp MUST be within the retention window (see Replay and Idempotency Requirements)

8. **Mark txRef as consumed**
   - If all checks pass, mark the reserved `(network, txRef)` as permanently consumed
   - The `(network, txRef)` record is subject to the retention policy

TXID deliberately leaves finality determination to the resource server; implementations MUST define and apply a network-specific confirmation or finality policy before delivering service.

#### 4.1.4 /verify Response

The facilitator /verify API MUST respond with either success or error depending on the verification result.

**Successful Response:**

```json
{
  "isValid": true,
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**Error Response:**

```json
{
  "isValid": false,
  "invalidReason": "payment_not_found",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

### 4.2 POST /settle

For TXID, the `/settle` endpoint is optional. The on-chain transaction has already been executed by the client, so there is no settlement transaction for the facilitator to submit.

Resource servers MAY implement `/settle` for TXID as an internal operation (e.g., logging, tracking prepaid balances, or finalizing service delivery), but it is not required since `/verify` is sufficient.

---

## 5. TXID Properties

The TXID asset transfer method has the following defining properties:

- **Payer-executed on-chain transfer**
  The payer submits the on-chain transaction that moves funds.

- **Transaction-reference proof**
  The client proves payment by providing `txRef` and a payer signature proving that the resource requester controls the account that funded the transaction.

- **Facilitator verification (no facilitator-submitted transaction)**
  The facilitator verifies the payment proof and confirms the on-chain transaction, but does not submit a transaction. The resource server MAY self-host the facilitator.

- **Freshness via retention policy**
  Facilitators enforce transaction freshness through retention window policies and transaction timestamp checks, rather than cryptographically-bound quote windows.

- **Client Identity**
  The **payer** that actually funded the on-chain transfer referenced by `txRef` (i.e., the transaction sender or equivalent chain-specific payer/authority) also provides the payment proof signature. This essentially ties the identity of the client to the payer.

---

## 6. Replay and Idempotency Requirements

Because TXID relies on a transaction reference rather than a one-time on-chain authorization primitive, replay protection for **service delivery** is essential.

### 6.1 Responsibility

The **resource server** is ultimately responsible for ensuring correct payment verification before delivering service — it is the party providing the service and booking the revenue. The x402 specification integrates a facilitator service, but this delegation does not transfer responsibility. If the resource server uses a facilitator, it is responsible for choosing a trustworthy facilitator and ensuring the facilitator implements the required behavior correctly.

### 6.2 Replay Scope and Consequences

Replay of TXID payment proofs can only result in duplicate service delivery. Replay cannot cause additional fund transfers without payer consent — the on-chain transaction has already been executed and cannot be replayed on-chain.

### 6.3 Required Behavior

For the **exact** payment scheme (one payment = one service delivery), the verification implementation (whether self-hosted or via facilitator) MUST:

1. **De-duplicate by transaction reference**
   A given `(network, txRef)` tuple MUST be accepted at most once for successful service authorization. Facilitators MUST track consumed `(network, txRef)` values and MUST reject reuse. Facilitators MUST mark `(network, txRef)` as consumed before returning success.

2. **Enforce retention window**
   Define a retention window `T` (e.g., 1–24 hours) for storing consumed `(network, txRef)` values. The retention window MUST be at least as long as `maxTimeoutSeconds`. The facilitator MUST reject any `txRef` whose on-chain timestamp is older than `T` relative to verification time. Resource servers MAY extend retention beyond `maxTimeoutSeconds` based on their own service delivery or dispute policies.

**Note**: Other payment schemes (e.g., `deferred`, `prepaid`) may define different replay semantics where a single `txRef` can authorize multiple service deliveries by tracking and decrementing a balance. Such schemes are outside the scope of this specification.

---

## 7. Transport Security

TXID payment proofs MUST be transmitted over a secure, authenticated transport (e.g., HTTPS). Payment proofs MUST NOT be transmitted over cleartext or unauthenticated channels.

TXID's resistance to service theft relies on the payment proof remaining off-chain and private. Because TXID payment proofs are bearer-like at the application layer (a valid proof can be replayed unless the facilitator enforces idempotency), transport-layer security is essential.

---

## 8. Security Posture

### 8.1 Strengths

- **Broad asset and chain support**: does not require specialized token contract interfaces.
- **No facilitator gas requirement**: payer submits the transaction and pays network fees.
- **Private proof delivery** (transport-protected): the payment proof is not inherently published on-chain as structured authorization data.
- **No additional fund transfer risk**: replay of payment proofs cannot cause additional fund transfers — only duplicate service delivery.

### 8.2 Tradeoffs

- **Facilitator-side replay risk for service delivery**: facilitators must implement `txRef` de-duplication and time-window enforcement.
- **Indexing/lookup dependency**: verification requires reliable access to chain transaction data and transfer parsing.
- **Proof format complexity**: multi-format signature verification introduces algorithm and canonicalization risks that must be constrained by whitelists and strict encoding rules.

### 8.3 Responsibility and Risk

TXID security depends on correct facilitator implementation. Facilitators choose their own risk tolerance for reorgs, replay windows, and storage duration. Incorrect implementation can cause duplicate service delivery but cannot cause unauthorized fund transfers.

---

## 9. Use Cases (Informative)

TXID addresses several important use cases that are difficult or impossible with authorization-based asset transfer methods like EIP-3009 and Permit2.

### 9.1 Economically Truthful Payment Model

With EIP-3009, the facilitator submits the on-chain transaction and pays gas fees — even though the facilitator typically does not receive the payment revenue. This creates an economic mismatch where facilitators must subsidize gas costs or pass them on indirectly.

TXID eliminates this mismatch: the payer submits the transaction and pays gas directly. The facilitator only performs verification, which requires no on-chain transaction and no gas expenditure. This aligns costs with the party who benefits from the service.

### 9.2 Native Token Payments

TXID allows payers to use native tokens (ETH, SOL, etc.) to pay for both:
- the x402 service itself, and
- the gas/transaction fees required to execute the payment.

With EIP-3009 and Permit2, payments are limited to tokens that implement the respective interfaces. Native tokens cannot be used. TXID removes this limitation, enabling payments in any transferable asset.

### 9.3 Token Utility and Ecosystem Support

TXID enables any token to be used for x402 payments, bringing additional utility and demand to tokens that may not have EIP-3009 or Permit2 support. This is particularly valuable for:
- tokens that fund decentralized projects or DAOs,
- community tokens that want to enable real-world utility,
- newer tokens that haven't implemented authorization-based transfer interfaces.

For example, a project like OMA3 (the author of this specification) would be able to accept x402 payments in the native token of its OMAChain Ethereum rollup.

### 9.4 Simplified Multi-Chain Support

With authorization-based asset transfer methods, each blockchain/VM requires a specific signed-transfer standard (EIP-3009 for EVM, SPL Token extensions for Solana, etc.). Resource servers must implement and maintain verification logic for each standard.

TXID simplifies multi-chain support: the core verification logic (signature verification + on-chain transaction lookup) follows the same pattern across chains. Resource servers can more easily support a wide range of VMs without requiring each chain to implement a specific authorization-based transfer mechanism.

---

## 10. Design Rationale: Why Payer-Submitted Transactions

An alternative design was considered where the client would sign a transaction offline and send it to the facilitator, who would then broadcast it on-chain — similar to how EIP-3009 and Permit2 work. This was rejected primarily due to **nonce synchronization**.

On EVM and most account-based chains, every transaction from an account must include a sequential nonce. If the client signs a transaction with nonce N and sends it to the facilitator for broadcast, but the client also independently submits a different transaction using the same nonce N (because the client's wallet is unaware of the facilitator-held transaction), whichever transaction gets mined first consumes nonce N. The other transaction becomes permanently invalid.

This creates a fragile coupling between the client's general wallet activity and their x402 payment flow. The client would need to either:
- freeze all other wallet activity until the facilitator broadcasts, or
- coordinate nonce allocation with the facilitator in real time.

Neither is practical, especially for active wallets or automated agents making frequent transactions.

By having the client submit the transaction directly, TXID avoids this entirely. The client manages their own nonces through their own wallet, and the facilitator only needs to verify the result — not participate in transaction construction or submission.

### Self-Hosted Verification

In x402, the facilitator has always been an optional component. Resource servers can host the facilitator endpoints (`/verify`, `/settle`) themselves rather than delegating to a third party. TXID makes this even more natural.

With authorization-based asset transfer methods (EIP-3009, Permit2), a third-party facilitator provides real value: it pays for gas, submits on-chain transactions, and handles blockchain interaction complexity on behalf of the resource server. With TXID, the facilitator submits no transactions and pays no gas — it only performs verification by reading chain state and checking signatures. This is logic that any resource server can implement directly without specialized blockchain infrastructure.

Resource servers that self-host verification eliminate the trust dependency on a third party, reduce latency by removing a network hop, and retain full control over their replay protection and transaction acceptance policies.

---

## 11. Version History

| Version | Date       | Changes                                                                                 | Author     |
| ------- | ---------- | --------------------------------------------------------------------------------------- | ---------- |
| v0.1    | 2025-12-18 | Initial draft                                                                           | Alfred Tom |
| v0.2    | 2026-03-28 | Migrate to `extra.assetTransferMethod` and restructure to match scheme spec conventions | Alfred Tom |
