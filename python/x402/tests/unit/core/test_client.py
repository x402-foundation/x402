"""Unit tests for x402Client and x402ClientSync - manual registration and policies."""

import pytest

from x402 import (
    SchemeRegistration,
    prefer_network,
    x402Client,
    x402ClientConfig,
    x402ClientSync,
)
from x402.schemas import (
    NoMatchingRequirementsError,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
)
from x402.schemas.hooks import PaymentResponseContext, RecoveredResponseResult
from x402.schemas.v1 import PaymentRequiredV1, PaymentRequirementsV1

# =============================================================================
# Mock Scheme Clients
# =============================================================================


class MockSchemeClient:
    """Mock V2 scheme client for testing."""

    scheme = "mock"

    def __init__(self, scheme: str = "mock"):
        self.scheme = scheme
        self.create_calls: list = []
        # Treat any asset as a recognized default so non-spend-control tests pass
        # the default allowlist (USD cap still applies unless overridden).
        self.find_default_asset = lambda asset, _network=None: {
            "asset": asset,
            "decimals": 6,
            "symbol": "MOCK",
        }

    def create_payment_payload(self, requirements):
        self.create_calls.append(requirements)
        return {"mock": "payload", "network": requirements.network}

    def set_find_default_asset(self, lookup):
        """Set ``find_default_asset`` for spend-control tests."""
        if callable(lookup):
            self.find_default_asset = lookup
        else:
            self.find_default_asset = lambda asset, _network=None, entry=lookup: entry

    def clear_find_default_asset(self):
        """Clear ``find_default_asset`` (scheme does not participate in spend controls)."""
        self.find_default_asset = None


class MockSchemeClientV1:
    """Mock V1 scheme client for testing."""

    scheme = "mock-v1"

    def __init__(self, scheme: str = "mock-v1"):
        self.scheme = scheme
        self.find_default_asset = lambda asset, _network=None: {
            "asset": asset,
            "decimals": 6,
            "symbol": "MOCK",
        }

    def create_payment_payload(self, requirements):
        return {"mock": "v1-payload", "network": requirements.network}

    def set_find_default_asset(self, lookup):
        if callable(lookup):
            self.find_default_asset = lookup
        else:
            self.find_default_asset = lambda asset, _network=None, entry=lookup: entry

    def clear_find_default_asset(self):
        self.find_default_asset = None


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


class TestPaymentCreationFailureHooks:
    @pytest.mark.asyncio
    async def test_after_hook_error_runs_async_failure_hook(self):
        client = x402Client().register("eip155:8453", MockSchemeClient("exact"))
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
        )
        after_error = RuntimeError("after hook failed")
        failure_errors: list[Exception] = []

        def after_hook(ctx):
            raise after_error

        def failure_hook(ctx):
            failure_errors.append(ctx.error)

        client.on_after_payment_creation(after_hook)
        client.on_payment_creation_failure(failure_hook)

        with pytest.raises(RuntimeError, match="after hook failed"):
            await client.create_payment_payload(payment_required)

        assert failure_errors == [after_error]

    def test_after_hook_error_runs_sync_failure_hook(self):
        client = x402ClientSync().register("eip155:8453", MockSchemeClient("exact"))
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
        )
        after_error = RuntimeError("after hook failed")
        failure_errors: list[Exception] = []

        def after_hook(ctx):
            raise after_error

        def failure_hook(ctx):
            failure_errors.append(ctx.error)

        client.on_after_payment_creation(after_hook)
        client.on_payment_creation_failure(failure_hook)

        with pytest.raises(RuntimeError, match="after hook failed"):
            client.create_payment_payload(payment_required)

        assert failure_errors == [after_error]


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

    @pytest.mark.asyncio
    async def test_merges_conflicting_array_fields_instead_of_replacing(self):
        class Ext:
            key = "builder-code"

            def enrich_payment_payload(self, payload, payment_required):
                extensions = dict(payload.extensions or {})
                extensions["builder-code"] = {"info": {"s": ["bc_shared", "bc_client"]}}
                return payload.model_copy(update={"extensions": extensions})

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
            extensions={
                "builder-code": {
                    "info": {"a": "bc_app", "s": ["bc_server", "bc_shared"]},
                    "schema": {"type": "object"},
                }
            },
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions["builder-code"] == {
            "info": {"a": "bc_app", "s": ["bc_shared", "bc_client", "bc_server"]},
            "schema": {"type": "object"},
        }

    @pytest.mark.asyncio
    async def test_merges_a_scalar_field_against_an_array_on_the_other_side(self):
        class Ext:
            key = "builder-code"

            def enrich_payment_payload(self, payload, payment_required):
                extensions = dict(payload.extensions or {})
                extensions["builder-code"] = {"info": {"s": ["bc_client"]}}
                return payload.model_copy(update={"extensions": extensions})

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
            extensions={
                "builder-code": {
                    "info": {"a": "bc_app", "s": "bc_server"},
                    "schema": {"type": "object"},
                }
            },
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions["builder-code"] == {
            "info": {"a": "bc_app", "s": ["bc_client", "bc_server"]},
            "schema": {"type": "object"},
        }

    @pytest.mark.asyncio
    async def test_dedupes_repeated_entries_within_a_single_side_of_a_merged_array_field(self):
        class Ext:
            key = "builder-code"

            def enrich_payment_payload(self, payload, payment_required):
                extensions = dict(payload.extensions or {})
                extensions["builder-code"] = {"info": {"s": ["bc_client", "bc_client"]}}
                return payload.model_copy(update={"extensions": extensions})

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
            extensions={
                "builder-code": {
                    "info": {"a": "bc_app", "s": ["bc_server", "bc_server"]},
                    "schema": {"type": "object"},
                }
            },
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions["builder-code"] == {
            "info": {"a": "bc_app", "s": ["bc_client", "bc_server"]},
            "schema": {"type": "object"},
        }

    @pytest.mark.asyncio
    async def test_keeps_the_server_array_for_a_non_additive_extension_field(self):
        # Array concatenation is scoped to _ADDITIVE_LIST_INFO_FIELDS (builder-code's
        # "s"); other extensions' conflicting list fields must keep the server's
        # value, matching x402ResourceServer's exact-match requirement for them.
        class Ext:
            key = "sign-in-with-x"

            def enrich_payment_payload(self, payload, payment_required):
                extensions = dict(payload.extensions or {})
                extensions["sign-in-with-x"] = {"info": {"resources": ["https://evil.example.com"]}}
                return payload.model_copy(update={"extensions": extensions})

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
            extensions={
                "sign-in-with-x": {"info": {"resources": ["https://api.example.com/data"]}}
            },
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions["sign-in-with-x"] == {
            "info": {"resources": ["https://api.example.com/data"]}
        }

    @pytest.mark.asyncio
    async def test_register_extension_enriches_without_server_declaration(self):
        class Ext:
            key = "clientOwnedExtension"

            def enrich_payment_payload(self, payload, payment_required):
                extensions = dict(payload.extensions or {})
                extensions["clientOwnedExtension"] = {"info": {"s": "client_data"}}
                return payload.model_copy(update={"extensions": extensions})

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
            extensions={},
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions["clientOwnedExtension"] == {"info": {"s": "client_data"}}

    @pytest.mark.asyncio
    async def test_server_gated_extension_noops_without_declaration(self):
        class Ext:
            key = "testGasSponsoring"

            def enrich_payment_payload(self, payload, payment_required):
                if not payment_required.extensions or "testGasSponsoring" not in (
                    payment_required.extensions
                ):
                    return payload
                extensions = dict(payload.extensions or {})
                extensions["testGasSponsoring"] = {"enriched": True}
                return payload.model_copy(update={"extensions": extensions})

        client = x402Client()
        client.register("eip155:8453", MockSchemeClient("exact"))
        client.register_extension(Ext())

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[_make_payment_requirements()],
            extensions={"other-extension": {}},
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is None or "testGasSponsoring" not in payload.extensions


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


# =============================================================================
# Spend Controls
# =============================================================================


class TestSpendControls:
    network = "eip155:8453"
    usdc = {
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "decimals": 6,
        "symbol": "USDC",
    }
    usdt = {
        "asset": "0xUsdTSecondaryAsset0000000000000000000001",
        "decimals": 6,
        "symbol": "USDT",
    }
    m_usd = {
        "asset": "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
        "decimals": 18,
        "symbol": "mUSD",
    }

    def _req(self, *, asset: str, amount: str, network: str | None = None, scheme: str = "exact"):
        return PaymentRequirements(
            scheme=scheme,
            network=network or self.network,
            asset=asset,
            amount=amount,
            pay_to="0xpay",
            max_timeout_seconds=60,
        )

    def _required(self, *accepts):
        return PaymentRequired(x402_version=2, accepts=list(accepts))

    def _client_with_default_asset(self, entry=None, controls=None):
        entry = entry or self.usdc
        mock_client = MockSchemeClient("exact")
        mock_client.set_find_default_asset(
            lambda asset, _network, e=entry: e if asset.lower() == e["asset"].lower() else None
        )
        client = x402Client()
        client.register(self.network, mock_client)
        if controls is not None:
            client.set_spend_controls(controls)
        return client, mock_client

    @pytest.mark.asyncio
    async def test_allows_payment_at_or_below_default_usd_cap(self):
        client, mock_client = self._client_with_default_asset()
        await client.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="1000000"))
        )
        assert len(mock_client.create_calls) == 1

    @pytest.mark.asyncio
    async def test_rejects_payment_above_default_usd_cap(self):
        client, _ = self._client_with_default_asset()
        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client.create_payment_payload(
                self._required(self._req(asset=self.usdc["asset"], amount="1000001"))
            )

    @pytest.mark.asyncio
    async def test_picks_affordable_accept_when_mixed_offer(self):
        client, mock_client = self._client_with_default_asset()
        await client.create_payment_payload(
            self._required(
                self._req(asset=self.usdc["asset"], amount="50000000"),
                self._req(asset=self.usdc["asset"], amount="500000"),
            )
        )
        assert mock_client.create_calls[0].amount == "500000"

    @pytest.mark.asyncio
    async def test_caps_second_usd_asset_on_same_network(self):
        mock_client = MockSchemeClient("exact")
        usdc, usdt = self.usdc, self.usdt

        def lookup(asset, _network):
            lower = asset.lower()
            if lower == usdc["asset"].lower():
                return usdc
            if lower == usdt["asset"].lower():
                return usdt
            return None

        mock_client.set_find_default_asset(lookup)
        client = x402Client()
        client.register(self.network, mock_client)

        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client.create_payment_payload(
                self._required(self._req(asset=usdt["asset"], amount="2000000"))
            )

    @pytest.mark.asyncio
    async def test_rejects_unrecognized_assets_and_schemes_without_find_default_asset(self):
        client, _ = self._client_with_default_asset()
        with pytest.raises(Exception, match=r"spend_controls\.allowed_assets"):
            await client.create_payment_payload(
                self._required(self._req(asset="0xCustomUnknownToken", amount="1"))
            )

        bare = MockSchemeClient("exact")
        bare.clear_find_default_asset()
        bare_client = x402Client()
        bare_client.register(self.network, bare)
        with pytest.raises(Exception, match=r"spend_controls\.allowed_assets"):
            await bare_client.create_payment_payload(
                self._required(self._req(asset=self.usdc["asset"], amount="1"))
            )

    @pytest.mark.asyncio
    async def test_spend_controls_false_disables_allowlist_and_usd_cap(self):
        custom = "0xCustomUnknownToken"
        client, mock_client = self._client_with_default_asset(self.usdc, False)

        await client.create_payment_payload(
            self._required(self._req(asset=custom, amount="999999999999"))
        )
        await client.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="5000000"))
        )
        assert len(mock_client.create_calls) == 2

    @pytest.mark.asyncio
    async def test_allowed_assets_true_allows_any_asset_usd_cap_still_applies(self):
        custom = "0xCustomUnknownToken"
        client, mock_client = self._client_with_default_asset(self.usdc, {"allowed_assets": True})

        await client.create_payment_payload(
            self._required(self._req(asset=custom, amount="999999999999"))
        )
        assert len(mock_client.create_calls) == 1

        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client.create_payment_payload(
                self._required(self._req(asset=self.usdc["asset"], amount="1000001"))
            )

    @pytest.mark.asyncio
    async def test_scales_usd_cap_for_18_decimal_default_asset(self):
        mock_client = MockSchemeClient("exact")
        mock_client.set_find_default_asset(self.m_usd)
        mezo = "eip155:31611"
        client18 = x402Client().register(mezo, mock_client)

        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client18.create_payment_payload(
                self._required(
                    self._req(
                        asset=self.m_usd["asset"],
                        amount="1000000000000000001",
                        network=mezo,
                    )
                )
            )

        await client18.create_payment_payload(
            self._required(
                self._req(
                    asset=self.m_usd["asset"],
                    amount="1000000000000000000",
                    network=mezo,
                )
            )
        )
        assert len(mock_client.create_calls) == 1

    @pytest.mark.asyncio
    async def test_honours_max_amount_false_custom_money_and_set_spend_controls(self):
        client, mock_client = self._client_with_default_asset(
            self.usdc, {"max_amount_per_payment": False}
        )
        await client.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="5000000"))
        )
        assert len(mock_client.create_calls) == 1

        mock5 = MockSchemeClient("exact")
        mock5.set_find_default_asset(self.usdc)
        client5 = x402Client.from_config(
            x402ClientConfig(
                schemes=[SchemeRegistration(network=self.network, client=mock5)],
                spend_controls={"max_amount_per_payment": "$5"},
            )
        )
        await client5.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="5000000"))
        )
        assert len(mock5.create_calls) == 1

        mock_num = MockSchemeClient("exact")
        mock_num.set_find_default_asset(self.usdc)
        client_num = (
            x402Client()
            .register(self.network, mock_num)
            .set_spend_controls({"max_amount_per_payment": 5})
        )
        await client_num.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="5000000"))
        )
        assert len(mock_num.create_calls) == 1

    @pytest.mark.asyncio
    async def test_allows_opt_in_assets_uncapped_or_with_atomic_cap(self):
        custom_asset = "0xCustomToken"
        capped_client, _ = self._client_with_default_asset(
            self.usdc,
            {
                "allowed_assets": [
                    {
                        "asset": custom_asset,
                        "network": self.network,
                        "max_amount_per_payment": "10000",
                    }
                ]
            },
        )

        with pytest.raises(Exception, match="allowed_assets max_amount_per_payment"):
            await capped_client.create_payment_payload(
                self._required(self._req(asset=custom_asset, amount="10001"))
            )

        uncapped_client, mock_client = self._client_with_default_asset(
            self.usdc,
            {"allowed_assets": [{"asset": custom_asset.lower(), "network": "eip155:*"}]},
        )
        await uncapped_client.create_payment_payload(
            self._required(self._req(asset=custom_asset, amount="999999999999"))
        )
        assert len(mock_client.create_calls) == 1

    @pytest.mark.asyncio
    async def test_drops_non_integer_amount_on_per_asset_atomic_cap_path(self):
        custom_asset = "0xCustomToken"
        client, _ = self._client_with_default_asset(
            self.usdc,
            {
                "allowed_assets": [
                    {
                        "asset": custom_asset,
                        "network": self.network,
                        "max_amount_per_payment": "10000",
                    }
                ]
            },
        )

        with pytest.raises(Exception, match="allowed_assets max_amount_per_payment"):
            await client.create_payment_payload(
                self._required(self._req(asset=custom_asset, amount="1.5"))
            )

    @pytest.mark.asyncio
    async def test_keeps_sibling_when_mixed_offer_has_non_integer_per_asset_amount(self):
        custom_asset = "0xCustomToken"
        client, mock_client = self._client_with_default_asset(
            self.usdc,
            {
                "allowed_assets": [
                    {
                        "asset": custom_asset,
                        "network": self.network,
                        "max_amount_per_payment": "10000",
                    }
                ]
            },
        )

        await client.create_payment_payload(
            self._required(
                self._req(asset=custom_asset, amount="1.5"),
                self._req(asset=custom_asset, amount="100"),
            )
        )
        assert mock_client.create_calls[0].amount == "100"

    @pytest.mark.asyncio
    async def test_errors_when_per_asset_cap_is_not_integer_atomic(self):
        custom_asset = "0xCustomToken"
        for cap in ("$1", "1.5"):
            client, _ = self._client_with_default_asset(
                self.usdc,
                {
                    "allowed_assets": [
                        {
                            "asset": custom_asset,
                            "network": self.network,
                            "max_amount_per_payment": cap,
                        }
                    ]
                },
            )
            with pytest.raises(
                Exception, match="max_amount_per_payment must be an integer atomic amount"
            ):
                await client.create_payment_payload(
                    self._required(self._req(asset=custom_asset, amount="100"))
                )

    @pytest.mark.asyncio
    async def test_overrides_usd_cap_for_default_assets_by_id_or_symbol(self):
        by_id, mock_by_id = self._client_with_default_asset(
            self.usdc,
            {
                "allowed_assets": [
                    {
                        "asset": self.usdc["asset"],
                        "network": self.network,
                        "max_amount_per_payment": "500000",
                    }
                ]
            },
        )

        with pytest.raises(Exception, match="allowed_assets max_amount_per_payment"):
            await by_id.create_payment_payload(
                self._required(self._req(asset=self.usdc["asset"], amount="600000"))
            )

        await by_id.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="400000"))
        )
        assert len(mock_by_id.create_calls) == 1

        pyusd = {
            "asset": "0xPayPalUsdAsset000000000000000000000001",
            "decimals": 6,
            "symbol": "PYUSD",
        }
        mock_pyusd = MockSchemeClient("exact")
        mock_pyusd.set_find_default_asset(
            lambda asset, _network, e=pyusd: e if asset.lower() == e["asset"].lower() else None
        )
        client_by_symbol = (
            x402Client()
            .register(self.network, mock_pyusd)
            .set_spend_controls(
                {
                    "allowed_assets": [
                        {
                            "asset": "pyusd",
                            "network": self.network,
                            "max_amount_per_payment": "500000",
                        }
                    ]
                }
            )
        )

        with pytest.raises(Exception, match="allowed_assets max_amount_per_payment"):
            await client_by_symbol.create_payment_payload(
                self._required(self._req(asset=pyusd["asset"], amount="600000"))
            )

        await client_by_symbol.create_payment_payload(
            self._required(self._req(asset=pyusd["asset"], amount="400000"))
        )
        assert len(mock_pyusd.create_calls) == 1

    @pytest.mark.asyncio
    async def test_keeps_usd_cap_when_default_listed_without_per_entry_cap(self):
        client, _ = self._client_with_default_asset(
            self.usdc,
            {"allowed_assets": [{"asset": self.usdc["symbol"], "network": self.network}]},
        )

        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client.create_payment_payload(
                self._required(self._req(asset=self.usdc["asset"], amount="1000001"))
            )

    @pytest.mark.asyncio
    async def test_allows_defaults_plus_listed_custom_assets(self):
        custom = "0xCustomToken"
        client, mock_client = self._client_with_default_asset(
            self.usdc,
            {
                "max_amount_per_payment": False,
                "allowed_assets": [{"asset": custom, "network": self.network}],
            },
        )

        await client.create_payment_payload(
            self._required(self._req(asset=self.usdc["asset"], amount="1"))
        )
        await client.create_payment_payload(self._required(self._req(asset=custom, amount="1")))
        assert len(mock_client.create_calls) == 2

    @pytest.mark.asyncio
    async def test_caps_v1_accepts_via_max_amount_required(self):
        mock_client = MockSchemeClient("exact")
        mock_client.set_find_default_asset(self.usdc)
        client = x402Client()
        client.register_v1("base", mock_client)

        v1_req = PaymentRequirementsV1(
            scheme="exact",
            network="base",
            asset=self.usdc["asset"],
            max_amount_required="2000000",
            pay_to="0xpay",
            max_timeout_seconds=60,
            description="",
            mime_type="",
            resource="https://example.com",
        )
        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client.create_payment_payload(PaymentRequiredV1(x402_version=1, accepts=[v1_req]))

    @pytest.mark.asyncio
    async def test_only_exposes_requirements_that_passed_spend_controls_to_policies(self):
        seen: list[str] = []
        client, mock_client = self._client_with_default_asset(self.usdc)
        client.register_policy(lambda _version, reqs: seen.extend(r.amount for r in reqs) or reqs)

        await client.create_payment_payload(
            self._required(
                self._req(asset=self.usdc["asset"], amount="50000000"),
                self._req(asset=self.usdc["asset"], amount="250000"),
            )
        )

        assert seen == ["250000"]
        assert mock_client.create_calls[0].amount == "250000"

    @pytest.mark.asyncio
    async def test_compares_non_integer_decimal_amounts_to_usd_cap_directly(self):
        rlusd = {
            "asset": "524C555344000000000000000000000000000000",
            "decimals": 15,
            "symbol": "RLUSD",
        }
        mock_client = MockSchemeClient("exact")
        mock_client.set_find_default_asset(rlusd)
        xrpl = "xrpl:1"
        client = x402Client().register(xrpl, mock_client)

        await client.create_payment_payload(
            self._required(self._req(asset=rlusd["asset"], amount="1.0", network=xrpl))
        )
        assert len(mock_client.create_calls) == 1

        with pytest.raises(Exception, match="max_amount_per_payment"):
            await client.create_payment_payload(
                self._required(self._req(asset=rlusd["asset"], amount="1.01", network=xrpl))
            )


class TestPaymentFlowSelection:
    """Client selection drops unrecognized paymentFlow and prefers authorization."""

    network = "eip155:8453"

    def _req(self, *, amount: str = "100", extra: dict | None = None):
        return PaymentRequirements(
            scheme="exact",
            network=self.network,
            asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount=amount,
            pay_to="0xpay",
            max_timeout_seconds=60,
            extra=extra or {},
        )

    def _required(self, *accepts):
        return PaymentRequired(x402_version=2, accepts=list(accepts))

    def _client(self):
        mock_client = MockSchemeClient("exact")
        client = x402Client().register(self.network, mock_client)
        return client, mock_client

    @pytest.mark.asyncio
    async def test_drops_accepts_with_unrecognized_payment_flow(self):
        client, mock_client = self._client()
        known = self._req(amount="100")
        unknown = self._req(amount="200", extra={"paymentFlow": "future-flow"})
        await client.create_payment_payload(self._required(unknown, known))
        assert mock_client.create_calls[0] == known

    @pytest.mark.asyncio
    async def test_throws_when_every_accept_has_unrecognized_payment_flow(self):
        client, _ = self._client()
        with pytest.raises(
            NoMatchingRequirementsError,
            match="No payment requirements with a recognized paymentFlow",
        ):
            await client.create_payment_payload(
                self._required(self._req(extra={"paymentFlow": "future-flow"}))
            )

    @pytest.mark.asyncio
    async def test_prefers_authorization_over_upfront(self):
        client, mock_client = self._client()
        upfront = self._req(amount="100", extra={"paymentFlow": "upfront"})
        auth = self._req(amount="200")
        await client.create_payment_payload(self._required(upfront, auth))
        assert mock_client.create_calls[0] == auth

    @pytest.mark.asyncio
    async def test_prefers_explicit_authorization_over_escrow(self):
        client, mock_client = self._client()
        escrow = self._req(amount="100", extra={"paymentFlow": "escrow"})
        auth = self._req(amount="200", extra={"paymentFlow": "authorization"})
        await client.create_payment_payload(self._required(escrow, auth))
        assert mock_client.create_calls[0] == auth

    @pytest.mark.asyncio
    async def test_selects_upfront_when_it_is_the_only_remaining_accept(self):
        client, mock_client = self._client()
        upfront = self._req(amount="100", extra={"paymentFlow": "upfront"})
        await client.create_payment_payload(self._required(upfront))
        assert mock_client.create_calls[0] == upfront

    @pytest.mark.asyncio
    async def test_custom_policies_override_authorization_preference(self):
        client, mock_client = self._client()
        upfront = self._req(amount="100", extra={"paymentFlow": "upfront"})
        auth = self._req(amount="200")
        client.register_policy(
            lambda _version, reqs: [r for r in reqs if r.extra.get("paymentFlow") == "upfront"]
        )
        await client.create_payment_payload(self._required(auth, upfront))
        assert mock_client.create_calls[0] == upfront
