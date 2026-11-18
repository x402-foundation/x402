"""Tests for the TVM settlement cache."""

import pytest

pytest.importorskip("pytoniq_core")

from x402.mechanisms.tvm.settlement_cache import SettlementCache


def test_is_duplicate_rejects_duplicate_until_released() -> None:
    cache = SettlementCache()

    assert cache.is_duplicate("settlement-1", 300.0) is False
    assert cache.is_duplicate("settlement-1", 300.0) is True

    cache.release("settlement-1")

    assert cache.is_duplicate("settlement-1", 300.0) is False


def test_is_duplicate_prunes_expired_entries() -> None:
    cache = SettlementCache()

    assert cache.is_duplicate("settlement-1", 300.0) is False
    cache._entries["settlement-1"] -= 301.0

    assert cache.is_duplicate("settlement-1", 300.0) is False


def test_release_prunes_expired_entries_when_cache_is_otherwise_idle() -> None:
    cache = SettlementCache()

    assert cache.is_duplicate("expired-settlement", 300.0) is False
    assert cache.is_duplicate("active-settlement", 300.0) is False

    cache._entries["expired-settlement"] -= 301.0

    cache.release("missing-settlement")

    assert "expired-settlement" not in cache._entries
    assert "active-settlement" in cache._entries
