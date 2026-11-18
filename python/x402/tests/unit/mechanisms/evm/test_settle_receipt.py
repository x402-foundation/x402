"""Unit tests for the shared settle-receipt policy chokepoint.

wait_for_receipt_and_build_response is the single place every EVM scheme (exact, upto,
batch) decides terminal vs settlement_pending after a broadcast. The boundary:

  - invalid broadcast hash          -> terminal (no hash to reconcile against)
  - receipt-wait failure            -> settlement_pending (hash kept)
  - reverted receipt                -> terminal (definitively failed on-chain)
  - validate_receipt returns failure-> terminal (confirmed, but did not settle)
  - unexpected throw while processing-> settlement_pending (confirmed, effect unknown)

The last case (malformed receipt, validate/on_success raising) must never be reported as a
terminal failure: the transaction is on-chain and may have succeeded, so a terminal result
could prompt a double-spend retry.
"""

from __future__ import annotations

from types import SimpleNamespace

from x402.mechanisms.evm.constants import ERR_SETTLEMENT_PENDING, TX_STATUS_SUCCESS
from x402.mechanisms.evm.settle_receipt import wait_for_receipt_and_build_response
from x402.pending_settlement_store import InMemoryPendingSettlementStore

_TX = "0x" + "ab" * 32
_FAILED = "invalid_exact_evm_transaction_failed"
_NETWORK = "eip155:8453"


class _Signer:
    def __init__(self, receipt=None, error: Exception | None = None) -> None:
        self._receipt = receipt
        self._error = error

    def wait_for_transaction_receipt(self, tx_hash):
        if self._error is not None:
            raise self._error
        return self._receipt


def _receipt(status=TX_STATUS_SUCCESS):
    return SimpleNamespace(status=status, logs=[])


def test_invalid_broadcast_hash_is_terminal():
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()), "not-a-hash", _NETWORK, None, failed_reason=_FAILED
    )
    assert out.success is False
    assert out.error_reason == _FAILED
    assert out.transaction == ""


def test_receipt_wait_failure_is_settlement_pending():
    out = wait_for_receipt_and_build_response(
        _Signer(error=RuntimeError("rpc timeout")), _TX, _NETWORK, None, failed_reason=_FAILED
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert out.transaction == _TX


def test_reverted_receipt_is_terminal():
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt(status=0)), _TX, _NETWORK, None, failed_reason=_FAILED
    )
    assert out.success is False
    assert out.error_reason == _FAILED
    assert out.transaction == _TX


def test_clean_validation_failure_is_terminal():
    from x402.schemas import SettleResponse

    def _validate(_receipt):
        return SettleResponse(
            success=False, error_reason=_FAILED, transaction=_TX, network=_NETWORK
        )

    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        validate_receipt=_validate,
    )
    assert out.success is False
    assert out.error_reason == _FAILED


def test_validate_receipt_raising_is_settlement_pending():
    def _validate(_receipt):
        raise ValueError("log decode failed")

    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        validate_receipt=_validate,
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert out.transaction == _TX


def test_on_success_raising_is_settlement_pending():
    def _on_success(_receipt):
        raise ValueError("amount parse failed")

    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        on_success=_on_success,
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert out.transaction == _TX


def test_malformed_receipt_missing_status_is_settlement_pending():
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=object()), _TX, _NETWORK, None, failed_reason=_FAILED
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert out.transaction == _TX


def test_success_returns_hash_and_amount():
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()), _TX, _NETWORK, "0xpayer", failed_reason=_FAILED, amount="100"
    )
    assert out.success is True
    assert out.transaction == _TX
    assert out.amount == "100"
    assert out.payer == "0xpayer"


# ============================================================================
# PendingSettlementStore mark/clear contract
#
# When pending_store and pending_key are both supplied, every outcome that leaves the
# broadcast's effect unresolved must record tx_hash (even a terminal reverted-receipt
# outcome — see the function's own docstring), and every outcome that resolves it
# (success, an invalid hash with nothing to reconcile against, or an explicit
# validate_receipt rejection of a confirmed receipt) must clear it. This is the single
# place all EVM schemes (exact, upto, batch-settlement) get this behavior from, so its
# store contract is pinned here directly rather than only indirectly via each scheme's
# own tests.
# ============================================================================

_KEY = "0xsomekey"


def test_invalid_broadcast_hash_clears_pending_when_store_provided():
    """An invalid hash means nothing usable was ever broadcast, so there is nothing to
    reconcile against later — unlike a reverted receipt (a real, replayable on-chain
    outcome), storing it would only make a retry re-observe the same invalid hash."""
    store = InMemoryPendingSettlementStore()
    store.set(_KEY, "0xstaleprior")

    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        "not-a-hash",
        _NETWORK,
        None,
        failed_reason=_FAILED,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == _FAILED
    assert store.get(_KEY) is None


def test_receipt_wait_failure_marks_pending_when_store_provided():
    store = InMemoryPendingSettlementStore()
    out = wait_for_receipt_and_build_response(
        _Signer(error=RuntimeError("rpc timeout")),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert store.get(_KEY) == _TX


def test_reverted_receipt_clears_pending_when_store_provided():
    """A reverted receipt is terminal (failed_reason, not settlement_pending). It must not
    be cached — only settlement_pending is safe to reconcile against — or it would linger
    as a false "pending" entry until TTL expiry."""
    store = InMemoryPendingSettlementStore()
    store.set(_KEY, _TX)
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt(status=0)),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == _FAILED
    assert store.get(_KEY) is None


def test_clean_validation_failure_clears_pending_when_store_provided():
    from x402.schemas import SettleResponse

    def _validate(_receipt):
        return SettleResponse(
            success=False, error_reason=_FAILED, transaction=_TX, network=_NETWORK
        )

    store = InMemoryPendingSettlementStore()
    store.set(_KEY, _TX)

    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        validate_receipt=_validate,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == _FAILED
    assert store.get(_KEY) is None


def test_validate_receipt_raising_marks_pending_when_store_provided():
    def _validate(_receipt):
        raise ValueError("log decode failed")

    store = InMemoryPendingSettlementStore()
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        validate_receipt=_validate,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert store.get(_KEY) == _TX


def test_on_success_raising_marks_pending_when_store_provided():
    def _on_success(_receipt):
        raise ValueError("amount parse failed")

    store = InMemoryPendingSettlementStore()
    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        on_success=_on_success,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert store.get(_KEY) == _TX


def test_success_clears_pending_when_store_provided():
    store = InMemoryPendingSettlementStore()
    store.set(_KEY, _TX)

    out = wait_for_receipt_and_build_response(
        _Signer(receipt=_receipt()),
        _TX,
        _NETWORK,
        "0xpayer",
        failed_reason=_FAILED,
        pending_store=store,
        pending_key=_KEY,
    )
    assert out.success is True
    assert store.get(_KEY) is None


def test_no_pending_key_is_a_noop_even_with_store_provided():
    """An empty/falsy pending_key (e.g. a malformed payload with no signature to key on)
    must disable the fast path store interaction entirely, not raise or store under a
    falsy key."""
    store = InMemoryPendingSettlementStore()

    out = wait_for_receipt_and_build_response(
        _Signer(error=RuntimeError("rpc timeout")),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        pending_store=store,
        pending_key="",
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
    assert store.entries == {}


def test_no_store_provided_is_a_noop_even_with_pending_key():
    """No pending_store at all (the default for callers that don't opt in) must not raise,
    regardless of outcome."""
    out = wait_for_receipt_and_build_response(
        _Signer(error=RuntimeError("rpc timeout")),
        _TX,
        _NETWORK,
        None,
        failed_reason=_FAILED,
        pending_key=_KEY,
    )
    assert out.success is False
    assert out.error_reason == ERR_SETTLEMENT_PENDING
