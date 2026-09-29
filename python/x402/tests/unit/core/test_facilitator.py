"""Unit tests for x402Facilitator and x402FacilitatorSync."""

from x402 import x402Facilitator, x402FacilitatorSync
from x402.interfaces import FacilitatorExtension
from x402.schemas import SettleResponse, VerifyResponse

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

    def test_find_with_wildcard_pattern(self):
        """Test finding facilitator with wildcard network pattern."""
        facilitator = x402Facilitator()
        mock_scheme = MockSchemeNetworkFacilitator("exact")
        # Register with wildcard pattern (derived from single network)
        facilitator.register(["eip155:8453"], mock_scheme)

        # Exact match should work
        assert facilitator._find_facilitator("exact", "eip155:8453") is mock_scheme


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
