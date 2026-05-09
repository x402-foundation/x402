"""Tests for EVM v1 legacy network utility functions."""

import pytest

from x402.mechanisms.evm.v1.utils import get_asset_info, get_evm_chain_id


class TestV1GetEvmChainId:
    """Test v1 get_evm_chain_id function (legacy names)."""

    def test_should_resolve_base(self):
        assert get_evm_chain_id("base") == 8453

    def test_should_resolve_base_sepolia(self):
        assert get_evm_chain_id("base-sepolia") == 84532

    def test_should_resolve_ethereum(self):
        assert get_evm_chain_id("ethereum") == 1

    def test_should_resolve_polygon(self):
        assert get_evm_chain_id("polygon") == 137

    def test_should_resolve_megaeth(self):
        assert get_evm_chain_id("megaeth") == 4326

    def test_should_resolve_monad(self):
        assert get_evm_chain_id("monad") == 143

    def test_should_resolve_avalanche(self):
        assert get_evm_chain_id("avalanche") == 43114

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
        usdc_address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        info = get_asset_info("base", usdc_address)
        assert info["address"].startswith("0x")
        assert info["decimals"] == 6

    def test_should_return_asset_by_address(self):
        info = get_asset_info("base-sepolia", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
        assert info["decimals"] == 6

    def test_should_raise_for_unknown_v1_network(self):
        with pytest.raises(ValueError, match="No default asset for v1 network"):
            get_asset_info("eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")

    def test_should_raise_for_unregistered_asset_address(self):
        unknown_address = "0x1234567890123456789012345678901234567890"
        with pytest.raises(ValueError, match="not a registered asset"):
            get_asset_info("base", unknown_address)
