/**
 * OpenAI Chatbot with MCP Tool Integration
 *
 * This example demonstrates a REAL chatbot using:
 * - OpenAI GPT for LLM
 * - MCP client for tool discovery and execution
 * - x402 for payment handling
 *
 * This shows EXACTLY which MCP client methods are actually used in practice.
 *
 * Setup:
 * 1. Set OPENAI_API_KEY in .env
 * 2. Set EVM_PRIVATE_KEY in .env
 * 3. Start MCP server: cd ../servers/mcp && pnpm dev
 * 4. Run: pnpm dev:openai-chatbot
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import OpenAI from "openai";
import * as readline from "readline";

config();

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error("❌ OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

/**
 * Main chatbot implementation showing real MCP client usage
 */
export async function main(): Promise<void> {
  console.log("\n🤖 OpenAI Chatbot with MCP Tools + x402 Payment\n");
  console.log("━".repeat(60));

  // ========================================================================
  // STEP 1: Create OpenAI client (the LLM)
  // ========================================================================
  const openai = new OpenAI({ apiKey: openaiKey });
  console.log("✅ OpenAI client initialized");

  // ========================================================================
  // STEP 2: Create MCP client (connects to tool servers)
  // ========================================================================
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log(`💳 Using wallet: ${evmSigner.address}`);

  const mcpClient = createx402MCPClient({
    name: "openai-chatbot",
    version: "1.0.0",
    schemes: [
      { network: "eip155:84532", client: new ExactEvmScheme(evmSigner) },
      { network: "eip155:84532", client: new UptoEvmScheme(evmSigner) },
    ],
    autoPayment: true,
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment requested: ${price.amount} ${price.asset}`);
      console.log(`   Tool: ${context.toolName}`);
      console.log(`   Auto-approving payment...\n`);
      return true;
    },
  });

  // ========================================================================
  // MCP CLIENT TOUCHPOINT #1: connect()
  // ========================================================================
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await mcpClient.connect(transport);
  console.log(`✅ Connected to MCP server at ${serverUrl}`);

  // ========================================================================
  // MCP CLIENT TOUCHPOINT #2: listTools()
  // Discover tools from MCP server to present to LLM
  // ========================================================================
  console.log("\n📋 Discovering MCP tools...");
  const { tools } = await mcpClient.listTools();
  console.log(`Found ${tools.length} tools:`);
  for (const tool of tools) {
    console.log(`   - ${tool.name}: ${tool.description}`);
  }

  // Convert MCP tools to OpenAI tool format
  const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(tool => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));

  console.log(`\n✅ Converted ${openaiTools.length} MCP tools to OpenAI format`);
  console.log("━".repeat(60));

  // ========================================================================
  // STEP 3: Interactive chat loop
  // ========================================================================
  const conversationHistory: OpenAI.ChatCompletionMessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n🤖 Chatbot Ready! Try:");
  console.log("   - 'What's the weather in San Francisco?'");
  console.log("   - 'Can you ping the server?'");
  console.log("   - 'quit' to exit\n");

  const askQuestion = (): Promise<void> => {
    return new Promise(resolve => {
      rl.question("You: ", async input => {
        const userInput = input.trim();

        if (userInput.toLowerCase() === "quit") {
          await mcpClient.close();
          rl.close();
          console.log("\n👋 Goodbye!");
          process.exit(0);
          return;
        }

        if (!userInput) {
          resolve();
          return;
        }

        // Add user message to history
        conversationHistory.push({
          role: "user",
          content: userInput,
        });

        try {
          // ====================================================================
          // CALL OPENAI WITH MCP TOOLS
          // This is where the LLM decides whether to use tools
          // ====================================================================
          let response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: conversationHistory,
            tools: openaiTools,
            tool_choice: "auto", // Let LLM decide
          });

          let assistantMessage = response.choices[0].message;
          conversationHistory.push(assistantMessage);

          // ====================================================================
          // HANDLE TOOL CALLS (if LLM requested any)
          // ====================================================================
          while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            console.log(`\n🔧 LLM is calling ${assistantMessage.tool_calls.length} tool(s)...\n`);

            // Execute each tool call via MCP client
            const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];

            for (const toolCall of assistantMessage.tool_calls) {
              console.log(`   Executing: ${toolCall.function.name}`);
              console.log(`   Arguments: ${toolCall.function.arguments}`);

              try {
                const args = JSON.parse(toolCall.function.arguments);

                // ====================================================================
                // MCP CLIENT TOUCHPOINT #3: callTool()
                // This is THE critical method - executes tools with payment
                // ====================================================================
                const mcpResult = await mcpClient.callTool(toolCall.function.name, args);

                // Show payment info if payment was made
                if (mcpResult.paymentMade && mcpResult.paymentResponse) {
                  console.log(`   💳 Payment: ${mcpResult.paymentResponse.transaction}`);
                }

                console.log(`   ✅ Result: ${mcpResult.content[0]?.text?.substring(0, 100)}...\n`);

                // Send result back to OpenAI
                toolResults.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content:
                    mcpResult.content[0]?.text ||
                    JSON.stringify(mcpResult.content[0]) ||
                    "No content",
                });
              } catch (error) {
                console.log(`   ❌ Error: ${error}\n`);
                toolResults.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Error: ${error}`,
                });
              }
            }

            // Add tool results to conversation
            conversationHistory.push(...toolResults);

            // Get LLM's final response after tool execution
            response = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: conversationHistory,
              tools: openaiTools,
            });

            assistantMessage = response.choices[0].message;
            conversationHistory.push(assistantMessage);
          }

          // ====================================================================
          // DISPLAY FINAL RESPONSE
          // ====================================================================
          if (assistantMessage.content) {
            console.log(`Bot: ${assistantMessage.content}\n`);
          }
        } catch (error) {
          console.log(`Bot: Error - ${error}\n`);
        }

        resolve();
      });
    });
  };

  // Chat loop
  while (true) {
    await askQuestion();
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
