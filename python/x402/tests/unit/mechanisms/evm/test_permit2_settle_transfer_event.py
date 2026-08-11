"""Regression: exact Permit2 settle must verify ERC-20 Transfer, not only status.

Receipt status alone is not enough: fee-on-transfer / non-conforming tokens can
underpay without reverting the proxy call. Mirrors EIP-3009 settle (#2385) and
TS #3080 / Go #3084.
"""

from __future__ import annotations

import time
from typing import Any

from x402.mechanisms.evm.constants import (
    ERR_TRANSACTION_FAILED,
    ERR_TRANSFER_EVENT_MISMATCH,
    X402_EXACT_PERMIT2_PROXY_ADDRESS,
)
from x402.mechanisms.evm.exact.eip3009_utils import ERC20_TRANSFER_EVENT_TOPIC
from x402.mechanisms.evm.exact.permit2_utils import _settle_permit2_direct
from x402.mechanisms.evm.types import (
    ExactPermit2Authorization,
    ExactPermit2Payload,
    ExactPermit2TokenPermissions,
    ExactPermit2Witness,
    TransactionReceipt,
)
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

NETWORK = "eip155:84532"
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x1234567890123456789012345678901234567890"
RECEIVER = "0x0987654321098765432109876543210987654321"
AMOUNT = "1000"
TX_HASH = "0x" + "ab" * 32


def _addr_topic(address: str) -> str:
    return "0x" + "0" * 24 + address.lower().removeprefix("0x")


def make_transfer_log(
    *,
    address: str,
    from_address: str,
    to: str,
    value: int,
) -> dict:
    return {
        "address": address,
        "topics": [
            ERC20_TRANSFER_EVENT_TOPIC,
            _addr_topic(from_address),
            _addr_topic(to),
        ],
        "data": "0x" + f"{value:064x}",
    }


def make_permit2_payload() -> ExactPermit2Payload:
    now = int(time.time())
    return ExactPermit2Payload(
        permit2_authorization=ExactPermit2Authorization(
            from_address=PAYER,
            permitted=ExactPermit2TokenPermissions(token=TOKEN, amount=AMOUNT),
            spender=X402_EXACT_PERMIT2_PROXY_ADDRESS,
            nonce="12345678901234567890",
            deadline=str(now + 3600),
            witness=ExactPermit2Witness(
                to=RECEIVER,
                valid_after=str(now - 600),
            ),
        ),
        signature="0x" + "aa" * 65,
    )


def make_payment_payload(permit2_payload: ExactPermit2Payload) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/protected-permit2",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=PaymentRequirements(
            scheme="exact",
            network=NETWORK,
            asset=TOKEN,
            amount=AMOUNT,
            pay_to=RECEIVER,
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2"},
        ),
        payload=permit2_payload.to_dict(),
    )


class _SettleMockSigner:
    def __init__(self, *, status: int = 1, logs: list[Any] | None = None):
        self._status = status
        self._logs = logs
        self.write_calls: list[tuple] = []

    def write_contract(self, *args: Any, **kwargs: Any) -> str:
        self.write_calls.append((args, kwargs))
        return TX_HASH

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        return TransactionReceipt(
            status=self._status,
            block_number=1,
            tx_hash=tx_hash,
            logs=self._logs,
        )


def test_settle_rejects_underpaying_transfer_event():
    permit2_payload = make_permit2_payload()
    signer = _SettleMockSigner(
        logs=[make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=900)]
    )
    result = _settle_permit2_direct(signer, make_payment_payload(permit2_payload), permit2_payload)
    assert result.success is False
    assert result.error_reason == ERR_TRANSFER_EVENT_MISMATCH
    assert result.transaction == TX_HASH


def test_settle_rejects_empty_logs():
    permit2_payload = make_permit2_payload()
    signer = _SettleMockSigner(logs=[])
    result = _settle_permit2_direct(signer, make_payment_payload(permit2_payload), permit2_payload)
    assert result.success is False
    assert result.error_reason == ERR_TRANSFER_EVENT_MISMATCH


def test_settle_rejects_wrong_recipient():
    permit2_payload = make_permit2_payload()
    attacker = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    signer = _SettleMockSigner(
        logs=[make_transfer_log(address=TOKEN, from_address=PAYER, to=attacker, value=1000)]
    )
    result = _settle_permit2_direct(signer, make_payment_payload(permit2_payload), permit2_payload)
    assert result.success is False
    assert result.error_reason == ERR_TRANSFER_EVENT_MISMATCH


def test_settle_accepts_matching_transfer_event():
    permit2_payload = make_permit2_payload()
    signer = _SettleMockSigner(
        logs=[make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=1000)]
    )
    result = _settle_permit2_direct(signer, make_payment_payload(permit2_payload), permit2_payload)
    assert result.success is True
    assert result.transaction == TX_HASH


def test_settle_still_fails_on_reverted_receipt():
    permit2_payload = make_permit2_payload()
    signer = _SettleMockSigner(status=0, logs=[])
    result = _settle_permit2_direct(signer, make_payment_payload(permit2_payload), permit2_payload)
    assert result.success is False
    assert result.error_reason == ERR_TRANSACTION_FAILED


def test_settle_skips_transfer_check_when_logs_absent():
    """Preserve prior semantics when the RPC omits logs entirely (logs is None)."""
    permit2_payload = make_permit2_payload()
    signer = _SettleMockSigner(logs=None)
    result = _settle_permit2_direct(signer, make_payment_payload(permit2_payload), permit2_payload)
    assert result.success is True
