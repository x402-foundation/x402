"""Tests for TVM mechanism exports."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

import x402.mechanisms.tvm as tvm_module
import x402.mechanisms.tvm.constants as constants_module
from x402.mechanisms.tvm import (
    DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
    DEFAULT_SETTLEMENT_BATCH_MAX_SIZE,
    DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS,
    DEFAULT_TVM_EMULATION_ADDRESS,
    DEFAULT_TVM_EMULATION_RELAY_AMOUNT,
    DEFAULT_TVM_EMULATION_SEQNO,
    DEFAULT_TVM_EMULATION_WALLET_ID,
    DEFAULT_TVM_INNER_GAS_BUFFER,
    DEFAULT_TVM_OUTER_GAS_BUFFER,
    HIGHLOAD_V3_CODE_HEX,
    MIN_FACILITATOR_TON_BALANCE,
    SCHEME_EXACT,
    SEND_MODE_IGNORE_ERRORS,
    SEND_MODE_PAY_FEES_SEPARATELY,
    SUPPORTED_NETWORKS,
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_PROVIDER_TONCENTER,
    TVM_TESTNET,
    W5_EXTERNAL_SIGNED_OPCODE,
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
        assert TonapiRestClient is not None
        assert create_tvm_provider_client is not None
        assert TVM_PROVIDER_TONCENTER == "toncenter"
        assert TVM_PROVIDER_TONAPI == "tonapi"
        assert ExactTvmPayload is not None
        assert SettlementCache is not None

    def test_should_export_tvm_runtime_constants(self):
        assert DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT == 30_000_000
        assert MIN_FACILITATOR_TON_BALANCE == 1_040_000_000
        assert DEFAULT_TVM_INNER_GAS_BUFFER == 7_100_000
        assert DEFAULT_TVM_OUTER_GAS_BUFFER == 500_000
        assert DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS == 3.0
        assert DEFAULT_SETTLEMENT_BATCH_MAX_SIZE == 185
        assert DEFAULT_TVM_EMULATION_ADDRESS.startswith("0:")
        assert DEFAULT_TVM_EMULATION_WALLET_ID == 2147483409
        assert DEFAULT_TVM_EMULATION_SEQNO == 1
        assert DEFAULT_TVM_EMULATION_RELAY_AMOUNT == 130_000_000

    def test_should_export_tvm_opcode_and_send_mode_constants(self):
        assert SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS == 3
        assert W5_EXTERNAL_SIGNED_OPCODE == 0x7369676E
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
