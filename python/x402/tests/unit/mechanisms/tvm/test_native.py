"""Tests for native TON payments in the exact TVM scheme."""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq.contract.contract import Contract
from pytoniq_core import Address, Cell, begin_cell
from pytoniq_core.tlb.block import CurrencyCollection, ExtraCurrencyCollection
from pytoniq_core.tlb.transaction import MessageAny

import x402.mechanisms.tvm.exact.facilitator as facilitator_module
from x402.mechanisms.tvm import (
    NATIVE_ASSET,
    TVM_TESTNET,
    ParsedNativeTransfer,
    ParsedTvmSettlement,
    SettlementCache,
    TvmAccountState,
    is_native_asset,
    normalize_asset,
)
from x402.mechanisms.tvm.codecs.native import native_transfer_body, parse_native_transfer
from x402.mechanisms.tvm.constants import (
    DEFAULT_TVM_OUTER_GAS_BUFFER,
    ERR_EXACT_TVM_INSUFFICIENT_BALANCE,
    ERR_EXACT_TVM_INVALID_AMOUNT,
    ERR_EXACT_TVM_INVALID_ASSET,
    ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER,
    ERR_EXACT_TVM_INVALID_RECIPIENT,
    ERR_EXACT_TVM_SIMULATION_FAILED,
)
from x402.mechanisms.tvm.exact import (
    ExactTvmClientScheme,
    ExactTvmFacilitatorScheme,
    ExactTvmServerScheme,
)
from x402.mechanisms.tvm.exact.codec import parse_exact_tvm_native_payload
from x402.mechanisms.tvm.trace_utils import body_hash_to_base64
from x402.schemas import AssetAmount, SupportedKind

from .builders import ASSET, MERCHANT, PAYER, make_tvm_payload, make_tvm_requirements
from .fakes import ClientSignerStub, FacilitatorSignerStub, ToncenterClientStub

AMOUNT = 10_000_000  # 0.01 TON
COMMENT = begin_cell().store_uint(0, 32).store_snake_string("inv-42").end_cell()
COMMENT_B64 = base64.b64encode(COMMENT.to_boc()).decode("ascii")
NATIVE_EXTRA = {"areFeesSponsored": True, "forwardPayload": COMMENT_B64}
PAYER_TX_HASH = "ab" * 32


def _native_requirements(**overrides):
    extra = overrides.pop("extra", NATIVE_EXTRA)
    return make_tvm_requirements(
        asset=overrides.pop("asset", NATIVE_ASSET),
        amount=overrides.pop("amount", str(AMOUNT)),
        extra=extra,
        **overrides,
    )


def _native_payload(**overrides):
    accepted_extra = overrides.pop("accepted_extra", NATIVE_EXTRA)
    return make_tvm_payload(
        accepted_asset=overrides.pop("accepted_asset", NATIVE_ASSET),
        payload_asset=overrides.pop("payload_asset", NATIVE_ASSET),
        accepted_amount=overrides.pop("accepted_amount", str(AMOUNT)),
        accepted_extra=accepted_extra,
        **overrides,
    )


class _NativeToncenterStub(ToncenterClientStub):
    def __init__(self, *, balance: int, **kwargs) -> None:
        super().__init__(**kwargs)
        self._balance = balance

    def get_account_state(self, address: str) -> TvmAccountState:
        state = super().get_account_state(address)
        state.balance = self._balance
        return state


class TestNativeAssetHelpers:
    def test_native_asset_is_not_normalized_as_address(self):
        assert is_native_asset("native") is True
        assert is_native_asset(ASSET) is False
        assert normalize_asset("native") == NATIVE_ASSET
        assert normalize_asset(ASSET) == ASSET

    def test_native_transfer_body_defaults_to_empty_cell(self):
        assert native_transfer_body({}).hash == Cell.empty().hash
        assert native_transfer_body({"forwardPayload": COMMENT_B64}).hash == COMMENT.hash


class TestNativeClient:
    def _client(self, monkeypatch, *, balance: int, is_active: bool = True):
        signer = ClientSignerStub()
        client = ExactTvmClientScheme(signer)
        toncenter = _NativeToncenterStub(balance=balance, is_active=is_active, signer=signer)
        monkeypatch.setattr(client, "_get_client", lambda network: toncenter)
        return client, toncenter, signer

    def test_should_sign_exact_native_transfer_to_pay_to(self, monkeypatch):
        client, toncenter, signer = self._client(monkeypatch, balance=AMOUNT * 10)

        payload = client.create_payment_payload(_native_requirements())
        settlement = parse_exact_tvm_native_payload(payload["settlementBoc"])

        assert payload["asset"] == NATIVE_ASSET
        assert settlement.payer == signer.address
        assert isinstance(settlement.transfer, ParsedNativeTransfer)
        assert settlement.transfer.destination == MERCHANT
        assert settlement.transfer.amount == AMOUNT
        assert settlement.transfer.body.hash == COMMENT.hash
        assert settlement.transfer.bounce is True
        assert settlement.transfer.has_extra_currencies is False
        assert settlement.transfer.has_state_init is False
        assert settlement.state_init is None
        # No Jetton wallet lookup and no fee emulation for native TON.
        assert toncenter.get_jetton_wallet_calls == []
        assert toncenter.emulate_trace_calls == []

    def test_should_send_empty_body_without_forward_payload(self, monkeypatch):
        client, _, _ = self._client(monkeypatch, balance=AMOUNT)

        payload = client.create_payment_payload(
            _native_requirements(extra={"areFeesSponsored": True})
        )
        settlement = parse_exact_tvm_native_payload(payload["settlementBoc"])

        assert settlement.transfer.body.hash == Cell.empty().hash

    def test_should_include_state_init_for_undeployed_wallet(self, monkeypatch):
        client, _, signer = self._client(monkeypatch, balance=AMOUNT, is_active=False)

        payload = client.create_payment_payload(_native_requirements())
        settlement = parse_exact_tvm_native_payload(payload["settlementBoc"])

        assert settlement.state_init is not None
        assert settlement.seqno == 0
        assert settlement.payer == signer.address

    def test_should_refuse_when_balance_does_not_cover_amount(self, monkeypatch):
        client, _, _ = self._client(monkeypatch, balance=AMOUNT - 1)

        with pytest.raises(ValueError, match="below the payment amount"):
            client.create_payment_payload(_native_requirements())

    @pytest.mark.parametrize(
        "extra_field", [{"forwardTonAmount": "0"}, {"responseDestination": MERCHANT}]
    )
    def test_should_refuse_jetton_only_extra_fields(self, monkeypatch, extra_field):
        client, _, _ = self._client(monkeypatch, balance=AMOUNT)

        with pytest.raises(ValueError, match="must not set"):
            client.create_payment_payload(
                _native_requirements(extra={**NATIVE_EXTRA, **extra_field})
            )


class TestNativeCodec:
    def test_should_flag_extra_currencies_and_state_init(self):
        message = Contract.create_internal_msg(
            src=None,
            dest=Address(MERCHANT),
            bounce=True,
            value=CurrencyCollection(AMOUNT, ExtraCurrencyCollection({100: 5})),
            state_init=ClientSignerStub().state_init,
            body=COMMENT,
        )

        # Round-trip through serialization, as the facilitator sees the message.
        transfer = parse_native_transfer(MessageAny.deserialize(message.serialize().begin_parse()))

        assert transfer.amount == AMOUNT
        assert transfer.has_extra_currencies is True
        assert transfer.has_state_init is True


def _native_settlement(**overrides) -> ParsedTvmSettlement:
    transfer = ParsedNativeTransfer(
        destination=overrides.pop("destination", MERCHANT),
        amount=overrides.pop("amount", AMOUNT),
        body=overrides.pop("transfer_body", COMMENT),
        bounce=True,
        has_extra_currencies=overrides.pop("has_extra_currencies", False),
        has_state_init=overrides.pop("has_state_init", False),
        body_hash=COMMENT.hash,
    )
    return ParsedTvmSettlement(
        payer=PAYER,
        wallet_id=777,
        valid_until=int(time.time()) + 120,
        seqno=12,
        settlement_hash="native-settlement-1",
        body=begin_cell().store_uint(0xABCD, 16).end_cell(),
        signed_slice_hash=b"signed-slice",
        signature=b"signature",
        state_init=None,
        transfer=transfer,
    )


def _native_trace(
    settlement: ParsedTvmSettlement,
    *,
    sent_value: int = AMOUNT,
    send_payment: bool = True,
    bounced: bool = False,
    fwd_fee: int = 400_000,
) -> dict[str, object]:
    payment_body_hash = body_hash_to_base64(settlement.transfer.body.hash)
    payer_tx = {
        "account": PAYER,
        "hash": PAYER_TX_HASH,
        "description": {
            "aborted": False,
            "action": {"success": True},
            "compute_ph": {"success": True, "skipped": False, "gas_fees": "1000000"},
            "storage_ph": {"storage_fees_collected": "2000"},
        },
        "in_msg": {
            "hash": "relay-msg",
            "message_content": {"hash": body_hash_to_base64(settlement.body.hash)},
        },
        "out_msgs": (
            [
                {
                    "hash": "payment-msg",
                    "destination": MERCHANT,
                    "value": str(sent_value),
                    "fwd_fee": str(fwd_fee),
                    "message_content": {"hash": payment_body_hash},
                }
            ]
            if send_payment
            else []
        ),
    }
    merchant_tx = {
        "account": MERCHANT,
        "hash": "merchant-tx-hash",
        "description": {
            "aborted": bounced,
            "compute_ph": {"success": not bounced, "skipped": bounced},
            **({"bounce": {"type": "ok"}} if bounced else {}),
        },
        "in_msg": {"hash": "payment-msg"},
    }
    return {"transactions": {"payer": payer_tx, "merchant": merchant_tx}}


class _NativeFacilitatorSigner(FacilitatorSignerStub):
    def __init__(self, trace: dict[str, object]) -> None:
        super().__init__()
        self.account_state.balance = AMOUNT * 2
        self.trace = trace

    def emulate_external_message(self, network: str, external_boc: bytes) -> dict[str, object]:
        assert network == TVM_TESTNET
        assert external_boc == b"external-boc"
        return self.trace


class _FakeBatcher:
    def __init__(self, *args, **kwargs) -> None:
        self.enqueued: list[object] = []

    def enqueue(self, queued_settlement):
        self.enqueued.append(queued_settlement)
        return facilitator_module._BatchResult(success=True, transaction="native-tx")


@dataclass
class _NativeEnv:
    facilitator: ExactTvmFacilitatorScheme
    signer: _NativeFacilitatorSigner
    settlement: ParsedTvmSettlement


@pytest.fixture
def native_env(monkeypatch):
    settlement = _native_settlement()
    signer = _NativeFacilitatorSigner(_native_trace(settlement))
    monkeypatch.setattr(facilitator_module, "_SettlementBatcher", _FakeBatcher)
    monkeypatch.setattr(
        facilitator_module, "parse_exact_tvm_native_payload", lambda boc: env.settlement
    )
    monkeypatch.setattr(
        facilitator_module,
        "parse_active_w5_account_state",
        lambda account: facilitator_module.W5InitData(
            signature_allowed=True,
            seqno=settlement.seqno,
            wallet_id=settlement.wallet_id,
            public_key=b"\x01" * 32,
            extensions_dict=None,
        ),
    )
    monkeypatch.setattr(facilitator_module, "verify_w5_signature", lambda *args: True)
    env = _NativeEnv(
        facilitator=ExactTvmFacilitatorScheme(signer, SettlementCache()),
        signer=signer,
        settlement=settlement,
    )
    return env


def _use_settlement(env: _NativeEnv, settlement: ParsedTvmSettlement, **trace_kwargs) -> None:
    env.settlement = settlement
    env.signer.trace = _native_trace(settlement, **trace_kwargs)


class TestNativeFacilitatorVerify:
    def test_should_accept_valid_native_payment(self, native_env):
        result = native_env.facilitator.verify(_native_payload(), _native_requirements())

        assert result.is_valid is True
        assert result.payer == PAYER

    def test_relay_should_cover_gas_but_never_the_payment_value(self, native_env):
        payload = _native_payload()
        requirements = _native_requirements()
        settlement = native_env.settlement

        _, relay_request = native_env.facilitator._verify(
            payload,
            requirements,
            facilitator_module.ExactTvmPayload.from_dict(payload.payload),
            settlement,
        )

        assert relay_request is not None
        assert relay_request.forward_ton_amount == 0
        assert relay_request.relay_amount == 1_000_000 + 2_000 + DEFAULT_TVM_OUTER_GAS_BUFFER
        assert relay_request.relay_amount < AMOUNT

    def test_should_reject_wallet_that_relies_on_relay_gas(self, native_env):
        # Balance covers the amount but not the outbound forward fee.
        native_env.signer.account_state.balance = AMOUNT + 399_999

        result = native_env.facilitator.verify(_native_payload(), _native_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == ERR_EXACT_TVM_INSUFFICIENT_BALANCE

    def test_should_reject_empty_wallet_before_emulation(self, native_env):
        native_env.signer.account_state.balance = 0
        native_env.signer.trace = {}

        result = native_env.facilitator.verify(_native_payload(), _native_requirements())

        assert result.invalid_reason == ERR_EXACT_TVM_INSUFFICIENT_BALANCE

    @pytest.mark.parametrize(
        ("settlement_overrides", "reason"),
        [
            pytest.param({"destination": ASSET}, ERR_EXACT_TVM_INVALID_RECIPIENT, id="recipient"),
            pytest.param({"amount": AMOUNT - 1}, ERR_EXACT_TVM_INVALID_AMOUNT, id="amount"),
            pytest.param(
                {"transfer_body": Cell.empty()},
                ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER,
                id="body",
            ),
            pytest.param(
                {"has_extra_currencies": True},
                ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER,
                id="extra-currencies",
            ),
            pytest.param(
                {"has_state_init": True},
                ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER,
                id="state-init",
            ),
        ],
    )
    def test_should_reject_settlement_that_does_not_match(
        self, native_env, settlement_overrides, reason
    ):
        _use_settlement(native_env, _native_settlement(**settlement_overrides))

        result = native_env.facilitator.verify(_native_payload(), _native_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == reason

    @pytest.mark.parametrize(
        "extra_field", [{"forwardTonAmount": "0"}, {"responseDestination": MERCHANT}]
    )
    def test_should_reject_jetton_only_extra_fields(self, native_env, extra_field):
        extra = {**NATIVE_EXTRA, **extra_field}

        result = native_env.facilitator.verify(
            _native_payload(accepted_extra=extra), _native_requirements(extra=extra)
        )

        assert result.invalid_reason == ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER

    def test_should_reject_forward_payload_mismatch_between_payload_and_requirements(
        self, native_env
    ):
        result = native_env.facilitator.verify(
            _native_payload(accepted_extra={"areFeesSponsored": True}),
            _native_requirements(),
        )

        assert result.invalid_reason == ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER

    def test_should_reject_native_payload_for_jetton_requirements(self, native_env, monkeypatch):
        monkeypatch.setattr(
            facilitator_module, "parse_exact_tvm_payload", lambda boc: native_env.settlement
        )

        result = native_env.facilitator.verify(
            _native_payload(),
            _native_requirements(asset=ASSET),
        )

        assert result.invalid_reason == ERR_EXACT_TVM_INVALID_ASSET

    def test_should_reject_native_settlement_against_jetton_requirements(
        self, native_env, monkeypatch
    ):
        monkeypatch.setattr(
            facilitator_module, "parse_exact_tvm_payload", lambda boc: native_env.settlement
        )

        result = native_env.facilitator.verify(
            _native_payload(accepted_asset=ASSET, payload_asset=ASSET),
            _native_requirements(asset=ASSET),
        )

        assert result.invalid_reason == ERR_EXACT_TVM_INVALID_JETTON_TRANSFER

    @pytest.mark.parametrize(
        "trace_kwargs",
        [
            pytest.param({"send_payment": False}, id="skipped-action"),
            pytest.param({"sent_value": AMOUNT - 1}, id="wrong-value"),
            pytest.param({"bounced": True}, id="bounced"),
        ],
    )
    def test_should_reject_trace_without_delivered_payment(self, native_env, trace_kwargs):
        _use_settlement(native_env, native_env.settlement, **trace_kwargs)

        result = native_env.facilitator.verify(_native_payload(), _native_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == ERR_EXACT_TVM_SIMULATION_FAILED


class TestNativeFacilitatorSettle:
    def test_should_enqueue_relay_without_payment_value(self, native_env):
        result = native_env.facilitator.settle(_native_payload(), _native_requirements())

        assert result.success is True
        assert result.transaction == "native-tx"
        batcher = native_env.facilitator._batcher
        assert len(batcher.enqueued) == 1
        assert batcher.enqueued[0].relay_request.relay_amount < AMOUNT

    def test_finalized_trace_should_return_payer_transaction_hash(self, native_env):
        trace = _native_trace(native_env.settlement)

        tx_hash = ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
            trace, settlement=native_env.settlement
        )

        assert tx_hash == PAYER_TX_HASH

    def test_finalized_trace_should_fail_when_payment_bounced(self, native_env):
        trace = _native_trace(native_env.settlement, bounced=True)

        with pytest.raises(ValueError, match="bounced"):
            ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
                trace, settlement=native_env.settlement
            )


class TestNativeServer:
    def test_should_parse_ton_price_as_native_nanotons(self):
        server = ExactTvmServerScheme()

        result = server.parse_price("0.01 TON", TVM_TESTNET)

        assert result.asset == NATIVE_ASSET
        assert result.amount == str(AMOUNT)
        assert result.extra == {"areFeesSponsored": True}

    def test_should_keep_native_asset_amount(self):
        server = ExactTvmServerScheme()

        result = server.parse_price(AssetAmount(amount="5", asset="native"), TVM_TESTNET)

        assert result.asset == NATIVE_ASSET

    def test_should_convert_decimal_native_amount_with_nine_decimals(self):
        server = ExactTvmServerScheme()
        requirements = _native_requirements(amount="0.5", extra={})

        enhanced = server.enhance_payment_requirements(
            requirements,
            SupportedKind(x402_version=2, scheme="exact", network=TVM_TESTNET),
            [],
        )

        assert enhanced.asset == NATIVE_ASSET
        assert enhanced.amount == "500000000"
        assert enhanced.extra == {"areFeesSponsored": True}
