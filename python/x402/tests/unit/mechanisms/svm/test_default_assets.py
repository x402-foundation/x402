"""Tests for SVM default asset lookup."""

from __future__ import annotations

import pytest

from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2
from x402.mechanisms.svm.default_assets import (
    DEFAULT_ASSETS,
    USDC_MAINNET_ADDRESS,
    find_default_asset,
    get_default_asset,
)

MAINNET_USDC = DEFAULT_ASSETS[SOLANA_MAINNET_CAIP2][0]


class TestFindDefaultAsset:
    def test_resolves_v1_legacy_network_name_solana(self):
        assert find_default_asset(USDC_MAINNET_ADDRESS, "solana") == MAINNET_USDC

    def test_returns_none_for_unknown_asset(self):
        assert find_default_asset("UnknownMint1111111111111111111111111111111", "solana") is None


class TestGetDefaultAsset:
    def test_returns_first_list_entry_as_network_default(self):
        assert get_default_asset(SOLANA_MAINNET_CAIP2) == MAINNET_USDC
        assert get_default_asset("solana") == MAINNET_USDC

    def test_resolves_a_suffixed_ticker_to_a_non_default_entry(self):
        assert get_default_asset(SOLANA_MAINNET_CAIP2, "USDT")["symbol"] == "USDT"

    def test_throws_when_requesting_a_symbol_not_configured(self):
        with pytest.raises(ValueError, match=r"No USDT default asset configured for network"):
            get_default_asset(SOLANA_DEVNET_CAIP2, "USDT")
