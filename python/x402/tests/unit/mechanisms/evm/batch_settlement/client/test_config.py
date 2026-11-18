"""Unit tests for client-side configuration helpers."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.client.config import (
        DEFAULT_SALT,
        BatchSettlementDepositPolicy,
        BatchSettlementEvmSchemeOptions,
        apply_max_deposit,
        deposit_amount_for_request,
        max_deposit_from_spend_cap,
        normalize_strategy_deposit_amount,
        parse_announced_min_deposit,
        resolve_client_options,
        validate_deposit_policy,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        InMemoryClientChannelStorage,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


class TestResolveClientOptions:
    def test_none_yields_defaults(self):
        r = resolve_client_options(None)
        assert isinstance(r.storage, InMemoryClientChannelStorage)
        assert r.salt == DEFAULT_SALT
        assert r.deposit_policy is None
        assert r.deposit_strategy is None
        assert r.payer_authorizer is None
        assert r.voucher_signer is None

    def test_policy_argument_keeps_defaults(self):
        policy = BatchSettlementDepositPolicy(deposit_multiplier=10)
        r = resolve_client_options(policy)
        assert r.deposit_policy is policy
        assert isinstance(r.storage, InMemoryClientChannelStorage)
        assert r.salt == DEFAULT_SALT

    def test_full_options_passes_through(self):
        storage = InMemoryClientChannelStorage()
        opts = BatchSettlementEvmSchemeOptions(
            storage=storage,
            salt="0x" + "ab" * 32,
            deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=7),
            rpc_url="https://example.test",
        )
        r = resolve_client_options(opts)
        assert r.storage is storage
        assert r.salt == "0x" + "ab" * 32
        assert r.deposit_policy is opts.deposit_policy
        assert r.rpc_url == "https://example.test"

    def test_full_options_with_missing_storage_uses_default(self):
        opts = BatchSettlementEvmSchemeOptions()
        r = resolve_client_options(opts)
        assert isinstance(r.storage, InMemoryClientChannelStorage)
        assert r.salt == DEFAULT_SALT

    def test_unsupported_type_raises(self):
        with pytest.raises(TypeError):
            resolve_client_options("oops")  # type: ignore[arg-type]


class TestValidateDepositPolicy:
    def test_none_accepted(self):
        validate_deposit_policy(None)

    def test_missing_multiplier_accepted(self):
        validate_deposit_policy(BatchSettlementDepositPolicy())

    def test_min_3(self):
        validate_deposit_policy(BatchSettlementDepositPolicy(deposit_multiplier=3))

    def test_rejects_below_3(self):
        with pytest.raises(ValueError):
            validate_deposit_policy(BatchSettlementDepositPolicy(deposit_multiplier=2))

    def test_rejects_bool_multiplier(self):
        with pytest.raises(ValueError):
            validate_deposit_policy(
                BatchSettlementDepositPolicy(deposit_multiplier=True)  # type: ignore[arg-type]
            )


class TestDepositAmountForRequest:
    cap = 1_000_000

    def test_uses_announced_min_deposit_when_valid(self):
        assert (
            deposit_amount_for_request(None, 1000, 1000, {"minDeposit": "12000"}, self.cap)
            == "12000"
        )

    def test_ignores_invalid_min_deposit_values(self):
        assert (
            deposit_amount_for_request(None, 1000, 1000, {"minDeposit": "abc"}, self.cap) == "5000"
        )
        assert deposit_amount_for_request(None, 1000, 1000, {"minDeposit": "0"}, self.cap) == "5000"
        assert (
            deposit_amount_for_request(None, 1000, 1000, {"minDeposit": "500"}, self.cap) == "5000"
        )

    def test_falls_back_to_deposit_multiplier_when_min_deposit_is_absent(self):
        assert (
            deposit_amount_for_request(
                BatchSettlementDepositPolicy(deposit_multiplier=7),
                1000,
                1000,
                None,
                self.cap,
            )
            == "7000"
        )

    def test_uses_the_voucher_gap_when_it_exceeds_the_target(self):
        assert (
            deposit_amount_for_request(None, 1000, 8000, {"minDeposit": "5000"}, self.cap) == "8000"
        )

    def test_clamps_the_target_to_max_deposit_when_the_voucher_gap_still_fits(self):
        assert deposit_amount_for_request(None, 1000, 1000, {"minDeposit": "12000"}, 4000) == "4000"

    def test_throws_when_the_voucher_gap_exceeds_max_deposit(self):
        with pytest.raises(ValueError, match="exceeds deposit_multiplier"):
            deposit_amount_for_request(None, 1000, 8000, {"minDeposit": "5000"}, 4000)

    def test_skips_the_ceiling_when_no_spend_cap_is_set(self):
        assert deposit_amount_for_request(None, 1000, 1000, {"minDeposit": "15000"}) == "15000"


class TestMaxDepositFromSpendCap:
    def test_multiplies_the_spend_cap_by_deposit_multiplier(self):
        assert max_deposit_from_spend_cap("1000") == 5000
        assert max_deposit_from_spend_cap("1000", 7) == 7000

    def test_returns_none_when_no_spend_cap_is_configured(self):
        assert max_deposit_from_spend_cap(None) is None


class TestApplyMaxDeposit:
    def test_returns_the_deposit_when_it_is_within_the_ceiling(self):
        assert apply_max_deposit(12000, 1000, 20000) == "12000"

    def test_returns_the_deposit_unchanged_when_uncapped(self):
        assert apply_max_deposit(12000, 1000) == "12000"


class TestParseAnnouncedMinDeposit:
    def test_accepts_positive_integers_at_or_above_request_amount(self):
        assert parse_announced_min_deposit("1000", 1000) == 1000
        assert parse_announced_min_deposit("5000", 1000) == 5000

    def test_rejects_invalid_values(self):
        assert parse_announced_min_deposit(None, 1000) is None
        assert parse_announced_min_deposit("999", 1000) is None
        assert parse_announced_min_deposit("-1", 1000) is None


class TestNormalizeStrategyDepositAmount:
    def test_int(self):
        assert normalize_strategy_deposit_amount(100) == "100"

    def test_digit_string(self):
        assert normalize_strategy_deposit_amount("250") == "250"

    @pytest.mark.parametrize("value", [0, -1, "0", "-1", "abc", "", True, False, "  100  "])
    def test_rejects_invalid(self, value):
        with pytest.raises(ValueError):
            normalize_strategy_deposit_amount(value)
