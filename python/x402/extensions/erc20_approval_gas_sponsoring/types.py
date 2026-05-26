"""Types for the ERC-20 Approval Gas Sponsoring extension."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

ERC20_APPROVAL_GAS_SPONSORING_KEY = "erc20ApprovalGasSponsoring"


@dataclass
class Erc20ApprovalGasSponsoringInfo:
    """ERC-20 approval data sent by the client for gasless Permit2 approval."""

    from_address: str
    asset: str
    spender: str
    amount: str
    signed_transaction: str
    version: str = "1"

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_address,
            "asset": self.asset,
            "spender": self.spender,
            "amount": self.amount,
            "signedTransaction": self.signed_transaction,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Erc20ApprovalGasSponsoringInfo:
        return cls(
            from_address=data.get("from", ""),
            asset=data.get("asset", ""),
            spender=data.get("spender", ""),
            amount=data.get("amount", ""),
            signed_transaction=data.get("signedTransaction", ""),
            version=data.get("version", "1"),
        )


@dataclass
class WriteContractCall:
    """An unsigned contract call for the extension signer to execute."""

    address: str
    abi: list[dict[str, Any]]
    function: str
    args: list[Any] = field(default_factory=list)


TransactionRequest = str | WriteContractCall


class Erc20ApprovalGasSponsoringSigner(Protocol):
    """Extension signer capable of broadcasting approval + settle atomically.

    Extends FacilitatorEvmSigner with send_transactions for batched execution.
    """

    def send_transactions(self, transactions: list[TransactionRequest]) -> list[str]:
        """Send a batch of transactions (pre-signed raw hex or unsigned calls).

        Args:
            transactions: List of either raw hex tx strings or WriteContractCall.

        Returns:
            List of transaction hashes, one per input.
        """
        ...

    def wait_for_transaction_receipt(self, tx_hash: str) -> Any:
        """Wait for a transaction to be mined."""
        ...


class Erc20ApprovalFacilitatorExtension:
    """Facilitator extension for ERC-20 approval gas sponsoring.

    Wraps a signer (or per-network signer resolver) that can broadcast
    the approval + settle bundle.

    Implements the FacilitatorExtension interface (key attribute) without
    inheriting from the frozen dataclass.
    """

    key: str = ERC20_APPROVAL_GAS_SPONSORING_KEY

    def __init__(
        self,
        signer: Erc20ApprovalGasSponsoringSigner | None = None,
        signer_for_network: Any = None,
    ):
        self._signer = signer
        self._signer_for_network = signer_for_network

    def resolve_signer(self, network: str) -> Erc20ApprovalGasSponsoringSigner | None:
        """Resolve the signer for a given network."""
        if self._signer_for_network is not None:
            result = self._signer_for_network(network)
            if result is not None:
                return result
        return self._signer
