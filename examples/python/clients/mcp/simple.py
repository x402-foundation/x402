"""MCP Client with x402 Payment Support - Simple Example.

This example demonstrates the RECOMMENDED way to create an MCP client
using the x402MCPClient wrapper with REAL MCP SDK (mcp package from PyPI).

Run with: python main.py simple
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

from x402 import x402ClientSync
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mcp import (
    MCPToolResult,
    x402MCPClient,
)

load_dotenv()

EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:4022")

if not EVM_PRIVATE_KEY:
    print("EVM_PRIVATE_KEY environment variable is required")
    sys.exit(1)


class MCPClientAdapter:
    """Async adapter wrapping mcp.ClientSession for x402MCPClient."""

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
        """Call tool via MCP session."""
        name = params.get("name", "")
        args = params.get("arguments", {})
        meta = params.get("_meta")

        result = await self._session.call_tool(
            name=name,
            arguments=args or {},
            meta=meta,
        )

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


async def run_simple_async() -> None:
    """Demonstrates the simple API using x402MCPClient with REAL MCP SDK."""
    print("\n📦 Using SIMPLE API (x402MCPClient factory) with REAL MCP SDK\n")
    print(f"🔌 Connecting to MCP server at: {MCP_SERVER_URL}")

    account = Account.from_key(EVM_PRIVATE_KEY)
    print(f"💳 Using wallet: {account.address}")

    # Create x402 payment client
    payment_client = x402ClientSync()
    register_exact_evm_client(payment_client, EthAccountSigner(account))

    # Connect to MCP server using SSE transport (interoperable with Go/TypeScript servers)
    async with sse_client(f"{MCP_SERVER_URL}/sse") as (
        read_stream,
        write_stream,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            print("✅ Connected to MCP server\n")

            # Wrap with x402
            adapter = MCPClientAdapter(session)

            def on_payment_requested(context: Any) -> bool:
                price = context.payment_required.accepts[0]
                print(f"\n💰 Payment required for tool: {context.tool_name}")
                print(f"   Amount: {price.amount} ({price.asset})")
                print(f"   Network: {price.network}")
                print("   Approving payment...\n")
                return True

            x402_mcp = x402MCPClient(
                adapter,
                payment_client,
                auto_payment=True,
                on_payment_requested=on_payment_requested,
            )

            # List tools
            print("📋 Discovering available tools...")
            tools_result = await adapter.list_tools()
            print("Available tools:")
            for tool in tools_result.tools:
                print(f"   - {tool.name}: {tool.description}")
            print()

            # Test free tool
            print("━" * 50)
            print("🆓 Test 1: Calling free tool (ping)")
            print("━" * 50)

            ping_result = await x402_mcp.call_tool("ping", {})
            if ping_result.content:
                first = ping_result.content[0]
                text = first.get("text", str(first)) if isinstance(first, dict) else str(first)
                print(f"Response: {text}")
            print(f"Payment made: {ping_result.payment_made}\n")

            # Test paid tool
            print("━" * 50)
            print("💰 Test 2: Calling paid tool (get_weather)")
            print("━" * 50)

            weather_result = await x402_mcp.call_tool("get_weather", {"city": "San Francisco"})
            if weather_result.content:
                first = weather_result.content[0]
                text = first.get("text", str(first)) if isinstance(first, dict) else str(first)
                print(f"Response: {text}")
            print(f"Payment made: {weather_result.payment_made}")

            if weather_result.payment_response:
                print("\n📦 Payment Receipt:")
                print(f"   Success: {weather_result.payment_response.success}")
                if hasattr(weather_result.payment_response, "transaction"):
                    print(f"   Transaction: {weather_result.payment_response.transaction}")

            print("\n✅ Demo complete!")


def run_simple() -> None:
    """Synchronous wrapper for async function."""
    asyncio.run(run_simple_async())
