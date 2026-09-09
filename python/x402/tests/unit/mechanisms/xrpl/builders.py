"""Builders and fakes for XRPL mechanism tests."""

from __future__ import annotations

import re
from typing import Any

from xrpl.core import binarycodec, keypairs
from xrpl.models.transactions import Payment
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from x402.mechanisms.xrpl.constants import XRPL_TESTNET
from x402.mechanisms.xrpl.exact import XrplClientOptions
from x402.mechanisms.xrpl.types import (
    XrplAccountAuthorization,
    XrplFacilitatorOptions,
    XrplSettlementResult,
)
from x402.mechanisms.xrpl.utils import (
    get_signed_transaction_hash,
    invoice_id_to_invoice_id_field,
)
from x402.schemas.payments import PaymentPayload, PaymentRequirements

MERCHANT = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"
ISSUER = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w"
INVOICE_ID = "inv_abc123"
CURRENT_LEDGER = 100_000
AMOUNT_DROPS = "1000"


def make_wallet() -> Wallet:
    """Create a throwaway wallet.

    Returns:
        A generated wallet.
    """
    return Wallet.create()


def sign_payment(
    wallet: Wallet,
    *,
    account: str | None = None,
    destination: str = MERCHANT,
    amount: Any = AMOUNT_DROPS,
    sequence: int | None = 7,
    ticket_sequence: int | None = None,
    last_ledger_sequence: int | None = CURRENT_LEDGER + 10,
    invoice_id: str | None = None,
    fee: str = "12",
    flags: int = 0,
    network_id: int | None = None,
    send_max: Any = None,
    paths: Any = None,
    destination_tag: int | None = None,
    memos: Any = None,
    delegate: str | None = None,
) -> str:
    """Build and sign a Payment, returning its blob.

    Args:
        wallet: Signing wallet.
        account: Sending account, when it differs from the signer, used to
            exercise regular-key authority.
        destination: Payment destination.
        amount: Drops string or issued-currency mapping.
        sequence: Account sequence, or None when using a ticket.
        ticket_sequence: Ticket sequence for concurrent payments.
        last_ledger_sequence: Expiry ledger.
        invoice_id: Raw x402 invoice id, hashed into InvoiceID.
        fee: Fee in drops.
        flags: Transaction flags.
        network_id: Signed NetworkID, normally omitted.
        send_max: Optional SendMax.
        paths: Optional Paths, which would permit cross-currency delivery.
        destination_tag: Optional DestinationTag for hosted accounts.
        memos: Optional Memos, which this scheme forbids.
        delegate: Optional Delegate, which this scheme forbids.

    Returns:
        Hex-encoded signed transaction blob.
    """
    fields: dict[str, Any] = {
        "account": account or wallet.address,
        "destination": destination,
        "amount": amount,
        "fee": fee,
        "flags": flags,
        "sequence": 0 if ticket_sequence is not None else sequence,
    }
    if ticket_sequence is not None:
        fields["ticket_sequence"] = ticket_sequence
    if last_ledger_sequence is not None:
        fields["last_ledger_sequence"] = last_ledger_sequence
    if invoice_id is not None:
        fields["invoice_id"] = invoice_id_to_invoice_id_field(invoice_id)
    if network_id is not None:
        fields["network_id"] = network_id
    if send_max is not None:
        fields["send_max"] = send_max
    if paths is not None:
        fields["paths"] = paths
    if destination_tag is not None:
        fields["destination_tag"] = destination_tag
    if memos is not None:
        fields["memos"] = memos
    if delegate is not None:
        fields["delegate"] = delegate

    return binarycodec.encode(sign(Payment(**fields), wallet).to_xrpl())


def make_requirements(
    *,
    asset: str = "XRP",
    amount: str = AMOUNT_DROPS,
    pay_to: str = MERCHANT,
    network: str = XRPL_TESTNET,
    max_timeout_seconds: int = 60,
    extra: dict[str, Any] | None = None,
    fees_sponsored: Any = False,
) -> PaymentRequirements:
    """Build payment requirements.

    Args:
        asset: Asset identifier.
        amount: Required amount.
        pay_to: Recipient address.
        network: CAIP-2 network identifier.
        max_timeout_seconds: Validity window.
        extra: Scheme-specific extra fields.
        fees_sponsored: Value for ``areFeesSponsored``; the resource server
            always sets this, so it is merged in unless a test omits it by
            passing None.

    Returns:
        The requirements.
    """
    merged = dict(extra if extra is not None else {"assetTransferMethod": "sequence"})
    if fees_sponsored is not None:
        merged.setdefault("areFeesSponsored", fees_sponsored)
    return PaymentRequirements(
        scheme="exact",
        network=network,
        asset=asset,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=max_timeout_seconds,
        extra=merged,
    )


def make_payload(
    blob: str,
    requirements: PaymentRequirements,
    *,
    accepted_extra: dict[str, Any] | None = None,
) -> PaymentPayload:
    """Build a payment payload mirroring the requirements.

    Args:
        blob: Signed transaction blob.
        requirements: Requirements being fulfilled.
        accepted_extra: Override for the accepted terms' extra field.

    Returns:
        The payload.
    """
    accepted = requirements.model_copy(deep=True)
    if accepted_extra is not None:
        # The payer echoes the server's terms, which always carry this.
        merged = dict(accepted_extra)
        merged.setdefault("areFeesSponsored", False)
        accepted.extra = merged
    return PaymentPayload(payload={"signedTxBlob": blob}, accepted=accepted)


def make_options(
    *,
    sequence: int = 7,
    ledger_index: int = CURRENT_LEDGER,
    regular_key: str | None = None,
    master_key_disabled: bool = False,
    ticket_available: bool = True,
    settled: bool = True,
    settlement_code: str = "tesSUCCESS",
    settlement_hash: str | None = None,
    simulation: str = "tesSUCCESS",
) -> XrplFacilitatorOptions:
    """Build facilitator options with every ledger read stubbed.

    Args:
        sequence: Sequence the ledger reports for the payer.
        ledger_index: Current validated ledger index.
        regular_key: Regular key configured on the account.
        master_key_disabled: Whether the master key is disabled.
        ticket_available: Whether a queried ticket exists.
        settled: Whether submission reports the transaction validated.
        settlement_code: Result code reported by submission.
        settlement_hash: Hash reported by submission; an honest node reports the
            hash the blob actually has, which is the default.
        simulation: Engine result returned by the dry run.

    Returns:
        Options wired to in-memory fakes.
    """
    return XrplFacilitatorOptions(
        get_current_ledger_index=lambda _net: ledger_index,
        get_account_sequence=lambda _account, _net: sequence,
        get_account_authorization=lambda _account, _net: XrplAccountAuthorization(
            regular_key=regular_key, is_master_key_disabled=master_key_disabled
        ),
        is_ticket_available=lambda _account, _ticket, _net: ticket_available,
        submit_signed_transaction=lambda blob, _net: XrplSettlementResult(
            hash=(
                settlement_hash
                if settlement_hash is not None
                else get_signed_transaction_hash(blob)
            ),
            validated=settled,
            result_code=settlement_code,
        ),
        simulate_signed_transaction=lambda _blob, _net: simulation,
    )


def reorder_adjacent_fields(blob: str) -> str:
    """Swap the adjacent Flags and Sequence fields of a signed blob.

    The result decodes to the same transaction with the same valid signature,
    but is no longer the canonical serialisation: the malleation the
    canonical-form check exists to refuse.

    Args:
        blob: Hex-encoded signed transaction with Flags=0.

    Returns:
        The re-ordered blob.
    """
    flags = re.search(r"2200000000", blob)
    sequence = re.search(r"24[0-9A-F]{8}", blob)
    assert flags and sequence and flags.end() == sequence.start()
    return (
        blob[: flags.start()]
        + blob[sequence.start() : sequence.end()]
        + blob[flags.start() : flags.end()]
        + blob[sequence.end() :]
    )


def sign_raw(wallet: Wallet, fields: dict[str, Any]) -> str:
    """Sign an arbitrary transaction, bypassing model validation.

    xrpl-py refuses to build some shapes (SendMax on an XRP payment, Paths on
    an XRP payment), but a client is not obliged to use xrpl-py. Model
    validation is a convenience, not a security boundary, so the facilitator
    must be tested against blobs a hostile client could hand-craft.

    Args:
        wallet: Signing wallet.
        fields: Raw XRPL transaction fields, in wire form.

    Returns:
        Hex-encoded signed transaction blob.
    """
    tx = {**fields, "SigningPubKey": wallet.public_key}
    tx["TxnSignature"] = keypairs.sign(
        bytes.fromhex(binarycodec.encode_for_signing(tx)), wallet.private_key
    )
    return binarycodec.encode(tx)


def base_fields(wallet: Wallet, **overrides: Any) -> dict[str, Any]:
    """Wire-form fields for a valid payment, for use with :func:`sign_raw`.

    Args:
        wallet: Sending wallet.
        overrides: Fields to add or replace.

    Returns:
        Transaction fields in wire form.
    """
    fields: dict[str, Any] = {
        "TransactionType": "Payment",
        "Account": wallet.address,
        "Destination": MERCHANT,
        "Amount": AMOUNT_DROPS,
        "Fee": "12",
        "Flags": 0,
        "Sequence": 7,
        "LastLedgerSequence": CURRENT_LEDGER + 10,
    }
    fields.update(overrides)
    return fields


def make_client_options(
    *,
    ticket: int | None = 42,
    created_tickets: list[int] | None = None,
    ticket_create_count: int = 1,
) -> XrplClientOptions:
    """Build client options with every ledger read stubbed.

    The stubbed ledger index and account sequence match what
    :func:`make_options` reports to the facilitator, so a client-built payment
    verifies without further wiring.

    Args:
        ticket: Ticket the payer holds, if any.
        created_tickets: Tickets a TicketCreate would produce.
        ticket_create_count: Tickets to create when the payer holds none.

    Returns:
        Options wired to in-memory fakes.
    """
    return XrplClientOptions(
        get_current_ledger_index=lambda _net: CURRENT_LEDGER,
        get_account_sequence=lambda _account, _net: 7,
        get_available_ticket_sequence=lambda _account, _net: ticket,
        create_tickets=lambda _wallet, _net, _count: list(created_tickets or []),
        ticket_create_count=ticket_create_count,
    )
