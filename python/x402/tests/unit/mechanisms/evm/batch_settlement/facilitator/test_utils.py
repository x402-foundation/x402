"""Unit tests for facilitator-side helpers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

try:
    from eth_utils import to_checksum_address

    from x402.mechanisms.evm.batch_settlement.constants import (
        MAX_WITHDRAW_DELAY,
        MIN_WITHDRAW_DELAY,
    )
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_CHANNEL_ID_MISMATCH,
        ERR_RECEIVER_AUTHORIZER_MISMATCH,
        ERR_RECEIVER_MISMATCH,
        ERR_TOKEN_MISMATCH,
        ERR_VALID_AFTER_IN_FUTURE,
        ERR_VALID_BEFORE_EXPIRED,
        ERR_WITHDRAW_DELAY_MISMATCH,
        ERR_WITHDRAW_DELAY_OUT_OF_RANGE,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.utils import (
        ZERO_ADDRESS,
        channel_ids_equal,
        erc3009_authorization_time_invalid_reason,
        to_contract_channel_config,
        validate_channel_config,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:84532"


def _channel_config(
    payer_authorizer: str = "0x2222222222222222222222222222222222222222",
    withdraw_delay: int = 900,
) -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer=payer_authorizer,
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token="0x5555555555555555555555555555555555555555",
        withdraw_delay=withdraw_delay,
        salt="0x" + "00" * 31 + "01",
    )


def _requirements(
    pay_to: str = "0x3333333333333333333333333333333333333333",
    asset: str = "0x5555555555555555555555555555555555555555",
    network: str = NETWORK,
    receiver_authorizer: str | None = "0x4444444444444444444444444444444444444444",
    withdraw_delay: int | None = None,
) -> SimpleNamespace:
    extra: dict[str, Any] = {}
    if receiver_authorizer is not None:
        extra["receiverAuthorizer"] = receiver_authorizer
    if withdraw_delay is not None:
        extra["withdrawDelay"] = withdraw_delay
    return SimpleNamespace(
        pay_to=pay_to,
        asset=asset,
        network=network,
        amount="100",
        extra=extra,
    )


class TestToContractChannelConfig:
    def test_returns_seven_tuple(self):
        cfg = _channel_config()
        out = to_contract_channel_config(cfg)
        assert len(out) == 7
        assert out[0] == to_checksum_address(cfg.payer)
        assert out[1] == to_checksum_address(cfg.payer_authorizer)
        assert out[5] == 900
        assert isinstance(out[6], bytes) and len(out[6]) == 32

    def test_zero_payer_authorizer_passes_through(self):
        cfg = _channel_config(payer_authorizer="0x" + "00" * 20)
        out = to_contract_channel_config(cfg)
        assert out[1] == ZERO_ADDRESS


class TestChannelIdsEqual:
    def test_case_insensitive(self):
        a = "0x" + "ab" * 32
        b = "0x" + "AB" * 32
        assert channel_ids_equal(a, b)

    def test_with_and_without_prefix(self):
        a = "0x" + "ab" * 32
        b = "ab" * 32
        assert channel_ids_equal(a, b)

    def test_distinct_returns_false(self):
        assert not channel_ids_equal("0x" + "ab" * 32, "0x" + "cd" * 32)

    def test_non_string_returns_false(self):
        assert not channel_ids_equal("0x" + "ab" * 32, None)  # type: ignore[arg-type]
        assert not channel_ids_equal("0x" + "ab" * 32, 123)  # type: ignore[arg-type]
        assert not channel_ids_equal("0x" + "ab" * 32, "")


class TestErc3009AuthorizationTimeInvalidReason:
    def test_expired_valid_before(self):
        # valid_before well in the past → expired
        assert erc3009_authorization_time_invalid_reason(0, 1) == ERR_VALID_BEFORE_EXPIRED

    def test_valid_after_in_future(self):
        # 100 years in the future
        far_future = 4 * 10**9
        reason = erc3009_authorization_time_invalid_reason(far_future, far_future + 60)
        assert reason == ERR_VALID_AFTER_IN_FUTURE

    def test_currently_valid_window(self):
        import time

        now = int(time.time())
        assert erc3009_authorization_time_invalid_reason(now - 60, now + 3600) is None


class TestValidateChannelConfig:
    def _config_with_id(self, cfg: ChannelConfig | None = None) -> tuple[ChannelConfig, str]:
        cfg = cfg or _channel_config()
        return cfg, compute_channel_id(cfg, NETWORK)

    def test_valid_returns_none(self):
        cfg, cid = self._config_with_id()
        assert validate_channel_config(cfg, cid, _requirements()) is None

    def test_channel_id_mismatch(self):
        cfg, _ = self._config_with_id()
        result = validate_channel_config(cfg, "0x" + "00" * 32, _requirements())
        assert result == ERR_CHANNEL_ID_MISMATCH

    def test_receiver_mismatch(self):
        cfg, cid = self._config_with_id()
        result = validate_channel_config(cfg, cid, _requirements(pay_to="0x" + "99" * 20))
        assert result == ERR_RECEIVER_MISMATCH

    def test_receiver_authorizer_mismatch(self):
        cfg, cid = self._config_with_id()
        result = validate_channel_config(
            cfg, cid, _requirements(receiver_authorizer="0x" + "99" * 20)
        )
        assert result == ERR_RECEIVER_AUTHORIZER_MISMATCH

    def test_receiver_authorizer_required(self):
        cfg, cid = self._config_with_id()
        result = validate_channel_config(cfg, cid, _requirements(receiver_authorizer=None))
        assert result == ERR_RECEIVER_AUTHORIZER_MISMATCH

    def test_zero_receiver_authorizer_rejected(self):
        cfg, cid = self._config_with_id()
        result = validate_channel_config(
            cfg, cid, _requirements(receiver_authorizer="0x" + "00" * 20)
        )
        assert result == ERR_RECEIVER_AUTHORIZER_MISMATCH

    def test_token_mismatch(self):
        cfg, cid = self._config_with_id()
        result = validate_channel_config(cfg, cid, _requirements(asset="0x" + "99" * 20))
        assert result == ERR_TOKEN_MISMATCH

    def test_withdraw_delay_mismatch_when_extra_provided(self):
        cfg, cid = self._config_with_id()
        result = validate_channel_config(cfg, cid, _requirements(withdraw_delay=3600))
        assert result == ERR_WITHDRAW_DELAY_MISMATCH

    def test_withdraw_delay_below_min(self):
        cfg = _channel_config(withdraw_delay=MIN_WITHDRAW_DELAY - 1)
        cid = compute_channel_id(cfg, NETWORK)
        result = validate_channel_config(cfg, cid, _requirements())
        assert result == ERR_WITHDRAW_DELAY_OUT_OF_RANGE

    def test_withdraw_delay_above_max(self):
        cfg = _channel_config(withdraw_delay=MAX_WITHDRAW_DELAY + 1)
        cid = compute_channel_id(cfg, NETWORK)
        result = validate_channel_config(cfg, cid, _requirements())
        assert result == ERR_WITHDRAW_DELAY_OUT_OF_RANGE
