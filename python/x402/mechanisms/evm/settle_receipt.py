"""Shared settle receipt wait helpers for EVM facilitators."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from ...schemas import SettleResponse
from .constants import ERR_SETTLEMENT_PENDING, TX_STATUS_SUCCESS
from .types import TransactionReceipt
from .utils import is_valid_tx_hash, truncate_error_message


class ReceiptWaiter(Protocol):
    """Signer capability required to confirm a broadcast settlement transaction."""

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        """Block until the transaction is mined and return its receipt."""
        ...


def invalid_broadcast_hash_response(
    tx: str,
    error_reason: str,
    network: str,
    payer: str | None = None,
) -> SettleResponse:
    """Terminal failure when a signer reports success without a usable hash."""
    return SettleResponse(
        success=False,
        error_reason=error_reason,
        error_message=f"signer returned an invalid transaction hash: {tx!r}",
        transaction="",
        network=network,
        payer=payer,
    )


def wait_for_receipt_and_build_response(
    signer: ReceiptWaiter,
    tx_hash: str,
    network: str,
    payer: str | None,
    *,
    failed_reason: str,
    amount: str | None = None,
    validate_receipt: Callable[[TransactionReceipt], SettleResponse | None] | None = None,
    on_success: Callable[[TransactionReceipt], SettleResponse] | None = None,
) -> SettleResponse:
    """Wait for a broadcast receipt and build the settlement response.

    A reverted receipt and an explicit validation failure are terminal. A receipt-wait
    failure, or an error raised while processing a confirmed receipt, leaves the broadcast
    onchain with an unknown effect and returns settlement_pending with the hash.

    validate_receipt runs after a successful receipt (e.g. a Transfer event check): return a
    SettleResponse to fail settlement, or None to accept success. on_success, when set,
    builds the success response from the receipt.
    """
    if not is_valid_tx_hash(tx_hash):
        return invalid_broadcast_hash_response(tx_hash, failed_reason, network, payer)

    try:
        receipt = signer.wait_for_transaction_receipt(tx_hash)
    except Exception as e:
        return _settlement_pending_response(tx_hash, network, payer, e)

    try:
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=failed_reason,
                transaction=tx_hash,
                network=network,
                payer=payer,
            )

        if validate_receipt is not None:
            validation_failure = validate_receipt(receipt)
            if validation_failure is not None:
                return validation_failure

        if on_success is not None:
            return on_success(receipt)

        return SettleResponse(
            success=True,
            transaction=tx_hash,
            network=network,
            payer=payer,
            amount=amount,
        )
    except Exception as e:
        return _settlement_pending_response(tx_hash, network, payer, e)


def _settlement_pending_response(
    tx_hash: str,
    network: str,
    payer: str | None,
    error: Exception,
) -> SettleResponse:
    """Build the non-terminal failure for a broadcast whose effect is unconfirmed."""
    return SettleResponse(
        success=False,
        error_reason=ERR_SETTLEMENT_PENDING,
        error_message=truncate_error_message(str(error)),
        transaction=tx_hash,
        network=network,
        payer=payer,
    )
