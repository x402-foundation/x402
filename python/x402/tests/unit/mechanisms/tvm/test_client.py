"""Tests for the exact TVM client scheme."""

from __future__ import annotations

import base64

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq.contract.contract import Contract
from pytoniq_core import Address, begin_cell

from x402.mechanisms.tvm import (
    TVM_TESTNET,
)
from x402.mechanisms.tvm.constants import (
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    DEFAULT_TVM_INNER_GAS_BUFFER,
)
from x402.mechanisms.tvm.exact import ExactTvmClientScheme
from x402.mechanisms.tvm.exact.codec import parse_exact_tvm_payload

from .builders import (
    ASSET,
    MERCHANT,
    RESPONSE_DESTINATION,
    SOURCE_WALLET,
    SPONSORED_EXTRA,
    make_tvm_requirements,
)
from .fakes import ClientSignerStub, ToncenterClientStub


def _make_requirements(**overrides):
    return make_tvm_requirements(default_extra=SPONSORED_EXTRA, **overrides)


class TestExactTvmClientSchemeConstructor:
    def test_should_create_instance_with_correct_scheme(self):
        signer = ClientSignerStub()

        client = ExactTvmClientScheme(signer)

        assert client.scheme == "exact"

    def test_should_store_signer_reference(self):
        signer = ClientSignerStub()

        client = ExactTvmClientScheme(signer)

        assert client._signer is signer

    def test_close_should_close_cached_toncenter_clients(self):
        client = ExactTvmClientScheme(ClientSignerStub())
        testnet_client = ToncenterClientStub()
        mainnet_client = ToncenterClientStub()
        client._clients = {
            TVM_TESTNET: testnet_client,
            "tvm:-239": mainnet_client,
        }

        client.close()

        assert testnet_client.close_calls == 1
        assert mainnet_client.close_calls == 1
        assert client._clients == {}

    def test_close_should_be_idempotent(self):
        client = ExactTvmClientScheme(ClientSignerStub())

        client.close()
        client.close()


class TestCreatePaymentPayload:
    def test_should_have_create_payment_payload_method(self):
        client = ExactTvmClientScheme(ClientSignerStub())

        assert hasattr(client, "create_payment_payload")
        assert callable(client.create_payment_payload)

    def test_should_reject_unsupported_network(self):
        client = ExactTvmClientScheme(ClientSignerStub())

        with pytest.raises(ValueError, match="Unsupported TVM network"):
            client.create_payment_payload(_make_requirements(network="tvm:999"))

    def test_should_reject_requirements_for_different_signer_network(self):
        client = ExactTvmClientScheme(ClientSignerStub())

        with pytest.raises(ValueError, match="Signer network .* does not match requirements"):
            client.create_payment_payload(_make_requirements(network="tvm:-239"))

    def test_should_require_fee_sponsorship(self):
        client = ExactTvmClientScheme(ClientSignerStub())

        with pytest.raises(ValueError, match="requires extra.areFeesSponsored to be true"):
            client.create_payment_payload(_make_requirements(extra={"areFeesSponsored": False}))

    def test_should_create_payload_with_forward_defaults(self, monkeypatch):
        signer = ClientSignerStub()
        client = ExactTvmClientScheme(signer)
        toncenter = ToncenterClientStub(
            is_active=True,
            source_wallet_balance=1_000_000,
            source_wallet_fwd_fees=[200_000],
            source_wallet_compute_fee=300_000,
            receiver_wallet_compute_fee=400_000,
            source_wallet_storage_fee=500_000,
            signer=signer,
        )
        monkeypatch.setattr(client, "_get_client", lambda network: toncenter)

        payload = client.create_payment_payload(_make_requirements())
        settlement = parse_exact_tvm_payload(payload["settlementBoc"])

        assert payload["asset"] == ASSET
        assert settlement.transfer.destination == MERCHANT
        assert settlement.transfer.source_wallet == SOURCE_WALLET
        assert settlement.transfer.response_destination is None
        assert settlement.transfer.forward_ton_amount == 0
        assert settlement.transfer.forward_payload.hash == begin_cell().store_bit(0).end_cell().hash
        assert settlement.transfer.attached_ton_amount == (
            200_000 + 300_000 + 400_000 + 500_000 + DEFAULT_TVM_INNER_GAS_BUFFER
        )
        assert toncenter.get_account_state_calls == 1
        assert toncenter.get_jetton_wallet_calls == [(ASSET, signer.address)]
        assert toncenter.emulate_trace_calls == [
            {
                "ignore_chksig": True,
                "timeout": DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
            }
        ]

    def test_should_use_default_emulation_wallet_to_relay_into_undeployed_payer(self, monkeypatch):
        signer = ClientSignerStub()
        client = ExactTvmClientScheme(signer)
        toncenter = ToncenterClientStub(
            is_active=False,
            source_wallet_balance=1_000_000,
            source_wallet_fwd_fees=[200_000],
            source_wallet_compute_fee=300_000,
            receiver_wallet_compute_fee=400_000,
            source_wallet_storage_fee=500_000,
            signer=signer,
        )
        monkeypatch.setattr(client, "_get_client", lambda network: toncenter)

        payload = client.create_payment_payload(_make_requirements())
        settlement = parse_exact_tvm_payload(payload["settlementBoc"])

        assert settlement.transfer.source_wallet == SOURCE_WALLET
        assert toncenter.get_account_state_calls == 1
        assert toncenter.get_jetton_wallet_calls == [(ASSET, signer.address)]
        assert toncenter.emulate_trace_calls == [
            {
                "ignore_chksig": True,
                "timeout": DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
            }
        ]

    def test_should_use_signer_emulation_timeout_override(self, monkeypatch):
        class _CustomTimeoutSigner(ClientSignerStub):
            @property
            def provider_emulation_timeout_seconds(self) -> float:
                return 14.0

        client = ExactTvmClientScheme(_CustomTimeoutSigner())
        toncenter = ToncenterClientStub(
            is_active=True,
            source_wallet_balance=1_000_000,
            source_wallet_fwd_fees=[200_000],
            source_wallet_compute_fee=300_000,
            receiver_wallet_compute_fee=400_000,
            source_wallet_storage_fee=500_000,
            signer=client._signer,
        )
        monkeypatch.setattr(client, "_get_client", lambda network: toncenter)

        client.create_payment_payload(_make_requirements())

        assert toncenter.emulate_trace_calls == [{"ignore_chksig": True, "timeout": 14.0}]

    def test_should_create_payload_with_custom_forward_settings(self, monkeypatch):
        signer = ClientSignerStub()
        client = ExactTvmClientScheme(signer)
        toncenter = ToncenterClientStub(
            is_active=True,
            source_wallet_balance=1_000_000,
            source_wallet_fwd_fees=[200_000, 250_000],
            source_wallet_compute_fee=300_000,
            receiver_wallet_compute_fee=400_000,
            source_wallet_storage_fee=500_000,
            signer=signer,
        )
        monkeypatch.setattr(client, "_get_client", lambda network: toncenter)
        forward_payload = begin_cell().store_uint(0xABCD, 16).end_cell()

        payload = client.create_payment_payload(
            _make_requirements(
                extra={
                    "areFeesSponsored": True,
                    "responseDestination": RESPONSE_DESTINATION,
                    "forwardTonAmount": "50000000",
                    "forwardPayload": base64.b64encode(forward_payload.to_boc()).decode("ascii"),
                }
            )
        )
        settlement = parse_exact_tvm_payload(payload["settlementBoc"])

        assert settlement.transfer.response_destination == RESPONSE_DESTINATION
        assert settlement.transfer.forward_ton_amount == 50_000_000
        assert settlement.transfer.forward_payload.hash == forward_payload.hash
        assert settlement.transfer.attached_ton_amount == 58_750_000

    def test_should_raise_when_trace_does_not_include_destination_wallet_transfer(
        self, monkeypatch
    ):
        signer = ClientSignerStub()
        client = ExactTvmClientScheme(signer)
        monkeypatch.setattr(
            client,
            "_get_client",
            lambda network: ToncenterClientStub(
                is_active=True,
                source_wallet_balance=1_000_000,
                source_wallet_fwd_fees=[200_000],
                source_wallet_compute_fee=300_000,
                receiver_wallet_compute_fee=400_000,
                source_wallet_storage_fee=500_000,
                omit_receiver_tx=True,
                signer=signer,
            ),
        )

        with pytest.raises(
            ValueError,
            match="Trace does not contain the expected destination jetton wallet transaction",
        ):
            client.create_payment_payload(_make_requirements())

    def test_build_transfer_body_should_reject_negative_forward_ton_amount(self):
        client = ExactTvmClientScheme(ClientSignerStub())

        with pytest.raises(ValueError, match="Forward ton amount should be >= 0"):
            client._build_transfer_body(_make_requirements(extra={"forwardTonAmount": "-1"}))

    def test_build_transfer_body_should_store_explicit_forward_payload(self):
        client = ExactTvmClientScheme(ClientSignerStub())
        forward_payload = begin_cell().store_uint(0xABCD, 16).end_cell()

        transfer_body = client._build_transfer_body(
            _make_requirements(
                extra={
                    "forwardTonAmount": "777",
                    "forwardPayload": base64.b64encode(forward_payload.to_boc()).decode("ascii"),
                }
            )
        )
        transfer = parse_exact_tvm_payload(
            base64.b64encode(
                Contract.create_internal_msg(
                    src=None,
                    dest=Address(ClientSignerStub().address),
                    bounce=True,
                    value=0,
                    body=client._build_signed_body(
                        source_wallet=SOURCE_WALLET,
                        transfer_body=transfer_body,
                        seqno=1,
                        valid_until=2,
                        attached_amount=3,
                    ),
                )
                .serialize()
                .to_boc()
            ).decode("ascii")
        )

        assert transfer.transfer.forward_ton_amount == 777
        assert transfer.transfer.forward_payload.hash == forward_payload.hash

    def test_estimate_required_inner_value_should_fallback_to_action_phase_fees(self, monkeypatch):
        signer = ClientSignerStub()
        client = ExactTvmClientScheme(signer)
        toncenter = ToncenterClientStub(
            is_active=True,
            source_wallet_balance=1_000_000,
            source_wallet_fwd_fees=[None],
            source_wallet_compute_fee=300_000,
            receiver_wallet_compute_fee=400_000,
            source_wallet_storage_fee=500_000,
            source_action_total_fwd_fees=200_000,
            signer=signer,
        )
        monkeypatch.setattr(client, "_get_client", lambda network: toncenter)

        payload = client.create_payment_payload(_make_requirements())
        settlement = parse_exact_tvm_payload(payload["settlementBoc"])

        assert settlement.transfer.attached_ton_amount == (
            200_000 + 300_000 + 400_000 + 500_000 + DEFAULT_TVM_INNER_GAS_BUFFER
        )
