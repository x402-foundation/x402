"""Unit tests for client-side configuration helpers."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.client.config import (
        DEFAULT_SALT,
        BatchSettlementDepositPolicy,
        BatchSettlementEvmSchemeOptions,
        deposit_amount_for_request,
        normalize_strategy_deposit_amount,
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
    def test_default_multiplier_is_5(self):
        assert deposit_amount_for_request(None, 100) == "500"

    def test_explicit_multiplier(self):
        policy = BatchSettlementDepositPolicy(deposit_multiplier=10)
        assert deposit_amount_for_request(policy, 100) == "1000"

    def test_none_multiplier_falls_back_to_default(self):
        policy = BatchSettlementDepositPolicy()
        assert deposit_amount_for_request(policy, 100) == "500"


class TestNormalizeStrategyDepositAmount:
    def test_int(self):
        assert normalize_strategy_deposit_amount(100) == "100"

    def test_digit_string(self):
        assert normalize_strategy_deposit_amount("250") == "250"

    @pytest.mark.parametrize("value", [0, -1, "0", "-1", "abc", "", True, False, "  100  "])
    def test_rejects_invalid(self, value):
        with pytest.raises(ValueError):
            normalize_strategy_deposit_amount(value)
