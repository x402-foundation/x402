"""MCP Client with x402 Payment Support - Advanced Example.

This example demonstrates the LOW-LEVEL API using x402MCPClient directly.
Use this approach when you need:
- Custom x402Client configuration
- Payment caching via on_payment_required hook
- Full control over the payment flow
- Integration with existing MCP clients

Run with: python main.py advanced
"""

import asyncio
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
    AfterPaymentContext,
    MCPToolResult,
    PaymentRequiredContext,
    x402MCPClient,
)

load_dotenv()

EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:4022")

if not EVM_PRIVATE_KEY:
    print("❌ EVM_PRIVATE_KEY environment variable is required")
    sys.exit(1)


# Adapter that wraps mcp.ClientSession to x402.mcp.MCPClientInterface
class MCPClientAdapter:
    """Adapter that wraps mcp.ClientSession for x402MCPClient.

    The x402MCPClient calls ``call_tool(params, **kwargs)`` where *params*
    is a dict ``{"name": ..., "arguments": ..., "_meta": ...}``.  This
    adapter unpacks that dict and forwards to the real MCP SDK session.
    """

    def __init__(self, session: ClientSession):
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

        Args:
            params: Dict with ``name``, ``arguments``, and optional ``_meta``.
            **kwargs: Forwarded (unused by MCP SDK today).
        """
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


async def run_advanced_async() -> None:
    """Demonstrates the advanced API with manual setup and hooks using REAL MCP SDK."""
    print("\n📦 Using ADVANCED API (x402MCPClient with manual setup) and REAL MCP SDK\n")
    print(f"🔌 Connecting to MCP server at: {MCP_SERVER_URL}")

    account = Account.from_key(EVM_PRIVATE_KEY)
    print(f"💳 Using wallet: {account.address}")

    # ========================================================================
    # ADVANCED: Manual setup with full control using REAL MCP SDK
    # ========================================================================

    # Connect to REAL MCP server using streamable HTTP transport
    async with sse_client(f"{MCP_SERVER_URL}/sse") as (
        read_stream,
        write_stream,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            # Create adapter
            adapter = MCPClientAdapter(session)

            # Step 2: Create x402 payment client manually
            payment_client = x402ClientSync()
            register_exact_evm_client(payment_client, EthAccountSigner(account))

            def on_payment_requested(context):
                print(f"\n💰 Payment required for tool: {context.tool_name}")
                print(f"   Amount: {context.payment_required.accepts[0].amount} ({context.payment_required.accepts[0].asset})")
                print(f"   Network: {context.payment_required.accepts[0].network}")
                print("   Approving payment...\n")
                return True

            # Step 3: Compose into x402MCPClient using adapter
            x402_mcp = x402MCPClient(
                adapter,
                payment_client,
                auto_payment=True,
                on_payment_requested=on_payment_requested,
            )

            # ========================================================================
            # ADVANCED: Register hooks for observability and control
            # ========================================================================

            # Hook: Called when 402 is received (before payment)
            def on_payment_required(context: PaymentRequiredContext) -> None:
                print(f"🔔 [Hook] Payment required received for: {context.tool_name}")
                print(f"   Options: {len(context.payment_required.accepts)} payment option(s)")

            # Hook: Called before payment is created
            def on_before_payment(context: PaymentRequiredContext) -> None:
                print(f"📝 [Hook] Creating payment for: {context.tool_name}")

            # Hook: Called after payment is submitted
            def on_after_payment(context: AfterPaymentContext) -> None:
                print(f"✅ [Hook] Payment submitted for: {context.tool_name}")
                if context.settle_response:
                    print(f"   Transaction: {context.settle_response.transaction}")

            x402_mcp.on_payment_required(on_payment_required)
            x402_mcp.on_before_payment(on_before_payment)
            x402_mcp.on_after_payment(on_after_payment)

            print("✅ Connected to MCP server")
            print("📊 Hooks enabled: on_payment_required, on_before_payment, on_after_payment\n")

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
                text = first.get("text", str(first)) if isinstance(first, dict) else getattr(first, "text", str(first))
                print(f"Response: {text}")
            print(f"Payment made: {ping_result.payment_made}\n")

            # Test paid tool
            print("━" * 50)
            print("💰 Test 2: Calling paid tool (get_weather)")
            print("━" * 50)

            weather_result = await x402_mcp.call_tool("get_weather", {"city": "San Francisco"})
            if weather_result.content:
                first = weather_result.content[0]
                text = first.get("text", str(first)) if isinstance(first, dict) else getattr(first, "text", str(first))
                print(f"Response: {text}")
            print(f"Payment made: {weather_result.payment_made}")

            if weather_result.payment_response:
                print("\n📦 Payment Receipt:")
                print(f"   Success: {weather_result.payment_response.success}")
                if weather_result.payment_response.transaction:
                    print(f"   Transaction: {weather_result.payment_response.transaction}")

            # Test accessing underlying clients
            print("\n" + "━" * 50)
            print("🔧 Test 3: Accessing underlying clients")
            print("━" * 50)
            print(f"MCP Client: {type(x402_mcp.client).__name__}")
            print(f"Payment Client: {type(x402_mcp.payment_client).__name__}")

            print("\n✅ Demo complete!")


def run_advanced() -> None:
    """Synchronous wrapper for async function."""
    asyncio.run(run_advanced_async())
