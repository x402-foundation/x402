"""Tests for TVM mechanism exports."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

from x402.mechanisms.tvm import (
    SCHEME_EXACT,
    SUPPORTED_NETWORKS,
    TVM_MAINNET,
    TVM_TESTNET,
    ClientTvmSigner,
    ExactTvmPayload,
    FacilitatorHighloadV3Signer,
    FacilitatorTvmSigner,
    SettlementCache,
    ToncenterRestClient,
    WalletV5R1MnemonicSigner,
    get_network_global_id,
    normalize_address,
    parse_amount,
    parse_money_to_decimal,
)
from x402.mechanisms.tvm.exact import (
    ExactTvmClientScheme,
    ExactTvmFacilitatorScheme,
    ExactTvmScheme,
    ExactTvmServerScheme,
)


class TestExports:
    def test_should_export_main_classes(self):
        assert ExactTvmScheme is ExactTvmClientScheme
        assert ExactTvmClientScheme is not None
        assert ExactTvmServerScheme is not None
        assert ExactTvmFacilitatorScheme is not None

    def test_should_export_signer_protocols_and_implementations(self):
        assert ClientTvmSigner is not None
        assert FacilitatorTvmSigner is not None
        assert WalletV5R1MnemonicSigner is not None
        assert FacilitatorHighloadV3Signer is not None

    def test_should_export_provider_and_payload_types(self):
        assert ToncenterRestClient is not None
        assert ExactTvmPayload is not None
        assert SettlementCache is not None


class TestNetworkUtilities:
    def test_should_export_supported_networks(self):
        assert SUPPORTED_NETWORKS == {TVM_MAINNET, TVM_TESTNET}

    def test_should_extract_global_id_from_caip2_network(self):
        assert get_network_global_id(TVM_MAINNET) == -239
        assert get_network_global_id(TVM_TESTNET) == -3

    def test_should_export_scheme_exact(self):
        assert SCHEME_EXACT == "exact"


class TestAmountUtilities:
    def test_should_parse_amount_using_decimals(self):
        assert parse_amount("0.001", 6) == 1000
        assert parse_amount("1", 6) == 1000000

    def test_should_parse_money_strings_without_currency_noise(self):
        assert parse_money_to_decimal("$0.10") == 0.1
        assert parse_money_to_decimal("2.5 USDT") == 2.5

    def test_should_normalize_raw_addresses(self):
        raw = "0:" + "1" * 64

        assert normalize_address(raw) == raw
