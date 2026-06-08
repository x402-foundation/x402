"""Tests for the ERC-8004 facilitator-side extension."""

from __future__ import annotations

from unittest.mock import MagicMock

from x402.extensions.erc8004.constants import get_ticket_minted_topic
from x402.extensions.erc8004.facilitator import (
    ERC8004TicketFacilitatorExtension,
    extract_agent_id,
    ticket_id_from_receipt,
)
from x402.extensions.erc8004.types import EXTENSION_KEY


def test_extension_resolves_wrapper_from_static_map() -> None:
    ext = ERC8004TicketFacilitatorExtension(
        wrappers={"eip155:31337": "0x" + "11" * 20},
    )
    assert ext.key == EXTENSION_KEY
    assert ext.resolve_wrapper("eip155:31337") == "0x" + "11" * 20
    assert ext.resolve_wrapper("eip155:8453") is None


def test_extract_agent_id_returns_int_when_present(make_payload_with_agent) -> None:
    payload = make_payload_with_agent(info={"agentId": 99})
    assert extract_agent_id(payload) == 99


def test_extract_agent_id_missing_returns_none(make_payload) -> None:
    payload = make_payload(network="eip155:31337")
    assert extract_agent_id(payload) is None


def test_ticket_id_from_receipt_parses_topic() -> None:
    ticket_id = 42
    topic0 = get_ticket_minted_topic()
    topic1 = "0x" + ticket_id.to_bytes(32, "big").hex()

    fake_signer = MagicMock()
    fake_signer._w3.eth.get_transaction_receipt.return_value = {
        "logs": [
            {"topics": ["0x" + "00" * 32]},
            {"topics": [topic0, topic1, "0x" + "33" * 32, "0x" + "44" * 32]},
        ]
    }

    assert ticket_id_from_receipt(fake_signer, "0xdead") == 42
