"""OpenAI Chatbot with MCP Tools + x402 Payments.

A complete chatbot implementation showing how to integrate:
- OpenAI GPT (the LLM)
- MCP Client (tool discovery and execution)
- x402 Payment Protocol (automatic payment for paid tools)

This demonstrates the ACTUAL MCP client methods used in production chatbots.

Usage:
    python main.py
"""

import asyncio
import json
import os
import sys
from typing import Any

from dotenv import load_dotenv
from eth_account import Account
from mcp import ClientSession
from mcp.client.sse import sse_client
from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam

from x402 import x402ClientSync
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mcp import (
    MCPToolCallResult,
    MCPToolResult,
    x402MCPClient,
)

load_dotenv()

# ============================================================================
# Configuration
# ============================================================================

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("OPENAI_API_KEY environment variable is required")
    print("   Get your API key from: https://platform.openai.com/api-keys")
    sys.exit(1)

EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")
if not EVM_PRIVATE_KEY:
    print("EVM_PRIVATE_KEY environment variable is required")
    print("   Generate one with: cast wallet new")
    sys.exit(1)

MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:4022")


# ============================================================================
# MCP Client Adapter
# ============================================================================


class MCPClientAdapter:
    """Adapter that wraps mcp.ClientSession for the x402 MCP client interface.

    The Python MCP SDK is async-first. This adapter bridges the async
    ClientSession into the interface expected by x402MCPClient.
    """

    def __init__(self, session: ClientSession):
        """Initialize adapter with MCP client session."""
        self._session = session

    async def connect(self, transport: Any) -> None:
        """Connect - already connected via session context manager."""
        pass

    async def close(self) -> None:
        """Close session."""
        pass

    async def call_tool(
        self, params: dict[str, Any], **kwargs: Any
    ) -> MCPToolResult:
        """Call tool via MCP session.

        Handles the bridge between x402MCPClient's call format and the
        MCP SDK's call_tool method.
        """
        name = params.get("name", "")
        args = params.get("arguments", {})
        meta = params.get("_meta")

        # Build keyword arguments for MCP SDK call_tool
        result = await self._session.call_tool(
            name=name,
            arguments=args or {},
            meta=meta,
        )

        # Convert to MCPToolResult format
        content = []
        for item in result.content:
            if hasattr(item, "text"):
                content.append({"type": "text", "text": item.text})
            else:
                content.append({"type": getattr(item, "type", "text"), "text": str(item)})

        meta_dict = {}
        if hasattr(result, "meta") and result.meta:
            meta_dict = dict(result.meta) if result.meta else {}

        return MCPToolResult(
            content=content,
            is_error=getattr(result, "isError", False) or getattr(result, "is_error", False),
            meta=meta_dict,
        )

    async def list_tools(self) -> Any:
        """List available tools from the server."""
        return await self._session.list_tools()


# ============================================================================
# Chatbot Implementation
# ============================================================================


async def main() -> None:
    """Main chatbot loop - demonstrates real MCP client usage patterns."""
    print("\nOpenAI + MCP Chatbot with x402 Payments")
    print("=" * 70)

    # ========================================================================
    # SETUP 1: Initialize OpenAI (the LLM)
    # ========================================================================
    openai_client = OpenAI(api_key=OPENAI_API_KEY)
    print("OpenAI client initialized")

    # ========================================================================
    # SETUP 2: Initialize x402 payment client
    # ========================================================================
    account = Account.from_key(EVM_PRIVATE_KEY)
    print(f"Wallet address: {account.address}")

    # ========================================================================
    # SETUP 3: Connect to MCP server and wrap with x402
    # ========================================================================
    print(f"Connecting to MCP server: {MCP_SERVER_URL}")

    async with sse_client(f"{MCP_SERVER_URL}/sse") as (
        read_stream,
        write_stream,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            # ================================================================
            # MCP TOUCHPOINT #1: initialize / connect
            # ================================================================
            await session.initialize()
            print("Connected to MCP server")

            # Create adapter and wrap with x402
            adapter = MCPClientAdapter(session)

            payment_client = x402ClientSync()
            register_exact_evm_client(payment_client, EthAccountSigner(account))

            def on_payment_requested(context: Any) -> bool:
                price = context.payment_required.accepts[0]
                print(f"\n  Payment requested for tool: {context.tool_name}")
                print(f"   Amount: {price.amount} ({price.asset})")
                print(f"   Network: {price.network}")
                print("   Approving payment...\n")
                return True  # Auto-approve

            x402_mcp = x402MCPClient(
                adapter,
                payment_client,
                auto_payment=True,
                on_payment_requested=on_payment_requested,
            )

            # ================================================================
            # MCP TOUCHPOINT #2: listTools()
            # Discover available tools from MCP server
            # ================================================================
            print("\nDiscovering tools from MCP server...")
            tools_result = await adapter.list_tools()
            mcp_tools = tools_result.tools
            print(f"Found {len(mcp_tools)} tools:")
            for tool in mcp_tools:
                is_paid = (
                    tool.description
                    and ("payment" in tool.description.lower() or "$" in tool.description)
                )
                prefix = "[paid]" if is_paid else "[free]"
                print(f"   {prefix} {tool.name}: {tool.description}")

            # ================================================================
            # HOST LOGIC: Convert MCP tools to OpenAI format
            # ================================================================
            openai_tools: list[ChatCompletionToolParam] = []
            for tool in mcp_tools:
                openai_tools.append({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description or "",
                        "parameters": tool.inputSchema if tool.inputSchema else {},
                    },
                })

            print("Converted to OpenAI tool format")
            print("=" * 70)

            # ================================================================
            # Interactive Chat Loop
            # ================================================================
            print("\nChat started! Try asking:")
            print("   - 'What's the weather in Tokyo?'")
            print("   - 'Can you ping the server?'")
            print("   - 'quit' to exit\n")

            conversation_history: list[ChatCompletionMessageParam] = [
                {
                    "role": "system",
                    "content": (
                        "You are a helpful assistant with access to MCP tools. "
                        "When users ask about weather, use the get_weather tool. "
                        "Be concise and friendly."
                    ),
                },
            ]

            while True:
                try:
                    user_input = input("You: ").strip()
                except (EOFError, KeyboardInterrupt):
                    print("\n\nClosing connections...")
                    break

                if not user_input:
                    continue

                if user_input.lower() in ("quit", "exit"):
                    print("\nClosing connections...")
                    break

                # Add user message to history
                conversation_history.append({
                    "role": "user",
                    "content": user_input,
                })

                # ==============================================================
                # OPENAI CALL: Send conversation + tools to LLM
                # ==============================================================
                response = openai_client.chat.completions.create(
                    model="gpt-4o",
                    messages=conversation_history,
                    tools=openai_tools if openai_tools else None,
                    tool_choice="auto",
                )

                assistant_message = response.choices[0].message

                # ==============================================================
                # TOOL EXECUTION LOOP
                # ==============================================================
                tool_call_count = 0
                while assistant_message.tool_calls:
                    tool_call_count += 1
                    print(
                        f"\n  [Turn {tool_call_count}] LLM is calling "
                        f"{len(assistant_message.tool_calls)} tool(s)..."
                    )

                    # Add assistant message with tool calls to history
                    conversation_history.append(assistant_message)  # type: ignore[arg-type]

                    # Execute each tool call
                    tool_results: list[ChatCompletionMessageParam] = []

                    for tool_call in assistant_message.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)

                        print(f"\n   Calling: {tool_name}")
                        print(f"   Args: {json.dumps(tool_args)}")

                        try:
                            # ================================================
                            # MCP TOUCHPOINT #3: callTool()
                            # Payment is handled automatically by x402MCPClient
                            # ================================================
                            mcp_result: MCPToolCallResult = await x402_mcp.call_tool(
                                tool_name, tool_args
                            )

                            # Show payment info if payment was made
                            if mcp_result.payment_made and mcp_result.payment_response:
                                print("   Payment settled!")
                                if hasattr(mcp_result.payment_response, "transaction"):
                                    print(
                                        f"      Transaction: "
                                        f"{mcp_result.payment_response.transaction}"
                                    )
                                if hasattr(mcp_result.payment_response, "network"):
                                    print(
                                        f"      Network: "
                                        f"{mcp_result.payment_response.network}"
                                    )

                            # Extract text content from MCP result
                            result_text = "No content returned"
                            if mcp_result.content:
                                first = mcp_result.content[0]
                                if isinstance(first, dict):
                                    result_text = first.get("text", json.dumps(first))
                                elif hasattr(first, "text"):
                                    result_text = first.text
                                else:
                                    result_text = str(first)

                            truncated = (
                                result_text[:200] + "..."
                                if len(result_text) > 200
                                else result_text
                            )
                            print(f"   Result: {truncated}")

                            tool_results.append({
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": result_text,
                            })

                        except Exception as e:
                            print(f"   Error: {e}")
                            tool_results.append({
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": f"Error executing tool: {e}",
                            })

                    # Add tool results to conversation
                    conversation_history.extend(tool_results)

                    # ===========================================================
                    # Get LLM's response after seeing tool results
                    # ===========================================================
                    response = openai_client.chat.completions.create(
                        model="gpt-4o",
                        messages=conversation_history,
                        tools=openai_tools if openai_tools else None,
                        tool_choice="auto",
                    )

                    assistant_message = response.choices[0].message

                # ==============================================================
                # Display final assistant response
                # ==============================================================
                if assistant_message.content:
                    conversation_history.append(assistant_message)  # type: ignore[arg-type]
                    print(f"\nBot: {assistant_message.content}\n")

    # ========================================================================
    # MCP TOUCHPOINT #4: close()
    # Clean shutdown handled by context managers
    # ========================================================================
    print("Goodbye!\n")


# ============================================================================
# Entry Point
# ============================================================================

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"\nFatal error: {e}")
        sys.exit(1)
