"""Unit tests for x402Facilitator and x402FacilitatorSync."""

import logging

import pytest

from x402 import x402Facilitator, x402FacilitatorSync
from x402.interfaces import FacilitatorExtension
from x402.schemas import (
    AbortResult,
    PaymentAbortedError,
    PaymentPayload,
    PaymentRequirements,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    SchemeNotFoundError,
    SettleResponse,
    VerifyResponse,
)

# =============================================================================
# Mock Scheme Facilitators
# =============================================================================


class MockSchemeNetworkFacilitator:
    """Mock V2 scheme network facilitator for testing."""

    scheme = "mock"
    caip_family = "eip155"

    def __init__(self, scheme: str = "mock"):
        self.scheme = scheme
        self.verify_calls: list = []
        self.settle_calls: list = []

    def verify(self, payload, requirements, context=None) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        return VerifyResponse(is_valid=True)

    def settle(self, payload, requirements, context=None) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
        )

    def get_extra(self, network: str) -> dict | None:
        return None

    def get_signers(self, network: str) -> list[str]:
        return ["eoa"]


class MockSchemeNetworkFacilitatorV1:
    """Mock V1 scheme network facilitator for testing."""

    scheme = "mock-v1"
    caip_family = "eip155"

    def __init__(self, scheme: str = "mock-v1"):
        self.scheme = scheme
        self.verify_calls: list = []
        self.settle_calls: list = []

    def verify(self, payload, requirements, context=None) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        return VerifyResponse(is_valid=True)

    def settle(self, payload, requirements, context=None) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
        )

    def get_extra(self, network: str) -> dict | None:
        return None

    def get_signers(self, network: str) -> list[str]:
        return ["eoa"]


# =============================================================================
# Registration Tests
# =============================================================================


class TestX402FacilitatorRegistration:
    """Tests for x402Facilitator scheme registration."""

    def test_register_v2_scheme(self):
        """Test registering a V2 scheme facilitator."""
        facilitator = x402Facilitator()
        mock_scheme = MockSchemeNetworkFacilitator()

        result = facilitator.register(["eip155:8453"], mock_scheme)

        # Should return self for chaining
        assert result is facilitator
        assert len(facilitator._schemes) == 1

    def test_register_multiple_networks(self):
        """Test registering a scheme for multiple networks."""
        facilitator = x402Facilitator()
        mock_scheme = MockSchemeNetworkFacilitator()

        facilitator.register(["eip155:8453", "eip155:1", "eip155:84532"], mock_scheme)

        assert len(facilitator._schemes) == 1
        scheme_data = facilitator._schemes[0]
        assert len(scheme_data.networks) == 3

    def test_register_v1_scheme(self):
        """Test registering a V1 scheme facilitator."""
        facilitator = x402Facilitator()
        mock_scheme = MockSchemeNetworkFacilitatorV1()

        facilitator.register_v1(["base-sepolia"], mock_scheme)

        assert len(facilitator._schemes_v1) == 1

    def test_chained_registration(self):
        """Test chaining registration calls."""
        facilitator = (
            x402Facilitator()
            .register(["eip155:8453"], MockSchemeNetworkFacilitator())
            .register(["solana:mainnet"], MockSchemeNetworkFacilitator("solana-exact"))
        )

        assert len(facilitator._schemes) == 2


class TestX402FacilitatorSyncRegistration:
    """Tests for x402FacilitatorSync scheme registration."""

    def test_register_v2_scheme(self):
        """Test registering a V2 scheme on sync facilitator."""
        facilitator = x402FacilitatorSync()
        mock_scheme = MockSchemeNetworkFacilitator()

        result = facilitator.register(["eip155:8453"], mock_scheme)

        assert result is facilitator
        assert len(facilitator._schemes) == 1


# =============================================================================
# Extension Registration Tests
# =============================================================================


class TestExtensionRegistration:
    """Tests for extension registration."""

    def test_register_extension(self):
        """Test registering an extension."""
        facilitator = x402Facilitator()

        result = facilitator.register_extension(FacilitatorExtension(key="bazaar"))

        assert result is facilitator
        assert "bazaar" in facilitator._extensions

    def test_register_multiple_extensions(self):
        """Test registering multiple extensions."""
        facilitator = x402Facilitator()

        facilitator.register_extension(FacilitatorExtension(key="bazaar"))
        facilitator.register_extension(FacilitatorExtension(key="other"))

        assert len(facilitator._extensions) == 2

    def test_duplicate_extension_not_added(self):
        """Test that duplicate extension is not added."""
        facilitator = x402Facilitator()

        facilitator.register_extension(FacilitatorExtension(key="bazaar"))
        facilitator.register_extension(FacilitatorExtension(key="bazaar"))

        assert len(facilitator._extensions) == 1

    def test_get_extensions(self):
        """Test get_extensions returns registered extensions."""
        facilitator = x402Facilitator()
        facilitator.register_extension(FacilitatorExtension(key="bazaar"))
        facilitator.register_extension(FacilitatorExtension(key="other"))

        extensions = facilitator.get_extensions()

        assert extensions == ["bazaar", "other"]


# =============================================================================
# get_supported Tests
# =============================================================================


class TestGetSupported:
    """Tests for get_supported method."""

    def test_empty_facilitator(self):
        """Test get_supported on empty facilitator."""
        facilitator = x402Facilitator()

        supported = facilitator.get_supported()

        assert len(supported.kinds) == 0
        assert len(supported.extensions) == 0

    def test_returns_v2_kinds(self):
        """Test that V2 schemes appear in kinds."""
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))

        supported = facilitator.get_supported()

        assert len(supported.kinds) == 1
        kind = supported.kinds[0]
        assert kind.x402_version == 2
        assert kind.scheme == "exact"
        assert kind.network == "eip155:8453"

    def test_returns_v1_kinds(self):
        """Test that V1 schemes appear in kinds."""
        facilitator = x402Facilitator()
        facilitator.register_v1(["base-sepolia"], MockSchemeNetworkFacilitatorV1())

        supported = facilitator.get_supported()

        assert len(supported.kinds) == 1
        kind = supported.kinds[0]
        assert kind.x402_version == 1
        assert kind.network == "base-sepolia"

    def test_returns_multiple_kinds_for_multiple_networks(self):
        """Test that multiple networks create multiple kinds."""
        facilitator = x402Facilitator()
        facilitator.register(
            ["eip155:8453", "eip155:1"],
            MockSchemeNetworkFacilitator("exact"),
        )

        supported = facilitator.get_supported()

        assert len(supported.kinds) == 2
        networks = {k.network for k in supported.kinds}
        assert "eip155:8453" in networks
        assert "eip155:1" in networks

    def test_returns_extensions(self):
        """Test that extensions appear in supported response."""
        facilitator = x402Facilitator()
        facilitator.register_extension(FacilitatorExtension(key="bazaar"))

        supported = facilitator.get_supported()

        assert "bazaar" in supported.extensions

    def test_returns_signers(self):
        """Test that signers are collected from facilitators."""
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator())

        supported = facilitator.get_supported()

        assert "eip155" in supported.signers
        assert "eoa" in supported.signers["eip155"]


# =============================================================================
# Hook Registration Tests
# =============================================================================


class TestX402FacilitatorHooks:
    """Tests for x402Facilitator hook registration."""

    def test_register_before_verify_hook(self):
        """Test registering before_verify hook."""
        facilitator = x402Facilitator()

        def hook(ctx):
            return None

        result = facilitator.on_before_verify(hook)

        assert result is facilitator
        assert len(facilitator._before_verify_hooks) == 1

    def test_register_after_verify_hook(self):
        """Test registering after_verify hook."""
        facilitator = x402Facilitator()

        facilitator.on_after_verify(lambda ctx: None)

        assert len(facilitator._after_verify_hooks) == 1

    def test_register_verify_failure_hook(self):
        """Test registering verify_failure hook."""
        facilitator = x402Facilitator()

        facilitator.on_verify_failure(lambda ctx: None)

        assert len(facilitator._on_verify_failure_hooks) == 1

    def test_register_settle_hooks(self):
        """Test registering settle hooks."""
        facilitator = x402Facilitator()

        facilitator.on_before_settle(lambda ctx: None)
        facilitator.on_after_settle(lambda ctx: None)
        facilitator.on_settle_failure(lambda ctx: None)

        assert len(facilitator._before_settle_hooks) == 1
        assert len(facilitator._after_settle_hooks) == 1
        assert len(facilitator._on_settle_failure_hooks) == 1

    def test_chained_hook_registration(self):
        """Test chaining hook registration."""
        facilitator = (
            x402Facilitator()
            .on_before_verify(lambda ctx: None)
            .on_after_verify(lambda ctx: None)
            .on_before_settle(lambda ctx: None)
            .on_after_settle(lambda ctx: None)
        )

        assert len(facilitator._before_verify_hooks) == 1
        assert len(facilitator._after_verify_hooks) == 1
        assert len(facilitator._before_settle_hooks) == 1
        assert len(facilitator._after_settle_hooks) == 1


class TestX402FacilitatorSyncHooks:
    """Tests for x402FacilitatorSync hook registration."""

    def test_register_all_hooks(self):
        """Test registering all hooks on sync facilitator."""
        facilitator = x402FacilitatorSync()

        facilitator.on_before_verify(lambda ctx: None)
        facilitator.on_after_verify(lambda ctx: None)
        facilitator.on_verify_failure(lambda ctx: None)
        facilitator.on_before_settle(lambda ctx: None)
        facilitator.on_after_settle(lambda ctx: None)
        facilitator.on_settle_failure(lambda ctx: None)

        assert len(facilitator._before_verify_hooks) == 1
        assert len(facilitator._after_verify_hooks) == 1
        assert len(facilitator._on_verify_failure_hooks) == 1
        assert len(facilitator._before_settle_hooks) == 1
        assert len(facilitator._after_settle_hooks) == 1
        assert len(facilitator._on_settle_failure_hooks) == 1


# =============================================================================
# Internal Helper Tests
# =============================================================================


class TestFindFacilitator:
    """Tests for _find_facilitator internal method."""

    def test_find_exact_network_match(self):
        """Test finding facilitator with exact network match."""
        facilitator = x402Facilitator()
        mock_scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(["eip155:8453"], mock_scheme)

        found = facilitator._find_facilitator("exact", "eip155:8453")

        assert found is mock_scheme

    def test_find_returns_none_for_wrong_scheme(self):
        """Test that wrong scheme returns None."""
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))

        found = facilitator._find_facilitator("other", "eip155:8453")

        assert found is None

    def test_find_returns_none_for_different_family(self):
        """Test that different network family returns None."""
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))

        # Different network family should not match
        found = facilitator._find_facilitator("exact", "solana:mainnet")

        assert found is None


class TestFindFacilitatorV1:
    """Tests for _find_facilitator_v1 internal method."""

    def test_find_v1_facilitator(self):
        """Test finding V1 facilitator."""
        facilitator = x402Facilitator()
        mock_scheme = MockSchemeNetworkFacilitatorV1("exact-v1")
        facilitator.register_v1(["base-sepolia"], mock_scheme)

        found = facilitator._find_facilitator_v1("exact-v1", "base-sepolia")

        assert found is mock_scheme

    def test_v1_and_v2_are_separate(self):
        """Test that V1 and V2 facilitators are separate."""
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))
        facilitator.register_v1(["base-sepolia"], MockSchemeNetworkFacilitatorV1("exact"))

        # V2 lookup shouldn't find V1
        assert facilitator._find_facilitator("exact", "base-sepolia") is None
        # V1 lookup shouldn't find V2
        assert facilitator._find_facilitator_v1("exact", "eip155:8453") is None


def _requirements(network: str, scheme: str = "exact") -> PaymentRequirements:
    return PaymentRequirements(
        scheme=scheme,
        network=network,
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def _payload(requirements: PaymentRequirements) -> PaymentPayload:
    return PaymentPayload(x402_version=2, payload={}, accepted=requirements)


class TestMixedNamespaceRegistration:
    def test_keeps_namespace_wildcard_when_mixed_with_another_namespace(self):
        facilitator = x402FacilitatorSync()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(
            ["stellar:testnet", "stellar:futurenet", "eip155:8453"],
            scheme,
        )

        stellar = _requirements("stellar:pubnet")
        stellar_result = facilitator.verify(_payload(stellar), stellar)
        assert stellar_result.is_valid is True

        evm = _requirements("eip155:8453")
        evm_result = facilitator.verify(_payload(evm), evm)
        assert evm_result.is_valid is True

        unlisted_evm = _requirements("eip155:11155111")
        with pytest.raises(
            SchemeNotFoundError,
            match="No scheme 'exact' registered for network 'eip155:11155111'",
        ):
            facilitator.verify(_payload(unlisted_evm), unlisted_evm)

        unknown = _requirements("solana:mainnet")
        with pytest.raises(
            SchemeNotFoundError,
            match="No scheme 'exact' registered for network 'solana:mainnet'",
        ):
            facilitator.verify(_payload(unknown), unknown)

    def test_derives_independent_wildcards_for_two_namespaces(self):
        facilitator = x402FacilitatorSync()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(
            ["stellar:testnet", "stellar:futurenet", "eip155:8453", "eip155:1"],
            scheme,
        )

        stellar = _requirements("stellar:pubnet")
        stellar_result = facilitator.verify(_payload(stellar), stellar)
        assert stellar_result.is_valid is True

        evm = _requirements("eip155:11155111")
        evm_result = facilitator.verify(_payload(evm), evm)
        assert evm_result.is_valid is True
        assert len(scheme.verify_calls) == 2

    def test_advertises_each_network_once_for_mixed_namespace_registration(self):
        facilitator = x402FacilitatorSync()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(
            ["stellar:testnet", "stellar:pubnet", "eip155:8453"],
            scheme,
        )

        kinds = facilitator.get_supported().kinds
        assert len(kinds) == 3
        networks_seen = [kind.network for kind in kinds]
        assert len(set(networks_seen)) == 3
        assert sorted(networks_seen) == ["eip155:8453", "stellar:pubnet", "stellar:testnet"]

        stellar = _requirements("stellar:testnet")
        facilitator.verify(_payload(stellar), stellar)
        evm = _requirements("eip155:8453")
        facilitator.verify(_payload(evm), evm)


# =============================================================================
# Hook Error Isolation Tests
# =============================================================================


class FailingSchemeNetworkFacilitator(MockSchemeNetworkFacilitator):
    """Mock scheme whose verify and settle raise."""

    def verify(self, payload, requirements, context=None) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        raise RuntimeError("verification rpc error")

    def settle(self, payload, requirements, context=None) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        raise RuntimeError("settlement rpc error")


RECOVERED_VERIFY = VerifyResponse(is_valid=True, payer="0xRecovered")
RECOVERED_SETTLE = SettleResponse(success=True, transaction="0xRecoveredTx", network="eip155:8453")


def _crash(ctx):
    raise RuntimeError("observer crashed")


async def _async_crash(ctx):
    raise RuntimeError("observer crashed")


class TestX402FacilitatorHookErrorIsolation:
    """A throwing advisory hook must not change the verify/settle outcome."""

    @pytest.mark.asyncio
    async def test_settle_resolves_when_after_settle_hook_throws(self, caplog):
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        failure_hook_called = False

        def on_failure(ctx):
            nonlocal failure_hook_called
            failure_hook_called = True

        facilitator.on_after_settle(_async_crash)
        facilitator.on_settle_failure(on_failure)

        with caplog.at_level(logging.WARNING):
            result = await facilitator.settle(_payload(requirements), requirements)

        # Settlement already executed onchain: the caller must still receive it.
        assert result.success is True
        assert result.transaction == "0xmock"
        # A throwing observer is not a settlement failure.
        assert failure_hook_called is False
        assert "Facilitator settle after hook threw: observer crashed" in caplog.text

    @pytest.mark.asyncio
    async def test_verify_resolves_when_after_verify_hook_throws(self):
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        failure_hook_called = False

        def on_failure(ctx):
            nonlocal failure_hook_called
            failure_hook_called = True

        facilitator.on_after_verify(_async_crash)
        facilitator.on_verify_failure(on_failure)

        result = await facilitator.verify(_payload(requirements), requirements)

        assert result.is_valid is True
        assert failure_hook_called is False

    @pytest.mark.asyncio
    async def test_later_verify_failure_hook_recovers_when_earlier_one_throws(self):
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], FailingSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        facilitator.on_verify_failure(_async_crash).on_verify_failure(
            lambda ctx: RecoveredVerifyResult(result=RECOVERED_VERIFY)
        )

        result = await facilitator.verify(_payload(requirements), requirements)

        assert result == RECOVERED_VERIFY

    @pytest.mark.asyncio
    async def test_later_settle_failure_hook_recovers_when_earlier_one_throws(self):
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], FailingSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        facilitator.on_settle_failure(_async_crash).on_settle_failure(
            lambda ctx: RecoveredSettleResult(result=RECOVERED_SETTLE)
        )

        result = await facilitator.settle(_payload(requirements), requirements)

        assert result == RECOVERED_SETTLE

    @pytest.mark.asyncio
    async def test_original_error_is_raised_when_failure_hooks_throw_without_recovering(self):
        facilitator = x402Facilitator()
        facilitator.register(["eip155:8453"], FailingSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        facilitator.on_verify_failure(_async_crash)
        facilitator.on_settle_failure(_async_crash)

        with pytest.raises(RuntimeError, match="verification rpc error"):
            await facilitator.verify(_payload(requirements), requirements)
        with pytest.raises(RuntimeError, match="settlement rpc error"):
            await facilitator.settle(_payload(requirements), requirements)


class TestX402FacilitatorGateHookErrors:
    """Gate hooks (before_*) keep failing closed."""

    @pytest.mark.asyncio
    async def test_verify_fails_closed_when_before_verify_hook_throws(self):
        facilitator = x402Facilitator()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(["eip155:8453"], scheme)
        requirements = _requirements("eip155:8453")

        execution_order = []
        failure_hook_called = False

        def first_gate(ctx):
            execution_order.append(1)
            raise RuntimeError("gate check failed")

        def second_gate(ctx):
            execution_order.append(2)

        def on_failure(ctx):
            nonlocal failure_hook_called
            failure_hook_called = True
            return RecoveredVerifyResult(result=RECOVERED_VERIFY)

        facilitator.on_before_verify(first_gate).on_before_verify(second_gate)
        facilitator.on_verify_failure(on_failure)

        # A gate that could not complete its check must not authorize the payment.
        with pytest.raises(RuntimeError, match="gate check failed"):
            await facilitator.verify(_payload(requirements), requirements)
        assert execution_order == [1]
        assert scheme.verify_calls == []
        # Recovery hooks cannot override a failed gate.
        assert failure_hook_called is False

    @pytest.mark.asyncio
    async def test_settle_fails_closed_when_before_settle_hook_throws(self):
        facilitator = x402Facilitator()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(["eip155:8453"], scheme)
        requirements = _requirements("eip155:8453")

        execution_order = []
        failure_hook_called = False

        def first_gate(ctx):
            execution_order.append(1)
            raise RuntimeError("gate check failed")

        def second_gate(ctx):
            execution_order.append(2)

        def on_failure(ctx):
            nonlocal failure_hook_called
            failure_hook_called = True
            return RecoveredSettleResult(result=RECOVERED_SETTLE)

        facilitator.on_before_settle(first_gate).on_before_settle(second_gate)
        facilitator.on_settle_failure(on_failure)

        with pytest.raises(RuntimeError, match="gate check failed"):
            await facilitator.settle(_payload(requirements), requirements)
        assert execution_order == [1]
        assert scheme.settle_calls == []
        assert failure_hook_called is False

    @pytest.mark.asyncio
    async def test_before_hook_abort_still_raises(self):
        facilitator = x402Facilitator()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(["eip155:8453"], scheme)
        requirements = _requirements("eip155:8453")

        facilitator.on_before_verify(lambda ctx: AbortResult(reason="blocked"))
        facilitator.on_before_settle(lambda ctx: AbortResult(reason="blocked"))

        with pytest.raises(PaymentAbortedError):
            await facilitator.verify(_payload(requirements), requirements)
        with pytest.raises(PaymentAbortedError):
            await facilitator.settle(_payload(requirements), requirements)
        assert scheme.verify_calls == []
        assert scheme.settle_calls == []


class TestX402FacilitatorSyncHookErrorIsolation:
    """Sync facilitator mirrors the async isolation and gate behavior."""

    def test_settle_resolves_when_after_settle_hook_throws(self, caplog):
        facilitator = x402FacilitatorSync()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        failure_hook_called = False

        def on_failure(ctx):
            nonlocal failure_hook_called
            failure_hook_called = True

        facilitator.on_after_settle(_crash)
        facilitator.on_settle_failure(on_failure)

        with caplog.at_level(logging.WARNING):
            result = facilitator.settle(_payload(requirements), requirements)

        assert result.success is True
        assert failure_hook_called is False
        assert "Facilitator settle after hook threw: observer crashed" in caplog.text

    def test_verify_resolves_when_after_verify_hook_throws(self):
        facilitator = x402FacilitatorSync()
        facilitator.register(["eip155:8453"], MockSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        facilitator.on_after_verify(_crash)

        result = facilitator.verify(_payload(requirements), requirements)

        assert result.is_valid is True

    def test_later_failure_hooks_recover_when_earlier_one_throws(self):
        facilitator = x402FacilitatorSync()
        facilitator.register(["eip155:8453"], FailingSchemeNetworkFacilitator("exact"))
        requirements = _requirements("eip155:8453")

        facilitator.on_verify_failure(_crash).on_verify_failure(
            lambda ctx: RecoveredVerifyResult(result=RECOVERED_VERIFY)
        )
        facilitator.on_settle_failure(_crash).on_settle_failure(
            lambda ctx: RecoveredSettleResult(result=RECOVERED_SETTLE)
        )

        assert facilitator.verify(_payload(requirements), requirements) == RECOVERED_VERIFY
        assert facilitator.settle(_payload(requirements), requirements) == RECOVERED_SETTLE

    def test_gate_hooks_fail_closed_when_before_hook_throws(self):
        facilitator = x402FacilitatorSync()
        scheme = MockSchemeNetworkFacilitator("exact")
        facilitator.register(["eip155:8453"], scheme)
        requirements = _requirements("eip155:8453")

        failure_hook_called = False

        def on_failure(ctx):
            nonlocal failure_hook_called
            failure_hook_called = True

        facilitator.on_before_verify(_crash).on_before_settle(_crash)
        facilitator.on_verify_failure(on_failure).on_settle_failure(on_failure)

        with pytest.raises(RuntimeError, match="observer crashed"):
            facilitator.verify(_payload(requirements), requirements)
        with pytest.raises(RuntimeError, match="observer crashed"):
            facilitator.settle(_payload(requirements), requirements)
        assert scheme.verify_calls == []
        assert scheme.settle_calls == []
        assert failure_hook_called is False
