"""XRPL client for the exact payment scheme."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ....schemas import PaymentRequirements
from .. import ledger
from ..constants import (
    ASSET_XRP,
    DEFAULT_CLIENT_FEE_DROPS,
    MAX_ACCOUNT_TICKETS,
    MAX_DESTINATION_TAG,
    SCHEME_EXACT,
    STANDARD_NETWORK_ID_CEILING,
)
from ..types import ExactXrplPayload, resolve_asset_transfer_method
from ..utils import (
    get_max_last_ledger_sequence,
    invoice_id_to_invoice_id_field,
    is_classic_address,
    is_destination_tag,
    is_issued_currency_value,
    is_xrpl_network,
    normalize_currency_code,
    parse_drops,
    parse_xrpl_network_id,
)

try:
    from xrpl.core import binarycodec
    from xrpl.models.transactions import Payment
    from xrpl.transaction import sign
    from xrpl.wallet import Wallet
except ModuleNotFoundError as e:  # pragma: no cover
    if (e.name or "").split(".")[0] != "xrpl":
        raise
    raise ImportError(
        "XRPL mechanism requires xrpl-py. Install with: pip install x402[xrpl]"
    ) from e


@dataclass
class XrplClientOptions:
    """Configuration for building XRPL payments.

    Ledger reads are injectable for the same reason they are on the facilitator:
    the payment-building logic stays testable without a network.
    """

    fee_drops: str = DEFAULT_CLIENT_FEE_DROPS
    rpc_url_by_network: dict[str, str] = field(default_factory=dict)

    # Ledger interactions, each defaulted by the ledger module when unset.
    get_current_ledger_index: Callable[[str], int] | None = None
    get_account_sequence: Callable[[str, str], int] | None = None
    get_available_ticket_sequence: Callable[[str, str], int | None] | None = None
    create_tickets: Callable[[Wallet, str, int], list[int]] | None = None
    # Tickets to create when the payer holds none. 0 disables creation and
    # makes a missing ticket an error instead.
    ticket_create_count: int = 1


def _destination_tag(value: Any) -> int:
    """Validate a destination tag rather than coercing it.

    ``int()`` would turn 1.5 into 1, a tag that differs from the one the
    server asked for, which at a hosted account credits the wrong customer.

    Args:
        value: Candidate destination tag.

    Returns:
        The validated tag.

    Raises:
        ValueError: If the value is not an integer in the uint32 range.
    """
    if not is_destination_tag(value):
        raise ValueError(
            f"destinationTag must be an integer between 0 and {MAX_DESTINATION_TAG}, got {value!r}"
        )
    return value


class ExactXrplScheme:
    """Builds signed XRPL payments that satisfy exact payment requirements."""

    scheme = SCHEME_EXACT

    def __init__(self, wallet: Wallet, options: XrplClientOptions | None = None) -> None:
        """Create the client scheme.

        Args:
            wallet: Wallet that signs and funds the payment.
            options: Fee and ledger-access configuration.
        """
        self.wallet = wallet
        self.options = options or XrplClientOptions()

    def create_payment_payload(self, requirements: PaymentRequirements) -> dict[str, Any]:
        """Build and sign a payment satisfying the requirements.

        Args:
            requirements: Requirements to fulfil.

        Returns:
            The scheme payload carrying the signed transaction blob.

        Raises:
            ValueError: If the requirements cannot be satisfied on XRPL.
        """
        if requirements.scheme != SCHEME_EXACT:
            raise ValueError(f"Unsupported scheme: {requirements.scheme}")
        if not is_xrpl_network(requirements.network):
            raise ValueError(f"Unsupported XRPL network: {requirements.network}")

        extra = requirements.extra or {}
        # Refuse to build a payment the facilitator is bound to reject, rather
        # than spend the payer's sequence on a request that cannot be paid.
        if extra.get("areFeesSponsored") is not False:
            raise ValueError(
                "XRPL exact payments require extra.areFeesSponsored to be false: "
                "the payer funds the XRPL transaction fee"
            )
        invoice_id = extra.get("invoiceId")
        if invoice_id is not None and (not isinstance(invoice_id, str) or invoice_id == ""):
            raise ValueError(f"extra.invoiceId must be a non-empty string, got {invoice_id!r}")

        # Before any ledger read: a malformed amount or issuer would otherwise
        # surface as an opaque serialiser error after the sequence was fetched.
        if requirements.asset == ASSET_XRP:
            if parse_drops(requirements.amount) is None:
                raise ValueError(
                    "XRP amounts are drops: a non-negative integer string, "
                    f"got {requirements.amount!r}"
                )
        else:
            if normalize_currency_code(requirements.asset) is None:
                raise ValueError(
                    "Issued currencies are a 3-character code or 40 hex characters, "
                    f"got {requirements.asset!r}"
                )
            issuer = extra.get("issuer")
            if not is_classic_address(issuer):
                raise ValueError(
                    f"{requirements.asset} payments require extra.issuer to be an XRPL "
                    f"classic address, got {issuer!r}"
                )
            if not is_issued_currency_value(requirements.amount):
                raise ValueError(
                    f"{requirements.asset} amounts are a non-negative decimal string, "
                    f"got {requirements.amount!r}"
                )

        method, error = resolve_asset_transfer_method(None, requirements.extra)
        if error:
            raise ValueError(error)

        destination_tag = extra.get("destinationTag")
        if destination_tag is not None:
            destination_tag = _destination_tag(destination_tag)
        ticket_create_count = 0
        if method == "ticketSequence":
            ticket_create_count = self._validate_ticket_create_count()

        fields: dict[str, Any] = {
            "account": self.wallet.address,
            "destination": requirements.pay_to,
            "amount": self._build_amount(requirements),
            "fee": self.options.fee_drops,
            "flags": 0,
            "last_ledger_sequence": self._expiry_ledger(requirements),
        }

        # Above the ceiling the signed NetworkID binds the payment to one
        # chain; below it, rippled rejects the field outright.
        network_id = parse_xrpl_network_id(requirements.network)
        if network_id > STANDARD_NETWORK_ID_CEILING:
            fields["network_id"] = network_id

        if destination_tag is not None:
            fields["destination_tag"] = destination_tag

        if invoice_id is not None:
            fields["invoice_id"] = invoice_id_to_invoice_id_field(invoice_id)

        amount = fields["amount"]
        if isinstance(amount, dict):
            # Mandatory for issued currencies; equal to Amount, since this
            # client does not pay issuer transfer fees on the payer's behalf.
            fields["send_max"] = amount

        if method == "ticketSequence":
            fields["sequence"] = 0
            fields["ticket_sequence"] = self._ticket_sequence(requirements, ticket_create_count)
        else:
            fields["sequence"] = self._account_sequence(requirements)

        signed = sign(Payment(**fields), self.wallet)
        blob = binarycodec.encode(signed.to_xrpl())
        return ExactXrplPayload(signed_tx_blob=blob).to_dict()

    def _build_amount(self, requirements: PaymentRequirements) -> str | dict[str, str]:
        """Build the Amount field for the required asset.

        The amount and issuer were validated before any ledger read, so this
        only assembles the field.

        Args:
            requirements: Payment requirements.

        Returns:
            Drops for XRP, or an issued-currency amount.
        """
        if requirements.asset == ASSET_XRP:
            return requirements.amount
        return {
            "currency": requirements.asset,
            "issuer": str((requirements.extra or {}).get("issuer")),
            "value": requirements.amount,
        }

    def _expiry_ledger(self, requirements: PaymentRequirements) -> int:
        """Compute LastLedgerSequence from the requirement's timeout.

        Args:
            requirements: Payment requirements.

        Returns:
            The ledger index at which the transaction expires.
        """
        get_index = self.options.get_current_ledger_index or (
            lambda net: ledger.get_current_ledger_index(net, self.options.rpc_url_by_network)
        )
        current = get_index(requirements.network)
        # Exactly the bound the facilitator enforces, from the shared helper.
        return get_max_last_ledger_sequence(current, requirements.max_timeout_seconds)

    def _account_sequence(self, requirements: PaymentRequirements) -> int:
        """Read the account sequence to consume.

        Args:
            requirements: Payment requirements.

        Returns:
            The account's current sequence.
        """
        get_sequence = self.options.get_account_sequence or (
            lambda account, net: ledger.get_account_sequence(
                account, net, self.options.rpc_url_by_network
            )
        )
        return int(get_sequence(self.wallet.address, requirements.network))

    def _validate_ticket_create_count(self) -> int:
        """Return the configured ticket count, refusing one the ledger rejects.

        Checked before any network call, so a bad count cannot reach a live
        TicketCreate.

        Returns:
            The validated count.

        Raises:
            ValueError: If the count is not an integer in 0..250.
        """
        count = self.options.ticket_create_count
        if isinstance(count, bool) or not isinstance(count, int):
            raise ValueError(f"ticket_create_count must be an integer, got {count!r}")
        if not 0 <= count <= MAX_ACCOUNT_TICKETS:
            raise ValueError(
                f"ticket_create_count must be between 0 and {MAX_ACCOUNT_TICKETS}, got {count!r}"
            )
        return count

    def _ticket_sequence(self, requirements: PaymentRequirements, count: int) -> int:
        """Find an available ticket to consume.

        Args:
            requirements: Payment requirements.
            count: Validated ticket count to create when the payer holds none.

        Returns:
            An available ticket sequence.

        Raises:
            ValueError: If the account holds no unspent ticket.
        """
        get_ticket = self.options.get_available_ticket_sequence or (
            lambda account, net: ledger.get_available_ticket_sequence(
                account, net, self.options.rpc_url_by_network
            )
        )
        ticket = get_ticket(self.wallet.address, requirements.network)
        if ticket is not None:
            return int(ticket)

        # The scheme requires the client to create a ticket when it holds none.
        # Each one locks owner reserve until it is spent, so the count is the
        # caller's to choose, and setting it to 0 opts out entirely.
        if count == 0:
            raise ValueError(
                f"{self.wallet.address} holds no available Ticket and automatic "
                "ticket creation is disabled (ticket_create_count=0)"
            )
        create = self.options.create_tickets or (
            lambda wallet, net, count: ledger.create_tickets(
                wallet, net, count, self.options.rpc_url_by_network
            )
        )
        created = create(self.wallet, requirements.network, count)
        if not created:
            raise ValueError(f"TicketCreate returned no tickets for {self.wallet.address}")
        return created[0]
