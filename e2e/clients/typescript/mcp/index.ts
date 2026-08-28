/**
 * MCP E2E Test Client with x402 Payment Support
 *
 * Thin MCP transport over the same multi-network `x402Client` the HTTP clients
 * share: connects over SSE, calls the tool named by ENDPOINT_PATH with no
 * arguments, and outputs a structured JSON result for the e2e test framework
 * to parse.
 */
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createx402MCPClient } from "@x402/mcp";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { createE2EClient, runClientScenario, type RequestResult } from "../index.ts";

const serverUrl = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string; // tool name, e.g. "exact_evm_eip3009"
const toolResourceUrl = `mcp://tool/${endpointPath}`;

const { schemes, batchSettlementScheme, batchSettlementPhase } = await createE2EClient();

// createx402MCPClient builds its own MCP `Client`, matching the
// `@modelcontextprotocol/sdk` version @x402/mcp resolves internally (which
// can differ from the SDK version installed for this e2e package). Passing
// in a `Client` we construct ourselves would risk a structural type mismatch
// across that version boundary, so we hand it scheme registrations instead
// and let it build both clients itself.
const x402Mcp = createx402MCPClient({
  name: "x402-mcp-e2e-client",
  version: "1.0.0",
  schemes,
  spendControls: false,
  autoPayment: true,
  onPaymentRequested: async () => true,
});

/**
 * Parses the tool result's first content item into the response body the
 * e2e harness expects (mirrors what the equivalent HTTP route returns).
 */
function parseToolData(result: Awaited<ReturnType<typeof x402Mcp.callTool>>): unknown {
  const firstContent = result.content?.[0];
  if (!firstContent) {
    return null;
  }
  if (firstContent.type === "text" && typeof firstContent.text === "string") {
    try {
      return JSON.parse(firstContent.text);
    } catch {
      return { text: firstContent.text };
    }
  }
  return firstContent;
}

async function issueRequest(): Promise<RequestResult> {
  const result = await x402Mcp.callTool(endpointPath, {});
  return {
    success: result.paymentResponse?.success ?? !result.isError,
    data: parseToolData(result),
    status_code: result.isError ? 402 : 200,
    payment_response: result.paymentResponse,
  };
}

/**
 * Bridges `BatchSettlementEvmScheme.refund()`'s HTTP `fetch` dependency onto
 * MCP tool calls, so the same cooperative-refund code path used by the HTTP
 * clients works unmodified over the MCP transport.
 */
const mcpRefundFetch: typeof fetch = async (_input, init) => {
  const headers = new Headers(init?.headers);
  const paymentHeader = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
  if (!paymentHeader) {
    const paymentRequired = await x402Mcp.getToolPaymentRequirements(endpointPath, {});
    if (!paymentRequired) {
      return new Response("", { status: 200 });
    }
    return new Response("", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
    });
  }

  const paymentPayload = decodePaymentSignatureHeader(paymentHeader);
  const result = await x402Mcp.callToolWithPayment(endpointPath, {}, paymentPayload);
  if (result.paymentResponse) {
    return new Response(JSON.stringify(parseToolData(result)), {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(result.paymentResponse) },
    });
  }

  const firstContent = result.content?.[0];
  if (result.isError && firstContent?.type === "text" && typeof firstContent.text === "string") {
    const paymentRequired = JSON.parse(firstContent.text);
    return new Response("", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
    });
  }

  return new Response(JSON.stringify(parseToolData(result)), { status: result.isError ? 500 : 200 });
};

try {
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await x402Mcp.connect(transport);

  // runClientScenario prints the JSON result and calls process.exit() itself.
  await runClientScenario({
    url: toolResourceUrl,
    batchSettlementPhase,
    batchSettlementScheme,
    issueRequest,
    refund: () => batchSettlementScheme.refund(toolResourceUrl, { fetch: mcpRefundFetch }),
  });
} catch (error: unknown) {
  console.log(
    JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "MCP tool call failed",
      status_code: 500,
    }),
  );
  await x402Mcp.close().catch(() => {});
  process.exit(1);
}
