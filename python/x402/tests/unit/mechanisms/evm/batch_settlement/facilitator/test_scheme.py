"""Unit tests for `BatchSettlementEvmFacilitator` dispatch."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.constants import SCHEME_BATCH_SETTLEMENT
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_AUTHORIZER_NOT_CONFIGURED,
        ERR_INVALID_PAYLOAD_TYPE,
        ERR_INVALID_SCHEME,
        ERR_NETWORK_MISMATCH,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator import refund as refund_mod
    from x402.mechanisms.evm.batch_settlement.facilitator.claim import (
        execute_claim_with_signature,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.refund import (
        execute_refund_with_signature,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.scheme import (
        BatchSettlementEvmFacilitator,
    )
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        ChannelState,
        ClaimPayload,
        EnrichedRefundPayload,
        VoucherClaim,
    )
    from x402.mechanisms.evm.constants import TX_STATUS_SUCCESS
    from x402.schemas import PaymentPayload, PaymentRequirements
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"


class _FakeAuthorizerSigner:
    def __init__(self, address: str) -> None:
        self.address = address

    def sign_typed_data(self, **kwargs) -> str:  # pragma: no cover
        return "0x" + "11" * 65


class _FakeFacilitatorSigner:
    def get_addresses(self) -> list[str]:
        return ["0xabc"]


def _requirements(scheme: str = SCHEME_BATCH_SETTLEMENT, network: str = NETWORK):
    return PaymentRequirements(
        scheme=scheme,
        network=network,
        asset="0x0000000000000000000000000000000000000001",
        amount="0",
        pay_to="0x0000000000000000000000000000000000000002",
        max_timeout_seconds=60,
        extra={},
    )


def _payload(payload_body: dict, scheme: str = SCHEME_BATCH_SETTLEMENT, network: str = NETWORK):
    return PaymentPayload(
        x402_version=2,
        payload=payload_body,
        accepted=_requirements(scheme=scheme, network=network),
    )


class TestFacilitatorMetadata:
    def test_get_extra_includes_receiver_authorizer(self):
        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )
        assert fac.get_extra(NETWORK) == {"receiverAuthorizer": "0xauth"}

    def test_get_extra_returns_none_without_authorizer(self):
        fac = BatchSettlementEvmFacilitator(_FakeFacilitatorSigner())  # type: ignore[arg-type]
        assert fac.get_extra(NETWORK) is None

    def test_get_signers_returns_addresses(self):
        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )
        assert fac.get_signers(NETWORK) == ["0xabc"]


class TestVerifyDispatchErrors:
    def _fac(self):
        return BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )

    def test_wrong_scheme_returns_invalid(self):
        fac = self._fac()
        payload = _payload({"type": "voucher"}, scheme="exact")
        out = fac.verify(payload, _requirements(scheme="exact"))
        assert out.is_valid is False
        assert out.invalid_reason == ERR_INVALID_SCHEME

    def test_network_mismatch(self):
        fac = self._fac()
        payload = _payload({"type": "voucher"}, network="eip155:1")
        out = fac.verify(payload, _requirements(network=NETWORK))
        assert out.is_valid is False
        assert out.invalid_reason == ERR_NETWORK_MISMATCH

    def test_unknown_payload_type(self):
        fac = self._fac()
        payload = _payload({"type": "junk"})
        out = fac.verify(payload, _requirements())
        assert out.is_valid is False
        assert out.invalid_reason == ERR_INVALID_PAYLOAD_TYPE


class TestSettleDispatchErrors:
    def test_unknown_payload_type(self):
        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )
        payload = _payload({"type": "junk"})
        out = fac.settle(payload, _requirements())
        assert out.success is False
        assert out.error_reason == ERR_INVALID_PAYLOAD_TYPE
        assert out.network == NETWORK


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token="0x5555555555555555555555555555555555555555",
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


def _voucher_claim() -> VoucherClaim:
    return VoucherClaim(
        channel=_channel_config(),
        max_claimable_amount="1000",
        signature="0xdead",
        total_claimed="0",
    )


class _SignerNotExpected:
    """Facilitator signer whose use signals the guard failed to short-circuit."""

    def read_contract(self, *args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("read_contract should not be called before the guard")

    def write_contract(self, *args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("write_contract should not be called before the guard")

    def wait_for_transaction_receipt(self, tx):  # pragma: no cover - must not run
        raise AssertionError("wait_for_transaction_receipt should not be called")


class _FakeReceipt:
    status = TX_STATUS_SUCCESS


class _SuccessfulSigner:
    def read_contract(self, *args, **kwargs):
        return None

    def write_contract(self, *args, **kwargs):
        return "0xtx"

    def wait_for_transaction_receipt(self, tx):
        return _FakeReceipt()


class TestClaimAuthorizerNotConfigured:
    def test_missing_signature_without_signer_returns_not_configured(self):
        payload = ClaimPayload(claims=[_voucher_claim()], claim_authorizer_signature=None)

        out = execute_claim_with_signature(
            _SignerNotExpected(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_AUTHORIZER_NOT_CONFIGURED
        assert out.network == NETWORK

    def test_supplied_signature_proceeds_without_signer(self):
        payload = ClaimPayload(
            claims=[_voucher_claim()],
            claim_authorizer_signature="0x" + "11" * 65,
        )

        out = execute_claim_with_signature(
            _SuccessfulSigner(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is True
        assert out.transaction == "0xtx"


class TestRefundAuthorizerNotConfigured:
    def _enriched_refund(
        self, *, with_claims: bool, refund_sig: str | None
    ) -> EnrichedRefundPayload:
        payload = EnrichedRefundPayload()
        payload.channel_config = _channel_config()
        payload.amount = "500"
        payload.refund_nonce = "0"
        payload.claims = [_voucher_claim()] if with_claims else []
        payload.refund_authorizer_signature = refund_sig
        payload.claim_authorizer_signature = None
        return payload

    def test_missing_refund_signature_without_signer_returns_not_configured(self, monkeypatch):
        monkeypatch.setattr(
            refund_mod,
            "read_channel_state",
            lambda signer, channel_id: ChannelState(
                balance=1000, total_claimed=0, withdraw_requested_at=0, refund_nonce=0
            ),
        )
        payload = self._enriched_refund(with_claims=False, refund_sig=None)

        out = execute_refund_with_signature(
            _SignerNotExpected(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_AUTHORIZER_NOT_CONFIGURED

    def test_missing_claim_signature_without_signer_returns_not_configured(self, monkeypatch):
        monkeypatch.setattr(
            refund_mod,
            "read_channel_state",
            lambda signer, channel_id: ChannelState(
                balance=1000, total_claimed=0, withdraw_requested_at=0, refund_nonce=0
            ),
        )
        payload = self._enriched_refund(with_claims=True, refund_sig="0x" + "11" * 65)

        out = execute_refund_with_signature(
            _SignerNotExpected(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_AUTHORIZER_NOT_CONFIGURED
