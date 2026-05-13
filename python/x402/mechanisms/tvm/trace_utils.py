"""Helpers for extracting TVM execution fees from Toncenter traces."""

from __future__ import annotations

import base64


def parse_trace_transactions(trace_data: dict[str, object]) -> list[dict[str, object]]:
    """Return transaction objects from a Toncenter trace payload."""
    try:
        transactions = trace_data["transactions"]
        return list(transactions.values())
    except (KeyError, AttributeError, TypeError) as exc:
        raise ValueError("Toncenter trace did not return transactions dict") from exc


def transaction_succeeded(transaction: dict[str, object]) -> bool:
    """Return True when a traced transaction completed successfully."""
    description = _transaction_phases(transaction)
    if description.get("aborted") is True:
        return False

    compute_phase: dict = description["compute_ph"]
    if compute_phase.get("skipped") is True or compute_phase.get("success") is not True:
        return False

    action_phase = description.get("action")
    if action_phase is not None and action_phase.get("success") is not True:
        return False

    return True


def body_hash_to_base64(raw_hash: bytes) -> str:
    """Encode a raw TVM cell hash to the Toncenter base64 representation."""
    return base64.b64encode(raw_hash).decode("ascii")


def trace_transaction_hash_to_hex(encoded_hash: str) -> str:
    """Convert a provider transaction hash to lowercase hex."""
    normalized = encoded_hash.strip()
    if len(normalized) == 64:
        try:
            bytes.fromhex(normalized)
            return normalized.lower()
        except ValueError:
            pass
    return base64.b64decode(normalized).hex()


def message_body_hash_matches(message: dict[str, object], expected_hash: bytes) -> bool:
    """Check whether a trace message matches a known TVM body hash."""
    return message.get("message_content", {}).get("hash") == body_hash_to_base64(expected_hash)


def trace_transaction_fwd_fees(
    transaction: dict[str, object],
    *,
    expected_count: int | None = None,
) -> int:
    """Extract the total forward fees paid by a transaction."""
    exact_fees = [
        parsed_fee
        for out_message in transaction.get("out_msgs", [])
        for parsed_fee in [_parse_int(out_message.get("fwd_fee"))]
        if parsed_fee is not None
    ]
    if exact_fees:
        return sum(exact_fees)

    action_phase: dict = _transaction_phases(transaction).get("action")
    if action_phase is not None:
        total_fwd_fees = _parse_int(action_phase.get("total_fwd_fees"))
        if total_fwd_fees is not None:
            return total_fwd_fees

        fwd_fee = _parse_int(action_phase.get("fwd_fee"))
        if fwd_fee is not None:
            return fwd_fee * expected_count if expected_count is not None else fwd_fee

    return 0


def trace_transaction_compute_fees(transaction: dict[str, object]) -> int:
    """Extract compute gas fees from a transaction description."""
    compute_phase: dict = _transaction_phases(transaction)["compute_ph"]
    return _parse_int(compute_phase.get("gas_fees")) or 0


def trace_transaction_storage_fees(transaction: dict[str, object]) -> int:
    """Extract storage fees from a transaction description."""
    storage_phase: dict = _transaction_phases(transaction)["storage_ph"]
    return (_parse_int(storage_phase.get("storage_fees_collected")) or 0) + (
        _parse_int(storage_phase.get("storage_fees_due")) or 0
    )


def trace_transaction_balance_before(transaction: dict[str, object]) -> int:
    """Extract the account balance before transaction execution."""
    before_state: dict = transaction.get("account_state_before")
    if before_state is not None:
        balance = _parse_int(before_state.get("balance"))
        if balance is not None:
            return balance

    account_state: dict = transaction.get("account_state")
    if account_state is not None:
        balance = _parse_int(account_state.get("balance"))
        if balance is not None:
            return balance

    balance = _parse_int(transaction.get("balance"))
    if balance is not None:
        return balance

    raise ValueError("Trace transaction is missing account_state_before balance")


def _transaction_phases(transaction: dict[str, object]) -> dict[str, object]:
    return transaction.get("description", transaction)


def _parse_int(value: object) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value, 0)
        except ValueError:
            return None
    return None
