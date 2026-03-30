"""Tests for the EIP-2612 Gas Sponsoring extension."""

from __future__ import annotations

import time
from typing import Any

from x402.extensions.eip2612_gas_sponsoring import (
    EIP2612_GAS_SPONSORING_KEY,
    Eip2612GasSponsoringInfo,
    declare_eip2612_gas_sponsoring_extension,
    extract_eip2612_gas_sponsoring_info,
    validate_eip2612_gas_sponsoring_info,
    validate_eip2612_permit_for_payment,
)
from x402.mechanisms.evm.constants import PERMIT2_ADDRESS
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x1234567890123456789012345678901234567890"


def _make_info(**overrides: Any) -> Eip2612GasSponsoringInfo:
    defaults = {
        "from_address": PAYER,
        "asset": TOKEN_ADDRESS,
        "spender": PERMIT2_ADDRESS,
        "amount": str(2**256 - 1),
        "nonce": "0",
        "deadline": str(int(time.time()) + 3600),
        "signature": "0x" + "aa" * 65,
        "version": "1",
    }
    defaults.update(overrides)
    return Eip2612GasSponsoringInfo(**defaults)


def _make_payload(info: Eip2612GasSponsoringInfo | None = None) -> PaymentPayload:
    ext = {}
    if info is not None:
        ext = {EIP2612_GAS_SPONSORING_KEY: {"info": info.to_dict()}}
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(url="http://example.com", description="test", mime_type="text"),
        accepted=PaymentRequirements(
            scheme="exact",
            network="eip155:84532",
            asset=TOKEN_ADDRESS,
            amount="1000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2"},
        ),
        payload={"permit2Authorization": {"from": PAYER}},
        extensions=ext,
    )


class TestDeclaration:
    def test_declare_returns_correct_key(self):
        result = declare_eip2612_gas_sponsoring_extension()
        assert EIP2612_GAS_SPONSORING_KEY in result
        ext = result[EIP2612_GAS_SPONSORING_KEY]
        assert "info" in ext
        assert "schema" in ext
        assert ext["info"]["version"] == "1"


class TestSerialization:
    def test_roundtrip(self):
        info = _make_info()
        d = info.to_dict()
        restored = Eip2612GasSponsoringInfo.from_dict(d)
        assert restored.from_address == info.from_address
        assert restored.asset == info.asset
        assert restored.spender == info.spender
        assert restored.amount == info.amount
        assert restored.nonce == info.nonce
        assert restored.deadline == info.deadline
        assert restored.signature == info.signature
        assert restored.version == info.version

    def test_to_dict_uses_camel_case(self):
        info = _make_info()
        d = info.to_dict()
        assert "from" in d
        assert "from_address" not in d


class TestExtraction:
    def test_extract_from_payload(self):
        info = _make_info()
        payload = _make_payload(info)
        result = extract_eip2612_gas_sponsoring_info(payload)
        assert result is not None
        assert result.from_address == PAYER

    def test_extract_returns_none_when_missing(self):
        payload = _make_payload(None)
        result = extract_eip2612_gas_sponsoring_info(payload)
        assert result is None


class TestValidation:
    def test_valid_info(self):
        info = _make_info()
        assert validate_eip2612_gas_sponsoring_info(info) is True

    def test_invalid_address(self):
        info = _make_info(from_address="not-an-address")
        assert validate_eip2612_gas_sponsoring_info(info) is False

    def test_invalid_amount(self):
        info = _make_info(amount="abc")
        assert validate_eip2612_gas_sponsoring_info(info) is False


class TestPaymentValidation:
    def test_valid_permit(self):
        info = _make_info()
        assert validate_eip2612_permit_for_payment(info, PAYER, TOKEN_ADDRESS) == ""

    def test_from_mismatch(self):
        info = _make_info()
        assert "from_mismatch" in validate_eip2612_permit_for_payment(
            info, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", TOKEN_ADDRESS
        )

    def test_asset_mismatch(self):
        info = _make_info()
        assert "asset_mismatch" in validate_eip2612_permit_for_payment(
            info, PAYER, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        )

    def test_spender_not_permit2(self):
        info = _make_info(spender="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        assert "spender_not_permit2" in validate_eip2612_permit_for_payment(
            info, PAYER, TOKEN_ADDRESS
        )

    def test_expired_deadline(self):
        info = _make_info(deadline=str(int(time.time()) - 100))
        assert "deadline_expired" in validate_eip2612_permit_for_payment(info, PAYER, TOKEN_ADDRESS)
