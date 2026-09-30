"""Types for the EIP-2612 Gas Sponsoring extension."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ...interfaces import FacilitatorExtension

EIP2612_GAS_SPONSORING_KEY = "eip2612GasSponsoring"

EIP2612_GAS_SPONSORING = FacilitatorExtension(key=EIP2612_GAS_SPONSORING_KEY)
"""Singleton extension instance for registering with x402Facilitator.

Unlike erc20ApprovalGasSponsoring, this extension needs no special signer —
the facilitator's main EVM signer handles settleWithPermit directly.
"""


@dataclass
class Eip2612GasSponsoringInfo:
    """EIP-2612 permit data sent by the client for gasless Permit2 approval."""

    from_address: str
    asset: str
    spender: str
    amount: str
    nonce: str
    deadline: str
    signature: str
    version: str = "1"

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_address,
            "asset": self.asset,
            "spender": self.spender,
            "amount": self.amount,
            "nonce": self.nonce,
            "deadline": self.deadline,
            "signature": self.signature,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Eip2612GasSponsoringInfo:
        return cls(
            from_address=data.get("from", ""),
            asset=data.get("asset", ""),
            spender=data.get("spender", ""),
            amount=data.get("amount", ""),
            nonce=data.get("nonce", ""),
            deadline=data.get("deadline", ""),
            signature=data.get("signature", ""),
            version=data.get("version", "1"),
        )
