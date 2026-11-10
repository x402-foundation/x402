"""Tests for TVM mechanism exports."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

import x402.mechanisms.tvm as tvm_module
import x402.mechanisms.tvm.constants as constants_module
from x402.mechanisms.tvm import (
    DEFAULT_TVM_EMULATION_ADDRESS,
    HIGHLOAD_V3_CODE_HEX,
    SUPPORTED_NETWORKS,
    TVM_MAINNET,
    TVM_TESTNET,
    W5R1_CODE_HASH,
    ClientTvmSigner,
    ExactTvmPayload,
    FacilitatorHighloadV3Signer,
    FacilitatorTvmSigner,
    SettlementCache,
    TonapiRestClient,
    ToncenterRestClient,
    WalletV5R1MnemonicSigner,
    create_tvm_provider_client,
    normalize_address,
    parse_amount,
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
        assert TonapiRestClient is not None
        assert create_tvm_provider_client is not None
        assert ExactTvmPayload is not None
        assert SettlementCache is not None

    def test_should_export_tvm_runtime_constants(self):
        assert DEFAULT_TVM_EMULATION_ADDRESS.startswith("0:")
        assert len(W5R1_CODE_HASH) == 64
        assert HIGHLOAD_V3_CODE_HEX.startswith("b5ee9c")

    def test_should_reexport_public_constants_module_surface(self):
        missing = [
            name
            for name in dir(constants_module)
            if name.isupper() and not hasattr(tvm_module, name)
        ]
        assert missing == []


class TestNetworkUtilities:
    def test_should_export_supported_networks(self):
        assert SUPPORTED_NETWORKS == {TVM_MAINNET, TVM_TESTNET}


class TestAmountUtilities:
    def test_should_parse_amount_using_decimals(self):
        assert parse_amount("0.001", 6) == 1000
        assert parse_amount("1", 6) == 1000000

    def test_should_normalize_raw_addresses(self):
        raw = "0:" + "1" * 64

        assert normalize_address(raw) == raw
