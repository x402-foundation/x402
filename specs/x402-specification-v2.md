# X402 Protocol Specification

**Protocol Version**: 2

**Document Scope**

This specification defines the core x402 protocol for internet-native payments. It covers:

- **Protocol fundamentals**: Payment requirements format, payment payload structure, and core message schemas
- **Facilitator interface**: Standard APIs for payment verification and settlement
- **Payment schemes**: Extensible payment methods (currently supporting the "exact" scheme)
- **Security considerations**: Replay attack prevention and trust minimization

**Out of Scope**: This specification does not include:

- Transport-specific implementations (covered in transport specifications)
- Specific implementation patterns (covered in application notes)
- Framework-specific integrations
- Client-side budget management
- Session handling mechanisms

**Architecture**

x402 is made up of three core components:

1. **Types**: Core data structures (e.g., `PaymentRequirements`, `PaymentPayload`, `SettlementResponse`) that are independent of both transport mechanism and payment scheme
2. **Logic**: Payment formation and verification logic that depends on the payment scheme (e.g., exact, deferred) and network (e.g., evm, solana, etc.)
3. **Representation**: How payment data is transmitted and signaled, which depends on the transport mechanism (e.g., HTTP, MCP, A2A)

**1. Overview**

x402 is an open payment standard that enables clients to pay for external resources. The protocol defines standardized message formats and payment flows that can be implemented over various transport layers, providing a standardized mechanism for payments across different payment schemes, networks and transport layers.

This specification is based on the x402 protocol implementation and documentation available in the [Coinbase x402 repository](https://github.com/coinbase/x402). It aims to provide a comprehensive and implementation-agnostic specification for the x402 protocol.

**2. Core Payment Flow**

The x402 protocol follows a standard request-response cycle with payment integration:

1. **Client Request**: Client makes a request to a resource server
2. **Payment Required Response**: If no valid payment is attached, the server responds with a payment required signal and payment requirements
3. **Payment Authorization Request**: Client submits a signed payment authorization in the subsequent request
4. **Settlement Response**: Server verifies the payment authorization and initiates blockchain settlement

**3. Protocol Components**

The x402 protocol involves three primary components:

- **Resource Server**: A service that requires payment for access to protected resources (APIs, content, data, etc.)
- **Client**: Any application or agent that requests access to protected resources
- **Facilitator**: A service that handles payment verification and blockchain settlement

**4. Response Types**

The x402 protocol defines standard response types with specific semantics:

- **Success**: Request successful, payment verified and settled
- **Payment Required**: Payment required to access the resource
- **Invalid Request**: Invalid payment payload or payment requirements
- **Server Error**: Server error during payment processing

Transport-specific implementations map these response types to appropriate transport mechanisms (e.g., HTTP status codes, JSON-RPC error codes, etc.).

**5. Types**

This section defines the core data structures used in the x402 protocol. These are completely independent of both transport mechanism and payment scheme. All transports and schemes use these exact data structures, differing only in how they represent them (transport layer) and what validation/settlement logic they apply (scheme layer).

**5.1 PaymentRequired Schema**

**5.1.1 JSON Payload**

When a resource server requires payment, it responds with a payment required signal and a JSON payload containing payment requirements. Example:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
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
  "extensions": {}
}
```

**5.1.2 Field Descriptions**

The `PaymentRequired` schema contains the following fields:

| Field Name    | Type     | Required | Description                                                            |
| ------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `x402Version` | `number` | Required | Protocol version identifier (must be 2)                                |
| `error`       | `string` | Optional | Human-readable error message explaining why payment is required        |
| `resource`    | `object` | Required | ResourceInfo object describing the protected resource                  |
| `accepts`     | `array`  | Required | Array of payment requirement objects defining acceptable payment methods |
| `extensions`  | `object` | Optional | Protocol extensions data                                               |

Each `PaymentRequirements` object in the `accepts` array contains:

| Field Name          | Type     | Required | Description                                                                   |
| ------------------- | -------- | -------- | ----------------------------------------------------------------------------- |
| `scheme`            | `string` | Required | Payment scheme identifier (e.g., "exact")                                     |
| `network`           | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., "eip155:84532")         |
| `amount`            | `string` | Required | Required payment amount in atomic token units                                 |
| `asset`             | `string` | Required | Token contract address or ISO 4217 currency code for fiat     |
| `payTo`             | `string` | Required | Recipient wallet address or role constant (e.g., "merchant")                  |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion                                   |
| `extra`             | `object` | Optional | Scheme-specific additional information                                        |

The `ResourceInfo` object contains:

| Field Name    | Type     | Required | Description                                |
| ------------- | -------- | -------- | ------------------------------------------ |
| `url`         | `string` | Required | URL of the protected resource              |
| `description` | `string` | Optional | Human-readable description of the resource |
| `mimeType`    | `string` | Optional | MIME type of the expected response         |

The `Extensions` object is a key-value map where each key is an extension identifier and each value follows a standardized structure:

| Field Name | Type     | Required | Description                                              |
| ---------- | -------- | -------- | -------------------------------------------------------- |
| `info`     | `object` | Required | Extension-specific data provided by the server           |
| `schema`   | `object` | Required | JSON Schema defining the expected structure of `info`    |

Extensions enable modular optional functionality beyond core payment mechanics. Servers advertise supported extensions in `PaymentRequired`, and clients echo them in `PaymentPayload`. The client must include at least the info received; it may append additional info but cannot delete or overwrite existing info.

**5.2 PaymentPayload Schema**

**5.2.1 JSON Structure**

The client includes payment authorization as JSON in the payment payload field:

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
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
    }
  },
  "extensions": {}
}
```

**5.2.2 Field Descriptions**

The `PaymentPayload` schema contains the following fields:

| Field Name    | Type     | Required | Description                                                         |
| ------------- | -------- | -------- | ------------------------------------------------------------------- |
| `x402Version` | `number` | Required | Protocol version identifier                                         |
| `resource`    | `object` | Optional | ResourceInfo object describing the resource being accessed          |
| `accepted`    | `object` | Required | PaymentRequirements object indicating the payment method chosen     |
| `payload`     | `object` | Required | Scheme-specific payment data                                        |
| `extensions`  | `object` | Optional | Protocol extensions data                                            |

The `accepted` field contains a `PaymentRequirements` object (see section 5.1.2).

The `payload` field contains scheme-specific data. For example, with exact EVM scheme, this includes:

| Field Name      | Type     | Required | Description                         |
| --------------- | -------- | -------- | ----------------------------------- |
| `signature`     | `string` | Required | EIP-712 signature for authorization |
| `authorization` | `object` | Required | EIP-3009 authorization parameters   |

The `Authorization` object contains the following fields:

| Field Name    | Type     | Required | Description                                     |
| ------------- | -------- | -------- | ----------------------------------------------- |
| `from`        | `string` | Required | Payer's wallet address                          |
| `to`          | `string` | Required | Recipient's wallet address                      |
| `value`       | `string` | Required | Payment amount in atomic units                  |
| `validAfter`  | `string` | Required | Unix timestamp when authorization becomes valid |
| `validBefore` | `string` | Required | Unix timestamp when authorization expires       |
| `nonce`       | `string` | Required | 32-byte random nonce to prevent replay attacks  |

**5.3 SettlementResponse Schema**

**5.3.1 JSON Structure**

After payment settlement, the server includes transaction details in the payment response field as JSON:

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:84532",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**5.3.2 Field Descriptions**

The `SettleResponse` schema contains the following fields:

| Field Name    | Type      | Required | Description                                                           |
| ------------- | --------- | -------- | --------------------------------------------------------------------- |
| `success`     | `boolean` | Required | Indicates whether the payment settlement was successful               |
| `errorReason` | `string`  | Optional | Error reason if settlement failed (omitted if successful)             |
| `payer`       | `string`  | Optional | Address of the payer's wallet                                         |
| `transaction` | `string`  | Required | Blockchain transaction hash (empty string if settlement failed)       |
| `network`     | `string`  | Required | Blockchain network identifier in CAIP-2 format                        |
| `amount`      | `string`  | Optional | The actual amount settled in atomic units (omitted if not applicable) |
| `extensions`  | `object`  | Optional | Protocol extensions data                                              |

**5.4 VerifyResponse Schema**


**5.4.2 Field Descriptions**

The `VerifyResponse` schema contains the following fields:

| Field Name      | Type      | Required | Description                                             |
| --------------- | --------- | -------- | ------------------------------------------------------- |
| `isValid`       | `boolean` | Required | Indicates whether the payment authorization is valid    |
| `invalidReason` | `string`  | Optional | Reason for invalidity (omitted if valid)                |
| `payer`         | `string`  | Optional | Address of the payer's wallet                           |

**6. Payment Schemes (The Logic)**

This section describes the payment schemes supported by the x402 protocol. Payment schemes define how payments are formed, validated, and settled on specific payment networks. Schemes are independent of the underlying transport mechanism.

Each scheme defines:

- How to construct the `payload` field within `PaymentPayload`
- Settlement and validation procedures
- Scheme-specific requirements in the `extra` field of `PaymentRequirements`

**6.1 Exact Scheme (EVM overview)**

The "exact" scheme uses EIP-3009 (Transfer with Authorization) to enable secure, gasless transfers of specific amounts of ERC-20 tokens.

**6.1.1 EIP-3009 Authorization**

The authorization follows the EIP-3009 standard for `transferWithAuthorization`:

```javascript
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
```

**6.1.2 Verification Steps**

The facilitator performs the following verification steps:

1. **Signature Validation**: Verify the EIP-712 signature is valid and properly signed by the payer
2. **Balance Verification**: Confirm the payer has sufficient token balance for the transfer
3. **Amount Validation**: Ensure the payment amount exactly matches the required amount
4. **Time Window Check**: Verify the authorization is within its valid time range
5. **Parameter Matching**: Confirm authorization parameters match the original payment requirements
6. **Transaction Simulation**: Simulate the `transferWithAuthorization` transaction to ensure it would succeed

**6.1.3 Settlement**

Settlement is performed by calling the `transferWithAuthorization` function on the ERC-20 contract with the signature and authorization parameters provided in the payment payload.

**6.2 Exact Scheme (SVM overview)**

For Solana (SVM), the `exact` scheme is implemented using `TransferChecked` for SPL tokens. Critical verification requirements include:

- Enforcing a strict instruction layout (Compute Unit Limit, Compute Unit Price, TransferChecked)
- Ensuring the facilitator fee payer does not appear in any instruction accounts and is not the transfer `authority` or `source`
- Bounding compute unit price to mitigate gas abuse
- Verifying the destination ATA matches the `payTo`/`asset` PDA and account existence rules
- Requiring the transfer `amount` to exactly equal the `amount` specified in PaymentRequirements

Full SVM details are specified in `specs/schemes/exact/scheme_exact_svm.md`.

**7. Facilitator Interface**

The facilitator provides HTTP REST APIs for payment verification and settlement. This allows resource servers to delegate blockchain operations to trusted third parties or host the endpoints themselves. Note that while the core x402 protocol is transport-agnostic, facilitator APIs are currently standardized as HTTP endpoints.

**7.1 POST /verify**

Verifies a payment authorization without executing the transaction on the blockchain.

**Request (Exact Scheme):**

```json
{
  "x402Version": 2,
  "paymentPayload": {
    /* PaymentPayload schema */
  },
  "paymentRequirements": {
    /* PaymentRequirements schema */
  }
}
```

Example with actual data:

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json"
    },
    "accepted": {
    "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    "payload": {
      "signature": "0x...",
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "10000",
        "validAfter": "1740672089",
        "validBefore": "1740672154",
        "nonce": "0x..."
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  }
}
```

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
  "invalidReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**7.2 POST /settle**

Executes a verified payment by broadcasting the transaction to the blockchain.

**Request:** Same structure as `/verify` endpoint (contains `paymentPayload` and `paymentRequirements`).

> **Note**: While the request structure is identical, some payment schemes may assign different semantics to fields at settlement time versus verification time. For example, in the `upto` scheme, the `amount` field in `paymentRequirements` represents the maximum authorized amount at verification time, but the actual amount to settle at settlement time. See individual scheme specifications for details.

**Successful Response:**

```json
{
  "success": true,
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:84532"
}
```

**Error Response:**

```json
{
  "success": false,
  "errorReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "",
  "network": "eip155:84532"
}
```

**7.3 GET /supported**

Returns the list of payment schemes, networks, and extensions supported by the facilitator.

**Response:**

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:8453"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:43113"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:43114"
    }
  ],
  "extensions": [],
  "signers": {
    "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"],
    "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
  }
}
```

**7.3.1 SupportedResponse Fields**

| Field Name   | Type     | Required | Description                                                              |
| ------------ | -------- | -------- | ------------------------------------------------------------------------ |
| `kinds`      | `array`  | Required | Array of supported payment kind objects                                       |
| `extensions` | `array`  | Required | Array of extension identifiers the facilitator has implemented                |
| `signers`    | `object` | Required | Map of CAIP-2 patterns (e.g., `eip155:*`) to public signer addresses          |

Each `SupportedKind` object in the `kinds` array contains:

| Field Name    | Type     | Required | Description                                                |
| ------------- | -------- | -------- | ---------------------------------------------------------- |
| `x402Version` | `number` | Required | Protocol version supported (2 for v2)                      |
| `scheme`      | `string` | Required | Payment scheme identifier (e.g., "exact")                  |
| `network`     | `string` | Required | Blockchain network identifier in CAIP-2 format             |
| `extra`       | `object` | Optional | Additional scheme-specific configuration                   |

**8. Discovery API**

The x402 protocol includes a discovery mechanism that allows clients to find and explore available x402-enabled resources. This enables the creation of marketplaces (known as "Bazaars") where users can discover and access monetized APIs and digital services.

Discovery is currently implemented as HTTP REST APIs, though the discovered resources may use any x402-supported transport.

8.1 GET /discovery/resources

List discoverable x402 resources from the Bazaar.

**Request Parameters:**

| Parameter | Type     | Required | Description                                 | Default |
| --------- | -------- | -------- | ------------------------------------------- | ------- |
| `type`    | `string` | Optional | Filter by resource type (e.g., "http")      | -       |
| `limit`   | `number` | Optional | Maximum number of results to return (1-100) | 20      |
| `offset`  | `number` | Optional | Number of results to skip for pagination    | 0       |

**Response:**

```json
{
  "x402Version": 2,
  "items": [
    {
      "resource": "https://api.example.com/premium-data",
      "type": "http",
      "x402Version": 1,
      "accepts": [
        {
          "scheme": "exact",
          "network": "eip155:84532",
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
      "lastUpdated": 1703123456,
      "metadata": {
        "category": "finance",
        "provider": "Example Corp"
      }
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 1
  }
}
```

**8.2 Discovered Resource Fields**

| Field Name    | Type     | Required | Description                                                     |
| ------------- | -------- | -------- | --------------------------------------------------------------- |
| `resource`    | `string` | Required | The resource URL or identifier being monetized                  |
| `type`        | `string` | Required | Resource type (currently "http" for HTTP endpoints)             |
| `x402Version` | `number` | Required | Protocol version supported by the resource                      |
| `accepts`     | `array`  | Required | Array of PaymentRequirements objects specifying payment methods |
| `lastUpdated` | `number` | Required | Unix timestamp of when the resource was last updated            |
| `metadata`    | `object` | Optional | Additional metadata (category, provider, etc.)                  |

**8.3 Bazaar Concept**

The Bazaar is a marketplace ecosystem where x402-enabled resources can be discovered and accessed. Key features:

- **Resource Discovery**: Find APIs and services by category, provider, or payment requirements
- **Payment Transparency**: View pricing and payment methods upfront
- **Provider Information**: Learn about service providers and their offerings
- **Dynamic Updates**: Resources can be added, updated, or removed dynamically

**8.4 Example Usage**

```bash
# Discover financial data APIs
GET /discovery/resources?type=http&limit=10

# Search for specific provider
GET /discovery/resources?metadata[provider]=Coinbase
```

**9. Error Handling**

The x402 protocol defines standard error codes that may be returned by facilitators or resource servers. These error codes help clients understand why a payment failed and take appropriate action.

- **`insufficient_funds`**: Client does not have enough tokens to complete the payment
- **`invalid_exact_evm_payload_authorization_valid_after`**: Payment authorization is not yet valid (before validAfter timestamp)
- **`invalid_exact_evm_payload_authorization_valid_before`**: Payment authorization has expired (after validBefore timestamp)
- **`invalid_exact_evm_payload_authorization_value_mismatch`**: Payment amount does not exactly match the required amount
- **`invalid_exact_evm_payload_signature`**: Payment authorization signature is invalid or improperly signed
- **`invalid_exact_evm_payload_recipient_mismatch`**: Recipient address does not match payment requirements
- **`invalid_network`**: Specified blockchain network is not supported
- **`invalid_payload`**: Payment payload is malformed or contains invalid data
- **`invalid_payment_requirements`**: Payment requirements object is invalid or malformed
- **`invalid_scheme`**: Specified payment scheme is not supported
- **`unsupported_scheme`**: Payment scheme is not supported by the facilitator
- **`invalid_x402_version`**: Protocol version is not supported
- **`invalid_transaction_state`**: Blockchain transaction failed or was rejected
- **`unexpected_verify_error`**: Unexpected error occurred during payment verification
- **`unexpected_settle_error`**: Unexpected error occurred during payment settlement

**10. Security Considerations**

**10.1 Replay Attack Prevention**

The x402 protocol implements multiple layers of protection against replay attacks:

- **EIP-3009 Nonce**: Each authorization includes a unique 32-byte nonce to prevent replay attacks
- **Blockchain Protection**: EIP-3009 contracts inherently prevent nonce reuse at the smart contract level
- **Time Constraints**: Authorizations have explicit valid time windows to limit their lifetime
- **Signature Verification**: All authorizations are cryptographically signed by the payer

**10.2 Authentication Integration**

The protocol supports integration with authentication systems (e.g., Sign-In with Ethereum - SIWE) to enable authenticated pricing models where verified users receive discounted rates or special access terms.

**11. Implementation Notes**

**11.1 Network Identifiers**

Networks in x402 v2 use CAIP-2 (Chain Agnostic Improvement Proposal) format: `namespace:reference`.

**Format:** `{namespace}:{reference}` (e.g., `eip155:8453` for Base mainnet)

Non-blockchain networks are encouraged to follow the CAIP-2 format (e.g., `ach:us`, `sepa:eu`).

Both EVM and Solana networks are supported by the reference implementations, e.g.:

- **`eip155:84532`**: Base Sepolia testnet
- **`eip155:8453`**: Base mainnet
- **`eip155:43113`**: Avalanche Fuji testnet
- **`eip155:43114`**: Avalanche mainnet
- **`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`**: Solana mainnet
- **`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`**: Solana devnet

**11.2 Supported Assets**

Token support varies by network:

**EVM Networks:**
- ERC-20 tokens implementing EIP-3009 (Transfer with Authorization)
- Example: USDC

**Solana:**
- Any SPL token
- Token2022 program tokens

Token availability depends on facilitator service capabilities and network-specific deployments.

**12. Use Cases and Applications**

The x402 protocol enables diverse monetization scenarios across the internet. While the core protocol is HTTP-native and chain-agnostic, specific implementations can vary based on use case requirements.

### 12.1 AI Agent Integration

AI agents can use x402 to autonomously pay for resources and services. The protocol supports:

- **Automatic payment handling** for resource access
- **Resource discovery** through facilitator services
- **Budget management** and spending controls (implementation-specific)
- **Correlation tracking** for operation grouping (implementation-specific)
- **Multi-transport support** allowing agents to work across HTTP APIs, MCP tools, and other protocol layers

### 12.2 Human User Applications

Applications can implement x402 for:

- **Session-based access** (time-limited subscriptions)
- **Pay-per-use content** (articles, videos, downloads, tools)
- **Resource monetization** with per-call pricing
- **Authentication-based pricing** (discounted rates for verified users)
- **Cross-protocol payments** supporting web, desktop, and AI applications

### 12.3 Transport Support

x402 integrates across multiple transport layers:

- **HTTP**: Web APIs, REST services, server frameworks (Express.js, FastAPI, Next.js, etc.)
- **MCP (Model Context Protocol)**: AI agent tools and resources
- **A2A (Agent-to-Agent Protocol)**: Direct agent-to-agent payments
- **Custom Protocols**: Any request-response based system can implement x402 payment flows

### 12.4 Server Frameworks

x402 integrates with popular frameworks:

- **Express.js**: `require_payment()` middleware
- **FastAPI/Flask**: Framework-specific middleware
- **Hono**: Edge runtime support
- **Next.js**: Fullstack integration
- **ai/agents**: AI agent and MCP frameworks

### 12.5 Client Libraries

Clients across different transports can be enhanced with x402 payment capabilities:

- **HTTP clients**: axios/fetch (browser), httpx/requests (Python), curl (CLI)
- **MCP clients**: ai/agents MCP Clients
- **A2A**: x402_a2a (python)
- **Custom integrations**: Application-specific payment handling

### 12.6 Advanced Patterns

The protocol enables sophisticated monetization strategies:

- **Dynamic pricing** based on user authentication or usage patterns
- **Session management** for time-based access control
- **Batch payments** for multiple resource access
- **Subscription models** built on micropayments

_Note: Implementation details for specific patterns (such as budget management, correlation tracking, or session handling) are available in application notes and implementation guides. Transport-specific implementation details are covered in the transport specification documents._

---

## Version History

| Version | Date        | Changes                                                           | Author                    |
| ------- | ----------- | ----------------------------------------------------------------- | ------------------------- |
| v2.0    | 2025-12-9   | Protocol v2: CAIP-2 networks, restructured PaymentPayload/Required, ResourceInfo separation, extensions support | x402 team |
| v0.2    | 2025-10-3   | Transport-agnostic redesign                                       | Ethan Niser               |
| v0.1    | 2025-8-29   | Initial draft                                                     | [derived from repository] |
