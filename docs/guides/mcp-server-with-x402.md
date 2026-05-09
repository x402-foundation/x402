---
title: "MCP Server with x402"
description: "[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a protocol for passing context between LLMs and other AI agents. This page shows how to use the x402 payment protocol with MCP to make paid API requests through an MCP server, and how to connect it to Claude Desktop."
---

### What is this integration?

This guide walks you through running an MCP server that can access paid APIs using the x402 protocol. The MCP server acts as a bridge between Claude Desktop (or any MCP-compatible client) and a paid API (such as the sample weather API in the x402 repo). When Claude (or another agent) calls a tool, the MCP server will:

1. Detect if the API requires payment (via HTTP 402 with `PAYMENT-REQUIRED` header)
2. Automatically handle the payment using your wallet via the registered x402 scheme
3. Return the paid data to the client (e.g., Claude)

This lets you (or your agent) access paid APIs programmatically, with no manual payment steps.

***

### Prerequisites

* Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
* pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
* An x402-compatible server to connect to (for this demo, we'll use the [sample express server with weather data](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/express) from the x402 repo, or any external x402 API)
* An Ethereum wallet with USDC (on Base Sepolia or Base Mainnet) and/or a Solana wallet with USDC (on Devnet or Mainnet)
* [Claude Desktop with MCP support](https://claude.ai/download)

***

### Quick Start

#### 1. Install and Build

```bash
# Clone the x402 repository
git clone https://github.com/x402-foundation/x402.git
cd x402/examples/typescript

# Install dependencies and build packages
pnpm install && pnpm build

# Navigate to the MCP client example
cd clients/mcp
```

#### 2. Configure Claude Desktop

Add the MCP server to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "demo": {
      "command": "pnpm",
      "args": [
        "--silent",
        "-C",
        "<absolute path to this repo>/examples/typescript/clients/mcp",
        "dev"
      ],
      "env": {
        "EVM_PRIVATE_KEY": "<private key of a wallet with USDC on Base Sepolia>",
        "SVM_PRIVATE_KEY": "<base58-encoded private key of a Solana wallet with USDC on Devnet>",
        "RESOURCE_SERVER_URL": "http://localhost:4021",
        "ENDPOINT_PATH": "/weather"
      }
    }
  }
}
```

#### 3. Start the x402 Server

Make sure your x402-compatible server is running at the URL specified in `RESOURCE_SERVER_URL`:

```bash
# In another terminal, from the examples/typescript directory
cd servers/express
pnpm dev
```

#### 4. Restart Claude Desktop

Restart Claude Desktop to load the new MCP server, then ask Claude to use the `get-data-from-resource-server` tool.

***

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `EVM_PRIVATE_KEY` | Your EVM wallet's private key (0x prefixed) | One of EVM or SVM required |
| `SVM_PRIVATE_KEY` | Your Solana wallet's private key (base58 encoded) | One of EVM or SVM required |
| `RESOURCE_SERVER_URL` | The base URL of the paid API | Yes |
| `ENDPOINT_PATH` | The specific endpoint path (e.g., `/weather`) | Yes |

***

### Implementation

The MCP server uses `@x402/axios` to wrap axios with automatic payment handling:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { config } from "dotenv";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";

if (!evmPrivateKey && !svmPrivateKey) {
  throw new Error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be provided");
}

/**
 * Creates an axios client configured with x402 payment support for EVM and/or SVM.
 */
async function createClient() {
  const client = new x402Client();

  // Register EVM scheme if private key is provided
  if (evmPrivateKey) {
    const evmSigner = privateKeyToAccount(evmPrivateKey);
    client.register("eip155:*", new ExactEvmScheme(evmSigner));
  }

  // Register SVM scheme if private key is provided
  if (svmPrivateKey) {
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    client.register("solana:*", new ExactSvmScheme(svmSigner));
  }

  return wrapAxiosWithPayment(axios.create({ baseURL }), client);
}

async function main() {
  const api = await createClient();

  // Create an MCP server
  const server = new McpServer({
    name: "x402 MCP Client Demo",
    version: "2.0.0",
  });

  // Add a tool that calls the paid API
  server.tool(
    "get-data-from-resource-server",
    "Get data from the resource server (in this example, the weather)",
    {},
    async () => {
      const res = await api.get(endpointPath);
      return {
        content: [{ type: "text", text: JSON.stringify(res.data) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

***

### How It Works

The MCP server exposes a tool that, when called, fetches data from a paid API endpoint. If the endpoint requires payment, the x402 axios wrapper automatically handles the payment handshake:

1. **402 Response**: The server returns HTTP 402 with `PAYMENT-REQUIRED` header
2. **Parse Requirements**: The wrapper extracts payment requirements from the header
3. **Create Payment**: Uses the registered scheme (EVM or SVM) to create a payment payload
4. **Retry Request**: Sends the original request with the `PAYMENT-SIGNATURE` header
5. **Return Data**: Once payment is verified, the data is returned to Claude

***

### Multi-Network Support

The example supports both EVM (Base, Ethereum) and Solana networks. The x402 client automatically selects the appropriate scheme based on the payment requirements:

```typescript
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const client = new x402Client();

// Register EVM scheme for Base/Ethereum payments
client.register("eip155:*", new ExactEvmScheme(evmSigner));

// Register SVM scheme for Solana payments
client.register("solana:*", new ExactSvmScheme(svmSigner));

// Now handles both EVM and Solana networks automatically
const httpClient = wrapAxiosWithPayment(axios.create({ baseURL }), client);
```

When the server returns a 402 response, the client checks the `network` field in the payment requirements:
- `eip155:*` networks use the EVM scheme
- `solana:*` networks use the SVM scheme

***

### Response Handling

#### Payment Required (402)

When a payment is required, the client receives:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded JSON>
```

The wrapper automatically:
1. Parses the payment requirements
2. Creates and signs a payment using the appropriate scheme
3. Retries the request with the `PAYMENT-SIGNATURE` header

#### Successful Response

After payment is processed, the MCP server returns:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"report\":{\"weather\":\"sunny\",\"temperature\":70}}"
    }
  ]
}
```

***

### Architecture Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│   MCP Server    │────▶│  x402 API       │
│                 │     │  (x402 client)  │     │  (paid endpoint)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │  1. Call tool         │  2. GET /weather      │
        │                       │                       │
        │                       │  3. 402 + requirements│
        │                       │◀──────────────────────│
        │                       │                       │
        │                       │  4. Sign payment      │
        │                       │                       │
        │                       │  5. Retry with payment│
        │                       │──────────────────────▶│
        │                       │                       │
        │                       │  6. 200 + data        │
        │                       │◀──────────────────────│
        │                       │                       │
        │  7. Return response   │                       │
        │◀──────────────────────│                       │
```

***

### Dependencies

The example uses these x402 v2 packages:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.9.0",
    "@x402/axios": "workspace:*",
    "@x402/evm": "workspace:*",
    "@x402/svm": "workspace:*",
    "axios": "^1.13.2",
    "viem": "^2.39.0",
    "@solana/kit": "^2.1.1",
    "@scure/base": "^1.2.6"
  }
}
```

***

### How the Pieces Fit Together

* **x402-compatible server**: Hosts the paid API (e.g., weather data). Responds with HTTP 402 and `PAYMENT-REQUIRED` header if payment is required.
* **MCP server (this implementation)**: Acts as a bridge, handling payment via `@x402/axios` and exposing tools to MCP clients.
* **Claude Desktop**: Calls the MCP tool, receives the paid data, and displays it to the user.

***

***

### Making Your MCP Tools Discoverable via Bazaar

If you are building an MCP **server** (not just a client bridge), you can make your paid tools visible in the [x402 Bazaar](/extensions/bazaar) so AI agents and other buyers can discover them without prior knowledge of your server.

Pass `extensions` in the payment wrapper config with the Bazaar discovery metadata:

```typescript
import { createPaymentWrapper } from "@x402/mcp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const paid = createPaymentWrapper(resourceServer, {
  accepts,
  resource: {
    url: "mcp://tool/get_weather",
    description: "Get current weather for a city",
  },
  // Bazaar discovery metadata — facilitators will catalog this tool
  extensions: declareDiscoveryExtension({
    toolName: "get_weather",
    description: "Get current weather for a city",
    transport: "sse",
    inputSchema: {
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
    example: { city: "San Francisco" },
  }),
});
```

When a client pays for the tool, the facilitator extracts the Bazaar extension from the payment payload and indexes the tool in `/discovery/resources` with `type: "mcp"`. Buyers can then discover it by querying a Bazaar-enabled facilitator:

```typescript
const mcpTools = await client.extensions.bazaar.listResources({ type: "mcp" });
```

See the full [Bazaar documentation](/extensions/bazaar) for details on buyers querying and calling discovered MCP tools.

***

### Next Steps

* [See the full example in the repo](https://github.com/x402-foundation/x402/tree/main/examples/typescript/clients/mcp)
* Try integrating with your own x402-compatible APIs
* Extend the MCP server with more tools or custom logic as needed
* [Learn about building x402 servers](/getting-started/quickstart-for-sellers)
* [Explore the Bazaar discovery layer](/extensions/bazaar)
