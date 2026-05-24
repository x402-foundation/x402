# Bazaar Discovery Extension

Part of [`@x402/extensions`](../README.md). Import from `@x402/extensions/bazaar`.

The Bazaar Discovery Extension enables facilitators to automatically catalog and index x402-enabled resources by following server-declared discovery instructions. This allows users to discover paid APIs and services through facilitator catalogs.

## How It Works

1. **Servers** declare discovery metadata when configuring their payment endpoints
2. The HTTP method is automatically inferred from the route definition (e.g., `"GET /weather"`)
3. **Facilitators** extract this metadata from payment requests
4. **Users** can browse and discover available paid resources through facilitator catalogs

## For Resource Servers

Declare endpoint discovery metadata in your payment middleware configuration. This helps facilitators understand how to call your endpoints and what they return.

> **Note:** The HTTP method is automatically inferred from the route key (e.g., `"GET /weather"` → GET method). You don't need to specify it in `declareDiscoveryExtension`.

### Basic Example: GET Endpoint with Query Parameters

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

### Example: POST Endpoint with JSON Body

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

### Example: PUT Endpoint with Form Data

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

### Example: DELETE Endpoint

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

### Example: MCP Tool

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

### Using with Next.js Middleware

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

## For Facilitators

Extract discovery information from incoming payment requests to catalog resources in the Bazaar.

### Basic Usage

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

### Validating Discovery Extensions

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

### Using with Server Extension Helper

The `bazaarResourceServerExtension` automatically enriches discovery extensions with HTTP method information from the request context:

```typescript
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { x402ResourceServer } from "@x402/core/server";

// The extension helper automatically extracts discovery info
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);
```

## Bazaar API Reference

### `declareDiscoveryExtension(config)`

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

### `extractDiscoveryInfo(paymentPayload, paymentRequirements, validate?)`

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

### `validateDiscoveryExtension(extension)`

Validates a discovery extension's info against its schema.

**Returns:** `{ valid: boolean, errors?: string[] }`

### `validateAndExtract(extension)`

Validates and extracts discovery info in one step.

**Returns:** `{ valid: boolean, info?: DiscoveryInfo, errors?: string[] }`

### `bazaarResourceServerExtension`

A server extension that automatically enriches HTTP discovery extensions with method information from the request context. MCP extensions are passed through unchanged.

**Usage:**
```typescript
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const resourceServer = new x402ResourceServer(facilitatorClient)
  .registerExtension(bazaarResourceServerExtension);
```

## `BAZAAR`

The extension identifier constant (`"bazaar"`).

## Troubleshooting

### Bazaar extension not being extracted

**Problem:** `extractDiscoveryInfo` returns `null`.

**Solutions:**

- Ensure the server has declared the extension using `declareDiscoveryExtension`
- Check that `paymentPayload.extensions.bazaar` exists
- Verify you're using x402 v2 (v1 uses a different format in `outputSchema`)

### Bazaar schema validation fails

**Problem:** `validateDiscoveryExtension` returns `valid: false`.

**Solutions:**

- Ensure `inputSchema` matches the structure of `input`
- Check that required fields are marked in `inputSchema.required`
- Verify JSON Schema syntax is correct

## Version support

This package supports both x402 v1 and v2:

- **v2**: Extensions are in `PaymentPayload.extensions` and `PaymentRequired.extensions`
- **v1**: Discovery info is in `PaymentRequirements.outputSchema` (automatically converted)

The `extractDiscoveryInfo` function automatically handles both versions.
