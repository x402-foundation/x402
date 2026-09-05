"""Process-wide cache of positive EVM asset-contract checks."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock

from .constants import ERR_ASSET_NOT_DEPLOYED_CONTRACT
from .signer import FacilitatorEvmSigner
from .utils import normalize_address

# Bounds how long a positive asset-contract check is reused.
DEFAULT_ASSET_CONTRACT_CACHE_TTL = timedelta(minutes=15)

# Bounds the cache so callers naming many distinct deployed contracts cannot grow it
# without limit. A facilitator serves few assets per chain.
_MAX_ASSET_CONTRACT_CACHE_ENTRIES = 4096


@dataclass(frozen=True)
class _AssetContractCacheKey:
    network: str = ""
    asset: str = ""


class _AssetContractCache:
    """Memoizes "this asset address has bytecode" per network.

    Process-wide because validate_asset_is_contract is a free function shared by every
    EVM facilitator scheme.

    Only positive results are stored: a negative result may be a token observed
    mid-deployment, which has to self-heal on the next request.
    """

    def __init__(self, ttl: timedelta) -> None:
        self._lock = Lock()
        self._ttl = ttl
        self._expiries: dict[_AssetContractCacheKey, datetime] = {}

    def is_fresh(self, key: _AssetContractCacheKey, now: datetime) -> bool:
        """Report whether an unexpired positive result is cached.

        An empty network is never cached, since entries would otherwise collide
        across chains where one address can hold bytecode on one chain and nothing
        on another.
        """
        if key.network == "":
            return False

        with self._lock:
            expiry = self._expiries.get(key)
            return expiry is not None and now < expiry

    def record(self, key: _AssetContractCacheKey, now: datetime) -> None:
        if key.network == "":
            return

        with self._lock:
            expired = [existing for existing, expiry in self._expiries.items() if now > expiry]
            for existing in expired:
                del self._expiries[existing]
            if (
                key not in self._expiries
                and len(self._expiries) >= _MAX_ASSET_CONTRACT_CACHE_ENTRIES
            ):
                return
            self._expiries[key] = now + self._ttl


_global_asset_contract_cache = _AssetContractCache(ttl=DEFAULT_ASSET_CONTRACT_CACHE_TTL)


def reset_asset_contract_cache() -> None:
    """Clear the process-wide asset-contract cache.

    For tests that assert on eth_getCode call counts across cases sharing an asset address.
    """
    with _global_asset_contract_cache._lock:
        _global_asset_contract_cache._expiries = {}


class AssetContractCheck:
    """An asset-contract check whose result is delivered by await_result."""

    def __init__(self, signer: FacilitatorEvmSigner, network: str, asset: str) -> None:
        self._signer = signer
        self._network = network
        self._asset = asset

    def await_result(self) -> str:
        """Return the check's result, caching a positive one for DEFAULT_ASSET_CONTRACT_CACHE_TTL.

        Recording on await_result rather than when the check is started keeps cache contents
        independent of an early return: a check that is never awaited cannot publish a result
        and does not issue eth_getCode.
        """
        reason = validate_asset_is_contract(self._signer, self._network, self._asset)
        if reason == "":
            _global_asset_contract_cache.record(
                _AssetContractCacheKey(network=self._network, asset=normalize_address(self._asset)),
                datetime.now(timezone.utc),
            )
        return reason


def validate_asset_is_contract(
    signer: FacilitatorEvmSigner,
    network: str,
    asset: str,
) -> str:
    """Check whether the payment asset is a deployed contract.

    Returns ERR_ASSET_NOT_DEPLOYED_CONTRACT for an EOA/empty address,
    "" for a deployed contract, or raises if eth_getCode itself fails.

    network identifies the chain the signer is bound to. It must be accurate, since it scopes the
    cache that serves positive results; an empty network disables caching for the call. Only
    start_asset_contract_check populates that cache, so calling this directly always hits the RPC.
    """
    normalized_asset = normalize_address(asset)
    if _global_asset_contract_cache.is_fresh(
        _AssetContractCacheKey(network=network, asset=normalized_asset),
        datetime.now(timezone.utc),
    ):
        return ""

    try:
        code = signer.get_code(normalized_asset)
    except Exception as exc:
        raise RuntimeError(f"failed to check whether asset is a contract: {exc}") from exc
    if len(code) == 0:
        return ERR_ASSET_NOT_DEPLOYED_CONTRACT
    return ""


def start_asset_contract_check(
    signer: FacilitatorEvmSigner,
    network: str,
    asset: str,
) -> AssetContractCheck:
    """Create an asset-contract check. The RPC and cache write happen in await_result."""
    return AssetContractCheck(signer=signer, network=network, asset=asset)
