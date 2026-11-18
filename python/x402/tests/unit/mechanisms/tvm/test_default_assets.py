"""Tests for TVM default asset lookup."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq_core import Address

from x402.mechanisms.tvm.constants import TVM_MAINNET, USDT_MAINNET_MINTER
from x402.mechanisms.tvm.default_assets import (
    DEFAULT_ASSETS,
    find_default_asset,
    get_default_asset,
)

MAINNET_USDT = DEFAULT_ASSETS[TVM_MAINNET][0]


class TestFindDefaultAsset:
    def test_matches_user_friendly_and_raw_ton_address_formats(self):
        friendly = Address(USDT_MAINNET_MINTER).to_str()

        assert find_default_asset(USDT_MAINNET_MINTER, TVM_MAINNET) == MAINNET_USDT
        assert find_default_asset(friendly, TVM_MAINNET) == MAINNET_USDT

    def test_returns_none_for_unknown_asset(self):
        assert (
            find_default_asset(
                "0:0000000000000000000000000000000000000000000000000000000000000001",
                TVM_MAINNET,
            )
            is None
        )


class TestGetDefaultAsset:
    def test_returns_first_list_entry_as_network_default(self):
        assert get_default_asset(TVM_MAINNET) == MAINNET_USDT

    def test_throws_when_requesting_a_symbol_not_configured(self):
        with pytest.raises(ValueError, match=r"No USDC default asset configured for network"):
            get_default_asset(TVM_MAINNET, "USDC")

    def test_throws_for_an_unknown_network(self):
        with pytest.raises(ValueError, match=r"No default asset configured for network tvm:999"):
            get_default_asset("tvm:999")
