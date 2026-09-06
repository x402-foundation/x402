"""Default USD-pegged assets for TVM payment schemes.

Index 0 of each network list is the ``"$0.10"`` default.
"""

from __future__ import annotations

from typing import TypedDict

from .codecs.common import normalize_address
from .constants import (
    DEFAULT_DECIMALS,
    TVM_MAINNET,
    TVM_TESTNET,
    USDT_MAINNET_MINTER,
    USDT_TESTNET_MINTER,
)


class TvmDefaultAsset(TypedDict):
    """Default stablecoin entry for TVM exact scheme."""

    asset: str
    decimals: int
    symbol: str


DEFAULT_ASSETS: dict[str, list[TvmDefaultAsset]] = {
    TVM_MAINNET: [
        {"asset": USDT_MAINNET_MINTER, "decimals": DEFAULT_DECIMALS, "symbol": "USDT"},
    ],
    TVM_TESTNET: [
        {"asset": USDT_TESTNET_MINTER, "decimals": DEFAULT_DECIMALS, "symbol": "USDT"},
    ],
}


def get_default_asset(network: str, symbol: str | None = None) -> TvmDefaultAsset:
    """Look up a default asset by network and optional ticker.

    Args:
        network: CAIP-2 network.
        symbol: Ticker; omit for the network default.

    Returns:
        Matching entry.

    Raises:
        ValueError: If network or ticker is unknown.
    """
    assets = DEFAULT_ASSETS.get(network)
    if not assets:
        raise ValueError(f"No default asset configured for network {network}")
    if not symbol:
        return assets[0]
    normalized = symbol.upper()
    for entry in assets:
        if entry["symbol"].upper() == normalized:
            return entry
    raise ValueError(f"No {symbol} default asset configured for network {network}")


def find_default_asset(asset: str, network: str) -> TvmDefaultAsset | None:
    """Reverse lookup by asset id (via ``normalize_address``) and network.

    Args:
        asset: Jetton master from payment requirements.
        network: CAIP-2 network.

    Returns:
        Matching entry, or ``None``.
    """
    assets = DEFAULT_ASSETS.get(network)
    if not assets:
        return None
    normalized = normalize_address(asset)
    for entry in assets:
        if normalize_address(entry["asset"]) == normalized:
            return entry
    return None
