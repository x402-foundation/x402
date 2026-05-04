"""Focused tests for TVM trace utility helpers."""

from __future__ import annotations

import base64

import pytest

from x402.mechanisms.tvm.trace_utils import (
    body_hash_to_base64,
    message_body_hash_matches,
    parse_trace_transactions,
    trace_transaction_balance_before,
    trace_transaction_compute_fees,
    trace_transaction_fwd_fees,
    trace_transaction_hash_to_hex,
    trace_transaction_storage_fees,
    transaction_succeeded,
)


class TestParseTraceTransactions:
    def test_should_return_transactions_values(self):
        transactions = parse_trace_transactions(
            {"transactions": {"a": {"hash": "1"}, "b": {"hash": "2"}}}
        )

        assert transactions == [{"hash": "1"}, {"hash": "2"}]

    def test_should_reject_malformed_trace_payload(self):
        with pytest.raises(ValueError, match="transactions dict"):
            parse_trace_transactions({})


class TestTransactionSucceeded:
    def test_should_return_true_for_successful_transaction(self):
        assert transaction_succeeded(
            {
                "description": {
                    "aborted": False,
                    "compute_ph": {"success": True, "skipped": False},
                    "action": {"success": True},
                }
            }
        )

    @pytest.mark.parametrize(
        "transaction",
        [
            pytest.param(
                {
                    "description": {
                        "aborted": True,
                        "compute_ph": {"success": True, "skipped": False},
                    }
                },
                id="aborted",
            ),
            pytest.param(
                {
                    "description": {
                        "aborted": False,
                        "compute_ph": {"success": False, "skipped": False},
                    }
                },
                id="compute-failed",
            ),
            pytest.param(
                {
                    "description": {
                        "aborted": False,
                        "compute_ph": {"success": True, "skipped": True},
                    }
                },
                id="compute-skipped",
            ),
            pytest.param(
                {
                    "description": {
                        "aborted": False,
                        "compute_ph": {"success": True, "skipped": False},
                        "action": {"success": False},
                    }
                },
                id="action-failed",
            ),
        ],
    )
    def test_should_return_false_for_failed_transaction(self, transaction):
        assert transaction_succeeded(transaction) is False


class TestBodyHashes:
    def test_should_encode_raw_hash_to_base64(self):
        raw_hash = b"\x01\x02\x03"

        assert body_hash_to_base64(raw_hash) == base64.b64encode(raw_hash).decode("ascii")

    def test_should_convert_toncenter_transaction_hash_to_hex(self):
        raw_hash = bytes(range(32))

        assert (
            trace_transaction_hash_to_hex(base64.b64encode(raw_hash).decode("ascii"))
            == raw_hash.hex()
        )

    def test_should_match_message_content_hash(self):
        raw_hash = b"\x05" * 32
        message = {"message_content": {"hash": body_hash_to_base64(raw_hash)}}

        assert message_body_hash_matches(message, raw_hash) is True
        assert message_body_hash_matches(message, b"\x06" * 32) is False


class TestForwardFees:
    def test_should_sum_forward_fees_from_out_messages(self):
        assert (
            trace_transaction_fwd_fees(
                {"out_msgs": [{"fwd_fee": "10"}, {"fwd_fee": "0x20"}, {"fwd_fee": "bad"}]}
            )
            == 42
        )

    def test_should_fallback_to_total_fwd_fees_from_action_phase(self):
        assert (
            trace_transaction_fwd_fees({"description": {"action": {"total_fwd_fees": "55"}}}) == 55
        )

    def test_should_fallback_to_fwd_fee_times_expected_count(self):
        assert (
            trace_transaction_fwd_fees(
                {"description": {"action": {"fwd_fee": "7"}}},
                expected_count=3,
            )
            == 21
        )

    def test_should_return_zero_when_fees_are_missing(self):
        assert trace_transaction_fwd_fees({"description": {}}) == 0


class TestOtherFeeExtraction:
    def test_should_extract_compute_fees(self):
        assert (
            trace_transaction_compute_fees({"description": {"compute_ph": {"gas_fees": "33"}}})
            == 33
        )

    def test_should_extract_storage_fees_collected_then_due(self):
        assert (
            trace_transaction_storage_fees(
                {"description": {"storage_ph": {"storage_fees_collected": "44"}}}
            )
            == 44
        )
        assert (
            trace_transaction_storage_fees(
                {"description": {"storage_ph": {"storage_fees_due": "55"}}}
            )
            == 55
        )


class TestBalanceBefore:
    def test_should_prefer_account_state_before_balance(self):
        assert (
            trace_transaction_balance_before(
                {
                    "account_state_before": {"balance": "10"},
                    "account_state": {"balance": "20"},
                    "balance": "30",
                }
            )
            == 10
        )

    def test_should_fallback_to_account_state_then_transaction_balance(self):
        assert trace_transaction_balance_before({"account_state": {"balance": "20"}}) == 20
        assert trace_transaction_balance_before({"balance": "30"}) == 30

    def test_should_fail_when_balance_is_missing(self):
        with pytest.raises(ValueError, match="missing account_state_before balance"):
            trace_transaction_balance_before({})
