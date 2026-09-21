"""Default USD-pegged assets for Cardano payment schemes."""

from typing import TypedDict

from .constants import (
    CARDANO_MAINNET_CAIP2,
    CARDANO_PREPROD_CAIP2,
    USDM_DEFAULT_DECIMALS,
    USDM_MAINNET_ASSET,
    USDM_PREPROD_ASSET,
    normalize_cardano_network,
)


class CardanoDefaultAsset(TypedDict):
    asset: str
    decimals: int
    symbol: str


DEFAULT_ASSETS: dict[str, list[CardanoDefaultAsset]] = {
    CARDANO_MAINNET_CAIP2: [
        {"asset": USDM_MAINNET_ASSET, "decimals": USDM_DEFAULT_DECIMALS, "symbol": "USDM"},
    ],
    CARDANO_PREPROD_CAIP2: [
        {"asset": USDM_PREPROD_ASSET, "decimals": USDM_DEFAULT_DECIMALS, "symbol": "USDM"},
    ],
}


def get_default_asset(network: str, symbol: str | None = None) -> CardanoDefaultAsset:
    """Look up the default stablecoin, optionally by ticker."""
    assets = DEFAULT_ASSETS.get(normalize_cardano_network(network))
    if not assets:
        raise ValueError(f"No default asset configured for network {network}")
    if not symbol:
        return assets[0]
    for entry in assets:
        if entry["symbol"].upper() == symbol.upper():
            return entry
    raise ValueError(f"No {symbol} default asset configured for network {network}")


def find_default_asset(asset: str, network: str) -> CardanoDefaultAsset | None:
    """Reverse lookup used by the core client's spend controls."""
    for entry in DEFAULT_ASSETS.get(normalize_cardano_network(network), []):
        if entry["asset"].lower() == asset.lower():
            return entry
    return None
