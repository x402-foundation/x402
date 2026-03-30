# @x402/extensions

x402 Payment Protocol Extensions. This package provides optional extensions that enhance the x402 payment protocol with additional functionality.

## Installation

```bash
pnpm install @x402/extensions
```

## Overview

Extensions are optional features that can be added to x402 payment flows. They follow a standardized `{ info, schema }` structure and are included in `PaymentRequired.extensions` and `PaymentPayload.extensions`.

This package includes:
- **Bazaar Discovery**: Automatic cataloging and indexing of x402-enabled resources
- **Sign-In-With-X (SIWx)**: CAIP-122 wallet authentication for accessing previously purchased resources

## Bazaar Discovery Extension

The Bazaar Discovery Extension enables facilitators to automatically catalog and index x402-enabled resources by following server-declared discovery instructions. This allows users to discover paid APIs and services through facilitator catalogs.

### How It Works

1. **Servers** declare discovery metadata when configuring their payment endpoints
2. The HTTP method is automatically inferred from the route definition (e.g., `"GET /weather"`)
3. **Facilitators** extract this metadata from payment requests
4. **Users** can browse and discover available paid resources through facilitator catalogs

### For Resource Servers

Declare endpoint discovery metadata in your payment middleware configuration. This helps facilitators understand how to call your endpoints and what they return.

> **Note:** The HTTP method is automatically inferred from the route key (e.g., `"GET /weather"` → GET method). You don't need to specify it in `declareDiscoveryExtension`.

#### Basic Example: GET Endpoint with Query Parameters

```typescript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const resources = {
  "GET /weather": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",
      payTo: "0xYourAddress"
    },
    extensions: {
      ...declareDiscoveryExtension({
        input: { city: "San Francisco" },
        inputSchema: {
          properties: {
            city: { type: "string" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] }
          },
          required: ["city"]
        },
        output: {
          example: {
            city: "San Francisco",
            weather: "foggy",
            temperature: 15,
            humidity: 85
          }
        },
      }),
    },
  },
};
```

#### Example: POST Endpoint with JSON Body

For POST, PUT, and PATCH endpoints, specify `bodyType` to indicate the request body format:

```typescript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const resources = {
  "POST /api/translate": {
    accepts: {
      scheme: "exact",
      price: "$0.01",
      network: "eip155:84532",
      payTo: "0xYourAddress"
    },
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          text: "Hello, world!",
          targetLanguage: "es"
        },
        inputSchema: {
          properties: {
            text: { type: "string" },
            targetLanguage: { type: "string", pattern: "^[a-z]{2}$" }
          },
          required: ["text", "targetLanguage"]
        },
        bodyType: "json",
        output: {
          example: {
            translatedText: "¡Hola, mundo!",
            sourceLanguage: "en",
            targetLanguage: "es"
          }
        },
      }),
    },
  },
};
```

#### Example: PUT Endpoint with Form Data

```typescript
const resources = {
  "PUT /api/user/profile": {
    accepts: {
      scheme: "exact",
      price: "$0.05",
      network: "eip155:84532",
      payTo: "0xYourAddress"
    },
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          name: "John Doe",
          email: "john@example.com",
          bio: "Software developer"
        },
        inputSchema: {
          properties: {
            name: { type: "string", minLength: 1 },
            email: { type: "string", format: "email" },
            bio: { type: "string", maxLength: 500 }
          },
          required: ["name", "email"]
        },
        bodyType: "form-data",
        output: {
          example: {
            success: true,
            userId: "123",
            updatedAt: "2024-01-01T00:00:00Z"
          }
        },
      }),
    },
  },
};
```

#### Example: DELETE Endpoint

```typescript
const resources = {
  "DELETE /api/data/:id": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",
      payTo: "0xYourAddress"
    },
    extensions: {
      ...declareDiscoveryExtension({
        input: { id: "123" },
        inputSchema: {
          properties: {
            id: { type: "string" }
          },
          required: ["id"]
        },
        output: {
          example: {
            success: true,
            deletedId: "123"
          }
        },
      }),
    },
  },
};
```

#### Example: MCP Tool

For MCP (Model Context Protocol) tools, use the `toolName` field instead of `bodyType`/`input`. The HTTP method is not relevant -- MCP tools are invoked by name.

```typescript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const resources = {
  "POST /mcp": {
    accepts: {
      scheme: "exact",
      price: "$0.01",
      network: "eip155:84532",
      payTo: "0xYourAddress"
    },
    extensions: {
      ...declareDiscoveryExtension({
        toolName: "financial_analysis",
        description: "Analyze financial data for a given ticker",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "Stock ticker symbol" },
            analysis_type: {
              type: "string",
              enum: ["fundamental", "technical", "sentiment"],
            },
          },
          required: ["ticker"],
        },
        example: { ticker: "AAPL", analysis_type: "fundamental" },
        output: {
          example: {
            pe_ratio: 28.5,
            recommendation: "hold",
            confidence: 0.85
          }
        },
      }),
    },
  },
};
```

You can optionally specify `transport` to indicate the MCP transport type (`"streamable-http"` or `"sse"`). When omitted, `streamable-http` is assumed per the MCP spec.

#### Using with Next.js Middleware

```typescript
import { paymentProxy, x402ResourceServer } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://facilitator.x402.org" });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

export const proxy = paymentProxy(
  {
    "/api/weather": {
      accepts: {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532",
        payTo: "0xYourAddress",
      },
      extensions: {
        ...declareDiscoveryExtension({
          input: { city: "San Francisco" },
          inputSchema: {
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          output: {
            example: { city: "San Francisco", weather: "foggy" }
          },
        }),
      },
    },
  },
  resourceServer,
);
```

### For Facilitators

Extract discovery information from incoming payment requests to catalog resources in the Bazaar.

#### Basic Usage

```typescript
import { extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

async function handlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements
) {
  // Extract discovery info from the payment
  const discovered = extractDiscoveryInfo(paymentPayload, paymentRequirements);

  if (discovered) {
    // discovered contains:
    // {
    //   resourceUrl: "https://api.example.com/weather",
    //   method: "GET",
    //   x402Version: 2,
    //   discoveryInfo: {
    //     input: { type: "http", method: "GET", queryParams: { city: "..." } },
    //     output: { type: "json", example: { ... } }
    //   }
    // }

    // Catalog the resource in your Bazaar
    await catalogResource({
      url: discovered.resourceUrl,
      method: discovered.method,
      inputSchema: discovered.discoveryInfo.input,
      outputExample: discovered.discoveryInfo.output?.example,
    });
  }
}
```

#### Validating Discovery Extensions

```typescript
import { validateDiscoveryExtension, extractDiscoveryInfo } from "@x402/extensions/bazaar";

function processPayment(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
  const discovered = extractDiscoveryInfo(paymentPayload, paymentRequirements);

  if (discovered && paymentPayload.extensions?.bazaar) {
    // Validate the extension schema
    const validation = validateDiscoveryExtension(paymentPayload.extensions.bazaar);

    if (!validation.valid) {
      console.warn("Invalid discovery extension:", validation.errors);
      // Handle invalid extension (log, reject, etc.)
      return;
    }

    // Extension is valid, proceed with cataloging
    catalogResource(discovered);
  }
}
```

#### Using with Server Extension Helper

The `bazaarResourceServerExtension` automatically enriches discovery extensions with HTTP method information from the request context:

```typescript
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { x402ResourceServer } from "@x402/core/server";

// The extension helper automatically extracts discovery info
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);
```

### Bazaar API Reference

#### `declareDiscoveryExtension(config)`

Creates a discovery extension object for resource servers. Accepts either an HTTP endpoint config or an MCP tool config.

**HTTP Parameters:**
- `config.input` (optional): Example input values (query params for GET/HEAD/DELETE, body for POST/PUT/PATCH)
- `config.inputSchema` (optional): JSON Schema for input validation
- `config.bodyType` (required for body methods): For POST/PUT/PATCH, specify `"json"`, `"form-data"`, or `"text"`. This is how TypeScript discriminates between query methods (GET/HEAD/DELETE) and body methods.
- `config.output` (optional): Output specification
  - `output.example`: Example output data
  - `output.schema`: JSON Schema for output validation

> **Note:** The HTTP method is NOT passed to this function. It is automatically inferred from the route key (e.g., `"GET /weather"`) or enriched by `bazaarResourceServerExtension` at runtime.

**MCP Parameters:**
- `config.toolName` (required): MCP tool name — the presence of this field identifies the config as MCP
- `config.description` (optional): Human-readable tool description
- `config.inputSchema` (required): JSON Schema for tool arguments
- `config.example` (optional): Example tool arguments
- `config.transport` (optional): MCP transport type (`"streamable-http"` or `"sse"`). Defaults to `streamable-http` per the MCP spec when omitted.
- `config.output` (optional): Output specification
  - `output.example`: Example output data
  - `output.schema`: JSON Schema for output validation

**Returns:** An object with a `bazaar` key containing the discovery extension.

**Examples:**
```typescript
// HTTP endpoint
const httpExtension = declareDiscoveryExtension({
  input: { query: "search term" },
  inputSchema: {
    properties: { query: { type: "string" } },
    required: ["query"]
  },
  output: {
    example: { results: [] }
  }
});

// MCP tool
const mcpExtension = declareDiscoveryExtension({
  toolName: "search",
  description: "Search for documents",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  },
  output: {
    example: { results: [] }
  }
});
// Both return: { bazaar: { info: {...}, schema: {...} } }
```

#### `extractDiscoveryInfo(paymentPayload, paymentRequirements, validate?)`

Extracts discovery information from a payment request (for facilitators).

**Parameters:**
- `paymentPayload`: The payment payload from the client
- `paymentRequirements`: The payment requirements from the server
- `validate` (optional): Whether to validate the extension (default: `true`)

**Returns:** `DiscoveredResource` object or `null` if not found.

```typescript
interface DiscoveredHTTPResource {
  resourceUrl: string;
  method: string;        // e.g. "GET", "POST"
  x402Version: number;
  discoveryInfo: DiscoveryInfo;
}

interface DiscoveredMCPResource {
  resourceUrl: string;
  toolName: string;      // MCP tool name
  x402Version: number;
  discoveryInfo: DiscoveryInfo;
}

type DiscoveredResource = DiscoveredHTTPResource | DiscoveredMCPResource;
```

#### `validateDiscoveryExtension(extension)`

Validates a discovery extension's info against its schema.

**Returns:** `{ valid: boolean, errors?: string[] }`

#### `validateAndExtract(extension)`

Validates and extracts discovery info in one step.

**Returns:** `{ valid: boolean, info?: DiscoveryInfo, errors?: string[] }`

#### `bazaarResourceServerExtension`

A server extension that automatically enriches HTTP discovery extensions with method information from the request context. MCP extensions are passed through unchanged.

**Usage:**
```typescript
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const resourceServer = new x402ResourceServer(facilitatorClient)
  .registerExtension(bazaarResourceServerExtension);
```

### `BAZAAR`

The extension identifier constant (`"bazaar"`).

## Sign-In-With-X Extension

The Sign-In-With-X extension implements [CAIP-122](https://chainagnostic.org/CAIPs/caip-122) for chain-agnostic wallet authentication. It allows clients to prove control of a wallet that previously paid for a resource, enabling access without repurchase.

### How It Works

1. Server returns 402 with `sign-in-with-x` extension containing challenge parameters
2. Client signs the CAIP-122 message with their wallet
3. Client sends signed proof in `SIGN-IN-WITH-X` header
4. Server verifies signature and grants access either because the route is auth-only or because the wallet has previously paid

### Server Usage

#### Recommended: Hooks (Automatic)

```typescript
import {
  declareSIWxExtension,
  siwxResourceServerExtension,
  createSIWxSettleHook,
  createSIWxRequestHook,
  InMemorySIWxStorage,
} from '@x402/extensions/sign-in-with-x';

// Storage for tracking paid addresses
const storage = new InMemorySIWxStorage();

// 1. Register extension for time-based field refreshment
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(siwxResourceServerExtension)  // Refreshes nonce/timestamps per request
  .onAfterSettle(createSIWxSettleHook({ storage }));  // Records payments

// 2. Declare SIWX support in routes
const routes = {
  "GET /data": {
    accepts: [{scheme: "exact", price: "$0.01", network: "eip155:8453", payTo}],
    extensions: declareSIWxExtension({
      statement: 'Sign in to access your purchased content',
    }),
  },
  "GET /profile": {
    accepts: [],
    extensions: declareSIWxExtension({
      network: ["eip155:8453", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      statement: 'Sign in to view your profile',
      expirationSeconds: 300,
    }),
  },
};

// 3. Verify incoming SIWX proofs
const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(createSIWxRequestHook({ storage }));  // Grants access when SIWX auth is sufficient

// Optional: Enable smart wallet support (EIP-1271/EIP-6492)
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({ chain: base, transport: http() });
const httpServerWithSmartWallets = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(createSIWxRequestHook({
    storage,
    verifyOptions: { evmVerifier: publicClient.verifyMessage },
  }));
```

The hooks automatically:
- **siwxResourceServerExtension**: Derives `network` from `accepts`, `domain`/`uri` from request URL, refreshes `nonce`/`issuedAt`/`expirationTime` per request
- **createSIWxSettleHook**: Records payment when settlement succeeds
- **createSIWxRequestHook**: Validates and verifies SIWX proofs, grants access for auth-only routes or when the wallet has paid

#### Manual Usage (Advanced)

```typescript
import {
  declareSIWxExtension,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
} from '@x402/extensions/sign-in-with-x';

// 1. Declare in PaymentRequired response
const extensions = declareSIWxExtension({
  domain: 'api.example.com',
  resourceUri: 'https://api.example.com/data',
  network: 'eip155:8453',
  statement: 'Sign in to access your purchased content',
});

// 2. Verify incoming proof
async function handleRequest(request: Request) {
  const header = request.headers.get('SIGN-IN-WITH-X');
  if (!header) return; // No auth provided

  // Parse the header
  const payload = parseSIWxHeader(header);

  // Validate message fields (expiry, nonce, domain, etc.)
  const validation = await validateSIWxMessage(
    payload,
    'https://api.example.com/data'
  );
  if (!validation.valid) {
    return { error: validation.error };
  }

  // Verify signature and recover address
  const verification = await verifySIWxSignature(payload);
  if (!verification.valid) {
    return { error: verification.error };
  }

  // verification.address is the verified wallet
  if (await isAuthOnlyRoute(request) || await checkPaymentHistory(verification.address)) {
    // Grant access
  }
}
```

### Client Usage

#### Recommended: Client Hook (Automatic)

```typescript
import { createSIWxClientHook } from '@x402/extensions/sign-in-with-x';
import { x402HTTPClient } from '@x402/fetch';

// Configure client with SIWX hook - automatically tries SIWX auth before payment
const httpClient = new x402HTTPClient(client)
  .onPaymentRequired(createSIWxClientHook(signer));

// Requests automatically use SIWX auth when server supports it
const response = await httpClient.fetch(url);
```

The client hook automatically:
- Detects SIWX support in 402 responses
- Matches your wallet's chain with server's `supportedChains`
- Signs and sends the authentication proof
- Falls back to payment if SIWX auth fails

#### Manual Usage (Advanced)

```typescript
import {
  createSIWxPayload,
  encodeSIWxHeader,
} from '@x402/extensions/sign-in-with-x';

// 1. Get extension and network from 402 response
const paymentRequired = await response.json();
const extension = paymentRequired.extensions['sign-in-with-x'];
const paymentNetwork = paymentRequired.accepts[0]?.network; // undefined for auth-only routes

// 2. Find matching chain in supportedChains
const matchingChain = paymentNetwork
  ? extension.supportedChains.find(chain => chain.chainId === paymentNetwork)
  : extension.supportedChains[0];

if (!matchingChain) {
  // No chain supported by this signer / route combination
  throw new Error('Chain not supported');
}

// 3. Build complete info with selected chain
const completeInfo = {
  ...extension.info,
  chainId: matchingChain.chainId,
  type: matchingChain.type,
};

// 4. Create signed payload
const payload = await createSIWxPayload(completeInfo, signer);

// 5. Encode and send
const header = encodeSIWxHeader(payload);
const response = await fetch(url, {
  headers: { 'SIGN-IN-WITH-X': header }
});
```

### SIWx API Reference

#### `declareSIWxExtension(options?)`

Creates the extension object for servers to include in PaymentRequired. Most fields are derived automatically from request context when using `siwxResourceServerExtension`.

```typescript
declareSIWxExtension({
  // All fields optional - derived from context if omitted
  domain?: string;                     // Server domain (derived from request URL)
  resourceUri?: string;                // Full resource URI (derived from request URL)
  network?: string | string[];         // CAIP-2 network(s) (derived from accepts[].network)
  statement?: string;                  // Human-readable purpose
  version?: string;                    // CAIP-122 version (default: "1")
  expirationSeconds?: number;          // Challenge TTL in seconds
})
```

**Automatic derivation:** When using `siwxResourceServerExtension`, omitted fields are derived:
- `network` → from `accepts[].network` in route config
- `resourceUri` → from request URL
- `domain` → parsed from resourceUri

For auth-only routes declared with `accepts: []`, `network` cannot be inferred from payment requirements and should be provided explicitly.

**Multi-chain support:** When `network` is an array (or multiple networks in `accepts`), `supportedChains` will contain one entry per network.

#### `parseSIWxHeader(header)`

Parses a base64-encoded SIGN-IN-WITH-X header into a payload object.

#### `validateSIWxMessage(payload, resourceUri, options?)`

Validates message fields (expiry, domain binding, nonce, etc.).

```typescript
validateSIWxMessage(payload, resourceUri, {
  maxAge?: number;                    // Max age for issuedAt (default: 5 min)
  checkNonce?: (nonce) => boolean;    // Custom nonce validation
})
// Returns: { valid: boolean; error?: string }
```

#### `verifySIWxSignature(payload, options?)`

Verifies the cryptographic signature and recovers the signer address.

```typescript
verifySIWxSignature(payload, {
  evmVerifier?: EVMMessageVerifier;  // For smart wallet support
})
// Returns: { valid: boolean; address?: string; error?: string }
```

**Smart Wallet Support (EIP-1271 / EIP-6492):**

By default, only EOA (Externally Owned Account) signatures are verified. To support smart contract wallets (like Coinbase Smart Wallet, Safe, etc.), pass `publicClient.verifyMessage` from viem:

```typescript
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({
  chain: base,
  transport: http()
});

// In your request hook
const result = await verifySIWxSignature(payload, {
  evmVerifier: publicClient.verifyMessage,
});
```

This enables:
- **EIP-1271**: Verification of deployed smart contract wallets
- **EIP-6492**: Verification of counterfactual (not-yet-deployed) wallets

Note: Smart wallet verification requires RPC calls, while EOA verification is purely local.

#### `createSIWxPayload(serverInfo, signer)`

Client helper that creates and signs a complete payload.

#### `encodeSIWxHeader(payload)`

Encodes a payload as base64 for the SIGN-IN-WITH-X header.

#### `SIGN_IN_WITH_X`

Extension identifier constant (`"sign-in-with-x"`).

### Supported Signature Schemes

| Scheme | Description |
|--------|-------------|
| `eip191` | personal_sign (default for EVM EOAs) |
| `eip1271` | Smart contract wallet verification |
| `eip6492` | Counterfactual smart wallet verification |
| `siws` | Sign-In-With-Solana |

## Troubleshooting

### Bazaar Extension Not Being Extracted

**Problem:** `extractDiscoveryInfo` returns `null`.

**Solutions:**
- Ensure the server has declared the extension using `declareDiscoveryExtension`
- Check that `paymentPayload.extensions.bazaar` exists
- Verify you're using x402 v2 (v1 uses a different format in `outputSchema`)

### Bazaar Schema Validation Fails

**Problem:** `validateDiscoveryExtension` returns `valid: false`.

**Solutions:**
- Ensure `inputSchema` matches the structure of `input`
- Check that required fields are marked in `inputSchema.required`
- Verify JSON Schema syntax is correct

### SIWx Signature Verification Fails

**Problem:** `verifySIWxSignature` returns `valid: false`.

**Solutions:**
- Ensure the message was signed with the correct wallet
- Check that the signature scheme matches the wallet type
- For smart wallets, enable `checkSmartWallet` option with a provider

### SIWx Message Validation Fails

**Problem:** `validateSIWxMessage` returns `valid: false`.

**Solutions:**
- Check that `issuedAt` is recent (within `maxAge`, default 5 minutes)
- Verify `expirationTime` hasn't passed
- Ensure `domain` matches the server's domain
- Confirm `uri` matches the resource URI

## Related Resources

- [x402 Core Package](../core/README.md) - Core x402 protocol implementation
- [CAIP-122 Specification](https://chainagnostic.org/CAIPs/caip-122) - Sign-In-With-X standard

## Version Support

This package supports both x402 v1 and v2:
- **v2**: Extensions are in `PaymentPayload.extensions` and `PaymentRequired.extensions`
- **v1**: Discovery info is in `PaymentRequirements.outputSchema` (automatically converted)

The `extractDiscoveryInfo` function automatically handles both versions.
