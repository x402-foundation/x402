"""Tests for the process-wide EVM asset-contract cache."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from x402.mechanisms.evm.asset_cache import (
    _MAX_ASSET_CONTRACT_CACHE_ENTRIES,
    DEFAULT_ASSET_CONTRACT_CACHE_TTL,
    _AssetContractCacheKey,
    _global_asset_contract_cache,
    reset_asset_contract_cache,
    start_asset_contract_check,
)
from x402.mechanisms.evm.constants import ERR_ASSET_NOT_DEPLOYED_CONTRACT

CACHE_TEST_ASSET = "0x00000000000000000000000000000000000000bb"


class _CountingCodeSigner:
    """Reports the asset as deployed and counts eth_getCode calls."""

    def __init__(self) -> None:
        self.calls = 0

    def get_code(self, address: str) -> bytes:
        self.calls += 1
        return b"\x60\x60"


def test_asset_contract_check_caches_positive_result() -> None:
    reset_asset_contract_cache()

    signer = _CountingCodeSigner()
    for _ in range(3):
        reason = start_asset_contract_check(signer, "eip155:84532", CACHE_TEST_ASSET).await_result()
        assert reason == ""

    assert signer.calls == 1, "only the first check should reach the RPC"


def test_asset_contract_check_without_await_does_not_cache() -> None:
    # A caller that never awaits must leave the cache untouched, so cache contents do not depend on
    # scheduling of the check relative to the caller.
    reset_asset_contract_cache()

    signer = _CountingCodeSigner()
    start_asset_contract_check(signer, "eip155:84532", CACHE_TEST_ASSET)

    reason = start_asset_contract_check(signer, "eip155:84532", CACHE_TEST_ASSET).await_result()
    assert reason == ""
    assert signer.calls == 1, "the abandoned check must not have populated the cache"


def test_asset_contract_cache_skips_empty_network() -> None:
    # An empty network cannot be cached: entries would otherwise collide across chains, where one
    # address can hold bytecode on one chain and nothing on another.
    reset_asset_contract_cache()

    signer = _CountingCodeSigner()
    for _ in range(2):
        start_asset_contract_check(signer, "", CACHE_TEST_ASSET).await_result()

    assert signer.calls == 2, "an empty network must bypass the cache"
    assert not _global_asset_contract_cache.is_fresh(
        _AssetContractCacheKey(asset=CACHE_TEST_ASSET), datetime.now(timezone.utc)
    )


def test_asset_contract_cache_entries_expire() -> None:
    reset_asset_contract_cache()

    key = _AssetContractCacheKey(network="eip155:84532", asset=CACHE_TEST_ASSET)
    start = datetime.now(timezone.utc)
    _global_asset_contract_cache.record(key, start)

    assert _global_asset_contract_cache.is_fresh(
        key, start + DEFAULT_ASSET_CONTRACT_CACHE_TTL - timedelta(seconds=1)
    )
    assert not _global_asset_contract_cache.is_fresh(
        key, start + DEFAULT_ASSET_CONTRACT_CACHE_TTL + timedelta(seconds=1)
    )


def test_asset_contract_cache_does_not_cache_negative_result() -> None:
    reset_asset_contract_cache()

    class _FlipCodeSigner:
        def __init__(self) -> None:
            self.calls = 0
            self.code = b""

        def get_code(self, address: str) -> bytes:
            self.calls += 1
            return self.code

    signer = _FlipCodeSigner()
    reason = start_asset_contract_check(signer, "eip155:84532", CACHE_TEST_ASSET).await_result()
    assert reason == ERR_ASSET_NOT_DEPLOYED_CONTRACT
    assert signer.calls == 1

    signer.code = b"\x60\x60"
    reason = start_asset_contract_check(signer, "eip155:84532", CACHE_TEST_ASSET).await_result()
    assert reason == ""
    assert signer.calls == 2, "a negative result must not be reused within the TTL"


def test_asset_contract_cache_is_bounded() -> None:
    # The cache is keyed partly by caller-supplied asset addresses, so it must not grow without
    # bound when many distinct deployed contracts are named within one TTL window.
    reset_asset_contract_cache()

    now = datetime.now(timezone.utc)
    for i in range(_MAX_ASSET_CONTRACT_CACHE_ENTRIES + 500):
        _global_asset_contract_cache.record(
            _AssetContractCacheKey(network="eip155:84532", asset=f"0x{i:040x}"),
            now,
        )

    with _global_asset_contract_cache._lock:
        size = len(_global_asset_contract_cache._expiries)

    assert size <= _MAX_ASSET_CONTRACT_CACHE_ENTRIES
