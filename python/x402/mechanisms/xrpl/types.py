"""XRPL payload and option types."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .constants import (
    DEFAULT_MAX_FEE_DROPS,
    DEFAULT_MAX_TIMEOUT_SECONDS,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_ASSET_TRANSFER_METHOD_MISMATCH,
)

# How a signed transaction reserves its place in the payer's account.
#
# - ``sequence`` consumes the account's current Sequence, so the account has at
#   most one pending payment at a time.
# - ``ticketSequence`` consumes a pre-created Ticket (Sequence 0 plus
#   TicketSequence), allowing concurrent pending payments.
ASSET_TRANSFER_METHODS: frozenset[str] = frozenset({"sequence", "ticketSequence"})


@dataclass
class ExactXrplPayload:
    """Exact payment payload for XRPL networks."""

    signed_tx_blob: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to a dictionary for JSON serialisation.

        Returns:
            The wire representation.
        """
        return {"signedTxBlob": self.signed_tx_blob}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExactXrplPayload:
        """Create from a dictionary.

        Args:
            data: Wire representation.

        Returns:
            The parsed payload.

        Raises:
            ValueError: If the required field is missing or empty.
        """
        signed_tx_blob = data.get("signedTxBlob")
        if not isinstance(signed_tx_blob, str) or not signed_tx_blob.strip():
            raise ValueError("Exact XRPL payload field 'signedTxBlob' is required")
        return cls(signed_tx_blob=signed_tx_blob)


@dataclass
class XrplAccountAuthorization:
    """Signing authority configured on an XRPL account."""

    regular_key: str | None = None
    is_master_key_disabled: bool = False


@dataclass
class XrplSettlementResult:
    """Outcome of submitting a signed transaction."""

    hash: str
    validated: bool
    result_code: str


@dataclass
class XrplFacilitatorOptions:
    """Configuration for XRPL verification and settlement.

    Every ledger interaction is injectable. That keeps the verification rules
    testable without a network, and lets a deployment supply its own pooled or
    cached transport rather than being tied to one client.
    """

    max_fee_drops: str = DEFAULT_MAX_FEE_DROPS
    # Ceiling on a requirement's maxTimeoutSeconds, which sets both the expiry
    # window and the duplicate guard's retention; without it, whoever writes
    # the requirements chooses how long a signed blob stays replayable.
    max_timeout_seconds: int = DEFAULT_MAX_TIMEOUT_SECONDS
    rpc_url_by_network: dict[str, str] = field(default_factory=dict)

    # Ledger interactions, each defaulted by the ledger module when unset.
    get_current_ledger_index: Callable[[str], int] | None = None
    get_account_sequence: Callable[[str, str], int] | None = None
    get_account_authorization: Callable[[str, str], XrplAccountAuthorization] | None = None
    is_ticket_available: Callable[[str, int, str], bool] | None = None
    submit_signed_transaction: Callable[[str, str], XrplSettlementResult] | None = None
    # The scheme requires simulation; a deployment that accepts the risk can
    # inject a stub that always answers "tesSUCCESS".
    simulate_signed_transaction: Callable[[str, str], str] | None = None


def is_asset_transfer_method(value: Any) -> bool:
    """Return True for a recognised asset transfer method.

    Args:
        value: Candidate value.

    Returns:
        Whether the value names a supported method.
    """
    return isinstance(value, str) and value in ASSET_TRANSFER_METHODS


def resolve_asset_transfer_method(
    accepted_extra: dict[str, Any] | None,
    required_extra: dict[str, Any] | None,
) -> tuple[str | None, str | None]:
    """Resolve the transfer method both sides agreed on.

    Validating only the required side would let a client echo terms it never
    agreed to, so both are checked and must match.

    Args:
        accepted_extra: ``extra`` from the payload's accepted terms.
        required_extra: ``extra`` from the payment requirements.

    Returns:
        A ``(method, error)`` pair; exactly one is set.
    """
    required = (required_extra or {}).get("assetTransferMethod")
    accepted = (accepted_extra or {}).get("assetTransferMethod")

    if required is not None and not is_asset_transfer_method(required):
        return None, ERR_ASSET_TRANSFER_METHOD
    if accepted is not None and not is_asset_transfer_method(accepted):
        return None, ERR_ASSET_TRANSFER_METHOD

    selected = accepted if is_asset_transfer_method(accepted) else required
    if not is_asset_transfer_method(selected):
        selected = "sequence"

    if required is not None and selected != required:
        return None, ERR_ASSET_TRANSFER_METHOD_MISMATCH
    return selected, None
