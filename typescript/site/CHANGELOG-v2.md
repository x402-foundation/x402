# Proposed V2 Changelog

## Goals:

1. Create clearer separation between the Spec, Facilitator, and SDK
2. Make it easier to add new networks, schemes, and generally extend the base x402 packages and spec for experimentation
3. Improve x402's conformity to common web standards and best practices
4. Codify learnings from experiments related to discovery
5. Give resource servers more tools to engage clients
6. Maintain backwards compatibility with v1 in the reference SDK, within a namespace

## x402 Spec

### Concept: Separation of Spec, Facilitator, and SDK

x402 v2 establishes clear boundaries between three distinct layers:

1. **The Specification** - Core protocol for payment signaling, consent, and settlement
2. **Facilitator** – (optional) verification and onchain/offchain settlement
3. **SDK** – Reference tools for client/server usage, with modular configuration

This will materialize across documentation, code, and complimentary materials.

### Version

Increment `x402Version` to `2`.

### PaymentRequired

1. Resource

**What**: `resource` to be added to the top level `PaymentRequired` object. This object will contain the `url`, `description`, and `mimeType` fields that were previously on `PaymentRequirements`. In addition, `website` will be included in `resource`.

**Why**: These fields describe the resource being gated, rather than the payment itself. The data was duplicated between each `PaymentRequirement` in the `PaymentRequired`'s `accepts`' array.

2. Extensions

**What**:  A new `extensions` property to be added to both `PaymentRequired` and `PaymentPayload`, enabling modular optional functionality beyond core payment mechanics. Extensions follow a standardized structure with `info` and `schema` properties, allowing servers to advertise capabilities and clients or facilitators to respond appropriately.

```git
+  "extensions": {
+    "discovery": {
+      "info": {},
+      "schema": {}
+    },
+    "sign-in-with-x": {
+      "info": {},
+      "schema": {}
+    },
+  } | undefined
```

**PaymentRequired with Extensions:**
```json
{
  "x402Version": "2",
  "error": "No PAYMENT-SIGNATURE header provided",
  "resource": {
    "url": "https://api.example.com/v1/ai/generate",
    "description": "Text to image generator using AI",
    "website": "https://api.example.com",
    "mimeType": "image/png"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "80000",
      "payTo": "0x9F86b5b01d584e2eF5AC2c7A60F3E5164d548881",
      "maxTimeoutSeconds": 60,
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }
  ],
  "extensions": {
    "discovery": {
      "info": {
        /* Discovery info per schema */
      },
      "schema": { /* JSON Schema */ }
    },
    "sign-in-with-x": {
      "info": {
        /* CAIP-122 / Sign-In-With-X info per schema */
      },
      "schema": { /* JSON Schema */ }
    }
  }
}
```

**Why**: The core x402 protocol focuses on payment signaling and settlement, but real-world applications need additional capabilities like service discovery, identity verification, authentication flows, and custom business logic. Extensions provide a standardized way to add these features without polluting the core payment protocol or requiring spec changes for each new capability.

### PaymentRequirements

1. Network

**What**: `network` to be moved from a custom identifier to the CAIP-2 format. (e.g. `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `cloudflare:com`, `ach:us`, `sepa:eu`).

```git
-  "network": "base" | "solana"
+  "network": "eip155:8453" | "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" | "cloudflare:com" | "ach:us" | "sepa:eu"
```

**Why**: Leveraging existing standards for blockchain networks will improves portability, and simplifies integrations with other networks. CAIP-2 format is flexible enough to support non-blockchain identifiers, therefor non-blockchain networks will be encouraged to follow the CAIP-2 format.

2. Asset

**What**: `asset`'s definition to be expanded beyond a token contract address to include [ISO 4217](https://www.iso.org/iso-4217-currency-codes.html) currency codes when referring to fiat.

```git
-  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
+  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" | "USD"
```

**Why**: Fiat is not expressed in token contract addresses. ISO 4217 is the international standard for expressing fiat.

**Validation rule**: ISO 4217 codes must appear only with custom networks, not CAIP-2 encoded networks.

3. PayTo

**What**: `payTo`'s definition to be expanded to include either an address or a constant (e.g. `merchant`).

```
-  "payTo": "0x209693Bc6afc0C5328bA36FaF04C514EF312287C" | "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4"
+  "payTo": "0x209693Bc6afc0C5328bA36FaF04C514EF312287C" | "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4" | "merchant"
```

**Why**: A facilitator who is faciliating a fiat transfer will not have an address for this transfer. Instead, the facilitator would resolve the `payTo` based on the `resource`, therefore `payTo` represents a role in association with the resource.

4. Remove Output Schema

**What**: `outputSchema` to be been removed from `PaymentRequirements`. An extension will be proposed which will bring back the structure.

```
-  "outputSchema": {
-   "input": <transport specific input> | undefined
-   "output": <transport specific output> | undefined
- } | undefined
```

**Why**: `outputSchema` is an transport concern rather than a payments concern.

5. Move MimeType, Resource & Description

**What**: `mimeType`, `resource` and `description` to be moved out of `PaymentRequirements` and into the top-level `PaymentRequired` response.

**Why**: `mimeType`, `resource` and `description` are not payment concerns, and thus are the same for every `PaymentRequirements` for a given resource.

7. Amount

**What**: `maxAmountRequired` to be renamed to `amount`, and let the scheme define what amount means.

```git
- "maxAmountRequired": "1000000"
+ "amount": "1000000
```

**Why**: `maxAmountRequired` is not a fitting name for every scheme. While it works for `exact` and for the future `upto` scheme, it is too prescriptive for many other schemes.

#### Updated PaymentRequirements

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `scheme` | `string` | Required | Payment scheme identifier (e.g., "exact") |
| `network` | `string` | Required | Network identifier in CAIP-2 format (e.g., "eip155:84532") or custom string |
| `amount` | `string` | Required | Required payment amount in atomic token units |
| `asset` | `string` | Required | Token contract address or ISO 4217 currency code |
| `payTo` | `string` | Required | Recipient wallet address for the payment or a constant (e.g. "merchant") |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion |
| `schema` | `object` | Optional | JSON schema describing the request & response formats |
| `extra` | `object` | Optional | Scheme-specific additional information |

### PaymentPayload

1. Accepted

**What**: The addition of a `accepted` property which stores the accepted `PaymentRequirement` from the list of acceptable payments.

**Why**: There is not sufficient overlap between the fields of a `PaymentPayload` to always correctly determine which `PaymentRequirement` it was made for

1. Scheme & Network

**What**: The `scheme` and `network` properties to be removed.

**Why**: The `scheme` and `network` properties are duplicated after the addition of `accepted`

3. Extensions

**What**: A new `extensions` property to be added to both `PaymentRequired` and `PaymentPayload`, enabling modular optional functionality beyond core payment mechanics. The `PaymentPayload` echo's the `extensions` from the `PaymentRequired`.

**PaymentPayload with Extensions:**
```json
{
  "x402Version": 2,
  "payload": { /* scheme-specific data */ },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "80000",
    "payTo": "0x9F86b5b01d584e2eF5AC2c7A60F3E5164d548881",
    "maxTimeoutSeconds": 60,
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  "extensions": {
    "discovery": {
      "info": { /* Discovery info per schema */ },
      "schema": { /* JSON Schema */ }
    },
    "sign-in-with-x": {
      "info": { /* CAIP-122 / Sign-In-With-X info per schema */ },
      "schema": { /* JSON Schema */ }
    }
  }
}
```

**Why**: The core x402 protocol focuses on payment signaling and settlement, but real-world applications need additional capabilities like service discovery, identity verification, authentication flows, and custom business logic. Extensions provide a standardized way to add these features without polluting the core payment protocol or requiring spec changes for each new capability.

**Validation Rule**: The `PaymentRequired`'s `extensions` must be a subset of the `PaymentPayload`'s `extensions`. The client must echo at least the info received. It may append additional info, however it cannot delete or overwrite existing info.

#### Updated PaymentPayload

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `x402Version` | `number` | Required | Protocol version identifier |
| `scheme` | `string` | Required | Payment scheme identifier (e.g., "exact") |
| `network` | `string` | Required | Network identifier in CAIP-2 format (e.g., "eip155:84532") or custom string |
| `payload` | `object` | Required | Payment data object |
| `accepted` | `PaymentRequirements` | Required | The payment required payload fulfills |
| `extensions` | `object` | Optional | The echoed extensions from PaymentRequired |



## Extensions

### Sign-In-With-X (SIWx)

**What**: A new extension implementing the CAIP-122 standard for chain-agnostic wallet-based identity assertions. This extension allows clients to prove control of a wallet that may have previously paid for a resource, enabling servers to grant access without requiring repurchase. The SIWx extension follows the standardized structure with `info` and `schema` properties.

**Why**: The CAIP-122 standard provides a chain-agnostic, interoperable way for blockchain accounts to authenticate with off-chain services. This aligns x402 with emerging identity standards used in WalletConnect v2, SIWS, and multi-chain wallets. It enables:
- Cross-chain authentication (EVM and non-EVM)
- Smart account verification via EIP-1271/6492
- Natural interoperability with W3C Verifiable Credentials
- Extensibility to non-blockchain networks via custom CAIP-2 namespaces

**Server PaymentRequired with SIWx Extension**:

Servers advertise SIWx support by including the extension in their PaymentRequired response:

```json
{
  "x402Version": "2",
  "error": "No authentication provided",
  "resource": {
    "url": "https://api.example.com/data/123",
    "description": "Premium market data"
  },
  "accepts": [...],
  "extensions": {
    "sign-in-with-x": {
      "info": {
        "domain": "api.example.com",
        "uri": "https://api.example.com",
        "statement": "Sign in to access your purchased content",
        "version": "1",
        "chainId": "eip155:8453",
        "nonce": "32891756",
        "issuedAt": "2025-10-17T10:00:00Z",
        "expirationTime": "2025-10-17T10:05:00Z",
        "resources": ["https://api.example.com"],
        "signatureScheme": "eip191" // or "eip1271", "eip6492", "siws"
      },
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
          "nonce": { "type": "string" },
          "issuedAt": { "type": "string", "format": "date-time" },
          "expirationTime": { "type": "string", "format": "date-time" },
          "notBefore": { "type": "string", "format": "date-time" },
          "requestId": { "type": "string" },
          "resources": { "type": "array", "items": { "type": "string", "format": "uri" } },
          "signature": { "type": "string" }
        },
        "required": ["domain", "address", "uri", "version", "chainId", "nonce", "issuedAt", "signature"]
      }
    }
  }
}
```

**Client Response with SIWx**:

Clients sign the CAIP-122 message and include it in their response:

```json
{
  "domain": "api.example.com",
  "address": "0x1234...abcd",
  "statement": "Sign this message to prove you control the wallet that purchased this resource",
  "uri": "https://api.example.com",
  "version": "1",
  "chainId": "eip155:8453",
  "nonce": "32891756",
  "issuedAt": "2025-10-17T10:00:00Z",
  "expirationTime": "2025-10-17T10:05:00Z",
  "resources": ["https://api.example.com"],
  "signature": "0x..."
}
```

**Validation Rules**:

- **Message Construction**: Servers MUST construct the CAIP-122 message following the canonical format specified in the standard
- **Signature Verification**: Chain-specific verification based on CAIP-2 namespace
- **Temporal Validation**:
  - `issuedAt` MUST be recent (recommended < 5 minutes old)
  - `expirationTime` MUST be in the future
  - `notBefore` (if present) MUST be in the past
- **Nonce**: MUST be unique per session to prevent replay attacks
- **Address Recovery**: The recovered address MUST match a previously verified payment for the resource
- **Domain Binding**: The `domain` field MUST match the server's domain
- **URI & Resources**: The `uri` and `resources` fields must refer to the base url of the resource

**Transport Considerations**:

- **HTTP**: 
  - Server includes SIWx extension in PAYMENT-REQUIRED header (base64-encoded)
  - Client sends signed SIWx message in SIGN-IN-WITH-X header (base64-encoded)
- **MCP**: 
  - Included in the extensions field of the payment required/payload structures
- **A2A**: 
  - Included in the extensions field of message payload structures


### Discovery

**What**: The discovery layer is being codified as an extension. Discovery enables Facilitators to automatically catalog and index x402-enabled resources by following the server's provided discovery instructions. When a server includes discovery information, Facilitators can proactively explore endpoints to maintain fresh payment requirements.

```json
{
  "extensions": {
    "discovery": {
      "info": {
        "input": {
          "type": "http",
          "method": "GET",
          /* Additional input fields as needed by the API */
        },
        "output": {
          /* Output specification for the API */
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "input": {
            "type": "object",
            "properties": {
              "type": { "type": "string" },
              "method": { "type": "string" }
            },
            "required": ["type", "method"],
            "additionalProperties": true
          },
          "output": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "required": ["input", "output"]
      }
    }
  }
}
```

**Why**: The discovery layer is not strictly a payments concern, but it's a valuable service for the x402 ecosystem.

**Discovery Flow**:

1. Server includes discovery extension in PaymentRequired response with instructions on how to explore its API.
2. Facilitator examines the discovery extension. Validates that it can safely explore the indicated endpoints.
3. Follows the `input` specification to construct valid requests.

4. When exploration triggers a 402 response, Facilitator logs the fresh PaymentRequired. It only logs if the response continues to include the discovery extension. Using this it updates its catalog with current pricing and requirements.

## Facilitator

### Supported Endpoint Update

The facilitator's `/supported` endpoint is being updated with three key improvements:

#### 1. Version-Grouped Kinds

**What**: The `kinds` array is being restructured to group supported payment kinds by `x402Version`, eliminating redundant version declarations.

```git
- "kinds": [
-   {
-     "x402Version": 2,
-     "scheme": "exact",
-     "network": "eip155:84532"
-   },
-   {
-     "x402Version": 2,
-     "scheme": "exact",
-     "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
-   }
- ]

+ "kinds": {
+   "1": [
+     {
+       "scheme": "exact",
+       "network": "base-sepolia"
+     }
+   ],
+   "2": [
+     {
+       "scheme": "exact",
+       "network": "eip155:84532"
+     },
+     {
+       "scheme": "exact",
+       "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
+       "extra": {
+         "feePayer": "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"
+       }
+     }
+   ]
+ }
```

**Why**: Facilitators supporting both v1 and v2 of the protocol were repeating the `x402Version` field for every payment kind. Grouping by version reduces payload size and improves readability, especially for facilitators supporting multiple versions with many network/scheme combinations.

#### 2. Public Signer Registry

**What**: A new `signers` field mapping network patterns to arrays of public addresses that the facilitator uses for settlement operations.

```git
+ "signers": {
+   "eip155:*": ["0x209693Bc6afc0C5329bA36FaF03C514EF312287C"],
+   "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
+ }
```

**Why**: Public declaration of facilitator signing addresses enables:
- **Transparency**: Resource servers and clients can verify who they're trusting
- **Tracking**: On-chain analysis tools can identify facilitator activity across networks

Network patterns follow CAIP-2 with wildcard support (e.g., `eip155:*` matches all EVM chains).

#### 3. Extensions Support Declaration

**What**: A new `extensions` field listing the extension keys that the facilitator has implemented.

```git
+ "extensions": ["discovery", "bazaar"]
```

**Why**: Not every facilitator will implement every extension. This explicit declaration enables resource servers to verify extension compatibility before use, preventing runtime failures when servers attempt to use unsupported extensions. Servers can query this endpoint to dynamically adapt their behavior based on facilitator capabilities.

**Note**: Not all extensions require facilitator involvement. Extensions that operate solely between resource servers and clients (such as Sign-In-With-X) can be used regardless of facilitator support. Facilitators only need to declare support for extensions where they play an active role in the extension's functionality (such as Discovery, where the facilitator performs the crawling).

#### Updated /supported Response Shape

```json
{
  "kinds": {
    "1": [
      {
        "scheme": "exact",
        "network": "base-sepolia"
      },
      {
        "scheme": "exact",
        "network": "solana-devnet",
        "extra": {
          "feePayer": "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"
        }
      }
    ],
    "2": [
      {
        "scheme": "exact",
        "network": "eip155:84532"
      },
      {
        "scheme": "exact",
        "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        "extra": {
          "feePayer": "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"
        }
      }
    ]
  },
  "extensions": ["discovery", "bazaar"],
  "signers": {
    "eip155:*": ["0x209693Bc6afc0C5329bA36FaF03C514EF312287C"],
    "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
  }
}
```

## HTTP Transport

### PAYMENT-SIGNATURE

**What**: `X-PAYMENT` header to be renamed to `PAYMENT-SIGNATURE`

**Why**: The `X-` prefix has been deprecated since RFC 6648. The IETF recommends against using the "X-" prefix for HTTP headers because:

1. It creates standardization challenges when experimental headers become widely adopted
2. Many "X-" headers become de facto standards but remain permanently marked as "experimental"
3. It leads to interoperability issues when transitioning from experimental to standard status

The new `PAYMENT-SIGNATURE` name is more descriptive and follows modern HTTP header naming conventions.

### PAYMENT-REQUIRED

**What**: The 402 status code response body to be moved to a `PAYMENT-REQUIRED` header and be base64 encoded.

**Why**: Headers separate protocol metadata from application content, allowing servers to return HTML paywalls for browsers or custom error messages while preserving payment requirements. This also improves middleware compatibility since many frameworks expect to control response bodies.

### PAYMENT-RESPONSE

**What**: The `X-PAYMENT-RESPONSE` header to be renamed to `PAYMENT-RESPONSE`

**Why**: Same as PAYMENT-SIGNATURE above. The `X-` prefix has been deprecated since RFC 6648 to avoid standardization and interoperability issues.

### SIGN-IN-WITH-X

**What**: A new optional `SIGN-IN-WITH-X` header containing a base64-encoded CAIP-122 compliant signed message proving wallet ownership, allowing access to previously purchased resources without re-payment. This header can be sent on the initial request to bypass the 402 response if the server recognizes the wallet has already paid.

**Why**: Provides a standardized, chain-agnostic authentication mechanism aligned with emerging identity standards (CAIP-122). Eliminates friction for returning users by providing lightweight proof of wallet control without requiring full payment re-submission or on-chain verification for every access.

## SDK Refactor

### Modularize Schemes & Networks

**What**: Replace hardcoded if/else chains with a `SchemeNetworkClient`, `SchemeNetworkServer` and `SchemeNetworkFacilitator` interfaces and builder pattern registration.

```typescript
interface SchemeNetworkClient {
  readonly scheme: string; // ex: "exact"

  createPaymentPayload(signer, requirements, version): Promise<string>;
  signPaymentPayload(string): Promise<string>;
}

interface SchemeNetworkServer {
  readonly scheme: string; // ex: "exact"

  parsePrice(price: Price, network: Network): Promise<AssetAmount>;
  enhancePaymentRequirements(paymentRequirements: PaymentRequirements, supportedKind: SupportedKind, facilitatorExtensions: string[]): Promise<PaymentRequirements>;
}

interface SchemeNetworkFacilitator {
  readonly scheme: string; // ex: "exact"

  verify(client, payload, requirements): Promise<VerifyResponse>;
  settle(signer, payload, requirements): Promise<SettleResponse>;
}

// Usage
const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmWallet))
  .register("solana:*", new ExactEvmScheme(svmWallet))
  .withIndentitySigner(svmWallet);

const server = new x402Server()
  .register("eip155:*", new ExactEvmScheme())
  .register("solana:*", new ExactEvmScheme()).

// Facilitator
const facilitator = new x402Facilitator()
  .register("eip155:*", new ExactEvmScheme(evmWallet))
  .register("solana:*", new ExactEvmScheme(svmWallet));
```

**Why**: Currently, contributors must navigate nested directories, modify core switching logic in `client/createPaymentHeader.ts` and `facilitator/facilitator.ts`, and understand internal coupling to add support for new blockchains or payment schemes. This refactor eliminates these barriers by providing a single interface to implement and explicit registration.

**Implementation Packaging**: The EVM and SVM implementations to be extracted into separate packages (`@x402/evm` and `@x402/svm`) to serve as reference implementations. For developer experience, they will be imported by default in the core `@x402/core` package, but their separation allows them to demonstrate the implementation pattern for future schemes and networks.

**Extensibility**: After this refactor, adding support for new networks, schemes, or implementations will not require a PR to the core repository. Developers can create their own packages implementing the `SchemeNetworkClient`, `SchemeNetworkServer` and `SchemeNetworkFacilitator` interfaces and use them immediately. We will continue to welcome PRs to add new implementations as official packages, but unofficial packages will be fully compatible with plug-and-play functionality.

### Client Configuration

The sdk will export a client type contructed via a builder pattern, that is leveraged for reference client packages such as `@x402/axios` and `@x402/fetch`

#### Composable Client Architecture

**What**: Clients to become composable containers for signers, scheme implementations, and policy lambdas, eliminating rigid wallet type requirements and enabling experimentation.

**Key Changes:**

(see builder pattern above for scheme / network changes)

**Lambda-Based Policy Engine**

```typescript
client
  .registerPolicy(paymentReq => paymentReq.amount <= 100_000)
  .registerPolicy(paymentReq => paymentReq.network !== "eip155:1") // no mainnet
  .registerPolicy((paymentReq, context) => context.timestamp > startTime);
```

**Why**: Current clients hardcode specific wallet types and schemes, creating friction for developers experimenting with new payment schemes or integrating different wallet libraries. This composable approach enables:

- Custom scheme implementations without SDK modifications
- Any wallet/signing library integration
- Runtime-configurable payment policies
- Immediate usability without build steps

### Middleware Configuration

#### Per-Route `payTo` Payment Configuration

**What**: The `payTo` parameter to move from a global middleware parameter into per-route configuration, allowing different payment addresses and networks for each endpoint.

**Before:**

```typescript
paymentMiddleware(
  "0x209693Bc6afc0C5329bA36FaF03C514EF312287C", // Single payTo for all routes
  routes,
);
```

**After:**

```typescript
paymentMiddleware({
  "/api/evm": {
    payTo: "0x209693Bc6afc0C5329bA36FaF03C514EF312287C",
    price: "$0.01",
    network: "eip155:84532",
  },
  "/api/solana": {
    payTo: "ABC123...",
    price: "$0.01",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  },
});
```

**Why**: Enables multi-chain applications and marketplace scenarios where different endpoints may have different payment recipients or operate on different networks.

#### Dynamic Payment Recipients

**What**: The `payTo` parameter to be a callback function that determines the payment recipient at runtime based on request context.

```typescript
{
  "POST /api/marketplace": {
    payTo: async (request) => {
      const productId = request.body.productId;
      const sellerAddress = await getSellerAddress(productId);
      return sellerAddress; // Returns address string
    },
    price: "$0.10",
    network: "eip155:84532
  }
}
```

**Why**: Enables marketplace models, revenue sharing, and context-dependent payment routing where the recipient cannot be determined at build time (e.g., user-generated content, dynamic seller selection, commission splits).

#### Multiple Payment Options Per Endpoint

**What**: Endpoints to accept an array of payment configurations, allowing clients to choose their preferred payment network and currency.

```typescript
{
  "/api/data": [
    {
      payTo: "0x209693Bc6afc0C5329bA36FaF03C514EF312287C",
      price: "$0.01",
      network: "eip155:8453"
    },
    {
      payTo: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg5",
      price: "0.05",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    },
  ]
}
```

**Why**: Provides payment flexibility for clients with different network preferences, reduces friction by supporting multiple currencies, and enables automatic failover if one network is congested or unavailable.

#### Dynamic Pricing

**What**: Price to be a callback function that determines pricing at runtime based on request context.

```typescript
{
  "/api/data": {
    price: async (request) => {
      const tier = request.query.tier;
      return tier === "premium" ? "$0.10" : "$0.01";
    },
    payTo: "0x209693Bc6afc0C5329bA36FaF03C514EF312287C",
    network: "base-sepolia"
  }
}
```

**Why**: Enables flexible pricing models including user-specific pricing, time-based rates, usage tiers, and request complexity-based pricing without requiring separate endpoints.

#### Network-Specific Convenience Wrappers

**What**: Introduction of network and asset specific middleware wrappers like `usdcOnBase()`, `usdcOnSolana()`, etc., that provide pre-configured setups for common payment stacks.

```typescript
// Before: Manual configuration
paymentMiddleware({
  "/api/*": {
    payTo: "0x309693Bc6afc0C5328bA36FaF03C514EF312287D",
    price: "$0.01",
    network: "eip155:8453",
  },
});

// After: Network-optimized wrapper
usdcOnBase(payTo, { "/api/*": "$0.01" });
```

**Why**: Reduces configuration complexity for faster development when following common patterns.

#### Hooks

**What**: A hooks system for middleware allowing custom logic injection at critical payment flow points. Six hooks cover the entire payment lifecycle, with `onSettlementFailure` being the most critical for handling irreversible side effects.

```typescript
paymentMiddleware(payTo, routes, facilitator, {
  beforeVerification: async ({ requirements, payload, request }) => {},
  afterVerification: async ({ requirements, payload, request }) => {},
  beforeSettlement: async ({ requirements, payload, request }) => {},
  afterSettlement: async ({ requirements, payload, request, response }) => {},
  onSettlementFailure: async ({ requirements, payload, request, response }) => {},
  onVerificationFailure: async ({ requirements, payload, request, response }) => {}
});
```

**Why**: Current middleware executes business logic after verification but before settlement. If settlement fails (facilitator outage, blockchain reorg, nonce reuse), irreversible side effects may persist without payment.

The hooks system enables:
- **Rollback mechanisms** for failed settlements
- **Pre-flight validation** (rate limiting, blacklisting)
- **Conditional settlement** based on risk assessment
- **Analytics and monitoring** at each stage
- **Custom error handling** for better UX

Without hooks, integrators must wrap response streams themselves, leading to fragmented compensation logic. The `onSettlementFailure` hook is especially critical as it provides the only opportunity to handle orphaned side effects when settlement fails after work completion.

### Facilitator Usage in Middlewares

#### Startup Validation

**What**: Middlewares to optionally validate facilitator compatibility at startup by calling `/supported` on each facilitator and building a scheme→network→facilitator mapping.

**Why**: Ensures configuration errors are caught immediately at startup rather than during runtime payment attempts, improving reliability and debugging.

**Note**: Validation can be skipped for serverless/lambda environments where startup time is critical.

#### Multiple Facilitator Support

**What**: Middlewares to accept an array of facilitator configurations or a single facilitator.

```typescript
const facilitators = [
  { url: "https://base.facilitator.com" },
  { url: "https://solana.facilitator.com" },
  { url: "https://polygon.facilitator.com" },
];
// or
const facilitators = "https://base.facilitator.com";
```

**Why**: Expands the supported payment schemes, networks, and assets that a single server can accept by combining multiple specialized facilitators. Also provides redundancy and enables gradual migration between providers.
