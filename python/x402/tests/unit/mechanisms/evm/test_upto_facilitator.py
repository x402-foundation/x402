"""Tests for the upto EVM facilitator."""

from __future__ import annotations

import time
from typing import Any

from x402.mechanisms.evm import get_default_asset
from x402.mechanisms.evm.asset_cache import reset_asset_contract_cache
from x402.mechanisms.evm.constants import (
    ERR_ASSET_NOT_DEPLOYED_CONTRACT,
    ERR_ERC20_APPROVAL_BROADCAST_FAILED,
    ERR_PERMIT2_AMOUNT_MISMATCH,
    ERR_PERMIT2_DEADLINE_EXPIRED,
    ERR_PERMIT2_INSUFFICIENT_BALANCE,
    ERR_PERMIT2_INVALID_SPENDER,
    ERR_PERMIT2_NOT_YET_VALID,
    ERR_PERMIT2_RECIPIENT_MISMATCH,
    ERR_PERMIT2_TOKEN_MISMATCH,
    ERR_SETTLEMENT_PENDING,
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
TOKEN_ADDRESS = get_default_asset(NETWORK)["asset"]
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
        code_by_address: dict[str, bytes] | None = None,
    ):
        self._addresses = addresses or [FACILITATOR]
        self._sig_valid = sig_valid
        self._allowance = allowance
        self._balance = balance
        self._tx_success = tx_success
        self._simulate_ok = simulate_ok
        self._code = code
        # Default: token contract is always a deployed contract so the asset check passes.
        # Tests that need per-address control can pass code_by_address explicitly.
        self._code_by_address: dict[str, bytes] = {
            TOKEN_ADDRESS.lower(): b"\x60",
        }
        if code_by_address:
            self._code_by_address.update({k.lower(): v for k, v in code_by_address.items()})
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

    def write_contract(
        self,
        address: str,
        abi: list[dict],
        function_name: str,
        *args,
        data_suffix: str | None = None,
    ) -> str:
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
        return self._code_by_address.get(address.lower(), self._code)


class _CountingAssetCodeSigner(MockFacilitatorSigner):
    """Counts get_code calls for the payment token."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.asset_get_code_calls = 0

    def get_code(self, address: str) -> bytes:
        if address.lower() == TOKEN_ADDRESS.lower():
            self.asset_get_code_calls += 1
        return super().get_code(address)


class _ReceiptTimeoutSigner(MockFacilitatorSigner):
    """Signer whose broadcast never confirms in time (settlement_pending)."""

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        raise TimeoutError("rpc: timeout waiting for receipt")


class TestUptoEvmSchemeConstructor:
    def test_creates_instance_with_correct_scheme(self):
        signer = MockFacilitatorSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)
        assert facilitator.scheme == "upto"
        assert facilitator.caip_family == "eip155:*"

    def test_uses_provided_pending_store_instead_of_a_fresh_default(self):
        """A caller-supplied PendingSettlementStore must be the instance actually used,
        not merely accepted and ignored in favor of the default. This is what lets a
        multi-instance facilitator inject a shared, network-backed store."""
        from x402.pending_settlement_store import InMemoryPendingSettlementStore

        signer = MockFacilitatorSigner()
        custom_store = InMemoryPendingSettlementStore()

        facilitator = UptoEvmFacilitatorScheme(signer, pending_store=custom_store)

        assert facilitator._pending_store is custom_store


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

    def test_invalid_spender_does_not_check_asset_contract(self):
        reset_asset_contract_cache()
        signer = _CountingAssetCodeSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)
        auth = make_upto_permit2_authorization(spender="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        payload = make_payment_payload(payload_dict=make_upto_payload_dict(auth))
        result = facilitator.verify(payload, make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_PERMIT2_INVALID_SPENDER
        assert signer.asset_get_code_calls == 0

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

    def test_rejects_eoa_asset(self):
        # When the token address has no bytecode, verify must reject with asset_not_deployed_contract.
        # Other tests share TOKEN_ADDRESS but model it as deployed, and positive asset checks are
        # cached process-wide, so drop those entries to force a real get_code here.
        reset_asset_contract_cache()
        from unittest.mock import patch

        facilitator = self._make_facilitator(
            code_by_address={TOKEN_ADDRESS.lower(): b""},  # token = EOA
        )
        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.verify(make_payment_payload(), make_requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_ASSET_NOT_DEPLOYED_CONTRACT

    def test_getcode_rpc_error_raises(self):
        # An RPC error on get_code must propagate as an exception, not a 400 response.
        from unittest.mock import patch

        import pytest

        reset_asset_contract_cache()

        class _RPCErrorSigner(MockFacilitatorSigner):
            def get_code(self, address: str) -> bytes:
                if address.lower() == TOKEN_ADDRESS.lower():
                    raise RuntimeError("rpc: connection refused")
                return b""

        facilitator = UptoEvmFacilitatorScheme(_RPCErrorSigner())

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            with pytest.raises(RuntimeError, match="rpc: connection refused"):
                facilitator.verify(make_payment_payload(), make_requirements())


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

    def test_receipt_wait_failure_returns_settlement_pending(self):
        from unittest.mock import patch

        signer = _ReceiptTimeoutSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_SETTLEMENT_PENDING
        assert result.transaction == "0x" + "ab" * 32  # broadcast tx hash from write_contract
        # Nothing is known to have settled yet, so no amount is reported.
        assert result.amount is None

    def test_receipt_wait_type_error_returns_settlement_pending(self):
        from unittest.mock import patch

        class _BrokenSigner(MockFacilitatorSigner):
            def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
                raise TypeError("wait_for_transaction_receipt() missing 1 required argument")

        signer = _BrokenSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_SETTLEMENT_PENDING
        assert result.transaction == "0x" + "ab" * 32

    def test_settle_invalid_broadcast_hash_is_terminal(self):
        # settlement_pending needs the broadcast hash to be actionable, so a signer that
        # reports success without a usable hash must fail terminally.
        from unittest.mock import patch

        class _InvalidHashSigner(MockFacilitatorSigner):
            def write_contract(self, *args: Any, **kwargs: Any) -> str:
                return "0xnothash"

            def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
                raise AssertionError("must not wait on an invalid transaction hash")

        facilitator = UptoEvmFacilitatorScheme(_InvalidHashSigner())

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_UPTO_TRANSACTION_FAILED
        assert result.transaction == ""

    def test_settle_erc20_approval_invalid_settlement_hash_returned_without_error(self):
        # Malformed final hash without error must not proceed to receipt wait.
        from x402.extensions.erc20_approval_gas_sponsoring import (
            Erc20ApprovalGasSponsoringInfo,
        )
        from x402.mechanisms.evm.upto.permit2_utils import (
            _settle_upto_with_erc20_approval,
        )

        class _InvalidHashExtensionSigner:
            def send_transactions(self, transactions: list[Any]) -> list[str]:
                return ["0xapproval"]

        permit2_payload = UptoPermit2Payload(
            permit2_authorization=make_upto_permit2_authorization(),
            signature="0x" + "aa" * 65,
        )
        erc20_info = Erc20ApprovalGasSponsoringInfo(
            from_address=PAYER,
            asset=TOKEN_ADDRESS,
            spender=X402_UPTO_PERMIT2_PROXY_ADDRESS,
            amount=str(2**256 - 1),
            signed_transaction="0x" + "ff" * 100,
            version="1",
        )

        result = _settle_upto_with_erc20_approval(
            _InvalidHashExtensionSigner(),
            make_payment_payload(),
            permit2_payload,
            erc20_info,
            settlement_amount=int(AMOUNT),
        )

        assert result.success is False
        assert result.error_reason == ERR_ERC20_APPROVAL_BROADCAST_FAILED
        assert result.transaction == ""

    def test_settle_erc20_approval_atomic_bundle_single_hash_succeeds(self):
        from x402.extensions.erc20_approval_gas_sponsoring import (
            Erc20ApprovalGasSponsoringInfo,
        )
        from x402.mechanisms.evm.upto.permit2_utils import (
            _settle_upto_with_erc20_approval,
        )

        bundle_hash = "0x" + "ef" * 32

        class _AtomicBundleExtensionSigner:
            def send_transactions(self, transactions: list[Any]) -> list[str]:
                return [bundle_hash]

            def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
                return TransactionReceipt(status=1, block_number=1, tx_hash=tx_hash)

        permit2_payload = UptoPermit2Payload(
            permit2_authorization=make_upto_permit2_authorization(),
            signature="0x" + "aa" * 65,
        )
        erc20_info = Erc20ApprovalGasSponsoringInfo(
            from_address=PAYER,
            asset=TOKEN_ADDRESS,
            spender=X402_UPTO_PERMIT2_PROXY_ADDRESS,
            amount=str(2**256 - 1),
            signed_transaction="0x" + "ff" * 100,
            version="1",
        )

        result = _settle_upto_with_erc20_approval(
            _AtomicBundleExtensionSigner(),
            make_payment_payload(),
            permit2_payload,
            erc20_info,
            settlement_amount=int(AMOUNT),
        )

        assert result.success is True
        assert result.transaction == bundle_hash

    def test_settle_erc20_approval_extension_receipt_wait_failure_returns_settlement_pending(
        self,
    ):
        from x402.extensions.erc20_approval_gas_sponsoring import (
            Erc20ApprovalGasSponsoringInfo,
        )
        from x402.mechanisms.evm.upto.permit2_utils import (
            _settle_upto_with_erc20_approval,
        )

        settle_hash = "0x" + "ef" * 32

        class _ReceiptTimeoutExtensionSigner:
            def send_transactions(self, transactions: list[Any]) -> list[str]:
                return ["0x" + "11" * 32, settle_hash]

            def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
                raise TimeoutError("rpc: timeout waiting for receipt")

        permit2_payload = UptoPermit2Payload(
            permit2_authorization=make_upto_permit2_authorization(),
            signature="0x" + "aa" * 65,
        )
        erc20_info = Erc20ApprovalGasSponsoringInfo(
            from_address=PAYER,
            asset=TOKEN_ADDRESS,
            spender=X402_UPTO_PERMIT2_PROXY_ADDRESS,
            amount=str(2**256 - 1),
            signed_transaction="0x" + "ff" * 100,
            version="1",
        )

        result = _settle_upto_with_erc20_approval(
            _ReceiptTimeoutExtensionSigner(),
            make_payment_payload(),
            permit2_payload,
            erc20_info,
            settlement_amount=int(AMOUNT),
        )

        assert result.success is False
        assert result.error_reason == ERR_SETTLEMENT_PENDING
        assert result.transaction == settle_hash

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


class TestUptoPermit2PendingSettlementStore:
    """Pending-settlement store integration for the upto Permit2 settle path."""

    def test_cache_miss_broadcast_success_leaves_store_empty(self):
        from unittest.mock import patch

        signer = MockFacilitatorSigner(sig_valid=True)
        facilitator = UptoEvmFacilitatorScheme(signer)

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is True
        assert facilitator._pending_store.entries == {}

    def test_cache_miss_wait_failure_populates_store_with_broadcast_hash(self):
        from unittest.mock import patch

        signer = _ReceiptTimeoutSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)
        payload = make_payment_payload()

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            result = facilitator.settle(payload, make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_SETTLEMENT_PENDING
        signature = payload.payload["signature"]
        assert facilitator._pending_store.get(signature) == result.transaction

    def test_cache_hit_skips_verify_and_broadcast_then_reconciles_success(self):
        from unittest.mock import patch

        signer = _ReceiptTimeoutSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)
        payload = make_payment_payload()

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            first = facilitator.settle(payload, make_requirements())
        assert first.success is False
        write_calls_after_first = len(signer.write_calls)

        signer.wait_for_transaction_receipt = lambda tx_hash: TransactionReceipt(
            status=1, block_number=1, tx_hash=tx_hash
        )

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils.verify_upto_permit2",
            side_effect=AssertionError("verify must be skipped on a pending-store hit"),
        ):
            second = facilitator.settle(payload, make_requirements())

        assert second.success is True
        assert second.transaction == first.transaction
        assert second.amount == AMOUNT
        assert len(signer.write_calls) == write_calls_after_first  # no second broadcast
        assert facilitator._pending_store.entries == {}

    def test_cache_hit_still_unconfirmed_returns_settlement_pending_again(self):
        from unittest.mock import patch

        signer = _ReceiptTimeoutSigner()
        facilitator = UptoEvmFacilitatorScheme(signer)
        payload = make_payment_payload()

        with patch(
            "x402.mechanisms.evm.upto.permit2_utils._verify_upto_permit2_signature",
            return_value=True,
        ):
            first = facilitator.settle(payload, make_requirements())
            second = facilitator.settle(payload, make_requirements())

        assert second.success is False
        assert second.error_reason == ERR_SETTLEMENT_PENDING
        assert second.transaction == first.transaction
        assert len(signer.write_calls) == 1  # never re-broadcast

    def test_verify_only_failure_is_terminal_and_never_touches_store(self):
        facilitator = UptoEvmFacilitatorScheme(MockFacilitatorSigner(sig_valid=False))

        result = facilitator.settle(make_payment_payload(), make_requirements())

        assert result.success is False
        assert facilitator._pending_store.entries == {}
