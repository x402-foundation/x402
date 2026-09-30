"""Tests for x402Client.from_config() and x402ClientSync.from_config()."""

from x402 import (
    SchemeRegistration,
    prefer_network,
    x402Client,
    x402ClientConfig,
    x402ClientSync,
)


# Simple mock scheme client for testing
class MockSchemeClient:
    """Mock scheme client for testing."""

    scheme = "mock"

    def create_payment_payload(self, requirements):
        return {"mock": "payload", "network": requirements.network}


class MockSchemeClientV1:
    """Mock V1 scheme client for testing."""

    scheme = "mock-v1"

    def create_payment_payload(self, requirements):
        return {"mock": "v1-payload", "network": requirements.network}


class TestSchemeRegistration:
    """Tests for SchemeRegistration dataclass."""

    def test_default_version_is_2(self):
        """Test that x402_version defaults to 2."""
        reg = SchemeRegistration(
            network="eip155:8453",
            client=MockSchemeClient(),
        )
        assert reg.x402_version == 2

    def test_explicit_version(self):
        """Test that x402_version can be set explicitly."""
        reg = SchemeRegistration(
            network="base-sepolia",
            client=MockSchemeClientV1(),
            x402_version=1,
        )
        assert reg.x402_version == 1


class TestX402ClientConfig:
    """Tests for x402ClientConfig dataclass."""

    def test_minimal_config(self):
        """Test config with only required field."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
        )
        assert len(config.schemes) == 1
        assert config.policies is None
        assert config.payment_requirements_selector is None

    def test_full_config(self):
        """Test config with all fields."""

        def selector(v, r):
            return r[0]

        policy = prefer_network("eip155:8453")

        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
            policies=[policy],
            payment_requirements_selector=selector,
        )
        assert len(config.schemes) == 1
        assert config.policies == [policy]
        assert config.payment_requirements_selector is selector


class TestX402ClientFromConfig:
    """Tests for x402Client.from_config()."""

    def test_creates_client_with_schemes(self):
        """Test that from_config registers schemes correctly."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
                SchemeRegistration(
                    network="eip155:1",
                    client=MockSchemeClient(),
                ),
            ],
        )

        client = x402Client.from_config(config)
        registered = client.get_registered_schemes()

        assert len(registered[2]) == 2
        networks = {s["network"] for s in registered[2]}
        assert "eip155:8453" in networks
        assert "eip155:1" in networks

    def test_creates_client_with_v1_schemes(self):
        """Test that from_config registers V1 schemes correctly."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="base-sepolia",
                    client=MockSchemeClientV1(),
                    x402_version=1,
                ),
            ],
        )

        client = x402Client.from_config(config)
        registered = client.get_registered_schemes()

        assert len(registered[1]) == 1
        assert registered[1][0]["network"] == "base-sepolia"

    def test_creates_client_with_mixed_versions(self):
        """Test that from_config handles mixed V1 and V2 schemes."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                    x402_version=2,
                ),
                SchemeRegistration(
                    network="base-sepolia",
                    client=MockSchemeClientV1(),
                    x402_version=1,
                ),
            ],
        )

        client = x402Client.from_config(config)
        registered = client.get_registered_schemes()

        assert len(registered[2]) == 1
        assert len(registered[1]) == 1

    def test_creates_client_with_policies(self):
        """Test that from_config registers policies."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
            policies=[
                prefer_network("eip155:8453"),
            ],
        )

        client = x402Client.from_config(config)
        # Policies are stored internally
        assert len(client._policies) == 1


class TestX402ClientSyncFromConfig:
    """Tests for x402ClientSync.from_config()."""

    def test_creates_sync_client_with_schemes(self):
        """Test that from_config creates sync client correctly."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
        )

        client = x402ClientSync.from_config(config)

        assert isinstance(client, x402ClientSync)
        registered = client.get_registered_schemes()
        assert len(registered[2]) == 1

    def test_creates_sync_client_with_policies(self):
        """Test that from_config registers policies on sync client."""
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
            policies=[
                prefer_network("eip155:8453"),
            ],
        )

        client = x402ClientSync.from_config(config)
        assert len(client._policies) == 1


class TestFromConfigMatchesManualRegistration:
    """Test that from_config produces equivalent clients to manual registration."""

    def test_async_client_equivalence(self):
        """Test that from_config produces same result as manual registration."""
        # Manual registration
        manual_client = x402Client()
        manual_client.register("eip155:8453", MockSchemeClient())
        manual_client.register_policy(prefer_network("eip155:8453"))

        # From config
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
            policies=[prefer_network("eip155:8453")],
        )
        config_client = x402Client.from_config(config)

        # Both should have same registered schemes
        assert manual_client.get_registered_schemes() == config_client.get_registered_schemes()
        assert len(manual_client._policies) == len(config_client._policies)

    def test_sync_client_equivalence(self):
        """Test that from_config produces same result as manual registration (sync)."""
        # Manual registration
        manual_client = x402ClientSync()
        manual_client.register("eip155:8453", MockSchemeClient())
        manual_client.register_policy(prefer_network("eip155:8453"))

        # From config
        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=MockSchemeClient(),
                ),
            ],
            policies=[prefer_network("eip155:8453")],
        )
        config_client = x402ClientSync.from_config(config)

        # Both should have same registered schemes
        assert manual_client.get_registered_schemes() == config_client.get_registered_schemes()
        assert len(manual_client._policies) == len(config_client._policies)
