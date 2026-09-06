"""Unit tests for x402ResourceServer and x402ResourceServerSync."""

import pytest

from x402 import FacilitatorCapabilityError, x402ResourceServer, x402ResourceServerSync
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceConfig,
    ResourceInfo,
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
    default_asset_transfer_method = "default"
    payment_flows = {
        "default": {"supported": ("authorization",), "default": "authorization"},
    }

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

    def test_initialize_raises_when_no_kinds_loaded(self):
        """Empty /supported must fail retryably, matching TypeScript."""
        server = x402ResourceServer(MockFacilitatorClient([]))

        with pytest.raises(
            RuntimeError,
            match="no supported payment kinds loaded from any facilitator",
        ):
            server.initialize()

        assert server._initialized is False
        assert server._supported_responses == {}


class _ValidatingSchemeServer(MockSchemeServer):
    """Mock scheme exposing the optional validate_facilitator_support hook."""

    def __init__(self, scheme: str = "mock", problem: str | None = None):
        super().__init__(scheme)
        self._problem = problem
        self.calls: list = []

    def validate_facilitator_support(self, network, supported_kind, facilitator_extensions):
        self.calls.append((network, supported_kind, facilitator_extensions))
        return self._problem


class TestValidateFacilitatorCapabilities:
    """Tests for the fail-fast facilitator-capability validation in initialize()."""

    def _client(self) -> MockFacilitatorClient:
        return MockFacilitatorClient(
            [SupportedKind(x402_version=2, scheme="mock", network="eip155:8453")]
        )

    def test_initialize_raises_when_scheme_reports_problem(self):
        server = x402ResourceServer(self._client())
        server.register("eip155:8453", _ValidatingSchemeServer("mock", problem="needs authorizer"))

        with pytest.raises(FacilitatorCapabilityError, match="needs authorizer"):
            server.initialize()

    def test_initialize_succeeds_when_hook_returns_none(self):
        scheme = _ValidatingSchemeServer("mock", problem=None)
        server = x402ResourceServer(self._client())
        server.register("eip155:8453", scheme)

        server.initialize()

        assert server._initialized is True
        assert len(scheme.calls) == 1

    def test_initialize_skips_unsupported_scheme_network(self):
        scheme = _ValidatingSchemeServer("mock", problem="should not be evaluated")
        # Facilitator advertises a different network than the scheme is registered on.
        client = MockFacilitatorClient(
            [SupportedKind(x402_version=2, scheme="mock", network="eip155:1")]
        )
        server = x402ResourceServer(client)
        server.register("eip155:8453", scheme)

        server.initialize()

        assert server._initialized is True
        assert scheme.calls == []


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
            payment_flows = {
                "default": {"supported": ("authorization",), "default": "authorization"},
                "permit2": {"supported": ("authorization",), "default": "authorization"},
            }

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


def _matching_req(**overrides) -> PaymentRequirements:
    base = {
        "scheme": "exact",
        "network": "eip155:8453",
        "asset": "USDC",
        "amount": "1000000",
        "pay_to": "0xabc",
        "max_timeout_seconds": 300,
        "extra": {},
    }
    extra = overrides.pop("extra", None)
    base.update(overrides)
    if extra is not None:
        base["extra"] = extra
    return PaymentRequirements(**base)


def _matching_payload(accepted: PaymentRequirements) -> PaymentPayload:
    return PaymentPayload(payload={}, accepted=accepted)


class TestFindMatchingRequirements:
    def test_matches_when_server_declared_terms_are_unchanged(self):
        server = x402ResourceServer()
        req1 = _matching_req(amount="1000000")
        req2 = _matching_req(amount="2000000")
        result = server.find_matching_requirements([req1, req2], _matching_payload(req1))
        assert result == req1

    def test_matches_additive_accepted_extra_fields(self):
        server = x402ResourceServer()
        req = _matching_req(
            scheme="batch-settlement",
            extra={"name": "USDC", "version": "2", "nested": {"required": True}},
        )
        accepted = req.model_copy(
            update={
                "extra": {
                    **req.extra,
                    "nested": {"required": True, "clientOnly": "ok"},
                    "channelState": {"chargedCumulativeAmount": "2000"},
                }
            }
        )
        assert server.find_matching_requirements([req], _matching_payload(accepted)) == req

    def test_matches_when_server_extra_has_none_fields_omitted_by_client(self):
        server = x402ResourceServer()
        req = _matching_req(
            scheme="batch-settlement",
            extra={"name": "USDC", "version": "2", "assetTransferMethod": None},
        )
        accepted = req.model_copy(update={"extra": {"name": "USDC", "version": "2"}})
        assert server.find_matching_requirements([req], _matching_payload(accepted)) == req

    def test_does_not_match_when_accepted_extra_overwrites_server_fields(self):
        server = x402ResourceServer()
        req = _matching_req(scheme="batch-settlement", extra={"name": "USDC", "version": "2"})
        accepted = req.model_copy(update={"extra": {**req.extra, "version": "3"}})
        assert server.find_matching_requirements([req], _matching_payload(accepted)) is None

    def test_does_not_match_when_accepted_extra_array_is_a_superset(self):
        server = x402ResourceServer()
        req = _matching_req(scheme="batch-settlement", extra={"allowedSigners": ["0xalice"]})
        accepted = req.model_copy(update={"extra": {"allowedSigners": ["0xmallory", "0xalice"]}})
        assert server.find_matching_requirements([req], _matching_payload(accepted)) is None

    def test_does_not_match_when_accepted_extra_array_is_reordered(self):
        server = x402ResourceServer()
        req = _matching_req(
            scheme="batch-settlement", extra={"allowedSigners": ["0xalice", "0xbob"]}
        )
        accepted = req.model_copy(update={"extra": {"allowedSigners": ["0xbob", "0xalice"]}})
        assert server.find_matching_requirements([req], _matching_payload(accepted)) is None

    def test_does_not_match_when_accepted_extra_omits_server_fields(self):
        server = x402ResourceServer()
        req = _matching_req(scheme="batch-settlement", extra={"name": "USDC", "version": "2"})
        accepted = req.model_copy(update={"extra": {"name": "USDC"}})
        assert server.find_matching_requirements([req], _matching_payload(accepted)) is None

    def test_returns_none_if_no_match_found(self):
        server = x402ResourceServer()
        req = _matching_req(scheme="exact")
        payload = _matching_payload(_matching_req(scheme="intent"))
        assert server.find_matching_requirements([req], payload) is None

    def test_matches_when_only_declared_dynamic_extra_fields_differ(self):
        class SvmLike(MockSchemeServer):
            dynamic_extra_fields = ["recentBlockhash", "lastValidBlockHeight"]

        server = x402ResourceServer()
        server.register("solana:mainnet", SvmLike("exact"))
        req = _matching_req(
            network="solana:mainnet",
            extra={
                "feePayer": "FeePayer111111111111111111111111111111111",
                "recentBlockhash": "freshBlockhash",
                "lastValidBlockHeight": "200",
            },
        )
        accepted = req.model_copy(
            update={
                "extra": {
                    "feePayer": "FeePayer111111111111111111111111111111111",
                    "recentBlockhash": "staleBlockhash",
                    "lastValidBlockHeight": "100",
                }
            }
        )
        assert server.find_matching_requirements([req], _matching_payload(accepted)) == req

    def test_does_not_match_when_static_extra_field_differs_despite_dynamic_fields(self):
        class SvmLike(MockSchemeServer):
            dynamic_extra_fields = ["recentBlockhash", "lastValidBlockHeight"]

        server = x402ResourceServer()
        server.register("solana:mainnet", SvmLike("exact"))
        req = _matching_req(
            network="solana:mainnet",
            extra={
                "feePayer": "FeePayer111111111111111111111111111111111",
                "recentBlockhash": "freshBlockhash",
            },
        )
        accepted = req.model_copy(
            update={
                "extra": {
                    "feePayer": "OtherPayer1111111111111111111111111111111",
                    "recentBlockhash": "staleBlockhash",
                }
            }
        )
        assert server.find_matching_requirements([req], _matching_payload(accepted)) is None

    def test_keeps_strict_extra_comparison_when_no_dynamic_fields_are_declared(self):
        server = x402ResourceServer()
        server.register("solana:mainnet", MockSchemeServer("exact"))
        req = _matching_req(
            network="solana:mainnet",
            extra={"feePayer": "FeePayer", "recentBlockhash": "fresh"},
        )
        accepted = req.model_copy(
            update={"extra": {"feePayer": "FeePayer", "recentBlockhash": "stale"}}
        )
        assert server.find_matching_requirements([req], _matching_payload(accepted)) is None


@pytest.mark.asyncio
async def test_rejects_extension_enrichment_that_injects_payment_flow() -> None:
    class FlowAttack:
        key = "flowAttack"

        def enrich_declaration(self, declaration, transport_context):
            return declaration

        def enrich_payment_required_response(self, declaration, context):
            context.requirements[0].extra["paymentFlow"] = "upfront"
            return {}

    server = x402ResourceServer()
    server.register_extension(FlowAttack())
    with pytest.raises(ValueError, match=r'extra\["paymentFlow"\].*protocol-reserved'):
        await server.create_payment_required_response(
            [_matching_req(extra={"name": "USDC"})],
            ResourceInfo(url="https://example.com", description="", mime_type=""),
            None,
            {"flowAttack": {}},
        )
