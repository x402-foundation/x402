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
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { toClientEvmSigner } from "@x402/evm";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { createx402MCPClient } from "@x402/mcp";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

interface E2EResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
}

interface RequestResult {
  success: boolean;
  data: any;
  status_code: number;
  payment_response?: any;
}

const serverUrl = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string; // tool name, e.g. "get_weather"
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const evmNetwork = process.env.EVM_NETWORK || "eip155:84532";
const evmChain = evmNetwork === "eip155:8453" ? base : baseSepolia;
const channelSalt = process.env.CHANNEL_SALT as `0x${string}` | undefined;
const batchSettlementPhase = process.env.BATCH_SETTLEMENT_PHASE as
  | "initial"
  | "recovery-refund"
  | "full"
  | undefined;

if (!serverUrl || !endpointPath || !evmPrivateKey) {
  const result: E2EResult = {
    success: false,
    error: "Missing required environment variables: RESOURCE_SERVER_URL, ENDPOINT_PATH, EVM_PRIVATE_KEY",
  };
  console.log(JSON.stringify(result));
  process.exit(1);
}

async function main(): Promise<void> {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  const publicClient = createPublicClient({
    chain: evmChain,
    transport: http(process.env.EVM_RPC_URL),
  });
  const evmSigner = toClientEvmSigner(evmAccount, publicClient);
  const evmSchemeOptions: ExactEvmSchemeOptions | undefined = process.env.EVM_RPC_URL
    ? { rpcUrl: process.env.EVM_RPC_URL }
    : undefined;
  const voucherSignerKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY as
    | `0x${string}`
    | undefined;
  const voucherSigner = voucherSignerKey
    ? toClientEvmSigner(privateKeyToAccount(voucherSignerKey), publicClient)
    : undefined;
  const batchSettlementOptions =
    channelSalt || voucherSigner
      ? { ...(channelSalt ? { salt: channelSalt } : {}), ...(voucherSigner ? { voucherSigner } : {}) }
      : undefined;
  const batchSettlementScheme = new BatchSettlementEvmScheme(evmSigner, batchSettlementOptions);

  const x402Mcp = createx402MCPClient({
    name: "x402-mcp-e2e-client",
    version: "1.0.0",
    schemes: [
      { network: "eip155:*", client: new ExactEvmScheme(evmAccount, evmSchemeOptions) },
      { network: "eip155:*", client: batchSettlementScheme },
    ],
    autoPayment: true,
    onPaymentRequested: async () => true,
  });

  try {
    // Connect to MCP server via SSE
    const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
    await x402Mcp.connect(transport);

    // Call the tool specified by ENDPOINT_PATH with test arguments
    const toolArgs = { city: "San Francisco" };

    function parseToolData(result: Awaited<ReturnType<typeof x402Mcp.callTool>>): any {
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
      const result = await x402Mcp.callTool(endpointPath, toolArgs);
      return {
        success: result.paymentResponse?.success ?? !result.isError,
        data: parseToolData(result),
        status_code: result.isError ? 402 : 200,
        payment_response: result.paymentResponse,
      };
    }

    function aggregateBatchResult(
      phase: "initial" | "recovery-refund" | "full",
      results: RequestResult[],
      details: Record<string, RequestResult>,
    ): E2EResult {
      const last = results[results.length - 1]!;
      return {
        success: results.every(result => result.success),
        data: {
          batchSettlement: {
            phase,
            requests: results,
            ...details,
          },
        },
        status_code: last.status_code,
        payment_response: last.payment_response,
      };
    }

    async function mcpRefundFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      const paymentHeader = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
      if (!paymentHeader) {
        const paymentRequired = await x402Mcp.getToolPaymentRequirements(endpointPath, toolArgs);
        if (!paymentRequired) {
          return new Response("", { status: 200 });
        }
        return new Response("", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
        });
      }

      const paymentPayload = decodePaymentSignatureHeader(paymentHeader);
      const result = await x402Mcp.callToolWithPayment(endpointPath, toolArgs, paymentPayload);
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
    }

    if (!batchSettlementPhase) {
      const result = await issueRequest();
      console.log(JSON.stringify(result));
      await x402Mcp.close();
      process.exit(0);
    }

    if (batchSettlementPhase === "initial") {
      const deposit = await issueRequest();
      const voucher = await issueRequest();
      console.log(JSON.stringify(aggregateBatchResult("initial", [deposit, voucher], { deposit, voucher })));
      await x402Mcp.close();
      process.exit(0);
    }

    if (batchSettlementPhase === "recovery-refund") {
      const recoveryVoucher = await issueRequest();
      const refundSettle = await batchSettlementScheme.refund(`mcp://tool/${endpointPath}`, {
        fetch: mcpRefundFetch,
      });
      const refund = {
        success: refundSettle.success,
        data: { refund: true },
        status_code: 200,
        payment_response: refundSettle,
      };
      console.log(
        JSON.stringify(
          aggregateBatchResult("recovery-refund", [recoveryVoucher, refund], {
            recoveryVoucher,
            refund,
          }),
        ),
      );
      await x402Mcp.close();
      process.exit(0);
    }

    if (batchSettlementPhase === "full") {
      const deposit = await issueRequest();
      const voucher = await issueRequest();
      const refundSettle = await batchSettlementScheme.refund(`mcp://tool/${endpointPath}`, {
        fetch: mcpRefundFetch,
      });
      const refund = {
        success: refundSettle.success,
        data: { refund: true },
        status_code: 200,
        payment_response: refundSettle,
      };
      console.log(JSON.stringify(aggregateBatchResult("full", [deposit, voucher, refund], { deposit, voucher, refund })));
      await x402Mcp.close();
      process.exit(0);
    }

    throw new Error(`Unknown BATCH_SETTLEMENT_PHASE: ${batchSettlementPhase}`);
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
