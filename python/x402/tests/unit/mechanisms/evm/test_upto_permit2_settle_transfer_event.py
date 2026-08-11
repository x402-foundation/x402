"""Regression: upto Permit2 settle must verify ERC-20 Transfer for settlement amount."""

from __future__ import annotations

import time
from typing import Any

from x402.mechanisms.evm.constants import (
    ERR_TRANSFER_EVENT_MISMATCH,
    X402_UPTO_PERMIT2_PROXY_ADDRESS,
)
from x402.mechanisms.evm.exact.eip3009_utils import ERC20_TRANSFER_EVENT_TOPIC
from x402.mechanisms.evm.types import (
    ExactPermit2TokenPermissions,
    TransactionReceipt,
    UptoPermit2Authorization,
    UptoPermit2Payload,
    UptoPermit2Witness,
)
from x402.mechanisms.evm.upto.permit2_utils import _settle_upto_direct
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

NETWORK = "eip155:84532"
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x1234567890123456789012345678901234567890"
RECEIVER = "0x0987654321098765432109876543210987654321"
FACILITATOR = "0x1111111111111111111111111111111111111111"
PERMITTED = "1000"
SETTLEMENT = 800
TX_HASH = "0x" + "cd" * 32


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


def make_upto_payload() -> UptoPermit2Payload:
    now = int(time.time())
    return UptoPermit2Payload(
        permit2_authorization=UptoPermit2Authorization(
            from_address=PAYER,
            permitted=ExactPermit2TokenPermissions(token=TOKEN, amount=PERMITTED),
            spender=X402_UPTO_PERMIT2_PROXY_ADDRESS,
            nonce="12345678901234567890",
            deadline=str(now + 3600),
            witness=UptoPermit2Witness(
                to=RECEIVER,
                facilitator=FACILITATOR,
                valid_after=str(now - 600),
            ),
        ),
        signature="0x" + "bb" * 65,
    )


def make_payment_payload(permit2_payload: UptoPermit2Payload) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/protected-upto",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=PaymentRequirements(
            scheme="upto",
            network=NETWORK,
            asset=TOKEN,
            amount=str(SETTLEMENT),
            pay_to=RECEIVER,
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2", "facilitatorAddress": FACILITATOR},
        ),
        payload=permit2_payload.to_dict(),
    )


class _SettleMockSigner:
    def __init__(self, *, status: int = 1, logs: list[Any] | None = None):
        self._status = status
        self._logs = logs

    def write_contract(self, *args: Any, **kwargs: Any) -> str:
        return TX_HASH

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        return TransactionReceipt(
            status=self._status,
            block_number=1,
            tx_hash=tx_hash,
            logs=self._logs,
        )


def test_upto_settle_rejects_underpaying_transfer_event():
    permit2_payload = make_upto_payload()
    signer = _SettleMockSigner(
        logs=[make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=700)]
    )
    result = _settle_upto_direct(
        signer, make_payment_payload(permit2_payload), permit2_payload, SETTLEMENT
    )
    assert result.success is False
    assert result.error_reason == ERR_TRANSFER_EVENT_MISMATCH
    assert result.transaction == TX_HASH


def test_upto_settle_rejects_empty_logs():
    permit2_payload = make_upto_payload()
    signer = _SettleMockSigner(logs=[])
    result = _settle_upto_direct(
        signer, make_payment_payload(permit2_payload), permit2_payload, SETTLEMENT
    )
    assert result.success is False
    assert result.error_reason == ERR_TRANSFER_EVENT_MISMATCH


def test_upto_settle_rejects_full_permitted_when_settlement_is_lower():
    """Upto must bind Transfer value to settlement amount, not permitted max."""
    permit2_payload = make_upto_payload()
    signer = _SettleMockSigner(
        logs=[
            make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=int(PERMITTED))
        ]
    )
    result = _settle_upto_direct(
        signer, make_payment_payload(permit2_payload), permit2_payload, SETTLEMENT
    )
    assert result.success is False
    assert result.error_reason == ERR_TRANSFER_EVENT_MISMATCH


def test_upto_settle_accepts_matching_settlement_transfer():
    permit2_payload = make_upto_payload()
    signer = _SettleMockSigner(
        logs=[make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=SETTLEMENT)]
    )
    result = _settle_upto_direct(
        signer, make_payment_payload(permit2_payload), permit2_payload, SETTLEMENT
    )
    assert result.success is True
    assert result.transaction == TX_HASH
    assert result.amount == str(SETTLEMENT)
