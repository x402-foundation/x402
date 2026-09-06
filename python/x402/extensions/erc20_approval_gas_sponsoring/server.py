"""Resource server declaration for the ERC-20 Approval Gas Sponsoring extension."""

from __future__ import annotations

from typing import Any

from .schema import erc20_approval_gas_sponsoring_schema
from .types import ERC20_APPROVAL_GAS_SPONSORING_KEY


def declare_erc20_approval_gas_sponsoring_extension() -> dict[str, Any]:
    """Declare the erc20ApprovalGasSponsoring extension for PaymentRequired.

    Returns a dict keyed by the extension key, ready to merge into
    PaymentRequired.extensions.
    """
    return {
        ERC20_APPROVAL_GAS_SPONSORING_KEY: {
            "info": {
                "description": (
                    "The facilitator accepts a raw signed approval transaction "
                    "and will sponsor the gas fees."
                ),
                "version": "1",
            },
            "schema": erc20_approval_gas_sponsoring_schema,
        }
    }
