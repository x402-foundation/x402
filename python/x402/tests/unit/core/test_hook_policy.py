"""Unit tests for hook mutation policy guards."""

import pytest

from x402.hook_policy import (
    assert_accepts_allowlisted_after_extension_enrich,
    assert_additive_payload_enrichment,
    assert_additive_settlement_extra,
    assert_settle_response_core_unchanged,
    is_vacant_string_field,
    merge_additive_settlement_extra,
    snapshot_payment_requirements_list,
    snapshot_settle_response_core,
)
from x402.schemas import PaymentRequirements, SettleResponse


def _build_payment_requirements(**overrides) -> PaymentRequirements:
    base = {
        "scheme": "exact",
        "network": "eip155:8453",
        "asset": "0xasset",
        "amount": "1000",
        "pay_to": "0xpayto",
        "max_timeout_seconds": 300,
        "extra": {},
    }
    base.update(overrides)
    return PaymentRequirements(**base)


def _build_settle_response(**overrides) -> SettleResponse:
    base = {
        "success": True,
        "transaction": "0xtx",
        "network": "eip155:8453",
    }
    base.update(overrides)
    return SettleResponse(**base)


def test_is_vacant_string_field() -> None:
    assert is_vacant_string_field("") is True
    assert is_vacant_string_field("   ") is True
    assert is_vacant_string_field("0xabc") is False


def test_extension_enrich_allows_filling_vacant_fields() -> None:
    baseline = snapshot_payment_requirements_list(
        [_build_payment_requirements(pay_to="", amount="", asset="")]
    )
    current = snapshot_payment_requirements_list(baseline)
    current[0].pay_to = "0xnew"
    current[0].amount = "1"
    current[0].asset = "USDC"
    assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_extension_enrich_rejects_scheme_change() -> None:
    baseline = snapshot_payment_requirements_list([_build_payment_requirements()])
    current = snapshot_payment_requirements_list(baseline)
    current[0].scheme = "other"
    with pytest.raises(ValueError, match="scheme/network"):
        assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_extension_enrich_rejects_amount_change_when_set() -> None:
    baseline = snapshot_payment_requirements_list([_build_payment_requirements(amount="1000")])
    current = snapshot_payment_requirements_list(baseline)
    current[0].amount = "999"
    with pytest.raises(ValueError, match="amount"):
        assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_extension_enrich_rejects_removed_extra_key() -> None:
    baseline = snapshot_payment_requirements_list([_build_payment_requirements(extra={"k": 1})])
    current = snapshot_payment_requirements_list(baseline)
    current[0].extra = {}
    with pytest.raises(ValueError, match='extra\\["k"\\]'):
        assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_extension_enrich_rejects_changed_extra_value() -> None:
    baseline = snapshot_payment_requirements_list([_build_payment_requirements(extra={"k": 1})])
    current = snapshot_payment_requirements_list(baseline)
    current[0].extra = {"k": 2}
    with pytest.raises(ValueError, match='extra\\["k"\\]'):
        assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_extension_enrich_allows_new_extra_keys() -> None:
    baseline = snapshot_payment_requirements_list([_build_payment_requirements(extra={"k": 1})])
    current = snapshot_payment_requirements_list(baseline)
    current[0].extra = {"k": 1, "new_key": True}
    assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_extension_enrich_detects_nested_extra_mutation() -> None:
    baseline = snapshot_payment_requirements_list(
        [_build_payment_requirements(extra={"nested": {"b": "c"}})]
    )
    current = snapshot_payment_requirements_list(baseline)
    current[0].extra["nested"]["b"] = "mutated"
    with pytest.raises(ValueError, match='extra\\["nested"\\]'):
        assert_accepts_allowlisted_after_extension_enrich(baseline, current, "ext")


def test_settle_core_unchanged_allows_extensions() -> None:
    result = _build_settle_response()
    snap = snapshot_settle_response_core(result)
    result.extensions = {"a": 1}
    assert_settle_response_core_unchanged(snap, result, "ext")


def test_settle_core_unchanged_rejects_transaction_change() -> None:
    result = _build_settle_response()
    snap = snapshot_settle_response_core(result)
    result.transaction = "0xother"
    with pytest.raises(ValueError, match="transaction"):
        assert_settle_response_core_unchanged(snap, result, "ext")


def test_additive_payload_enrichment() -> None:
    assert_additive_payload_enrichment(
        {"client_field": "client"},
        {"server_field": "server"},
        "scheme test",
    )
    with pytest.raises(ValueError, match="client_field"):
        assert_additive_payload_enrichment(
            {"client_field": "client"},
            {"client_field": "server"},
            "scheme test",
        )


def test_additive_settlement_extra() -> None:
    assert_additive_settlement_extra(
        {"facilitator_field": "facilitator"},
        {"scheme_field": "scheme"},
        "scheme test",
    )
    assert_additive_settlement_extra(
        {"channel_state": {"channel_id": "0xchannel", "balance": "1000"}},
        {"channel_state": {"charged_cumulative_amount": "200"}},
        "scheme test",
    )
    with pytest.raises(ValueError, match="facilitator_field"):
        assert_additive_settlement_extra(
            {"facilitator_field": "facilitator"},
            {"facilitator_field": "scheme"},
            "scheme test",
        )


def test_merge_additive_settlement_extra() -> None:
    merged = merge_additive_settlement_extra(
        {"channel_state": {"channel_id": "0xchannel", "balance": "1000"}},
        {
            "charged_amount": "100",
            "channel_state": {"charged_cumulative_amount": "200"},
        },
    )
    assert merged == {
        "charged_amount": "100",
        "channel_state": {
            "channel_id": "0xchannel",
            "balance": "1000",
            "charged_cumulative_amount": "200",
        },
    }
