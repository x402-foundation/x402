"""Tests for ERC-8004 server extension."""

from unittest.mock import MagicMock

from eth_account import Account

from x402.extensions.erc8004.artifact import verify_interaction_attestation
from x402.extensions.erc8004.server import (
    ATTESTATION_HEADER,
    attach_interaction_attestation_header,
    create_erc8004_resource_server_extension,
    create_interaction_attestation,
)
from x402.schemas.hooks import ServerPaymentRequiredContext, SettleResultContext
from x402.schemas.responses import SettleResponse


def _server_config(make_config):
    return make_config(wrapper_address="0x" + "aa" * 20, agent_id=42)


def test_extension_key(make_config) -> None:
    ext = create_erc8004_resource_server_extension(_server_config(make_config))
    assert ext.key == "erc8004"


def test_enrich_payment_required_response(make_config) -> None:
    ext = create_erc8004_resource_server_extension(_server_config(make_config))
    ctx = ServerPaymentRequiredContext(
        requirements=[], resource_info=None, error=None, payment_required_response=MagicMock()
    )
    result = ext.enrich_payment_required_response({}, ctx)
    assert result["info"]["agentId"] == 42


def test_settlement_hook_surfaces_ticket_id(make_config, make_requirements, make_payload) -> None:
    ext = create_erc8004_resource_server_extension(_server_config(make_config))
    settle = SettleResponse(
        success=True,
        transaction="0x" + "ab" * 32,
        network="eip155:8453",
        payer="0x" + "02" * 20,
        extensions={"erc8004": {"ticketId": "7"}},
    )
    ctx = SettleResultContext(
        payment_payload=make_payload(),
        requirements=make_requirements(),
        result=settle,
    )
    assert ext.enrich_settlement_response({}, ctx) == {"ticketId": "7"}


def test_create_interaction_attestation_signs_eip712(make_requirements) -> None:
    agent = Account.create()
    att = create_interaction_attestation(
        agent,
        wrapper_address="0x" + "aa" * 20,
        requirements=make_requirements(),
        ticket_id=99,
        method="GET",
        url="https://x/y",
        request_body=b"",
        response_body=b"ok",
        response_status=200,
    )
    assert att.ticket_id == 99
    assert verify_interaction_attestation(
        att, wrapper_address="0x" + "aa" * 20, expected_owner=agent.address
    )


def test_attach_attestation_header(make_requirements) -> None:
    agent = Account.create()
    att = create_interaction_attestation(
        agent,
        wrapper_address="0x" + "aa" * 20,
        requirements=make_requirements(),
        ticket_id=1,
        method="GET",
        url="https://x/y",
        request_body=b"",
        response_body=b"ok",
        response_status=200,
    )
    headers = attach_interaction_attestation_header({}, att)
    assert ATTESTATION_HEADER in headers
