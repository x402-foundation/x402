"""Tests for ERC-8004 settle routing inside ExactEvmScheme.

Phase 3.4: when the facilitator has `ERC8004TicketFacilitatorExtension`
registered AND the client populated ticket bind fields, settle() routes
through `settle_via_ticket_minter` instead of the default transfer/proxy path.
Otherwise it falls through and the standard settle code runs.
"""

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


def _payload_with_bind() -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"authorization": {"from": "0x" + "02" * 20}},
        accepted=_requirements(),
        extensions={
            EXTENSION_KEY: {
                "info": {
                    "agentId": 42,
                    "requestHash": "0x" + "11" * 32,
                    "interactionHash": "0x" + "22" * 32,
                    "endpoint": "https://agent.example/r",
                }
            }
        },
    )


def _payload_without_bind() -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"authorization": {"from": "0x" + "02" * 20}},
        accepted=_requirements(),
        extensions=None,
    )


def test_routes_through_minter_when_all_guards_hold() -> None:
    minter_addr = "0x" + "aa" * 20
    ext = ERC8004TicketFacilitatorExtension(minters={"eip155:31337": minter_addr})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    signer = MagicMock()
    sentinel = SettleResponse(
        success=True,
        transaction="0xdead",
        network="eip155:31337",
        payer="0x" + "02" * 20,
        extensions={EXTENSION_KEY: {"ticketId": "7"}},
    )

    # The helper looks up settle_via_ticket_minter via a late import from
    # x402.extensions.erc8004, so patch the name on the package the late
    # import resolves to.
    with patch(
        "x402.extensions.erc8004.settle_via_ticket_minter",
        return_value=sentinel,
    ) as mock_settle:
        result = _maybe_route_to_ticket_minter(
            signer, _payload_with_bind(), _requirements(), context
        )

    assert result is sentinel
    mock_settle.assert_called_once()
    args, _ = mock_settle.call_args
    assert args[0] is signer
    assert args[1] == minter_addr  # minter_address
    assert args[3] is not None  # requirements


def test_falls_through_when_extension_not_registered() -> None:
    context = FacilitatorContext({})  # no extension
    result = _maybe_route_to_ticket_minter(
        MagicMock(), _payload_with_bind(), _requirements(), context
    )
    assert result is None


def test_falls_through_when_minter_not_configured_for_network() -> None:
    # Extension registered, but no minter for this network.
    ext = ERC8004TicketFacilitatorExtension(minters={"eip155:8453": "0x" + "bb" * 20})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    result = _maybe_route_to_ticket_minter(
        MagicMock(), _payload_with_bind(), _requirements(), context
    )
    assert result is None


def test_falls_through_when_bind_missing() -> None:
    ext = ERC8004TicketFacilitatorExtension(minters={"eip155:31337": "0x" + "aa" * 20})
    context = FacilitatorContext({EXTENSION_KEY: ext})
    result = _maybe_route_to_ticket_minter(
        MagicMock(), _payload_without_bind(), _requirements(), context
    )
    assert result is None


def test_falls_through_when_extension_under_wrong_type() -> None:
    # Some other extension squatting on the erc8004 key.
    class NotOurs:
        key = EXTENSION_KEY

    context = FacilitatorContext({EXTENSION_KEY: NotOurs()})  # type: ignore[arg-type]
    result = _maybe_route_to_ticket_minter(
        MagicMock(), _payload_with_bind(), _requirements(), context
    )
    assert result is None


def test_exact_evm_scheme_settle_uses_ticket_routing() -> None:
    """End-to-end: registered + bound + context => settle() never calls the default path."""
    minter_addr = "0x" + "aa" * 20
    ext = ERC8004TicketFacilitatorExtension(minters={"eip155:31337": minter_addr})
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
        patch(
            "x402.extensions.erc8004.settle_via_ticket_minter",
            return_value=sentinel,
        ) as routed,
        patch(
            "x402.mechanisms.evm.exact.facilitator.settle_permit2",
        ) as default_permit2,
    ):
        result = scheme.settle(_payload_with_bind(), _requirements(), context)

    assert result is sentinel
    routed.assert_called_once()
    default_permit2.assert_not_called()


def test_exact_evm_scheme_settle_falls_through_without_context() -> None:
    """No context → routing helper isn't even consulted; default path runs."""
    signer = MagicMock()
    scheme = ExactEvmScheme(signer)

    with patch(
        "x402.extensions.erc8004.settle_via_ticket_minter"
    ) as routed:
        # Use a permit2 payload so the default settle_permit2 path is taken
        # — we just need to verify the ticket routing branch wasn't entered.
        # The settle_permit2 call will fail (mocked signer), but that's after
        # the point we're testing.
        try:
            scheme.settle(_payload_with_bind(), _requirements(), context=None)
        except Exception:
            pass

    routed.assert_not_called()
