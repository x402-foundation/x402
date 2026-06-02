"""Tests for ERC-8004 server extension."""

from unittest.mock import MagicMock

from eth_account import Account
from x402.schemas.hooks import ServerPaymentRequiredContext, SettleResultContext
from x402.schemas.payments import PaymentPayload, PaymentRequirements
from x402.schemas.responses import SettleResponse

from x402.extensions.erc8004.server import (
    create_erc8004_resource_server_extension,
    create_interaction_receipt,
)
from x402.extensions.erc8004.types import ERC8004Config
from x402.extensions.erc8004.artifact import (
    build_artifact,
    compute_interaction_hash,
    verify_interaction_receipt,
)


def _config(agent_id: int = 42) -> ERC8004Config:
    return ERC8004Config(
        network="eip155:8453",
        reputation_registry="0x" + "00" * 20,
        identity_registry="0x" + "00" * 20,
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


_REQUEST = {"method": "GET", "url": "https://x/y", "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "00" * 32}
_RESPONSE = {"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32}


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
    assert "schema" in result


def test_settlement_hook_returns_none_when_no_ticket() -> None:
    """The settle hook returns None when no ticket id is present on the settle result."""
    ext = create_erc8004_resource_server_extension(_config())
    ctx = SettleResultContext(
        payment_payload=PaymentPayload(payload={}, accepted=_requirements()),
        requirements=_requirements(),
        result=SettleResponse(success=True, transaction="0x" + "ab" * 32, network="eip155:8453", payer="0x" + "02" * 20),
    )
    assert ext.enrich_settlement_response({}, ctx) is None


def test_settlement_hook_surfaces_ticket_id() -> None:
    """When the facilitator returns extensions.erc8004.ticketId, it appears in PAYMENT-RESPONSE."""
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


def test_after_verify_skips_handler_when_bind_missing() -> None:
    """With require_ticket_bind=True, a payload lacking ticket bind skips the handler."""
    from x402.schemas.hooks import VerifyResultContext
    from x402.schemas.responses import VerifyResponse

    ext = create_erc8004_resource_server_extension(_config(), require_ticket_bind=True)
    payload = PaymentPayload(payload={}, accepted=_requirements())  # no extensions
    ctx = VerifyResultContext(
        payment_payload=payload,
        requirements=_requirements(),
        result=VerifyResponse(is_valid=True, payer="0x" + "02" * 20),
    )
    result = ext.after_verify(ctx)
    assert result is not None
    assert result.response is not None
    assert result.response.body == {"error": "erc8004_ticket_bind_required"}


def test_after_verify_allows_handler_when_bind_present() -> None:
    """A payload carrying ticket bind passes through after_verify."""
    from x402.schemas.hooks import VerifyResultContext
    from x402.schemas.responses import VerifyResponse

    ext = create_erc8004_resource_server_extension(_config(), require_ticket_bind=True)
    payload = PaymentPayload(
        payload={},
        accepted=_requirements(),
        extensions={
            "erc8004": {
                "info": {
                    "agentId": 42,
                    "requestHash": "0x" + "11" * 32,
                    "interactionHash": "0x" + "22" * 32,
                    "endpoint": "https://agent.example/r",
                }
            }
        },
    )
    ctx = VerifyResultContext(
        payment_payload=payload,
        requirements=_requirements(),
        result=VerifyResponse(is_valid=True, payer="0x" + "02" * 20),
    )
    assert ext.after_verify(ctx) is None


def test_after_verify_noop_when_gate_disabled() -> None:
    """Default (require_ticket_bind=False) preserves prior behavior — handler always runs."""
    from x402.schemas.hooks import VerifyResultContext
    from x402.schemas.responses import VerifyResponse

    ext = create_erc8004_resource_server_extension(_config())
    payload = PaymentPayload(payload={}, accepted=_requirements())
    ctx = VerifyResultContext(
        payment_payload=payload,
        requirements=_requirements(),
        result=VerifyResponse(is_valid=True, payer="0x" + "02" * 20),
    )
    assert ext.after_verify(ctx) is None


def test_create_interaction_receipt_signs_over_ticket_id() -> None:
    """Phase 4.4: digest is keccak(prefix ‖ chainId ‖ ticketId ‖ interactionHash)."""
    agent = Account.create()
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    receipt = create_interaction_receipt(
        agent,
        agent_id=42,
        requirements=_requirements(),
        payment_payload=payload,
        ticket_id=99,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        request=_REQUEST,
        response=_RESPONSE,
        payment_method="eip3009",
    )
    assert receipt.ticket_id == 99
    assert verify_interaction_receipt(receipt, agent.address) is True

    # Changing ticket_id changes the signed digest → verification with the old
    # signature against a different ticket fails.
    other = create_interaction_receipt(
        agent,
        agent_id=42,
        requirements=_requirements(),
        payment_payload=payload,
        ticket_id=100,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        request=_REQUEST,
        response=_RESPONSE,
        payment_method="eip3009",
    )
    assert other.signature != receipt.signature


def test_create_interaction_receipt_covers_request_response() -> None:
    agent = Account.create()
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())

    receipt = create_interaction_receipt(
        agent,
        agent_id=42,
        requirements=_requirements(),
        payment_payload=payload,
        ticket_id=1,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        request=_REQUEST,
        response=_RESPONSE,
        payment_method="eip3009",
    )

    assert receipt.chain_id == 8453
    assert verify_interaction_receipt(receipt, agent.address) is True

    # The receipt's interaction_hash must equal the hash over the full artifact
    # core (settlement + request + response), proving it covers the response.
    artifact = build_artifact(
        requirements=_requirements(),
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="eip3009",
        agent_id=42,
        request=_REQUEST,
        response=_RESPONSE,
        feedback={"agentId": 42, "value": 95},
    )
    assert receipt.interaction_hash == compute_interaction_hash(artifact.to_dict())


def test_create_interaction_receipt_uses_asset_transfer_method_extra() -> None:
    agent = Account.create()
    reqs = _requirements().model_copy(update={"extra": {"assetTransferMethod": "permit2"}})
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=reqs)
    receipt = create_interaction_receipt(
        agent,
        agent_id=42,
        requirements=reqs,
        payment_payload=payload,
        ticket_id=1,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        request=_REQUEST,
        response=_RESPONSE,
        payment_method=None,
    )

    ref = build_artifact(
        requirements=reqs,
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="permit2",
        agent_id=42,
        request=_REQUEST,
        response=_RESPONSE,
        feedback={"agentId": 42, "value": 95},
    )
    assert receipt.interaction_hash == compute_interaction_hash(ref.to_dict())


def test_receipt_changes_when_response_changes() -> None:
    agent = Account.create()
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    common = dict(
        agent_id=42,
        requirements=_requirements(),
        payment_payload=payload,
        ticket_id=1,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        request=_REQUEST,
        payment_method="eip3009",
    )
    r1 = create_interaction_receipt(agent, response={"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32}, **common)
    r2 = create_interaction_receipt(agent, response={"status": 500, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0b" * 32}, **common)
    assert r1.interaction_hash != r2.interaction_hash
