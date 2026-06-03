"""EVM integration tests for MCP transport with REAL blockchain transactions.

These tests verify the complete MCP payment flow using:
- Real MCP SDK transport (mcp package from PyPI)
- Real EVM blockchain transactions on Base Sepolia (NO mocks for x402 protocol)
- Real x402 payment processing (NO mocks for payment verification or settlement)

Required environment variables:
- EVM_CLIENT_PRIVATE_KEY: Private key for the client wallet (payer)
- EVM_FACILITATOR_PRIVATE_KEY: Private key for the facilitator wallet (settles payments)

These tests make REAL blockchain transactions on Base Sepolia testnet.
All x402 payment operations (verification, settlement) use real blockchain calls.
"""

import asyncio
import os
import socket
import threading
import time

import pytest
from web3 import Web3

mcp = pytest.importorskip("mcp", reason="mcp package not available")
from mcp.client.streamable_http import streamable_http_client  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

from mcp import ClientSession  # noqa: E402
from mcp.types import TextContent  # noqa: E402
from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync  # noqa: E402
from x402.mcp import create_payment_wrapper, x402MCPClientSync  # noqa: E402
from x402.mechanisms.evm.exact import (  # noqa: E402
    ExactEvmClientScheme,
    ExactEvmFacilitatorScheme,
    ExactEvmSchemeConfig,
    ExactEvmServerScheme,
)
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer  # noqa: E402
from x402.schemas import ResourceConfig, ResourceInfo  # noqa: E402

# Environment variables
CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_PRIVATE_KEY")
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")

# Test constants
TEST_NETWORK = "eip155:84532"  # Base Sepolia
TEST_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"  # USDC on Base Sepolia
TEST_PRICE = "1000"  # 0.001 USDC
TEST_PORT_FREE = 4099
TEST_PORT_PAID = 4100

# Skip all tests if environment variables aren't set
pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY,
    reason="EVM_CLIENT_PRIVATE_KEY and EVM_FACILITATOR_PRIVATE_KEY environment variables required for MCP EVM integration tests",
)


def wait_for_pending_transactions(
    address: str,
    rpc_url: str = RPC_URL,
    timeout: float = 120.0,
) -> None:
    """Wait until a wallet has no pending transactions.

    Prevents nonce collisions when integration tests share the same keys and run
    back-to-back (matches Go's waitForPendingTransactions).
    """
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    checksum = Web3.to_checksum_address(address)
    deadline = time.time() + timeout
    while time.time() < deadline:
        confirmed = w3.eth.get_transaction_count(checksum, "latest")
        pending = w3.eth.get_transaction_count(checksum, "pending")
        if pending == confirmed:
            return
        time.sleep(2)
    raise TimeoutError(
        f"Timed out waiting for pending transactions to clear for {address} "
        f"(confirmed={confirmed}, pending={pending})"
    )


class EvmFacilitatorClientSync:
    """Facilitator client wrapper for x402ResourceServerSync."""

    scheme = "exact"
    network = "eip155:84532"
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync):
        """Create wrapper."""
        self._facilitator = facilitator

    def verify(self, payload, requirements):
        """Verify payment."""
        return self._facilitator.verify(payload, requirements)

    def settle(self, payload, requirements):
        """Settle payment."""
        return self._facilitator.settle(payload, requirements)

    def get_supported(self):
        """Get supported kinds."""
        return self._facilitator.get_supported()


class MCPClientAdapter:
    """Adapter that wraps mcp.ClientSession to x402.mcp.MCPClientInterface."""

    def __init__(self, session: ClientSession):
        """Initialize adapter with MCP client session."""
        self._session = session

    def connect(self, transport):
        """Connect - already connected via session."""
        pass

    def close(self):
        """Close session."""
        # Session cleanup handled by context manager
        pass

    def call_tool(self, params, **kwargs):
        """Call tool via MCP session."""
        import nest_asyncio

        # Allow nested event loops
        nest_asyncio.apply()

        name = params.get("name", "")
        arguments = params.get("arguments", {})
        # _meta can be in params dict or passed via kwargs
        # Extract _meta if present (check both params and kwargs)
        meta = None
        if "_meta" in params:
            meta = params["_meta"]
        elif "_meta" in kwargs:
            meta = kwargs["_meta"]
        elif "meta" in kwargs:
            meta = kwargs["meta"]

        # Use asyncio.run() which now works with nest_asyncio
        # Only pass meta if it's not None (matches original behavior)
        if meta is not None:
            result = asyncio.run(self._session.call_tool(name, arguments, meta=meta))
        else:
            result = asyncio.run(self._session.call_tool(name, arguments))

        # Convert to dict format
        content = []
        for item in result.content:
            if isinstance(item, TextContent):
                content.append({"type": "text", "text": item.text})
            else:
                content.append({"type": getattr(item, "type", "text"), "text": str(item)})

        return type(
            "MCPResult",
            (),
            {
                "content": content,
                "isError": result.isError,  # MCP SDK uses camelCase
                "_meta": result.meta if hasattr(result, "meta") and result.meta else {},
                "structuredContent": (
                    result.structuredContent if hasattr(result, "structuredContent") else None
                ),
            },
        )()

    def list_tools(self):
        """List tools via MCP session."""
        import nest_asyncio

        nest_asyncio.apply()

        result = asyncio.run(self._session.list_tools())
        tools = []
        for tool in result.tools:
            tools.append({"name": tool.name, "description": tool.description})
        return {"tools": tools}


class TestMCPEVMIntegration:
    """Integration tests for MCP transport with REAL EVM transactions."""

    def setup_method(self):
        """Set up test fixtures with real blockchain clients."""
        from eth_account import Account

        # Create signers
        client_account = Account.from_key(CLIENT_PRIVATE_KEY)
        self.client_signer = EthAccountSigner(client_account)
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )

        # Create client with EVM scheme
        self.client = x402ClientSync().register(
            "eip155:84532",
            ExactEvmClientScheme(self.client_signer),
        )

        # Create facilitator with EVM scheme
        self.facilitator = x402FacilitatorSync().register(
            ["eip155:84532"],
            ExactEvmFacilitatorScheme(
                self.facilitator_signer,
                ExactEvmSchemeConfig(),
            ),
        )

        # Create facilitator client wrapper
        facilitator_client = EvmFacilitatorClientSync(self.facilitator)

        # Create resource server with EVM scheme
        self.server = x402ResourceServerSync(facilitator_client)
        self.server.register("eip155:84532", ExactEvmServerScheme())
        self.server.initialize()

    def test_free_tool_works_without_payment(self):
        """Test that free tools work without payment."""
        # Create FastMCP server with port configuration
        mcp_server = FastMCP("x402-test-server", json_response=True, port=TEST_PORT_FREE)

        # Register free tool
        @mcp_server.tool()
        def ping() -> str:
            """A free health check tool."""
            return "pong"

        # Start server in background
        server_thread = threading.Thread(
            target=lambda: mcp_server.run(transport="streamable-http"),
            daemon=True,
        )
        server_thread.start()

        # Wait for server to be ready
        max_wait = 5.0
        start_time = time.time()
        while time.time() - start_time < max_wait:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(0.1)
                result = sock.connect_ex(("localhost", TEST_PORT_FREE))
                sock.close()
                if result == 0:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError(
                f"Server failed to start on port {TEST_PORT_FREE} within {max_wait}s"
            )

        try:
            # Connect client
            async def run_client():
                async with streamable_http_client(f"http://localhost:{TEST_PORT_FREE}/mcp") as (
                    read_stream,
                    write_stream,
                    _,
                ):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()

                        # Wrap with x402
                        adapter = MCPClientAdapter(session)
                        x402_mcp = x402MCPClientSync(
                            adapter,
                            self.client,
                            auto_payment=True,
                        )

                        result = x402_mcp.call_tool("ping", {})

                        assert result.payment_made is False
                        assert result.is_error is False
                        assert len(result.content) > 0
                        assert result.content[0]["text"] == "pong"

            asyncio.run(run_client())
        finally:
            # Server cleanup handled by daemon thread
            pass

    def test_paid_tool_with_real_blockchain_transaction(self):
        """Test complete MCP payment flow with REAL blockchain transactions.

        This test:
        1. Sets up MCP client and server with real EVM signers
        2. Creates payment wrapper for server
        3. Calls paid tool (triggers payment required)
        4. Client automatically creates and submits payment
        5. Server verifies and settles payment on-chain

        WARNING: This makes REAL blockchain transactions on Base Sepolia!
        """
        # Prior EVM integration tests may leave facilitator txs in the mempool.
        wait_for_pending_transactions(self.facilitator_signer.address)
        wait_for_pending_transactions(self.client_signer.address)

        # Build payment requirements
        config = ResourceConfig(
            scheme="exact",
            network="eip155:84532",
            pay_to=self.facilitator_signer.address,
            price="$0.001",
        )

        accepts = self.server.build_payment_requirements(config)

        # Ensure all required fields
        if len(accepts) == 0:
            pytest.fail("No payment requirements returned")
        if not accepts[0].asset:
            accepts[0].asset = TEST_ASSET
        if not accepts[0].pay_to:
            accepts[0].pay_to = self.facilitator_signer.address
        if not accepts[0].max_timeout_seconds:
            accepts[0].max_timeout_seconds = 300

        # Create payment wrapper (decorator - same pattern as E2E mcp-python server)
        weather_wrapper = create_payment_wrapper(
            self.server,
            accepts=accepts,
            resource=ResourceInfo(
                url="mcp://tool/get_weather",
                description="Get weather for a city",
                mime_type="application/json",
            ),
        )

        # Create FastMCP server with port configuration
        mcp_server = FastMCP("x402-test-server", json_response=True, port=TEST_PORT_PAID)

        # Register free tool
        @mcp_server.tool()
        def ping() -> str:
            """A free health check tool."""
            return "pong"

        # Register paid tool with decorator (returns CallToolResult with _meta)
        @mcp_server.tool(
            name="get_weather",
            description="Get weather for a city. Requires payment of $0.001.",
        )
        @weather_wrapper
        async def get_weather(city: str) -> str:
            """Return weather data."""
            return '{"city": "' + city + '", "weather": "sunny", "temperature": 72}'

        # Start server in background
        server_thread = threading.Thread(
            target=lambda: mcp_server.run(transport="streamable-http"),
            daemon=True,
        )
        server_thread.start()

        # Wait for server to be ready
        max_wait = 5.0
        start_time = time.time()
        while time.time() - start_time < max_wait:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(0.1)
                result = sock.connect_ex(("localhost", TEST_PORT_PAID))
                sock.close()
                if result == 0:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError(
                f"Server failed to start on port {TEST_PORT_PAID} within {max_wait}s"
            )

        try:
            # Connect client
            async def run_client():
                async with streamable_http_client(f"http://localhost:{TEST_PORT_PAID}/mcp") as (
                    read_stream,
                    write_stream,
                    _,
                ):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()

                        # Wrap with x402
                        adapter = MCPClientAdapter(session)
                        x402_mcp = x402MCPClientSync(
                            adapter,
                            self.client,
                            auto_payment=True,
                            on_payment_requested=lambda ctx: True,  # Auto-approve
                        )

                        # Call paid tool - this makes a REAL blockchain transaction!
                        print("\n🔄 Starting paid tool call with real blockchain settlement...\n")

                        result = x402_mcp.call_tool("get_weather", {"city": "New York"})

                        # Verify payment was made
                        assert result.payment_made is True, (
                            f"expected payment retry; content={result.content!r}"
                        )
                        assert result.is_error is False, (
                            f"tool call failed after payment; content={result.content!r}"
                        )

                        # Verify payment response (settlement result)
                        assert result.payment_response is not None, (
                            f"settlement meta missing; content={result.content!r}"
                        )
                        assert result.payment_response.success is True
                        assert result.payment_response.transaction is not None
                        assert result.payment_response.network == TEST_NETWORK

                        print("\n✅ Settlement successful!")
                        print(f"   Transaction: {result.payment_response.transaction}")
                        print(f"   Network: {result.payment_response.network}")
                        print(
                            f"   View on BaseScan: https://sepolia.basescan.org/tx/{result.payment_response.transaction}\n"
                        )

            asyncio.run(run_client())
        finally:
            # Server cleanup handled by daemon thread
            pass
