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

    def test_finds_musd_on_mezo_testnet(self):
        assert find_default_asset(MEZO_TESTNET_MUSD["asset"], "eip155:31611") == MEZO_TESTNET_MUSD

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


# Circle-issued USDC. The EIP-712 name and version are what each token reports on chain, and
# the domain separator recomputed from them matches the contract's DOMAIN_SEPARATOR().
CIRCLE_USDC_DEFAULTS = [
    pytest.param("eip155:10", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USD Coin", id="op"),
    pytest.param("eip155:130", "0x078D782b760474a361dDA0AF3839290b0EF57AD6", "USDC", id="unichain"),
    pytest.param("eip155:146", "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", "USDC", id="sonic"),
    pytest.param("eip155:999", "0xb88339CB7199b77E23DB6E890353E22632Ba630f", "USDC", id="hyperevm"),
    pytest.param("eip155:57073", "0x2D270e6886d130D724215A266106e6832161EAEd", "USDC", id="ink"),
    pytest.param("eip155:59144", "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", "USDC", id="linea"),
    pytest.param("eip155:81224", "0xd996633a415985DBd7D6D12f4A4343E31f5037cf", "USDC", id="codex"),
    pytest.param("eip155:98866", "0x222365EF19F7947e5484218551B56bb3965Aa7aF", "USDC", id="plume"),
]


class TestCircleUsdcDefaults:
    @pytest.mark.parametrize(("network", "asset", "name"), CIRCLE_USDC_DEFAULTS)
    def test_network_default_is_native_usdc_with_eip3009_domain(self, network, asset, name):
        expected = {
            "asset": asset,
            "name": name,
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        }

        # Exactly these keys: no assetTransferMethod, so the default EIP-3009 method is used.
        assert get_default_asset(network) == expected
        assert get_default_asset(network, "USDC") == expected

    @pytest.mark.parametrize(("network", "asset", "name"), CIRCLE_USDC_DEFAULTS)
    def test_reverse_lookup_recognizes_the_asset_for_spend_controls(self, network, asset, name):
        entry = get_default_asset(network)

        assert find_default_asset(asset, network) == entry
        assert find_default_asset(asset.lower(), network) == entry

    @pytest.mark.parametrize(("network", "asset", "name"), CIRCLE_USDC_DEFAULTS)
    def test_addresses_are_eip55_checksummed(self, network, asset, name):
        assert to_checksum_address(asset) == asset


class TestExactEvmSchemeGetAssetDecimals:
    def test_returns_none_for_unrecognized_asset_on_18_decimal_network(self):
        server = ExactEvmScheme()
        other_asset = "0x0000000000000000000000000000000000000001"
        assert server.get_asset_decimals(other_asset, "eip155:31611") is None
        assert (
            server.get_asset_decimals(MEZO_TESTNET_MUSD["asset"], "eip155:31611")
            == MEZO_TESTNET_MUSD["decimals"]
        )
