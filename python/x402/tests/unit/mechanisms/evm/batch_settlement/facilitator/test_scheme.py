"""Unit tests for `BatchSettlementEvmFacilitator` dispatch."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.constants import SCHEME_BATCH_SETTLEMENT
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_INVALID_PAYLOAD_TYPE,
        ERR_INVALID_SCHEME,
        ERR_NETWORK_MISMATCH,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.scheme import (
        BatchSettlementEvmFacilitator,
    )
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
