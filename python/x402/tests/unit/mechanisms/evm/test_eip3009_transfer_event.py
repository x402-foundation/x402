"""Unit tests for exact EIP-3009 post-settle Transfer event verification."""

from __future__ import annotations

from x402.mechanisms.evm.exact.eip3009_utils import (
    ERC20_TRANSFER_EVENT_TOPIC,
    verify_eip3009_transfer_event,
)
from x402.mechanisms.evm.utils import normalize_address

TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
OTHER_TOKEN = "0x0000000000000000000000000000000000000001"
PAYER = "0x1234567890123456789012345678901234567890"
RECEIVER = "0x0987654321098765432109876543210987654321"
ATTACKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


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


def test_matches_canonical_transfer_event():
    logs = [make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=1000)]
    assert verify_eip3009_transfer_event(
        logs,
        TOKEN,
        from_address=PAYER,
        to=RECEIVER,
        value=1000,
    )


def test_matches_when_unrelated_logs_present():
    logs = [
        make_transfer_log(address=OTHER_TOKEN, from_address=ATTACKER, to=RECEIVER, value=999),
        make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=1000),
    ]
    assert verify_eip3009_transfer_event(
        logs,
        normalize_address(TOKEN),
        from_address=PAYER,
        to=RECEIVER,
        value=1000,
    )


def test_rejects_wrong_value():
    logs = [make_transfer_log(address=TOKEN, from_address=PAYER, to=RECEIVER, value=1)]
    assert not verify_eip3009_transfer_event(
        logs, TOKEN, from_address=PAYER, to=RECEIVER, value=1000
    )


def test_rejects_wrong_recipient():
    logs = [make_transfer_log(address=TOKEN, from_address=PAYER, to=ATTACKER, value=1000)]
    assert not verify_eip3009_transfer_event(
        logs, TOKEN, from_address=PAYER, to=RECEIVER, value=1000
    )


def test_rejects_wrong_sender():
    logs = [make_transfer_log(address=TOKEN, from_address=ATTACKER, to=RECEIVER, value=1000)]
    assert not verify_eip3009_transfer_event(
        logs, TOKEN, from_address=PAYER, to=RECEIVER, value=1000
    )


def test_rejects_wrong_token():
    logs = [make_transfer_log(address=OTHER_TOKEN, from_address=PAYER, to=RECEIVER, value=1000)]
    assert not verify_eip3009_transfer_event(
        logs, TOKEN, from_address=PAYER, to=RECEIVER, value=1000
    )


def test_rejects_empty_or_missing_logs():
    assert not verify_eip3009_transfer_event([], TOKEN, from_address=PAYER, to=RECEIVER, value=1000)
    assert not verify_eip3009_transfer_event(
        None, TOKEN, from_address=PAYER, to=RECEIVER, value=1000
    )
