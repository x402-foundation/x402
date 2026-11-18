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
from x402.extensions.eip2612_gas_sponsoring.client import sign_eip2612_permit
from x402.mechanisms.evm.constants import (
    EIP2612_NONCES_ABI,
    EIP2612_PERMIT_TYPES,
    PERMIT2_ADDRESS,
)
from x402.mechanisms.evm.types import TypedDataField
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


class _StubPermitSigner:
    """Minimal signer that records every read_contract / sign_typed_data call.

    Mirrors the stub-signer pattern used in test_erc20_approval_gas_sponsoring.py
    for sign_erc20_approval_transaction.
    """

    def __init__(self, nonce: int = 0, signature: bytes | None = None):
        self.address = PAYER
        self._nonce = nonce
        self._signature = signature if signature is not None else b"\xab" * 65
        self.read_contract_calls: list[tuple[Any, ...]] = []
        self.sign_typed_data_calls: list[dict[str, Any]] = []

    def read_contract(
        self,
        address: str,
        abi: list[dict[str, Any]],
        function_name: str,
        *args: Any,
    ) -> int:
        self.read_contract_calls.append((address, abi, function_name, args))
        return self._nonce

    def sign_typed_data(
        self,
        domain: dict[str, Any],
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
    ) -> bytes:
        self.sign_typed_data_calls.append(
            {
                "domain": domain,
                "types": types,
                "primary_type": primary_type,
                "message": message,
            }
        )
        return self._signature


class TestSignEip2612Permit:
    """Coverage for sign_eip2612_permit: nonce read, EIP-712 payload, return shape."""

    def test_returns_info_with_all_fields_populated(self):
        signer = _StubPermitSigner(nonce=7, signature=b"\xcd" * 65)
        deadline = "1700000000"
        amount = "1000000"

        info = sign_eip2612_permit(
            signer=signer,
            token_address=TOKEN_ADDRESS,
            token_name="USDC",
            token_version="2",
            chain_id=84532,
            deadline=deadline,
            amount=amount,
        )

        assert info.from_address == PAYER
        assert info.asset == TOKEN_ADDRESS
        assert info.spender == PERMIT2_ADDRESS
        assert info.amount == amount
        assert info.deadline == deadline
        assert info.nonce == "7"
        assert info.signature == "0x" + ("cd" * 65)
        assert info.version == "1"

    def test_reads_nonce_from_token_using_signer_address(self):
        signer = _StubPermitSigner(nonce=42)

        sign_eip2612_permit(
            signer=signer,
            token_address=TOKEN_ADDRESS,
            token_name="USDC",
            token_version="2",
            chain_id=84532,
            deadline="1700000000",
            amount="1000",
        )

        assert len(signer.read_contract_calls) == 1
        address, abi, function_name, args = signer.read_contract_calls[0]
        assert address == TOKEN_ADDRESS
        assert abi == EIP2612_NONCES_ABI
        assert function_name == "nonces"
        assert args == (PAYER,)

    def test_signs_typed_data_with_correct_domain_and_primary_type(self):
        signer = _StubPermitSigner()

        sign_eip2612_permit(
            signer=signer,
            token_address=TOKEN_ADDRESS,
            token_name="USDC",
            token_version="2",
            chain_id=84532,
            deadline="1700000000",
            amount="1000",
        )

        assert len(signer.sign_typed_data_calls) == 1
        call = signer.sign_typed_data_calls[0]
        assert call["primary_type"] == "Permit"
        assert call["domain"] == {
            "name": "USDC",
            "version": "2",
            "chainId": 84532,
            "verifyingContract": TOKEN_ADDRESS,
        }
        # Types must mirror EIP2612_PERMIT_TYPES in name and order, just as
        # TypedDataField objects rather than raw dicts.
        expected_types = {
            type_name: [TypedDataField(name=f["name"], type=f["type"]) for f in fields]
            for type_name, fields in EIP2612_PERMIT_TYPES.items()
        }
        assert call["types"] == expected_types

    def test_signs_message_with_int_fields_and_correct_owner_spender(self):
        signer = _StubPermitSigner(nonce=3)

        sign_eip2612_permit(
            signer=signer,
            token_address=TOKEN_ADDRESS,
            token_name="USDC",
            token_version="2",
            chain_id=84532,
            deadline="1700000000",
            amount="1500",
        )

        message = signer.sign_typed_data_calls[0]["message"]
        assert message["owner"] == PAYER
        assert message["spender"] == PERMIT2_ADDRESS
        # Numeric fields are coerced to int for EIP-712 signing even though
        # the public API takes them as decimal strings.
        assert message["value"] == 1500
        assert message["nonce"] == 3
        assert message["deadline"] == 1700000000
        assert all(isinstance(message[k], int) for k in ("value", "nonce", "deadline"))

    def test_supports_max_uint256_amount(self):
        signer = _StubPermitSigner()
        max_uint256 = str(2**256 - 1)

        info = sign_eip2612_permit(
            signer=signer,
            token_address=TOKEN_ADDRESS,
            token_name="USDC",
            token_version="2",
            chain_id=84532,
            deadline="1700000000",
            amount=max_uint256,
        )

        assert info.amount == max_uint256
        assert signer.sign_typed_data_calls[0]["message"]["value"] == 2**256 - 1
