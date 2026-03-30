"""Tests for the Permit2 payment flow in the exact EVM scheme."""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import MagicMock, patch

from x402.mechanisms.evm.constants import (
    ERR_INSUFFICIENT_BALANCE,
    ERR_NETWORK_MISMATCH,
    ERR_PERMIT2_ALLOWANCE_REQUIRED,
    ERR_PERMIT2_AMOUNT_MISMATCH,
    ERR_PERMIT2_DEADLINE_EXPIRED,
    ERR_PERMIT2_INVALID_SIGNATURE,
    ERR_PERMIT2_INVALID_SPENDER,
    ERR_PERMIT2_NOT_YET_VALID,
    ERR_PERMIT2_RECIPIENT_MISMATCH,
    ERR_PERMIT2_TOKEN_MISMATCH,
    ERR_UNSUPPORTED_SCHEME,
    X402_EXACT_PERMIT2_PROXY_ADDRESS,
)
from x402.mechanisms.evm.exact import ExactEvmClientScheme, ExactEvmFacilitatorScheme
from x402.mechanisms.evm.types import (
    ExactPermit2Authorization,
    ExactPermit2Payload,
    ExactPermit2TokenPermissions,
    ExactPermit2Witness,
    TransactionReceipt,
    is_permit2_payload,
)
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

NETWORK = "eip155:84532"  # Base Sepolia
TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x1234567890123456789012345678901234567890"
RECIPIENT = "0x0987654321098765432109876543210987654321"
FACILITATOR = "0x1111111111111111111111111111111111111111"
AMOUNT = "1000"


def make_permit2_authorization(
    *,
    from_address: str = PAYER,
    token: str = TOKEN_ADDRESS,
    amount: str = AMOUNT,
    spender: str = X402_EXACT_PERMIT2_PROXY_ADDRESS,
    nonce: str = "12345678901234567890",
    deadline_offset: int = 3600,
    valid_after_offset: int = -600,
    witness_to: str = RECIPIENT,
) -> ExactPermit2Authorization:
    now = int(time.time())
    return ExactPermit2Authorization(
        from_address=from_address,
        permitted=ExactPermit2TokenPermissions(token=token, amount=amount),
        spender=spender,
        nonce=nonce,
        deadline=str(now + deadline_offset),
        witness=ExactPermit2Witness(
            to=witness_to,
            valid_after=str(now + valid_after_offset),
        ),
    )


def make_permit2_payload_dict(
    auth: ExactPermit2Authorization | None = None,
    signature: str = "0x" + "aa" * 65,
) -> dict[str, Any]:
    if auth is None:
        auth = make_permit2_authorization()
    payload = ExactPermit2Payload(permit2_authorization=auth, signature=signature)
    return payload.to_dict()


def make_payment_payload(
    *,
    payload_dict: dict[str, Any] | None = None,
    accepted_scheme: str = "exact",
    accepted_network: str = NETWORK,
    pay_to: str = RECIPIENT,
    amount: str = AMOUNT,
) -> PaymentPayload:
    if payload_dict is None:
        payload_dict = make_permit2_payload_dict()
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/protected-permit2",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=PaymentRequirements(
            scheme=accepted_scheme,
            network=accepted_network,
            asset=TOKEN_ADDRESS,
            amount=amount,
            pay_to=pay_to,
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2"},
        ),
        payload=payload_dict,
    )


def make_requirements(
    *,
    scheme: str = "exact",
    network: str = NETWORK,
    amount: str = AMOUNT,
    pay_to: str = RECIPIENT,
) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=scheme,
        network=network,
        asset=TOKEN_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={"assetTransferMethod": "permit2"},
    )


class MockFacilitatorSigner:
    """Mock signer for permit2 facilitator tests."""

    def __init__(
        self,
        *,
        sig_valid: bool = True,
        allowance: int = int(AMOUNT) * 2,
        balance: int = int(AMOUNT) * 10,
        tx_success: bool = True,
    ):
        self._sig_valid = sig_valid
        self._allowance = allowance
        self._balance = balance
        self._tx_success = tx_success
        self.write_calls: list[tuple] = []

    def get_addresses(self) -> list[str]:
        return [FACILITATOR]

    def read_contract(self, address: str, abi: list[dict], function_name: str, *args) -> Any:
        if function_name == "allowance":
            return self._allowance
        if function_name == "balanceOf":
            return self._balance
        raise AssertionError(f"unexpected read_contract: {function_name}")

    def verify_typed_data(self, *args: Any, **kwargs: Any) -> bool:
        return self._sig_valid

    def write_contract(self, address: str, abi: list[dict], function_name: str, *args) -> str:
        self.write_calls.append((address, function_name, args))
        return "0x" + "ab" * 32

    def send_transaction(self, to: str, data: bytes) -> str:
        return "0x" + "cd" * 32

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        status = 1 if self._tx_success else 0
        return TransactionReceipt(status=status, block_number=1, tx_hash=tx_hash)

    def get_balance(self, address: str, token_address: str) -> int:
        return self._balance

    def get_chain_id(self) -> int:
        return 84532

    def get_code(self, address: str) -> bytes:
        return b""


# ============================================================================
# Type detection tests
# ============================================================================


class TestIsPermit2Payload:
    def test_detects_permit2_payload(self):
        payload = make_permit2_payload_dict()
        assert is_permit2_payload(payload) is True

    def test_rejects_eip3009_payload(self):
        payload = {"authorization": {"from": PAYER}, "signature": "0x"}
        assert is_permit2_payload(payload) is False

    def test_rejects_empty_dict(self):
        assert is_permit2_payload({}) is False


# ============================================================================
# ExactPermit2Payload serialization
# ============================================================================


class TestExactPermit2PayloadSerialization:
    def test_to_dict_and_from_dict_roundtrip(self):
        auth = make_permit2_authorization()
        original = ExactPermit2Payload(permit2_authorization=auth, signature="0x" + "ff" * 65)

        d = original.to_dict()
        restored = ExactPermit2Payload.from_dict(d)

        assert restored.permit2_authorization.from_address == auth.from_address
        assert restored.permit2_authorization.spender == auth.spender
        assert restored.permit2_authorization.nonce == auth.nonce
        assert restored.permit2_authorization.deadline == auth.deadline
        assert restored.permit2_authorization.permitted.token == auth.permitted.token
        assert restored.permit2_authorization.permitted.amount == auth.permitted.amount
        assert restored.permit2_authorization.witness.to == auth.witness.to
        assert restored.permit2_authorization.witness.valid_after == auth.witness.valid_after
        assert restored.signature == original.signature

    def test_to_dict_keys_are_camel_case(self):
        auth = make_permit2_authorization()
        payload = ExactPermit2Payload(permit2_authorization=auth, signature="0xsig")
        d = payload.to_dict()

        assert "permit2Authorization" in d
        p2 = d["permit2Authorization"]
        assert "from" in p2
        assert "permitted" in p2
        assert "spender" in p2
        assert "nonce" in p2
        assert "deadline" in p2
        assert "witness" in p2
        assert "to" in p2["witness"]
        assert "validAfter" in p2["witness"]


# ============================================================================
# Facilitator verify_permit2 tests
# ============================================================================


class TestVerifyPermit2:
    def _make_facilitator(self, **kwargs) -> ExactEvmFacilitatorScheme:
        signer = MockFacilitatorSigner(**kwargs)
        return ExactEvmFacilitatorScheme(signer)

    def _verify(self, facilitator: ExactEvmFacilitatorScheme, **payload_kwargs):
        payload = make_payment_payload(**payload_kwargs)
        requirements = make_requirements()
        return facilitator.verify(payload, requirements)

    def test_verify_accepts_valid_payment(self):
        facilitator = self._make_facilitator(sig_valid=True)
        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = self._verify(facilitator)
        assert result.is_valid is True
        assert result.payer == PAYER

    def test_verify_rejects_wrong_scheme(self):
        facilitator = self._make_facilitator()
        payload = make_payment_payload(accepted_scheme="upto")
        requirements = make_requirements()
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNSUPPORTED_SCHEME

    def test_verify_rejects_network_mismatch(self):
        facilitator = self._make_facilitator()
        payload = make_payment_payload(accepted_network="eip155:8453")
        requirements = make_requirements(network="eip155:84532")
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_NETWORK_MISMATCH

    def test_verify_rejects_invalid_spender(self):
        facilitator = self._make_facilitator()
        auth = make_permit2_authorization(spender="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        payload = make_payment_payload(payload_dict=make_permit2_payload_dict(auth))
        requirements = make_requirements()
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_INVALID_SPENDER

    def test_verify_rejects_recipient_mismatch(self):
        facilitator = self._make_facilitator()
        wrong_recipient = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        auth = make_permit2_authorization(witness_to=wrong_recipient)
        payload = make_payment_payload(payload_dict=make_permit2_payload_dict(auth))
        requirements = make_requirements(pay_to=RECIPIENT)
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_RECIPIENT_MISMATCH

    def test_verify_rejects_expired_deadline(self):
        facilitator = self._make_facilitator()
        auth = make_permit2_authorization(deadline_offset=-100)  # expired
        payload = make_payment_payload(payload_dict=make_permit2_payload_dict(auth))
        requirements = make_requirements()
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_DEADLINE_EXPIRED

    def test_verify_rejects_valid_after_in_future(self):
        facilitator = self._make_facilitator()
        auth = make_permit2_authorization(valid_after_offset=3600)  # 1 hour from now
        payload = make_payment_payload(payload_dict=make_permit2_payload_dict(auth))
        requirements = make_requirements()
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_NOT_YET_VALID

    def test_verify_rejects_amount_mismatch(self):
        facilitator = self._make_facilitator()
        auth = make_permit2_authorization(amount="999")  # wrong amount
        payload = make_payment_payload(payload_dict=make_permit2_payload_dict(auth))
        requirements = make_requirements(amount=AMOUNT)
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_AMOUNT_MISMATCH

    def test_verify_rejects_token_mismatch(self):
        facilitator = self._make_facilitator()
        wrong_token = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        auth = make_permit2_authorization(token=wrong_token)
        payload = make_payment_payload(payload_dict=make_permit2_payload_dict(auth))
        requirements = make_requirements()
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_TOKEN_MISMATCH

    def test_verify_rejects_invalid_signature(self):
        facilitator = self._make_facilitator()
        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=False,
        ):
            result = self._verify(facilitator)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_INVALID_SIGNATURE

    def test_verify_rejects_missing_signature(self):
        facilitator = self._make_facilitator()
        auth = make_permit2_authorization()
        payload_dict = ExactPermit2Payload(permit2_authorization=auth, signature=None).to_dict()
        payload = make_payment_payload(payload_dict=payload_dict)
        requirements = make_requirements()
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_INVALID_SIGNATURE

    def test_verify_rejects_insufficient_allowance(self):
        facilitator = self._make_facilitator(allowance=0)
        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = self._verify(facilitator)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_ALLOWANCE_REQUIRED

    def test_verify_rejects_insufficient_balance(self):
        facilitator = self._make_facilitator(allowance=int(AMOUNT) * 10, balance=0)
        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = self._verify(facilitator)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_INSUFFICIENT_BALANCE


# ============================================================================
# Facilitator settle_permit2 tests
# ============================================================================


class TestSettlePermit2:
    def _make_facilitator(self, **kwargs) -> ExactEvmFacilitatorScheme:
        signer = MockFacilitatorSigner(**kwargs)
        return ExactEvmFacilitatorScheme(signer)

    def test_settle_calls_proxy_contract(self):
        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = ExactEvmFacilitatorScheme(signer)
        payload = make_payment_payload()
        requirements = make_requirements()

        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(payload, requirements)

        assert result.success is True
        assert len(signer.write_calls) == 1
        address, function_name, _ = signer.write_calls[0]
        assert address == X402_EXACT_PERMIT2_PROXY_ADDRESS
        assert function_name == "settle"

    def test_settle_returns_transaction_hash(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)
        payload = make_payment_payload()
        requirements = make_requirements()

        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(payload, requirements)

        assert result.success is True
        assert result.transaction is not None
        assert len(result.transaction) > 0

    def test_settle_fails_if_verify_fails(self):
        facilitator = self._make_facilitator(allowance=0)
        payload = make_payment_payload()
        requirements = make_requirements()
        result = facilitator.settle(payload, requirements)
        assert result.success is False

    def test_settle_fails_on_transaction_failure(self):
        signer = MockFacilitatorSigner(tx_success=False)
        facilitator = ExactEvmFacilitatorScheme(signer)
        payload = make_payment_payload()
        requirements = make_requirements()

        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(payload, requirements)

        assert result.success is False


# ============================================================================
# Client routing tests
# ============================================================================


class TestClientPermit2Routing:
    def test_routes_to_permit2_when_asset_transfer_method_is_permit2(self):
        mock_signer = MagicMock()
        mock_signer.address = PAYER
        mock_signer.sign_typed_data.return_value = b"\x00" * 65

        client_scheme = ExactEvmClientScheme(mock_signer)
        requirements = make_requirements()

        result = client_scheme.create_payment_payload(requirements)

        assert "permit2Authorization" in result
        assert "authorization" not in result
        assert result["permit2Authorization"]["from"] == PAYER
        assert result["permit2Authorization"]["spender"] == X402_EXACT_PERMIT2_PROXY_ADDRESS

    def test_routes_to_eip3009_when_no_asset_transfer_method(self):
        mock_signer = MagicMock()
        mock_signer.address = PAYER
        mock_signer.sign_typed_data.return_value = b"\x00" * 65

        client_scheme = ExactEvmClientScheme(mock_signer)
        requirements = PaymentRequirements(
            scheme="exact",
            network=NETWORK,
            asset=TOKEN_ADDRESS,
            amount=AMOUNT,
            pay_to=RECIPIENT,
            max_timeout_seconds=3600,
            extra={"name": "USD Coin", "version": "2"},
        )

        result = client_scheme.create_payment_payload(requirements)

        assert "authorization" in result
        assert "permit2Authorization" not in result

    def test_permit2_payload_has_correct_structure(self):
        mock_signer = MagicMock()
        mock_signer.address = PAYER
        mock_signer.sign_typed_data.return_value = b"\xff" * 65

        client_scheme = ExactEvmClientScheme(mock_signer)
        requirements = make_requirements()

        result = client_scheme.create_payment_payload(requirements)

        p2 = result["permit2Authorization"]
        assert p2["from"] == PAYER
        assert p2["spender"] == X402_EXACT_PERMIT2_PROXY_ADDRESS
        assert p2["witness"]["to"] == RECIPIENT
        assert "nonce" in p2
        assert "deadline" in p2
        assert "permitted" in p2
        assert p2["permitted"]["token"] == "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
        assert p2["permitted"]["amount"] == AMOUNT


# ============================================================================
# Extension-aware verify tests
# ============================================================================


class TestVerifyPermit2WithExtensions:
    """Tests for verify_permit2 with gas sponsoring extension fallbacks."""

    def _make_facilitator(self, **kwargs) -> ExactEvmFacilitatorScheme:
        signer = MockFacilitatorSigner(**kwargs)
        return ExactEvmFacilitatorScheme(signer)

    def test_verify_accepts_with_eip2612_extension_when_allowance_insufficient(self):
        """When allowance is 0 but valid EIP-2612 extension is present, verify passes."""
        from x402.extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY
        from x402.mechanisms.evm.constants import PERMIT2_ADDRESS

        facilitator = self._make_facilitator(allowance=0, sig_valid=True)

        now = int(time.time())
        eip2612_info = {
            "from": PAYER,
            "asset": TOKEN_ADDRESS,
            "spender": PERMIT2_ADDRESS,
            "amount": str(2**256 - 1),
            "nonce": "0",
            "deadline": str(now + 3600),
            "signature": "0x" + "aa" * 65,
            "version": "1",
        }

        payload_dict = make_permit2_payload_dict()
        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/test",
                description="Test",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=NETWORK,
                asset=TOKEN_ADDRESS,
                amount=AMOUNT,
                pay_to=RECIPIENT,
                max_timeout_seconds=3600,
                extra={"assetTransferMethod": "permit2"},
            ),
            payload=payload_dict,
            extensions={EIP2612_GAS_SPONSORING_KEY: {"info": eip2612_info}},
        )
        requirements = make_requirements()

        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(payload, requirements)

        assert result.is_valid is True

    def test_verify_rejects_with_invalid_eip2612_extension(self):
        """When allowance is 0 and EIP-2612 extension has wrong spender, verify fails."""
        from x402.extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY

        facilitator = self._make_facilitator(allowance=0, sig_valid=True)

        now = int(time.time())
        eip2612_info = {
            "from": PAYER,
            "asset": TOKEN_ADDRESS,
            "spender": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            "amount": str(2**256 - 1),
            "nonce": "0",
            "deadline": str(now + 3600),
            "signature": "0x" + "aa" * 65,
            "version": "1",
        }

        payload_dict = make_permit2_payload_dict()
        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/test",
                description="Test",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=NETWORK,
                asset=TOKEN_ADDRESS,
                amount=AMOUNT,
                pay_to=RECIPIENT,
                max_timeout_seconds=3600,
                extra={"assetTransferMethod": "permit2"},
            ),
            payload=payload_dict,
            extensions={EIP2612_GAS_SPONSORING_KEY: {"info": eip2612_info}},
        )
        requirements = make_requirements()

        with patch(
            "x402.mechanisms.evm.exact.permit2_utils._verify_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert "spender_not_permit2" in result.invalid_reason
