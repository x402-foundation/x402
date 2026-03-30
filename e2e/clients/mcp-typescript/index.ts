/**
 * MCP E2E Test Client with x402 Payment Support
 *
 * One-shot client that connects to an MCP server via SSE, calls a paid tool,
 * and outputs a structured JSON result for the e2e test framework to parse.
 *
 * Adapted from examples/typescript/clients/mcp/simple.ts for e2e.
 */

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme, type ExactEvmSchemeOptions } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";

interface E2EResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
}

const serverUrl = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string; // tool name, e.g. "get_weather"
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;

if (!serverUrl || !endpointPath || !evmPrivateKey) {
  const result: E2EResult = {
    success: false,
    error: "Missing required environment variables: RESOURCE_SERVER_URL, ENDPOINT_PATH, EVM_PRIVATE_KEY",
  };
  console.log(JSON.stringify(result));
  process.exit(1);
}

async function main(): Promise<void> {
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  const evmSchemeOptions: ExactEvmSchemeOptions | undefined = process.env.EVM_RPC_URL
    ? { rpcUrl: process.env.EVM_RPC_URL }
    : undefined;

  const x402Mcp = createx402MCPClient({
    name: "x402-mcp-e2e-client",
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(evmSigner, evmSchemeOptions) }],
    autoPayment: true,
    onPaymentRequested: async () => true, // Auto-approve all payments for e2e
  });

  try {
    // Connect to MCP server via SSE
    const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
    await x402Mcp.connect(transport);

    // Call the tool specified by ENDPOINT_PATH with test arguments
    const toolArgs = { city: "San Francisco" };
    const result = await x402Mcp.callTool(endpointPath, toolArgs);

    // Extract text content from the result
    let data: any = null;
    if (result.content && result.content.length > 0) {
      const firstContent = result.content[0];
      if (firstContent.type === "text" && typeof firstContent.text === "string") {
        try {
          data = JSON.parse(firstContent.text as string);
        } catch {
          data = { text: firstContent.text };
        }
      } else {
        data = firstContent;
      }
    }

    // Build e2e result
    const e2eResult: E2EResult = {
      success: true,
      data: data,
      status_code: 200,
      payment_response: result.paymentResponse
        ? {
            success: result.paymentResponse.success,
            transaction: result.paymentResponse.transaction,
            network: result.paymentResponse.network,
          }
        : undefined,
    };

    console.log(JSON.stringify(e2eResult));
    await x402Mcp.close();
    process.exit(0);
  } catch (error: any) {
    const e2eResult: E2EResult = {
      success: false,
      error: error.message || "MCP tool call failed",
      status_code: error.code || 500,
    };
    console.log(JSON.stringify(e2eResult));

    try {
      await x402Mcp.close();
    } catch {
      // Ignore close errors
    }

    process.exit(1);
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    success: false,
    error: error.message || "Fatal error",
  }));
  process.exit(1);
});
