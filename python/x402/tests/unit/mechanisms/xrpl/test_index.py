"""Tests for XRPL mechanism exports."""

from __future__ import annotations

import x402.mechanisms.xrpl as xrpl_module
from x402 import interfaces
from x402.mechanisms.xrpl import (
    DEFAULT_RPC_URLS,
    SCHEME_EXACT,
    XRPL_DEVNET,
    XRPL_MAINNET,
    XRPL_TESTNET,
    ExactXrplPayload,
    SettlementCache,
    XrplFacilitatorOptions,
)
from x402.mechanisms.xrpl.exact import (
    ExactXrplClientScheme,
    ExactXrplFacilitatorScheme,
    ExactXrplScheme,
    ExactXrplServerScheme,
    XrplClientOptions,
)

from .builders import (
    make_client_options,
    make_options,
    make_payload,
    make_requirements,
    make_wallet,
    sign_payment,
)


class TestExports:
    """The main classes and constants are exported."""

    def test_should_export_scheme_classes(self):
        assert ExactXrplScheme is not None
        assert ExactXrplClientScheme is not None
        assert ExactXrplServerScheme is not None
        assert ExactXrplFacilitatorScheme is not None

    def test_the_unified_export_is_the_client(self):
        assert ExactXrplScheme is ExactXrplClientScheme

    def test_should_export_types_and_options(self):
        assert ExactXrplPayload is not None
        assert SettlementCache is not None
        assert XrplFacilitatorOptions is not None
        assert XrplClientOptions is not None

    def test_should_export_network_constants(self):
        assert SCHEME_EXACT == "exact"
        assert XRPL_MAINNET == "xrpl:0"
        assert XRPL_TESTNET == "xrpl:1"
        assert XRPL_DEVNET == "xrpl:2"
        assert set(DEFAULT_RPC_URLS) == {XRPL_MAINNET, XRPL_TESTNET, XRPL_DEVNET}

    def test_every_name_in_all_is_importable(self):
        missing = [name for name in xrpl_module.__all__ if not hasattr(xrpl_module, name)]
        assert not missing, f"__all__ names {missing} are not importable"


class TestProtocolConformance:
    """A scheme that does not satisfy the package's Protocol cannot be plugged
    into it, however well it behaves on its own."""

    def test_each_scheme_exposes_what_its_protocol_declares(self):
        wallet = make_wallet()
        cases = [
            (ExactXrplFacilitatorScheme(), interfaces.SchemeNetworkFacilitator),
            (ExactXrplServerScheme(), interfaces.SchemeNetworkServer),
            (ExactXrplClientScheme(wallet, make_client_options()), interfaces.SchemeNetworkClient),
        ]
        for impl, protocol in cases:
            missing = [
                name
                for name in dir(protocol)
                if not name.startswith("_") and not hasattr(impl, name)
            ]
            assert not missing, f"{type(impl).__name__} is missing {missing}"

    def test_the_facilitator_is_callable_the_way_the_package_calls_it(self):
        # server_base passes extensions positionally; the facilitator receives
        # an optional context. Both are exercised here rather than assumed.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        facilitator = ExactXrplFacilitatorScheme(make_options())
        assert facilitator.verify(payload, requirements, None).is_valid is True
