"""Unit tests for x402ResourceServer and x402ResourceServerSync."""

import pytest

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.schemas import (
    ResourceConfig,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)

# =============================================================================
# Mock Facilitator Clients
# =============================================================================


class MockFacilitatorClient:
    """Mock async facilitator client for testing."""

    def __init__(self, kinds: list[SupportedKind] | None = None):
        self._kinds = kinds or []
        self.verify_calls: list = []
        self.settle_calls: list = []

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=self._kinds,
            extensions=[],
            signers={},
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        return VerifyResponse(is_valid=True)

    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
        )


class MockFacilitatorClientSync:
    """Mock sync facilitator client for testing."""

    def __init__(self, kinds: list[SupportedKind] | None = None):
        self._kinds = kinds or []
        self.verify_calls: list = []
        self.settle_calls: list = []

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=self._kinds,
            extensions=[],
            signers={},
        )

    def verify(self, payload, requirements) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        return VerifyResponse(is_valid=True)

    def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
        )


class MockAsyncFacilitatorClient:
    """Mock client that appears async (for type checking tests)."""

    async def verify(self, payload, requirements) -> VerifyResponse:
        return VerifyResponse(is_valid=True)

    async def settle(self, payload, requirements) -> SettleResponse:
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network="eip155:8453",
        )

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(kinds=[], extensions=[], signers={})


class MockSchemeServer:
    """Mock scheme server for testing."""

    scheme = "mock"

    def __init__(self, scheme: str = "mock"):
        self.scheme = scheme

    def parse_price(self, price, network):
        from dataclasses import dataclass

        @dataclass
        class AssetAmount:
            asset: str
            amount: str
            extra: dict | None = None

        return AssetAmount(
            asset="0x0000000000000000000000000000000000000000",
            amount="1000000",
        )

    def enhance_payment_requirements(self, requirements, supported_kind, extensions):
        return requirements


# =============================================================================
# Server Registration Tests
# =============================================================================


class TestX402ResourceServerRegistration:
    """Tests for x402ResourceServer scheme registration."""

    def test_register_scheme(self):
        """Test registering a scheme server."""
        server = x402ResourceServer()
        mock_scheme = MockSchemeServer()

        result = server.register("eip155:8453", mock_scheme)

        # Should return self for chaining
        assert result is server
        assert server.has_registered_scheme("eip155:8453", "mock")

    def test_register_multiple_schemes(self):
        """Test registering multiple scheme servers."""
        server = x402ResourceServer()

        server.register("eip155:8453", MockSchemeServer("exact"))
        server.register("eip155:1", MockSchemeServer("exact"))

        assert server.has_registered_scheme("eip155:8453", "exact")
        assert server.has_registered_scheme("eip155:1", "exact")

    def test_chained_registration(self):
        """Test chaining registration calls."""
        server = (
            x402ResourceServer()
            .register("eip155:8453", MockSchemeServer())
            .register("eip155:1", MockSchemeServer())
        )

        assert server.has_registered_scheme("eip155:8453", "mock")
        assert server.has_registered_scheme("eip155:1", "mock")


class TestX402ResourceServerSyncRegistration:
    """Tests for x402ResourceServerSync scheme registration."""

    def test_register_scheme(self):
        """Test registering a scheme server on sync server."""
        server = x402ResourceServerSync()
        mock_scheme = MockSchemeServer()

        result = server.register("eip155:8453", mock_scheme)

        assert result is server
        assert server.has_registered_scheme("eip155:8453", "mock")


# =============================================================================
# Facilitator Client Handling Tests
# =============================================================================


class TestFacilitatorClientHandling:
    """Tests for facilitator client handling."""

    def test_accept_single_facilitator_client(self):
        """Test accepting a single facilitator client."""
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)

        assert len(server._facilitator_clients) == 1

    def test_accept_list_of_facilitator_clients(self):
        """Test accepting a list of facilitator clients."""
        clients = [MockFacilitatorClient(), MockFacilitatorClient()]
        server = x402ResourceServer(clients)

        assert len(server._facilitator_clients) == 2

    def test_accept_none_facilitator_client(self):
        """Test accepting None as facilitator client."""
        server = x402ResourceServer(None)

        assert len(server._facilitator_clients) == 0


class TestX402ResourceServerSyncFacilitatorValidation:
    """Tests for x402ResourceServerSync facilitator client validation."""

    def test_accepts_sync_facilitator_client(self):
        """Test that sync server accepts sync facilitator client."""
        client = MockFacilitatorClientSync()
        server = x402ResourceServerSync(client)

        assert len(server._facilitator_clients) == 1

    def test_rejects_async_facilitator_client(self):
        """Test that sync server rejects async facilitator client."""
        async_client = MockAsyncFacilitatorClient()

        with pytest.raises(TypeError, match="requires a sync facilitator client"):
            x402ResourceServerSync(async_client)  # type: ignore


# =============================================================================
# Initialization Tests
# =============================================================================


class TestServerInitialization:
    """Tests for server initialization."""

    def test_initialize_populates_supported_responses(self):
        """Test that initialize() populates supported responses."""
        kinds = [
            SupportedKind(
                x402_version=2,
                scheme="exact",
                network="eip155:8453",
            )
        ]
        client = MockFacilitatorClient(kinds)
        server = x402ResourceServer(client)

        server.initialize()

        assert server._initialized is True
        # Should have registered the facilitator client for the network/scheme
        assert "eip155:8453" in server._facilitator_clients_map
        assert "exact" in server._facilitator_clients_map["eip155:8453"]

    def test_initialize_with_multiple_clients(self):
        """Test initialization with multiple facilitator clients."""
        kinds1 = [SupportedKind(x402_version=2, scheme="exact", network="eip155:8453")]
        kinds2 = [SupportedKind(x402_version=2, scheme="exact", network="eip155:1")]
        client1 = MockFacilitatorClient(kinds1)
        client2 = MockFacilitatorClient(kinds2)

        server = x402ResourceServer([client1, client2])
        server.initialize()

        assert "eip155:8453" in server._facilitator_clients_map
        assert "eip155:1" in server._facilitator_clients_map

    def test_earlier_client_takes_precedence(self):
        """Test that earlier facilitator clients take precedence."""
        kinds = [SupportedKind(x402_version=2, scheme="exact", network="eip155:8453")]
        client1 = MockFacilitatorClient(kinds)
        client2 = MockFacilitatorClient(kinds)

        server = x402ResourceServer([client1, client2])
        server.initialize()

        # First client should be registered
        assert server._facilitator_clients_map["eip155:8453"]["exact"] is client1


# =============================================================================
# has_registered_scheme Tests
# =============================================================================


class TestHasRegisteredScheme:
    """Tests for has_registered_scheme method."""

    def test_exact_network_match(self):
        """Test exact network match."""
        server = x402ResourceServer()
        server.register("eip155:8453", MockSchemeServer("exact"))

        assert server.has_registered_scheme("eip155:8453", "exact") is True
        assert server.has_registered_scheme("eip155:8453", "other") is False
        assert server.has_registered_scheme("eip155:1", "exact") is False

    def test_wildcard_network_match(self):
        """Test wildcard network match."""
        server = x402ResourceServer()
        server.register("eip155:*", MockSchemeServer("exact"))

        # Wildcard should match any eip155 network
        assert server.has_registered_scheme("eip155:8453", "exact") is True
        assert server.has_registered_scheme("eip155:1", "exact") is True
        # But not other families
        assert server.has_registered_scheme("solana:mainnet", "exact") is False


# =============================================================================
# Hook Registration Tests
# =============================================================================


class TestX402ResourceServerHooks:
    """Tests for x402ResourceServer hook registration."""

    def test_register_before_verify_hook(self):
        """Test registering before_verify hook."""
        server = x402ResourceServer()

        def hook(ctx):
            return None

        result = server.on_before_verify(hook)

        assert result is server
        assert len(server._before_verify_hooks) == 1

    def test_register_after_verify_hook(self):
        """Test registering after_verify hook."""
        server = x402ResourceServer()

        server.on_after_verify(lambda ctx: None)

        assert len(server._after_verify_hooks) == 1

    def test_register_verify_failure_hook(self):
        """Test registering verify_failure hook."""
        server = x402ResourceServer()

        server.on_verify_failure(lambda ctx: None)

        assert len(server._on_verify_failure_hooks) == 1

    def test_register_settle_hooks(self):
        """Test registering settle hooks."""
        server = x402ResourceServer()

        server.on_before_settle(lambda ctx: None)
        server.on_after_settle(lambda ctx: None)
        server.on_settle_failure(lambda ctx: None)

        assert len(server._before_settle_hooks) == 1
        assert len(server._after_settle_hooks) == 1
        assert len(server._on_settle_failure_hooks) == 1

    def test_chained_hook_registration(self):
        """Test chaining hook registration."""
        server = (
            x402ResourceServer()
            .on_before_verify(lambda ctx: None)
            .on_after_verify(lambda ctx: None)
            .on_before_settle(lambda ctx: None)
            .on_after_settle(lambda ctx: None)
        )

        assert len(server._before_verify_hooks) == 1
        assert len(server._after_verify_hooks) == 1
        assert len(server._before_settle_hooks) == 1
        assert len(server._after_settle_hooks) == 1


class TestX402ResourceServerSyncHooks:
    """Tests for x402ResourceServerSync hook registration."""

    def test_register_all_hooks(self):
        """Test registering all hooks on sync server."""
        server = x402ResourceServerSync()

        server.on_before_verify(lambda ctx: None)
        server.on_after_verify(lambda ctx: None)
        server.on_verify_failure(lambda ctx: None)
        server.on_before_settle(lambda ctx: None)
        server.on_after_settle(lambda ctx: None)
        server.on_settle_failure(lambda ctx: None)

        assert len(server._before_verify_hooks) == 1
        assert len(server._after_verify_hooks) == 1
        assert len(server._on_verify_failure_hooks) == 1
        assert len(server._before_settle_hooks) == 1
        assert len(server._after_settle_hooks) == 1
        assert len(server._on_settle_failure_hooks) == 1


# =============================================================================
# Extension Registration Tests
# =============================================================================


class TestExtensionRegistration:
    """Tests for extension registration."""

    def test_register_extension(self):
        """Test registering an extension."""

        class MockExtension:
            key = "test"

            def enrich_declaration(self, declared, context):
                return declared

        server = x402ResourceServer()
        extension = MockExtension()

        result = server.register_extension(extension)

        assert result is server
        assert "test" in server._extensions


# =============================================================================
# Build Requirements Tests
# =============================================================================


class TestBuildPaymentRequirements:
    """Tests for build_payment_requirements."""

    def test_merges_resource_config_extra_with_parsed_price_extra(self):
        """Merchant config extra should be preserved when requirements are built."""

        class SchemeWithParsedExtra(MockSchemeServer):
            def parse_price(self, price, network):
                from dataclasses import dataclass

                @dataclass
                class AssetAmount:
                    asset: str
                    amount: str
                    extra: dict | None = None

                return AssetAmount(
                    asset="0x0000000000000000000000000000000000000000",
                    amount="1000000",
                    extra={"parsed": "value"},
                )

        kinds = [
            SupportedKind(
                x402_version=2,
                scheme="exact",
                network="eip155:8453",
            )
        ]
        server = x402ResourceServerSync(MockFacilitatorClientSync(kinds))
        server.register("eip155:8453", SchemeWithParsedExtra("exact"))
        server.initialize()

        requirements = server.build_payment_requirements(
            ResourceConfig(
                scheme="exact",
                pay_to="0xmerchant",
                price="$1.00",
                network="eip155:8453",
                extra={
                    "assetTransferMethod": "permit2",
                    "merchantNote": "custom-scheme-data",
                },
            )
        )

        assert len(requirements) == 1
        assert requirements[0].extra is not None
        assert requirements[0].extra.get("parsed") == "value"
        assert requirements[0].extra.get("assetTransferMethod") == "permit2"
        assert requirements[0].extra.get("merchantNote") == "custom-scheme-data"


# =============================================================================
# Error Handling Tests
# =============================================================================


class TestServerErrorHandling:
    """Tests for server error handling."""

    def test_verify_raises_if_not_initialized(self):
        """Test that verify raises if server not initialized."""
        server = x402ResourceServer()

        with pytest.raises(RuntimeError, match="not initialized"):
            import asyncio

            asyncio.run(server.verify_payment(None, None))  # type: ignore

    def test_settle_raises_if_not_initialized(self):
        """Test that settle raises if server not initialized."""
        server = x402ResourceServer()

        with pytest.raises(RuntimeError, match="not initialized"):
            import asyncio

            asyncio.run(server.settle_payment(None, None))  # type: ignore

    def test_build_requirements_raises_if_not_initialized(self):
        """Test that build_payment_requirements raises if not initialized."""
        server = x402ResourceServer()

        with pytest.raises(RuntimeError, match="not initialized"):
            server.build_payment_requirements(None)  # type: ignore
