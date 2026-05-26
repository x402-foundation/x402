"""Tests for the upto EVM facilitator."""

from __future__ import annotations

import time
from typing import Any

from x402.mechanisms.evm import get_network_config
from x402.mechanisms.evm.constants import (
    ERR_PERMIT2_AMOUNT_MISMATCH,
    ERR_PERMIT2_DEADLINE_EXPIRED,
    ERR_PERMIT2_INSUFFICIENT_BALANCE,
    ERR_PERMIT2_INVALID_SPENDER,
    ERR_PERMIT2_NOT_YET_VALID,
    ERR_PERMIT2_RECIPIENT_MISMATCH,
    ERR_PERMIT2_TOKEN_MISMATCH,
    ERR_UPTO_FACILITATOR_MISMATCH,
    ERR_UPTO_INVALID_SCHEME,
    ERR_UPTO_NETWORK_MISMATCH,
    ERR_UPTO_SETTLEMENT_EXCEEDS_AMOUNT,
    ERR_UPTO_TRANSACTION_FAILED,
    X402_UPTO_PERMIT2_PROXY_ADDRESS,
)
from x402.mechanisms.evm.types import (
    ExactPermit2TokenPermissions,
    TransactionReceipt,
    UptoPermit2Authorization,
    UptoPermit2Payload,
    UptoPermit2Witness,
)
from x402.mechanisms.evm.upto import UptoEvmFacilitatorScheme, UptoEvmSchemeConfig
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

NETWORK = "eip155:8453"
TOKEN_ADDRESS = get_network_config(NETWORK)["default_asset"]["address"]
PAYER = "0x1234567890123456789012345678901234567890"
RECIPIENT = "0x0987654321098765432109876543210987654321"
FACILITATOR = "0x1111111111111111111111111111111111111111"
AMOUNT = "1000"


def make_upto_permit2_authorization(
    *,
    from_address: str = PAYER,
    token: str = TOKEN_ADDRESS,
    amount: str = AMOUNT,
    spender: str = X402_UPTO_PERMIT2_PROXY_ADDRESS,
    nonce: str = "12345678901234567890",
    deadline_offset: int = 3600,
    valid_after_offset: int = -600,
    witness_to: str = RECIPIENT,
    facilitator: str = FACILITATOR,
) -> UptoPermit2Authorization:
    now = int(time.time())
    return UptoPermit2Authorization(
        from_address=from_address,
        permitted=ExactPermit2TokenPermissions(token=token, amount=amount),
        spender=spender,
        nonce=nonce,
        deadline=str(now + deadline_offset),
        witness=UptoPermit2Witness(
            to=witness_to,
            facilitator=facilitator,
            valid_after=str(now + valid_after_offset),
        ),
    )


def make_upto_payload_dict(
    auth: UptoPermit2Authorization | None = None,
    signature: str = "0x" + "aa" * 65,
) -> dict[str, Any]:
    if auth is None:
        auth = make_upto_permit2_authorization()
    payload = UptoPermit2Payload(permit2_authorization=auth, signature=signature)
    return payload.to_dict()


def make_payment_payload(
    *,
    payload_dict: dict[str, Any] | None = None,
    accepted_scheme: str = "upto",
    accepted_network: str = NETWORK,
    pay_to: str = RECIPIENT,
    amount: str = AMOUNT,
) -> PaymentPayload:
    if payload_dict is None:
        payload_dict = make_upto_payload_dict()
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/upto-test",
            description="Upto test resource",
            mime_type="application/json",
        ),
        accepted=PaymentRequirements(
            scheme=accepted_scheme,
            network=accepted_network,
            asset=TOKEN_ADDRESS,
            amount=amount,
            pay_to=pay_to,
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2", "facilitatorAddress": FACILITATOR},
        ),
        payload=payload_dict,
    )


def make_requirements(
    *,
    scheme: str = "upto",
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
        extra={"assetTransferMethod": "permit2", "facilitatorAddress": FACILITATOR},
    )


class MockFacilitatorSigner:
    def __init__(
        self,
        *,
        addresses: list[str] | None = None,
        sig_valid: bool = True,
        allowance: int = int(AMOUNT) * 2,
        balance: int = int(AMOUNT) * 10,
        tx_success: bool = True,
        simulate_ok: bool = True,
        code: bytes = b"",
    ):
        self._addresses = addresses or [FACILITATOR]
        self._sig_valid = sig_valid
        self._allowance = allowance
        self._balance = balance
        self._tx_success = tx_success
        self._simulate_ok = simulate_ok
        self._code = code
        self.write_calls: list[tuple] = []

    def get_addresses(self) -> list[str]:
        return self._addresses

    def read_contract(self, address: str, abi: list[dict], function_name: str, *args) -> Any:
        if function_name == "allowance":
            return self._allowance
        if function_name == "balanceOf":
            return self._balance
        if function_name in {"settle", "settleWithPermit"}:
            if self._simulate_ok:
                return None
            raise RuntimeError("simulation failed")
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
        return 8453

    def get_code(self, address: str) -> bytes:
        return self._code


class TestUptoEvmSchemeConstructor:
    def test_creates_instance_with_correct_scheme(self):
        signer = MockFacilitatorSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)
        assert facilitator.scheme == "upto"
        assert facilitator.caip_family == "eip155:*"


class TestGetExtra:
    def test_returns_facilitator_address(self):
        signer = MockFacilitatorSigner(addresses=[FACILITATOR])
        facilitator = UptoEvmFacilitatorScheme(signer)
        extra = facilitator.get_extra(NETWORK)
        assert extra is not None
        assert extra["facilitatorAddress"] == FACILITATOR

    def test_returns_none_when_no_addresses(self):
        signer = MockFacilitatorSigner()
        signer._addresses = []
        facilitator = UptoEvmFacilitatorScheme(signer)
        assert facilitator.get_extra(NETWORK) is None

    def test_returns_one_of_multiple_addresses(self):
        """get_extra picks randomly from multiple addresses (matches Go/TS behavior)."""
        addr2 = "0x2222222222222222222222222222222222222222"
        addresses = [FACILITATOR, addr2]
        signer = MockFacilitatorSigner(addresses=addresses)
        facilitator = UptoEvmFacilitatorScheme(signer)
        seen = set()
        for _ in range(50):
            extra = facilitator.get_extra(NETWORK)
            assert extra is not None
            seen.add(extra["facilitatorAddress"])
        assert seen == set(addresses), "get_extra should select from all addresses"


class TestGetSigners:
    def test_returns_signer_addresses(self):
        addresses = [FACILITATOR, "0x2222222222222222222222222222222222222222"]
        signer = MockFacilitatorSigner(addresses=addresses)
        facilitator = UptoEvmFacilitatorScheme(signer)
        assert facilitator.get_signers(NETWORK) == addresses


class TestVerify:
    def _make_facilitator(self, **kwargs) -> UptoEvmFacilitatorScheme:
        signer = MockFacilitatorSigner(**kwargs)
        return UptoEvmFacilitatorScheme(signer)

    def test_rejects_wrong_scheme(self):
        facilitator = self._make_facilitator()
        result = facilitator.verify(
            make_payment_payload(accepted_scheme="exact"),
            make_requirements(),
        )
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UPTO_INVALID_SCHEME

    def test_rejects_wrong_network(self):
        facilitator = self._make_facilitator()
        result = facilitator.verify(
            make_payment_payload(accepted_network="eip155:1"),
            make_requirements(),
        )
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UPTO_NETWORK_MISMATCH

    def test_rejects_invalid_spender(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(spender="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_INVALID_SPENDER

    def test_rejects_recipient_mismatch(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(
            witness_to="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        )
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_RECIPIENT_MISMATCH

    def test_rejects_facilitator_mismatch(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(
            facilitator="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        )
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UPTO_FACILITATOR_MISMATCH

    def test_rejects_expired_deadline(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(deadline_offset=-100)
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_DEADLINE_EXPIRED

    def test_rejects_valid_after_in_future(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(valid_after_offset=3600)
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_NOT_YET_VALID

    def test_rejects_amount_mismatch(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(amount="999")
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements(amount=AMOUNT))
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_AMOUNT_MISMATCH

    def test_rejects_token_mismatch(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization(token="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_TOKEN_MISMATCH

    def test_accepts_valid_upto_payload(self):
        from unittest.mock import patch

        facilitator = self._make_facilitator(sig_valid=True)
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())
        assert result.is_valid is True
        assert result.payer == PAYER

    def test_verify_skips_allowance_and_simulation_when_simulate_false(self):
        """simulate=False must return valid after signature check, matching Go/TS behavior."""
        from unittest.mock import patch

        from x402.mechanisms.evm.upto.permit2_utils import verify_upto_permit2

        signer = MockFacilitatorSigner(sig_valid=True, allowance=0, balance=0, simulate_ok=False)
        payload = make_payment_payload()
        requirements = make_requirements()
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = verify_upto_permit2(signer, payload, requirements, simulate=False)
        assert result.is_valid is True

    def test_rejects_unsupported_payload_type(self):
        facilitator = self._make_facilitator()
        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://test", description="test", mime_type="application/json"
            ),
            accepted=PaymentRequirements(
                scheme="upto",
                network=NETWORK,
                asset=TOKEN_ADDRESS,
                amount=AMOUNT,
                pay_to=RECIPIENT,
                max_timeout_seconds=3600,
                extra={},
            ),
            payload={"authorization": {"from": PAYER}, "signature": "0x"},
        )
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == "unsupported_payload_type"


class TestSettle:
    def _make_facilitator(self, **kwargs) -> UptoEvmFacilitatorScheme:
        signer = MockFacilitatorSigner(**kwargs)
        return UptoEvmFacilitatorScheme(signer)

    def test_settle_calls_upto_proxy_contract(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is True
        assert len(signer.write_calls) == 1
        address, function_name, _ = signer.write_calls[0]
        assert address == X402_UPTO_PERMIT2_PROXY_ADDRESS
        assert function_name == "settle"

    def test_settle_returns_amount_in_response(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is True
        assert result.amount == AMOUNT

    def test_zero_settlement_returns_success_without_tx(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements(amount="0"))

        assert result.success is True
        assert result.transaction == ""
        assert result.amount == "0"
        assert len(signer.write_calls) == 0

    def test_settlement_exceeding_amount_fails(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        # authorized max is AMOUNT (1000), try to settle for 2000
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements(amount="2000"))

        assert result.success is False
        assert result.error_reason == ERR_UPTO_SETTLEMENT_EXCEEDS_AMOUNT

    def test_settle_fails_if_verify_fails(self):
        # Use an invalid signature with no deployed contract code so that
        # verify always rejects (signature check runs regardless of simulate mode).
        facilitator = self._make_facilitator(sig_valid=False)
        result = facilitator.settle(make_payment_payload(), make_requirements())
        assert result.success is False

    def test_settle_fails_on_transaction_failure(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(tx_success=False)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is False

    def test_partial_settlement_below_max(self):
        """Settle for 500 when max authorized is 1000."""
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements(amount="500"))

        assert result.success is True
        assert result.amount == "500"
        assert len(signer.write_calls) == 1

    def test_settle_for_exact_max_amount(self):
        """Settle for exactly the max authorized amount (boundary)."""
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements(amount=AMOUNT))

        assert result.success is True
        assert result.amount == AMOUNT

    def test_settle_respects_simulate_in_settle_config(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True, simulate_ok=False)
        facilitator = UptoEvmFacilitatorScheme(
            signer, config=UptoEvmSchemeConfig(simulate_in_settle=True)
        )

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_UPTO_TRANSACTION_FAILED


class TestVerifyEdgeCases:
    def _make_facilitator(self, **kwargs) -> UptoEvmFacilitatorScheme:
        signer = MockFacilitatorSigner(**kwargs)
        return UptoEvmFacilitatorScheme(signer)

    def test_rejects_missing_signature(self):
        facilitator = self._make_facilitator()
        auth = make_upto_permit2_authorization()
        payload_dict = UptoPermit2Payload(permit2_authorization=auth, signature=None).to_dict()
        payload = make_payment_payload(payload_dict=payload_dict)
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert "signature" in result.invalid_reason

    def test_rejects_invalid_signature(self):
        from unittest.mock import patch

        facilitator = self._make_facilitator()
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=False,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())
        assert result.is_valid is False
        assert "signature" in result.invalid_reason

    def test_rejects_insufficient_balance(self):
        from unittest.mock import patch

        facilitator = self._make_facilitator(balance=0)
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_INSUFFICIENT_BALANCE

    def test_rejects_insufficient_allowance(self):
        from unittest.mock import patch

        facilitator = self._make_facilitator(allowance=0)
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == "permit2_allowance_required"

    def test_rejects_requirements_scheme_mismatch(self):
        """TS checks both payload.accepted.scheme and requirements.scheme."""
        facilitator = self._make_facilitator()
        result = facilitator.verify(
            make_payment_payload(),
            make_requirements(scheme="exact"),
        )
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UPTO_INVALID_SCHEME

    def test_accepts_contract_wallet_when_simulation_succeeds(self):
        from unittest.mock import patch

        facilitator = self._make_facilitator(sig_valid=False, code=b"\x01", simulate_ok=True)
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=False,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())

        assert result.is_valid is True

    def test_rejects_when_upto_settle_simulation_fails(self):
        from unittest.mock import patch

        facilitator = self._make_facilitator(sig_valid=True, simulate_ok=False)
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == ERR_UPTO_TRANSACTION_FAILED


class TestMapUptoSettleError:
    """Verify _map_upto_settle_error produces canonical Go/TS-parity error codes."""

    def _call(self, msg: str) -> str:
        from x402.mechanisms.evm.upto.permit2_utils import _map_upto_settle_error

        resp = _map_upto_settle_error(RuntimeError(msg), "eip155:8453", PAYER)
        return resp.error_reason

    def test_amount_exceeds_permitted(self):
        assert (
            self._call("execution reverted: AmountExceedsPermitted")
            == "upto_amount_exceeds_permitted"
        )

    def test_unauthorized_facilitator(self):
        assert (
            self._call("execution reverted: UnauthorizedFacilitator")
            == "upto_unauthorized_facilitator"
        )

    def test_invalid_destination(self):
        assert self._call("execution reverted: InvalidDestination") == "permit2_invalid_destination"

    def test_invalid_owner(self):
        assert self._call("execution reverted: InvalidOwner") == "permit2_invalid_owner"

    def test_payment_too_early(self):
        assert self._call("execution reverted: PaymentTooEarly") == "permit2_payment_too_early"

    def test_invalid_signature(self):
        assert self._call("execution reverted: InvalidSignature") == "invalid_permit2_signature"

    def test_signature_expired(self):
        assert self._call("execution reverted: SignatureExpired") == "invalid_permit2_signature"

    def test_invalid_nonce(self):
        assert self._call("execution reverted: InvalidNonce") == "permit2_invalid_nonce"

    def test_permit2612_amount_mismatch(self):
        assert (
            self._call("execution reverted: Permit2612AmountMismatch")
            == "permit2_2612_amount_mismatch"
        )

    def test_erc20_approval_broadcast_failed(self):
        assert self._call("erc20_approval_tx_failed: 0xabc") == "erc20_approval_broadcast_failed"

    def test_default_maps_to_upto_transaction_failed(self):
        assert self._call("some unknown revert") == "invalid_upto_evm_transaction_failed"
