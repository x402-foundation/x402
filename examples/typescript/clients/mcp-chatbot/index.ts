/**
 * OpenAI Chatbot with MCP Tools + x402 Payments
 *
 * A complete chatbot implementation showing how to integrate:
 * - OpenAI GPT (the LLM)
 * - MCP Client (tool discovery and execution)
 * - x402 Payment Protocol (automatic payment for paid tools)
 *
 * This demonstrates the ACTUAL MCP client methods used in production chatbots.
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import OpenAI from "openai";
import * as readline from "readline";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

config();

// ============================================================================
// Configuration
// ============================================================================

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error("❌ OPENAI_API_KEY environment variable is required");
  console.error("   Get your API key from: https://platform.openai.com/api-keys");
  process.exit(1);
}

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  console.error("   Generate one with: cast wallet new");
  process.exit(1);
}

const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

// ============================================================================
// Chatbot Implementation
// ============================================================================

/**
 * Main chatbot loop - demonstrates real MCP client usage patterns
 */
export async function main(): Promise<void> {
  console.log("\n🤖 OpenAI + MCP Chatbot with x402 Payments");
  console.log("━".repeat(70));

  // ========================================================================
  // SETUP 1: Initialize OpenAI (the LLM)
  // ========================================================================
  const openai = new OpenAI({ apiKey: openaiKey });
  console.log("✅ OpenAI client initialized");

  // ========================================================================
  // SETUP 2: Initialize MCP client (connects to tool servers)
  // ========================================================================
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log(`💳 Wallet address: ${evmSigner.address}`);

  const mcpClient = createx402MCPClient({
    name: "openai-mcp-chatbot",
    version: "1.0.0",
    schemes: [
      { network: "eip155:84532", client: new ExactEvmScheme(evmSigner) },
      { network: "eip155:84532", client: new UptoEvmScheme(evmSigner) },
    ],
    autoPayment: true,
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment requested for tool: ${context.toolName}`);
      console.log(`   Amount: ${price.amount} (${price.asset})`);
      console.log(`   Network: ${price.network}`);
      console.log(`   ✅ Approving payment...\n`);
      return true; // Auto-approve
    },
  });

  // ========================================================================
  // MCP TOUCHPOINT #1: connect()
  // Establish connection to MCP server
  // ========================================================================
  console.log(`🔌 Connecting to MCP server: ${serverUrl}`);
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await mcpClient.connect(transport);
  console.log("✅ Connected to MCP server");

  // ========================================================================
  // MCP TOUCHPOINT #2: listTools()
  // Discover available tools from MCP server
  // ========================================================================
  console.log("\n📋 Discovering tools from MCP server...");
  const { tools: mcpTools } = await mcpClient.listTools();
  console.log(`Found ${mcpTools.length} tools:`);
  for (const tool of mcpTools) {
    const isPaid =
      tool.description?.toLowerCase().includes("payment") ||
      tool.description?.toLowerCase().includes("$");
    console.log(`   ${isPaid ? "💰" : "🆓"} ${tool.name}: ${tool.description}`);
  }

  // ========================================================================
  // HOST LOGIC: Convert MCP tools to OpenAI format
  // This is not an MCP client method - it's host application logic
  // ========================================================================
  const openaiTools: ChatCompletionTool[] = mcpTools.map(tool => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));

  console.log(`✅ Converted to OpenAI tool format`);
  console.log("━".repeat(70));

  // ========================================================================
  // Interactive Chat Loop
  // ========================================================================
  console.log("\n💬 Chat started! Try asking:");
  console.log("   - 'What's the weather in Tokyo?'");
  console.log("   - 'Can you ping the server?'");
  console.log("   - 'quit' to exit\n");

  const conversationHistory: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a helpful assistant with access to MCP tools. When users ask about weather, use the get_weather tool. Be concise and friendly.`,
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  /**
   * Process one chat turn
   *
   * @param userInput - The user's message to process
   */
  const processTurn = async (userInput: string): Promise<void> => {
    // Add user message to history
    conversationHistory.push({
      role: "user",
      content: userInput,
    });

    // ========================================================================
    // OPENAI CALL: Send conversation + tools to LLM
    // ========================================================================
    let response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: conversationHistory,
      tools: openaiTools,
      tool_choice: "auto", // Let LLM decide when to use tools
    });

    let assistantMessage = response.choices[0].message;

    // ========================================================================
    // TOOL EXECUTION LOOP
    // This is where MCP client is actually used!
    // ========================================================================
    let toolCallCount = 0;
    while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      toolCallCount++;
      console.log(
        `\n🔧 [Turn ${toolCallCount}] LLM is calling ${assistantMessage.tool_calls.length} tool(s)...`,
      );

      // Add assistant message with tool calls to history
      conversationHistory.push(assistantMessage);

      // Execute each tool call
      const toolResults: ChatCompletionMessageParam[] = [];

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        console.log(`\n   📞 Calling: ${toolName}`);
        console.log(`   📝 Args: ${JSON.stringify(toolArgs)}`);

        try {
          // ====================================================================
          // MCP TOUCHPOINT #3: callTool()
          // THIS IS THE MAIN TOUCHPOINT - Execute tool via MCP
          // Payment is handled automatically by x402MCPClient
          // ====================================================================
          const mcpResult = await mcpClient.callTool(toolName, toolArgs);

          // Show payment info if payment was made
          if (mcpResult.paymentMade && mcpResult.paymentResponse) {
            console.log(`   💳 Payment settled!`);
            console.log(`      Transaction: ${mcpResult.paymentResponse.transaction}`);
            console.log(`      Network: ${mcpResult.paymentResponse.network}`);
          }

          // Extract text content from MCP result
          const resultText =
            mcpResult.content[0]?.text ||
            JSON.stringify(mcpResult.content[0]) ||
            "No content returned";

          console.log(
            `   ✅ Result: ${resultText.substring(0, 200)}${resultText.length > 200 ? "..." : ""}`,
          );

          // Format for OpenAI
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultText,
          });
        } catch (error) {
          console.log(`   ❌ Error: ${error instanceof Error ? error.message : error}`);

          // Send error to OpenAI so it can handle it
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error executing tool: ${error instanceof Error ? error.message : error}`,
          });
        }
      }

      // Add tool results to conversation
      conversationHistory.push(...toolResults);

      // ========================================================================
      // Get LLM's response after seeing tool results
      // ========================================================================
      response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: conversationHistory,
        tools: openaiTools,
        tool_choice: "auto",
      });

      assistantMessage = response.choices[0].message;
    }

    // ========================================================================
    // Display final assistant response
    // ========================================================================
    if (assistantMessage.content) {
      conversationHistory.push(assistantMessage);
      console.log(`\n🤖 Bot: ${assistantMessage.content}\n`);
    }
  };

  /**
   * Main chat loop
   */
  const chatLoop = async (): Promise<void> => {
    return new Promise(resolve => {
      rl.question("You: ", async input => {
        const userInput = input.trim();

        if (userInput.toLowerCase() === "quit" || userInput.toLowerCase() === "exit") {
          console.log("\n👋 Closing connections...");

          // ====================================================================
          // MCP TOUCHPOINT #4: close()
          // Clean shutdown of MCP connection
          // ====================================================================
          await mcpClient.close();
          rl.close();
          console.log("✅ Goodbye!\n");
          process.exit(0);
          return;
        }

        if (!userInput) {
          resolve();
          return;
        }

        try {
          await processTurn(userInput);
        } catch (error) {
          console.log(`\n❌ Error: ${error instanceof Error ? error.message : error}\n`);
        }

        resolve();
      });
    });
  };

  // Start chat loop
  while (true) {
    await chatLoop();
  }
}

// ============================================================================
// Entry Point
// ============================================================================

main().catch(error => {
  console.error("\n💥 Fatal error:", error);
  process.exit(1);
});
