"""Tests for EVM v1 legacy network utility functions."""

import pytest

from x402.mechanisms.evm.default_assets import get_default_asset
from x402.mechanisms.evm.v1.utils import get_asset_info, get_evm_chain_id


class TestV1GetEvmChainId:
    """Test v1 get_evm_chain_id lookup and rejection."""

    @pytest.mark.parametrize(
        ("network", "chain_id"),
        [
            ("base", 8453),
            ("base-sepolia", 84532),
            ("ethereum", 1),
            ("polygon", 137),
            ("polygon-amoy", 80002),
            ("avalanche", 43114),
            ("avalanche-fuji", 43113),
            ("abstract", 2741),
            ("abstract-testnet", 11124),
            ("iotex", 4689),
            ("sei", 1329),
            ("sei-testnet", 1328),
            ("peaq", 3338),
            ("megaeth", 4326),
            ("monad", 143),
            ("monad-testnet", 10143),
            ("stable", 988),
            ("stable-testnet", 2201),
            ("celo", 42220),
            ("flare", 14),
        ],
    )
    def test_should_map_legacy_name_to_chain_id(self, network: str, chain_id: int):
        assert get_evm_chain_id(network) == chain_id

    def test_should_resolve_story(self):
        assert get_evm_chain_id("story") == 1514

    def test_should_resolve_educhain(self):
        assert get_evm_chain_id("educhain") == 41923

    def test_should_resolve_skale_base_sepolia(self):
        assert get_evm_chain_id("skale-base-sepolia") == 324705682

    def test_should_reject_undefined_aliases(self):
        with pytest.raises(ValueError, match="Unknown v1 network"):
            get_evm_chain_id("base-mainnet")
        with pytest.raises(ValueError, match="Unknown v1 network"):
            get_evm_chain_id("mainnet")

    def test_should_reject_caip2_format(self):
        with pytest.raises(ValueError, match="Unknown v1 network"):
            get_evm_chain_id("eip155:8453")

    def test_should_reject_unknown_network(self):
        with pytest.raises(ValueError, match="Unknown v1 network"):
            get_evm_chain_id("unknown-chain")


class TestV1GetAssetInfo:
    """Test v1 get_asset_info function."""

    def test_should_return_default_asset_for_base(self):
        asset = get_default_asset("eip155:8453")
        info = get_asset_info("base", asset["asset"])
        assert info["address"].startswith("0x")
        assert info["decimals"] == asset["decimals"]
        assert info["name"] == asset["name"]

    def test_should_return_asset_by_address(self):
        asset = get_default_asset("eip155:84532")
        info = get_asset_info("base-sepolia", asset["asset"])
        assert info["decimals"] == asset["decimals"]

    def test_should_raise_for_unknown_v1_network(self):
        with pytest.raises(ValueError, match="Unknown v1 network"):
            get_asset_info("eip155:8453", get_default_asset("eip155:8453")["asset"])

    def test_should_raise_for_unregistered_asset_address(self):
        unknown_address = "0x1234567890123456789012345678901234567890"
        with pytest.raises(ValueError, match="not a registered asset"):
            get_asset_info("base", unknown_address)
