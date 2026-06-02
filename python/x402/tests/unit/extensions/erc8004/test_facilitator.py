"""Tests for the ERC-8004 facilitator-side extension."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from x402.extensions.erc8004.facilitator import (
    ERC8004TicketFacilitatorExtension,
    TicketBind,
    extract_ticket_bind,
    ticket_id_from_receipt,
)
from x402.extensions.erc8004.constants import get_ticket_minted_topic
from x402.extensions.erc8004.types import EXTENSION_KEY
from x402.schemas.payments import PaymentPayload, PaymentRequirements


def _accepted() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:31337",
        asset="0x" + "01" * 20,
        amount="1000000",
        pay_to="0x" + "03" * 20,
        max_timeout_seconds=60,
    )


def _payload_with_ext(info: dict) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={},
        accepted=_accepted(),
        extensions={EXTENSION_KEY: {"info": info}},
    )


def test_extension_resolves_minter_from_static_map() -> None:
    ext = ERC8004TicketFacilitatorExtension(
        minters={"eip155:31337": "0x" + "11" * 20},
    )
    assert ext.key == EXTENSION_KEY
    assert ext.resolve_minter("eip155:31337") == "0x" + "11" * 20
    assert ext.resolve_minter("eip155:8453") is None


def test_extension_resolves_minter_from_callable_first() -> None:
    def callable_lookup(network: str) -> str | None:
        return "0x" + "aa" * 20 if network == "eip155:1" else None

    ext = ERC8004TicketFacilitatorExtension(
        minter_for_network=callable_lookup,
        minters={"eip155:1": "0x" + "bb" * 20},
    )
    # Callable wins when it returns non-None.
    assert ext.resolve_minter("eip155:1") == "0x" + "aa" * 20
    # Falls back to static map when callable returns None.
    ext2 = ERC8004TicketFacilitatorExtension(
        minter_for_network=lambda _n: None,
        minters={"eip155:1": "0x" + "cc" * 20},
    )
    assert ext2.resolve_minter("eip155:1") == "0x" + "cc" * 20


def test_extract_ticket_bind_returns_struct_when_present() -> None:
    payload = _payload_with_ext(
        {
            "agentId": 99,
            "requestHash": "0x" + "11" * 32,
            "interactionHash": "0x" + "22" * 32,
            "endpoint": "https://agent.example/r",
        }
    )
    bind = extract_ticket_bind(payload)
    assert bind == TicketBind(
        agent_id=99,
        request_hash=bytes.fromhex("11" * 32),
        interaction_hash=bytes.fromhex("22" * 32),
        endpoint="https://agent.example/r",
    )


def test_extract_ticket_bind_missing_returns_none() -> None:
    payload = PaymentPayload(
        x402_version=2,
        payload={},
        accepted=_accepted(),
        extensions=None,
    )
    assert extract_ticket_bind(payload) is None


def test_extract_ticket_bind_malformed_returns_none() -> None:
    payload = _payload_with_ext({"agentId": 1, "requestHash": "not-hex", "interactionHash": "0x", "endpoint": "/r"})
    assert extract_ticket_bind(payload) is None


def test_ticket_id_from_receipt_parses_topic() -> None:
    ticket_id = 42
    topic0 = get_ticket_minted_topic()
    topic1 = "0x" + ticket_id.to_bytes(32, "big").hex()

    fake_signer = MagicMock()
    fake_signer._w3.eth.get_transaction_receipt.return_value = {
        "logs": [
            {"topics": ["0x" + "00" * 32]},  # unrelated log
            {"topics": [topic0, topic1, "0x" + "33" * 32, "0x" + "44" * 32]},
        ]
    }

    assert ticket_id_from_receipt(fake_signer, "0xdead") == 42


def test_ticket_id_from_receipt_returns_none_when_missing() -> None:
    fake_signer = MagicMock()
    fake_signer._w3.eth.get_transaction_receipt.return_value = {"logs": []}
    assert ticket_id_from_receipt(fake_signer, "0xdead") is None


def test_ticket_id_from_receipt_handles_no_w3_attribute() -> None:
    class SignerNoW3:
        pass

    assert ticket_id_from_receipt(SignerNoW3(), "0xdead") is None
