"""Tests for ERC-8004 server extension."""

from unittest.mock import MagicMock

from eth_account import Account
from x402.schemas.hooks import ServerPaymentRequiredContext, SettleResultContext
from x402.schemas.payments import PaymentPayload, PaymentRequirements
from x402.schemas.responses import SettleResponse

from x402.extensions.erc8004.server import (
    ATTESTATION_HEADER,
    attach_interaction_attestation_header,
    create_erc8004_resource_server_extension,
    create_interaction_attestation,
)
from x402.extensions.erc8004.types import ERC8004Config
from x402.extensions.erc8004.artifact import verify_interaction_attestation


def _config(agent_id: int = 42) -> ERC8004Config:
    return ERC8004Config(
        network="eip155:8453",
        reputation_registry="0x" + "00" * 20,
        identity_registry="0x" + "00" * 20,
        wrapper_address="0x" + "aa" * 20,
        rpc_url="http://localhost:8545",
        agent_id=agent_id,
    )


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x" + "01" * 20,
        amount="1000000",
        pay_to="0x" + "03" * 20,
        max_timeout_seconds=60,
    )


def test_extension_key() -> None:
    ext = create_erc8004_resource_server_extension(_config())
    assert ext.key == "erc8004"


def test_enrich_payment_required_response() -> None:
    ext = create_erc8004_resource_server_extension(_config())
    ctx = ServerPaymentRequiredContext(
        requirements=[], resource_info=None, error=None, payment_required_response=MagicMock()
    )
    result = ext.enrich_payment_required_response({}, ctx)
    assert result["info"]["agentId"] == 42


def test_settlement_hook_surfaces_ticket_id() -> None:
    ext = create_erc8004_resource_server_extension(_config())
    settle = SettleResponse(
        success=True,
        transaction="0x" + "ab" * 32,
        network="eip155:8453",
        payer="0x" + "02" * 20,
        extensions={"erc8004": {"ticketId": "7"}},
    )
    ctx = SettleResultContext(
        payment_payload=PaymentPayload(payload={}, accepted=_requirements()),
        requirements=_requirements(),
        result=settle,
    )
    assert ext.enrich_settlement_response({}, ctx) == {"ticketId": "7"}


def test_create_interaction_attestation_signs_eip712() -> None:
    agent = Account.create()
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    att = create_interaction_attestation(
        agent,
        wrapper_address="0x" + "aa" * 20,
        agent_id=42,
        requirements=_requirements(),
        payment_payload=payload,
        ticket_id=99,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
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


def test_attach_attestation_header() -> None:
    agent = Account.create()
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    att = create_interaction_attestation(
        agent,
        wrapper_address="0x" + "aa" * 20,
        agent_id=42,
        requirements=_requirements(),
        payment_payload=payload,
        ticket_id=1,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        method="GET",
        url="https://x/y",
        request_body=b"",
        response_body=b"ok",
        response_status=200,
    )
    headers = attach_interaction_attestation_header({}, att)
    assert ATTESTATION_HEADER in headers
