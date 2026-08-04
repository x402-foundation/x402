"""Tests for ERC-8004 settle routing inside ExactEvmScheme."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from x402.extensions.erc8004 import ERC8004TicketFacilitatorExtension
from x402.extensions.erc8004.types import EXTENSION_KEY
from x402.interfaces import FacilitatorContext
from x402.mechanisms.evm.exact.facilitator import (
    ExactEvmScheme,
    _maybe_route_to_ticket_minter,
)
from x402.schemas import VerifyResponse
from x402.schemas.responses import SettleResponse


def test_routes_through_wrapper_when_agent_id_in_requirements(make_requirements) -> None:
    wrapper_addr = "0x" + "aa" * 20
    ext = ERC8004TicketFacilitatorExtension(wrappers={"eip155:31337": wrapper_addr})
    context = FacilitatorContext({EXTENSION_KEY: ext})

    requirements = make_requirements(network="eip155:31337", agent_id=42)
    route = _maybe_route_to_ticket_minter(requirements, context)

    assert route == (wrapper_addr, 42)


def test_falls_through_when_agent_id_missing(make_requirements) -> None:
    ext = ERC8004TicketFacilitatorExtension(wrappers={"eip155:31337": "0x" + "aa" * 20})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    route = _maybe_route_to_ticket_minter(make_requirements(network="eip155:31337"), context)
    assert route is None


def test_exact_evm_scheme_settle_reverifies_then_routes(make_requirements, make_payload) -> None:
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
    requirements = make_requirements(network="eip155:31337", agent_id=42)

    with (
        patch("x402.extensions.erc8004.settle_via_wrapper", return_value=sentinel) as routed,
        patch("x402.mechanisms.evm.exact.facilitator.settle_permit2") as default_permit2,
        patch.object(
            ExactEvmScheme,
            "_verify_for_settle",
            return_value=VerifyResponse(is_valid=True, payer="0x" + "02" * 20),
        ) as reverify,
    ):
        result = scheme.settle(make_payload(network="eip155:31337"), requirements, context)

    assert result is sentinel
    reverify.assert_called_once()
    routed.assert_called_once()
    default_permit2.assert_not_called()


def test_exact_evm_scheme_settle_rejects_invalid_ticket_payment(make_requirements, make_payload) -> None:
    """Re-verify failure short-circuits before the wrapper is touched."""
    wrapper_addr = "0x" + "aa" * 20
    ext = ERC8004TicketFacilitatorExtension(wrappers={"eip155:31337": wrapper_addr})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    scheme = ExactEvmScheme(MagicMock())
    requirements = make_requirements(network="eip155:31337", agent_id=42)

    with (
        patch("x402.extensions.erc8004.settle_via_wrapper") as routed,
        patch.object(
            ExactEvmScheme,
            "_verify_for_settle",
            return_value=VerifyResponse(
                is_valid=False, invalid_reason="bad_sig", payer="0x" + "02" * 20
            ),
        ),
    ):
        result = scheme.settle(make_payload(network="eip155:31337"), requirements, context)

    assert result.success is False
    assert result.error_reason == "bad_sig"
    routed.assert_not_called()
