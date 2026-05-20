"""Unit tests for x402Client and x402ClientSync - manual registration and policies."""

import pytest

from x402 import (
    prefer_network,
    x402Client,
    x402ClientSync,
)
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse
from x402.schemas.hooks import PaymentResponseContext, RecoveredResponseResult

# =============================================================================
# Mock Scheme Clients
# =============================================================================


class MockSchemeClient:
    """Mock V2 scheme client for testing."""

    scheme = "mock"

    def __init__(self, scheme: str = "mock"):
        self.scheme = scheme
        self.create_calls: list = []

    def create_payment_payload(self, requirements):
        self.create_calls.append(requirements)
        return {"mock": "payload", "network": requirements.network}


class MockSchemeClientV1:
    """Mock V1 scheme client for testing."""

    scheme = "mock-v1"

    def __init__(self, scheme: str = "mock-v1"):
        self.scheme = scheme

    def create_payment_payload(self, requirements):
        return {"mock": "v1-payload", "network": requirements.network}


# =============================================================================
# x402Client Registration Tests
# =============================================================================


class TestX402ClientRegistration:
    """Tests for x402Client scheme registration."""

    def test_register_v2_scheme(self):
        """Test registering a V2 scheme."""
        client = x402Client()
        mock_scheme = MockSchemeClient()

        result = client.register("eip155:8453", mock_scheme)

        # Should return self for chaining
        assert result is client

        registered = client.get_registered_schemes()
        assert len(registered[2]) == 1
        assert registered[2][0]["network"] == "eip155:8453"
        assert registered[2][0]["scheme"] == "mock"

    def test_register_v1_scheme(self):
        """Test registering a V1 scheme."""
        client = x402Client()
        mock_scheme = MockSchemeClientV1()

        client.register_v1("base-sepolia", mock_scheme)

        registered = client.get_registered_schemes()
        assert len(registered[1]) == 1
        assert registered[1][0]["network"] == "base-sepolia"

    def test_register_multiple_schemes(self):
        """Test registering multiple schemes."""
        client = x402Client()

        client.register("eip155:8453", MockSchemeClient())
        client.register("eip155:1", MockSchemeClient())
        client.register("solana:mainnet", MockSchemeClient("solana-exact"))

        registered = client.get_registered_schemes()
        assert len(registered[2]) == 3

    def test_chained_registration(self):
        """Test chaining registration calls."""
        client = (
            x402Client()
            .register("eip155:8453", MockSchemeClient())
            .register("eip155:1", MockSchemeClient())
        )

        registered = client.get_registered_schemes()
        assert len(registered[2]) == 2


class TestX402ClientSyncRegistration:
    """Tests for x402ClientSync scheme registration."""

    def test_register_v2_scheme(self):
        """Test registering a V2 scheme on sync client."""
        client = x402ClientSync()
        mock_scheme = MockSchemeClient()

        result = client.register("eip155:8453", mock_scheme)

        assert result is client
        registered = client.get_registered_schemes()
        assert len(registered[2]) == 1

    def test_register_v1_scheme(self):
        """Test registering a V1 scheme on sync client."""
        client = x402ClientSync()

        client.register_v1("base-sepolia", MockSchemeClientV1())

        registered = client.get_registered_schemes()
        assert len(registered[1]) == 1


# =============================================================================
# Policy Tests
# =============================================================================


class TestX402ClientPolicies:
    """Tests for x402Client policy registration and application."""

    def test_register_policy(self):
        """Test registering a policy."""
        client = x402Client()
        policy = prefer_network("eip155:8453")

        result = client.register_policy(policy)

        assert result is client
        assert len(client._policies) == 1

    def test_register_multiple_policies(self):
        """Test registering multiple policies."""
        client = x402Client()

        client.register_policy(prefer_network("eip155:8453"))
        client.register_policy(prefer_network("eip155:1"))

        assert len(client._policies) == 2

    def test_chained_policy_registration(self):
        """Test chaining policy registration."""
        client = (
            x402Client()
            .register("eip155:8453", MockSchemeClient())
            .register_policy(prefer_network("eip155:8453"))
            .register_policy(prefer_network("eip155:1"))
        )

        assert len(client._policies) == 2


class TestX402ClientSyncPolicies:
    """Tests for x402ClientSync policy registration."""

    def test_register_policy(self):
        """Test registering a policy on sync client."""
        client = x402ClientSync()
        policy = prefer_network("eip155:8453")

        client.register_policy(policy)

        assert len(client._policies) == 1


# =============================================================================
# Hook Registration Tests
# =============================================================================


class TestX402ClientHooks:
    """Tests for x402Client hook registration."""

    def test_register_before_payment_creation_hook(self):
        """Test registering before_payment_creation hook."""
        client = x402Client()

        def hook(ctx):
            return None

        result = client.on_before_payment_creation(hook)

        assert result is client
        assert len(client._before_payment_creation_hooks) == 1

    def test_register_after_payment_creation_hook(self):
        """Test registering after_payment_creation hook."""
        client = x402Client()

        def hook(ctx):
            pass

        client.on_after_payment_creation(hook)

        assert len(client._after_payment_creation_hooks) == 1

    def test_register_payment_creation_failure_hook(self):
        """Test registering payment_creation_failure hook."""
        client = x402Client()

        def hook(ctx):
            return None

        client.on_payment_creation_failure(hook)

        assert len(client._on_payment_creation_failure_hooks) == 1

    def test_chained_hook_registration(self):
        """Test chaining hook registration."""
        client = (
            x402Client()
            .on_before_payment_creation(lambda ctx: None)
            .on_after_payment_creation(lambda ctx: None)
            .on_payment_creation_failure(lambda ctx: None)
        )

        assert len(client._before_payment_creation_hooks) == 1
        assert len(client._after_payment_creation_hooks) == 1
        assert len(client._on_payment_creation_failure_hooks) == 1


class TestX402ClientSyncHooks:
    """Tests for x402ClientSync hook registration."""

    def test_register_before_payment_creation_hook(self):
        """Test registering before_payment_creation hook on sync client."""
        client = x402ClientSync()

        def hook(ctx):
            return None

        client.on_before_payment_creation(hook)

        assert len(client._before_payment_creation_hooks) == 1

    def test_register_all_hooks(self):
        """Test registering all hooks on sync client."""
        client = x402ClientSync()

        client.on_before_payment_creation(lambda ctx: None)
        client.on_after_payment_creation(lambda ctx: None)
        client.on_payment_creation_failure(lambda ctx: None)

        assert len(client._before_payment_creation_hooks) == 1
        assert len(client._after_payment_creation_hooks) == 1
        assert len(client._on_payment_creation_failure_hooks) == 1


def _make_payment_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def _make_payment_payload() -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"signature": "0xmock"},
        accepted=_make_payment_requirements(),
    )


def _make_payment_response_context(**kwargs) -> PaymentResponseContext:
    return PaymentResponseContext(
        payment_payload=kwargs.get("payment_payload", _make_payment_payload()),
        requirements=kwargs.get("requirements", _make_payment_requirements()),
        settle_response=kwargs.get("settle_response"),
        payment_required=kwargs.get("payment_required"),
    )


class TestOnPaymentResponseRegistration:
    def test_chaining(self):
        client = x402Client()
        result = client.on_payment_response(lambda ctx: None).on_payment_response(lambda ctx: None)
        assert result is client
        assert len(client._payment_response_hooks) == 2

    def test_sync_chaining(self):
        client = x402ClientSync()
        client.on_payment_response(lambda ctx: None)
        assert len(client._payment_response_hooks) == 1


class TestHandlePaymentResponse:
    @pytest.mark.asyncio
    async def test_returns_none_when_no_hooks(self):
        client = x402Client()
        assert await client.handle_payment_response(_make_payment_response_context()) is None

    @pytest.mark.asyncio
    async def test_passes_context_fields(self):
        client = x402Client()
        settle = SettleResponse(
            success=True,
            transaction="0xabc",
            network="eip155:8453",
        )
        ctx = _make_payment_response_context(settle_response=settle)
        received: list[PaymentResponseContext] = []

        client.on_payment_response(lambda c: received.append(c) or None)

        await client.handle_payment_response(ctx)

        assert len(received) == 1
        assert received[0].settle_response == settle
        assert received[0].payment_payload.x402_version == 2

    @pytest.mark.asyncio
    async def test_early_return_on_first_recovery(self):
        client = x402Client()
        order: list[int] = []

        client.on_payment_response(lambda ctx: order.append(1) or RecoveredResponseResult())
        client.on_payment_response(lambda ctx: order.append(2) or None)

        result = await client.handle_payment_response(_make_payment_response_context())

        assert isinstance(result, RecoveredResponseResult)
        assert order == [1]

    def test_sync_early_return_on_recovery(self):
        client = x402ClientSync()
        order: list[int] = []

        client.on_payment_response(lambda ctx: order.append(1) or RecoveredResponseResult())
        client.on_payment_response(lambda ctx: order.append(2) or None)

        result = client.handle_payment_response(_make_payment_response_context())

        assert isinstance(result, RecoveredResponseResult)
        assert order == [1]


class TestRegisterExtension:
    @pytest.mark.asyncio
    async def test_register_extension_enrich_payment_payload(self):
        class Ext:
            key = "test-ext"

            def enrich_payment_payload(self, payload, payment_required):
                payload.extensions = {**(payload.extensions or {}), "test-ext": {"enriched": True}}
                return payload

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        requirements = _make_payment_requirements()
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[requirements],
            extensions={"test-ext": {"declared": True}},
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions["test-ext"]["enriched"] is True


# =============================================================================
# get_registered_schemes Tests
# =============================================================================


class TestGetRegisteredSchemes:
    """Tests for get_registered_schemes method."""

    def test_empty_client_returns_empty_dict(self):
        """Test that empty client returns empty version dicts."""
        client = x402Client()
        registered = client.get_registered_schemes()

        assert 1 in registered
        assert 2 in registered
        assert len(registered[1]) == 0
        assert len(registered[2]) == 0

    def test_returns_scheme_info(self):
        """Test that registered schemes include scheme and network info."""
        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))

        registered = client.get_registered_schemes()

        assert len(registered[2]) == 1
        info = registered[2][0]
        assert "scheme" in info
        assert "network" in info
        assert info["scheme"] == "exact"
        assert info["network"] == "eip155:8453"

    def test_separates_v1_and_v2(self):
        """Test that V1 and V2 schemes are in separate lists."""
        client = x402Client()
        client.register("eip155:8453", MockSchemeClient())
        client.register_v1("base-sepolia", MockSchemeClientV1())

        registered = client.get_registered_schemes()

        assert len(registered[2]) == 1
        assert len(registered[1]) == 1
        assert registered[2][0]["network"] == "eip155:8453"
        assert registered[1][0]["network"] == "base-sepolia"
