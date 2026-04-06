"""Tests for TVM mechanism exports and registration helpers."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

import x402.mechanisms.tvm.exact.facilitator as facilitator_module
from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
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
    register_exact_tvm_client,
    register_exact_tvm_facilitator,
    register_exact_tvm_server,
)


class _ClientSignerStub:
    address = "0:" + "1" * 64
    network = TVM_TESTNET
    wallet_id = 1
    state_init = object()

    def sign_message(self, message: bytes) -> bytes:
        return b"\x00" * 64


class _FacilitatorSignerStub:
    def get_addresses(self) -> list[str]:
        return ["0:" + "f" * 64]

    def get_addresses_for_network(self, network: str) -> list[str]:
        return ["0:" + "f" * 64]


class _FakeBatcher:
    def __init__(self, *args, **kwargs) -> None:
        pass


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


class TestRegisterHelpers:
    def test_register_exact_tvm_client_should_register_on_signer_network_and_policies(self):
        client = x402ClientSync()
        policy = lambda version, requirements: requirements

        result = register_exact_tvm_client(client, _ClientSignerStub(), policies=[policy])

        assert result is client
        assert TVM_TESTNET in client._schemes
        assert client._schemes[TVM_TESTNET]["exact"].scheme == "exact"
        assert client._policies == [policy]

    def test_register_exact_tvm_server_should_register_all_supported_networks_by_default(self):
        server = x402ResourceServerSync()

        result = register_exact_tvm_server(server)

        assert result is server
        for network in SUPPORTED_NETWORKS:
            assert network in server._schemes
            assert server._schemes[network]["exact"].scheme == "exact"

    def test_register_exact_tvm_facilitator_should_register_one_scheme_for_requested_networks(
        self, monkeypatch
    ):
        facilitator = x402FacilitatorSync()
        monkeypatch.setattr(facilitator_module, "_SettlementBatcher", _FakeBatcher)

        result = register_exact_tvm_facilitator(
            facilitator,
            _FacilitatorSignerStub(),
            [TVM_TESTNET, TVM_MAINNET],
        )

        assert result is facilitator
        assert len(facilitator._schemes) == 1
        scheme_data = facilitator._schemes[0]
        assert scheme_data.networks == {TVM_TESTNET, TVM_MAINNET}
        assert scheme_data.facilitator.scheme == "exact"
