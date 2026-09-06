"""Resource server declaration for the EIP-2612 Gas Sponsoring extension."""

from __future__ import annotations

from typing import Any

from .schema import eip2612_gas_sponsoring_schema
from .types import EIP2612_GAS_SPONSORING_KEY


def declare_eip2612_gas_sponsoring_extension() -> dict[str, Any]:
    """Declare the eip2612GasSponsoring extension for inclusion in PaymentRequired.

    Returns a dict keyed by the extension key, ready to merge into
    PaymentRequired.extensions.
    """
    return {
        EIP2612_GAS_SPONSORING_KEY: {
            "info": {
                "description": (
                    "The facilitator accepts EIP-2612 gasless Permit to Permit2 canonical contract."
                ),
                "version": "1",
            },
            "schema": eip2612_gas_sponsoring_schema,
        }
    }
