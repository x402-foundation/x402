"""Tests for ERC-8004 settle routing inside ExactEvmScheme."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from x402.interfaces import FacilitatorContext
from x402.schemas.payments import PaymentPayload, PaymentRequirements
from x402.schemas.responses import SettleResponse

from x402.extensions.erc8004 import ERC8004TicketFacilitatorExtension
from x402.extensions.erc8004.types import EXTENSION_KEY
from x402.mechanisms.evm.exact.facilitator import (
    ExactEvmScheme,
    _maybe_route_to_ticket_minter,
)


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:31337",
        asset="0x" + "01" * 20,
        amount="1000000",
        pay_to="0x" + "03" * 20,
        max_timeout_seconds=60,
    )


def _payload_with_agent() -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"authorization": {"from": "0x" + "02" * 20}},
        accepted=_requirements(),
        extensions={EXTENSION_KEY: {"info": {"agentId": 42}}},
    )


def _payload_without_agent() -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"authorization": {"from": "0x" + "02" * 20}},
        accepted=_requirements(),
        extensions=None,
    )


def test_routes_through_wrapper_when_all_guards_hold() -> None:
    wrapper_addr = "0x" + "aa" * 20
    ext = ERC8004TicketFacilitatorExtension(wrappers={"eip155:31337": wrapper_addr})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    signer = MagicMock()
    sentinel = SettleResponse(
        success=True,
        transaction="0xdead",
        network="eip155:31337",
        payer="0x" + "02" * 20,
        extensions={EXTENSION_KEY: {"ticketId": "7"}},
    )

    with patch(
        "x402.extensions.erc8004.settle_via_wrapper",
        return_value=sentinel,
    ) as mock_settle:
        result = _maybe_route_to_ticket_minter(
            signer, _payload_with_agent(), _requirements(), context
        )

    assert result is sentinel
    mock_settle.assert_called_once()
    args, _ = mock_settle.call_args
    assert args[1] == wrapper_addr


def test_falls_through_when_agent_id_missing() -> None:
    ext = ERC8004TicketFacilitatorExtension(wrappers={"eip155:31337": "0x" + "aa" * 20})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    result = _maybe_route_to_ticket_minter(
        MagicMock(), _payload_without_agent(), _requirements(), context
    )
    assert result is None


def test_exact_evm_scheme_settle_uses_wrapper_routing() -> None:
    wrapper_addr = "0x" + "aa" * 20
    ext = ERC8004TicketFacilitatorExtension(wrappers={"eip155:31337": wrapper_addr})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    signer = MagicMock()
    sentinel = SettleResponse(
        success=True,
        transaction="0xfeed",
        network="eip155:31337",
        payer="0x" + "02" * 20,
        extensions={EXTENSION_KEY: {"ticketId": "12"}},
    )
    scheme = ExactEvmScheme(signer)

    with (
        patch("x402.extensions.erc8004.settle_via_wrapper", return_value=sentinel) as routed,
        patch("x402.mechanisms.evm.exact.facilitator.settle_permit2") as default_permit2,
    ):
        result = scheme.settle(_payload_with_agent(), _requirements(), context)

    assert result is sentinel
    routed.assert_called_once()
    default_permit2.assert_not_called()
