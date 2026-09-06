"""Tests for EVM default asset lookup."""

from __future__ import annotations

import pytest
from eth_utils import to_checksum_address

from x402.mechanisms.evm.default_assets import (
    DEFAULT_ASSETS,
    find_default_asset,
    get_default_asset,
)
from x402.mechanisms.evm.exact.server import ExactEvmScheme

BASE_USDC = DEFAULT_ASSETS["eip155:8453"][0]
MEZO_TESTNET_MUSD = DEFAULT_ASSETS["eip155:31611"][0]


class TestFindDefaultAsset:
    def test_matches_checksummed_and_lowercase_addresses(self):
        checksummed = to_checksum_address(BASE_USDC["asset"])
        lowercase = BASE_USDC["asset"].lower()

        assert find_default_asset(checksummed, "eip155:8453") == BASE_USDC
        assert find_default_asset(lowercase, "eip155:8453") == BASE_USDC

    def test_resolves_v1_legacy_network_name_base(self):
        assert find_default_asset(BASE_USDC["asset"], "base") == BASE_USDC

    def test_finds_18_decimal_musd_on_mezo_testnet(self):
        assert find_default_asset(MEZO_TESTNET_MUSD["asset"], "eip155:31611") == MEZO_TESTNET_MUSD
        assert MEZO_TESTNET_MUSD["decimals"] == 18

    def test_returns_none_for_unknown_asset(self):
        assert (
            find_default_asset("0x0000000000000000000000000000000000000001", "eip155:8453") is None
        )


class TestGetDefaultAsset:
    def test_returns_first_list_entry_as_network_default(self):
        assert get_default_asset("eip155:8453") == BASE_USDC
        assert get_default_asset("base") == BASE_USDC

    def test_throws_when_requesting_a_symbol_not_configured(self):
        with pytest.raises(
            ValueError,
            match=r"No USDT default asset configured for network eip155:8453",
        ):
            get_default_asset("eip155:8453", "USDT")


class TestExactEvmSchemeGetAssetDecimals:
    def test_returns_none_for_unrecognized_asset_on_18_decimal_network(self):
        server = ExactEvmScheme()
        other_asset = "0x0000000000000000000000000000000000000001"
        assert server.get_asset_decimals(other_asset, "eip155:31611") is None
        assert server.get_asset_decimals(MEZO_TESTNET_MUSD["asset"], "eip155:31611") == 18
