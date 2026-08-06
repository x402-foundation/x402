"""Core integration tests - parameterized for both sync and async classes.

These tests verify the core payment flow works correctly. The same test logic
runs against both sync (x402ClientSync, etc.) and async (x402Client, etc.)
implementations using pytest parameterization.

Async-specific behavior (hooks with actual async work, timeouts) is tested
separately in test_async_behavior.py.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import pytest

from x402 import (
    prefer_network,
    x402Client,
    x402ClientSync,
    x402Facilitator,
    x402FacilitatorSync,
    x402ResourceServer,
    x402ResourceServerSync,
)
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
    VerifyResponse,
)

from ..mocks import (
    CashFacilitatorClient,
    CashFacilitatorClientSync,
    CashSchemeNetworkClient,
    CashSchemeNetworkFacilitator,
    CashSchemeNetworkServer,
    build_cash_payment_requirements,
)

if TYPE_CHECKING:
    from x402.schemas import PaymentPayloadV1, PaymentRequiredV1


# =============================================================================
# Test Fixture Wrappers
# =============================================================================
# These wrappers unify sync and async interfaces so the same test logic works.


@dataclass
class ComponentsFixture:
    """Container for test components (sync or async versions)."""

    client: x402Client | x402ClientSync
    facilitator: x402Facilitator | x402FacilitatorSync
    server: x402ResourceServer | x402ResourceServerSync
    is_async: bool

    def create_payment_required_response(
        self,
        requirements: list[PaymentRequirements],
        resource: ResourceInfo | None = None,
        error: str | None = None,
        extensions: dict[str, Any] | None = None,
    ) -> PaymentRequired:
        """Build 402 response, handling sync/async uniformly."""
        if self.is_async:
            return asyncio.run(
                self.server.create_payment_required_response(  # type: ignore
                    requirements,
                    resource,
                    error,
                    extensions,
                )
            )
        return self.server.create_payment_required_response(  # type: ignore
            requirements,
            resource,
            error,
            extensions,
        )

    def create_payment_payload(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
    ) -> PaymentPayload | PaymentPayloadV1:
        """Create payment payload, handling sync/async uniformly."""
        if self.is_async:
            return asyncio.run(
                self.client.create_payment_payload(payment_required)  # type: ignore
            )
        return self.client.create_payment_payload(payment_required)  # type: ignore

    def verify_payment(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify payment, handling sync/async uniformly."""
        if self.is_async:
            return asyncio.run(
                self.server.verify_payment(payload, requirements)  # type: ignore
            )
        return self.server.verify_payment(payload, requirements)  # type: ignore

    def settle_payment(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle payment, handling sync/async uniformly."""
        if self.is_async:
            return asyncio.run(
                self.server.settle_payment(payload, requirements)  # type: ignore
            )
        return self.server.settle_payment(payload, requirements)  # type: ignore

    def facilitator_verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify via facilitator directly."""
        if self.is_async:
            return asyncio.run(
                self.facilitator.verify(payload, requirements)  # type: ignore
            )
        return self.facilitator.verify(payload, requirements)  # type: ignore

    def facilitator_settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle via facilitator directly."""
        if self.is_async:
            return asyncio.run(
                self.facilitator.settle(payload, requirements)  # type: ignore
            )
        return self.facilitator.settle(payload, requirements)  # type: ignore


def _create_sync_components() -> ComponentsFixture:
    """Create sync test components."""
    facilitator = x402FacilitatorSync().register(
        ["x402:cash"],
        CashSchemeNetworkFacilitator(),
    )
    facilitator_client = CashFacilitatorClientSync(facilitator)

    client = x402ClientSync().register(
        "x402:cash",
        CashSchemeNetworkClient("John"),
    )

    server = x402ResourceServerSync(facilitator_client)
    server.register("x402:cash", CashSchemeNetworkServer())
    server.initialize()

    return ComponentsFixture(
        client=client,
        facilitator=facilitator,
        server=server,
        is_async=False,
    )


def _create_async_components() -> ComponentsFixture:
    """Create async test components."""
    facilitator = x402Facilitator().register(
        ["x402:cash"],
        CashSchemeNetworkFacilitator(),
    )
    facilitator_client = CashFacilitatorClient(facilitator)

    client = x402Client().register(
        "x402:cash",
        CashSchemeNetworkClient("John"),
    )

    server = x402ResourceServer(facilitator_client)
    server.register("x402:cash", CashSchemeNetworkServer())
    server.initialize()

    return ComponentsFixture(
        client=client,
        facilitator=facilitator,
        server=server,
        is_async=True,
    )


@pytest.fixture(params=["sync", "async"])
def components(request: pytest.FixtureRequest) -> ComponentsFixture:
    """Fixture that provides both sync and async component sets."""
    if request.param == "sync":
        return _create_sync_components()
    return _create_async_components()


# =============================================================================
# Core Payment Flow Tests
# =============================================================================


class TestCorePaymentFlow:
    """Core payment flow tests - run against both sync and async implementations."""

    def test_complete_payment_flow_verify_and_settle(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test complete flow: client creates payload, server verifies and settles."""
        # Server builds PaymentRequired response
        accepts = [build_cash_payment_requirements("Company Co.", "USD", "1")]
        resource = ResourceInfo(
            url="https://company.co",
            description="Company Co. resource",
            mime_type="application/json",
        )
        payment_required = components.create_payment_required_response(
            accepts,
            resource,
        )

        # Client responds with PaymentPayload
        payment_payload = components.create_payment_payload(payment_required)

        # Server maps payment payload to requirements
        accepted = components.server.find_matching_requirements(accepts, payment_payload)
        assert accepted is not None

        # Server verifies the payment
        verify_response = components.verify_payment(payment_payload, accepted)
        assert verify_response.is_valid is True
        assert verify_response.payer == "~John"

        # Server settles the payment
        settle_response = components.settle_payment(payment_payload, accepted)
        assert settle_response.success is True
        assert "John transferred 1 USD to Company Co." in settle_response.transaction

    def test_client_creates_valid_payment_payload(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test that client creates a properly structured payment payload."""
        accepts = [build_cash_payment_requirements("Merchant", "USD", "10")]
        payment_required = components.create_payment_required_response(accepts)

        payload = components.create_payment_payload(payment_required)

        assert payload.x402_version == 2
        assert payload.accepted.scheme == "cash"
        assert payload.accepted.network == "x402:cash"
        assert payload.accepted.amount == "10"
        assert payload.accepted.pay_to == "Merchant"
        assert payload.payload["signature"] == "~John"
        assert payload.payload["name"] == "John"
        assert "validUntil" in payload.payload

    def test_facilitator_verify_and_settle_directly(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test that facilitator can verify and settle payments directly."""
        requirements = build_cash_payment_requirements("Recipient", "USD", "5")
        payment_required = components.create_payment_required_response([requirements])
        payload = components.create_payment_payload(payment_required)

        # Verify directly with facilitator
        verify_result = components.facilitator_verify(payload, payload.accepted)
        assert verify_result.is_valid is True

        # Settle directly with facilitator
        settle_result = components.facilitator_settle(payload, payload.accepted)
        assert settle_result.success is True
        assert settle_result.network == "x402:cash"

    def test_invalid_signature_fails_verification(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test that invalid signatures fail verification."""
        requirements = build_cash_payment_requirements("Recipient", "USD", "5")
        payment_required = components.create_payment_required_response([requirements])
        payload = components.create_payment_payload(payment_required)

        # Tamper with the payload
        payload.payload["signature"] = "~Hacker"

        verify_result = components.verify_payment(payload, requirements)
        assert verify_result.is_valid is False
        assert verify_result.invalid_reason == "invalid_signature"

    def test_find_matching_requirements_returns_none_for_mismatch(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test that findMatchingRequirements returns None when no match."""
        accepts = [build_cash_payment_requirements("Company A", "USD", "1")]
        payment_required = components.create_payment_required_response(accepts)
        payload = components.create_payment_payload(payment_required)

        # Try to match against different requirements
        different_accepts = [build_cash_payment_requirements("Company B", "USD", "99")]
        result = components.server.find_matching_requirements(different_accepts, payload)

        assert result is None

    def test_facilitator_get_supported(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test that facilitator returns supported kinds."""
        supported = components.facilitator.get_supported()

        assert len(supported.kinds) == 1
        assert supported.kinds[0].scheme == "cash"
        assert supported.kinds[0].network == "x402:cash"
        assert supported.kinds[0].x402_version == 2

    def test_multiple_payment_requirements_selects_first(
        self,
        components: ComponentsFixture,
    ) -> None:
        """Test server with multiple payment requirements selects first."""
        accepts = [
            build_cash_payment_requirements("Merchant A", "USD", "10"),
            build_cash_payment_requirements("Merchant B", "EUR", "20"),
        ]
        payment_required = components.create_payment_required_response(accepts)

        payload = components.create_payment_payload(payment_required)

        # Should match the first one
        assert payload.accepted.pay_to == "Merchant A"
        assert payload.accepted.amount == "10"


class TestServerInitialization:
    """Tests for server initialization - run against both sync and async."""

    @pytest.fixture(params=["sync", "async"])
    def uninitialized_server(
        self, request: pytest.FixtureRequest
    ) -> x402ResourceServer | x402ResourceServerSync:
        """Fixture that provides uninitialized servers."""
        if request.param == "sync":
            facilitator = x402FacilitatorSync().register(
                ["x402:cash"],
                CashSchemeNetworkFacilitator(),
            )
            facilitator_client = CashFacilitatorClientSync(facilitator)
            server = x402ResourceServerSync(facilitator_client)
        else:
            facilitator = x402Facilitator().register(
                ["x402:cash"],
                CashSchemeNetworkFacilitator(),
            )
            facilitator_client = CashFacilitatorClient(facilitator)
            server = x402ResourceServer(facilitator_client)

        server.register("x402:cash", CashSchemeNetworkServer())
        # Deliberately NOT calling initialize()
        return server

    def test_server_requires_initialization(
        self,
        uninitialized_server: x402ResourceServer | x402ResourceServerSync,
    ) -> None:
        """Test that server raises error if not initialized."""
        requirements = build_cash_payment_requirements("Test", "USD", "1")
        if isinstance(uninitialized_server, x402ResourceServer):
            payment_required = asyncio.run(
                uninitialized_server.create_payment_required_response([requirements])
            )
        else:
            payment_required = uninitialized_server.create_payment_required_response([requirements])

        # Create a valid client to make payload
        client = x402ClientSync().register("x402:cash", CashSchemeNetworkClient("Test"))
        payload = client.create_payment_payload(payment_required)

        with pytest.raises(RuntimeError, match="not initialized"):
            if isinstance(uninitialized_server, x402ResourceServerSync):
                uninitialized_server.verify_payment(payload, requirements)
            else:
                asyncio.run(uninitialized_server.verify_payment(payload, requirements))


class TestClientPolicies:
    """Tests for client payment policies - run against both sync and async."""

    def test_prefer_network_policy(self, components: ComponentsFixture) -> None:
        """Test that prefer_network policy affects requirement selection."""
        # Create new client with policy
        if components.is_async:
            client = (
                x402Client()
                .register("x402:cash", CashSchemeNetworkClient("John"))
                .register("x402:other", CashSchemeNetworkClient("John"))
                .register_policy(prefer_network("x402:other"))
            )
        else:
            client = (
                x402ClientSync()
                .register("x402:cash", CashSchemeNetworkClient("John"))
                .register("x402:other", CashSchemeNetworkClient("John"))
                .register_policy(prefer_network("x402:other"))
            )

        # Create requirements (only x402:cash is supported by facilitator)
        accepts = [build_cash_payment_requirements("Test", "USD", "1")]
        payment_required = components.create_payment_required_response(accepts)

        if components.is_async:
            payload = asyncio.run(
                client.create_payment_payload(payment_required)  # type: ignore
            )
        else:
            payload = client.create_payment_payload(payment_required)  # type: ignore

        # Should still select x402:cash since it's the only supported one
        assert payload.accepted.network == "x402:cash"


class TestSyncHooks:
    """Tests for sync hooks - these apply to both sync and async classes."""

    def test_client_after_payment_creation_hook(self, components: ComponentsFixture) -> None:
        """Test that after_payment_creation hook is called."""
        hook_called = False
        received_payload = None

        def after_hook(context: Any) -> None:
            nonlocal hook_called, received_payload
            hook_called = True
            received_payload = context.payment_payload

        # Register hook on a fresh client
        if components.is_async:
            client = (
                x402Client()
                .register("x402:cash", CashSchemeNetworkClient("John"))
                .on_after_payment_creation(after_hook)
            )
        else:
            client = (
                x402ClientSync()
                .register("x402:cash", CashSchemeNetworkClient("John"))
                .on_after_payment_creation(after_hook)
            )

        accepts = [build_cash_payment_requirements("Test", "USD", "1")]
        payment_required = components.create_payment_required_response(accepts)

        if components.is_async:
            payload = asyncio.run(
                client.create_payment_payload(payment_required)  # type: ignore
            )
        else:
            payload = client.create_payment_payload(payment_required)  # type: ignore

        assert hook_called is True
        assert received_payload is not None
        assert received_payload.accepted.pay_to == "Test"
        assert payload == received_payload

    def test_server_after_verify_hook(self, components: ComponentsFixture) -> None:
        """Test that after_verify hook is called on successful verification."""
        hook_called = False
        received_result = None

        def after_hook(context: Any) -> None:
            nonlocal hook_called, received_result
            hook_called = True
            received_result = context.result

        components.server.on_after_verify(after_hook)

        accepts = [build_cash_payment_requirements("Test", "USD", "1")]
        payment_required = components.create_payment_required_response(accepts)
        payload = components.create_payment_payload(payment_required)

        components.verify_payment(payload, accepts[0])

        assert hook_called is True
        assert received_result is not None
        assert received_result.is_valid is True
