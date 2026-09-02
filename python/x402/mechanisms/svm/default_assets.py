"""Default USD-pegged assets for SVM payment schemes.

Index 0 of each network list is the ``"$0.10"`` default. Extra entries enable
suffixed prices such as ``"1 USDT"`` via core ``parse_money``.
"""

from __future__ import annotations

from typing import TypedDict

from .constants import (
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    SOLANA_TESTNET_CAIP2,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
    USDC_TESTNET_ADDRESS,
    V1_TO_V2_NETWORK_MAP,
)


class SvmDefaultAsset(TypedDict):
    """Default stablecoin entry for SVM exact scheme."""

    asset: str
    decimals: int
    symbol: str
    token_program: str


DEFAULT_ASSETS: dict[str, list[SvmDefaultAsset]] = {
    SOLANA_MAINNET_CAIP2: [
        {
            "asset": USDC_MAINNET_ADDRESS,
            "decimals": 6,
            "symbol": "USDC",
            "token_program": TOKEN_PROGRAM_ADDRESS,
        },
        {
            "asset": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            "decimals": 6,
            "symbol": "USDT",
            "token_program": TOKEN_PROGRAM_ADDRESS,
        },
        {
            "asset": "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
            "decimals": 6,
            "symbol": "USDG",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
        {
            "asset": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
            "decimals": 6,
            "symbol": "PYUSD",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
        {
            "asset": "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
            "decimals": 6,
            "symbol": "CASH",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
    ],
    SOLANA_DEVNET_CAIP2: [
        {
            "asset": USDC_DEVNET_ADDRESS,
            "decimals": 6,
            "symbol": "USDC",
            "token_program": TOKEN_PROGRAM_ADDRESS,
        },
        {
            "asset": "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
            "decimals": 6,
            "symbol": "USDG",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
        {
            "asset": "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
            "decimals": 6,
            "symbol": "PYUSD",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
    ],
    SOLANA_TESTNET_CAIP2: [
        {
            "asset": USDC_TESTNET_ADDRESS,
            "decimals": 6,
            "symbol": "USDC",
            "token_program": TOKEN_PROGRAM_ADDRESS,
        },
        {
            "asset": "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
            "decimals": 6,
            "symbol": "USDG",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
        {
            "asset": "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
            "decimals": 6,
            "symbol": "PYUSD",
            "token_program": TOKEN_2022_PROGRAM_ADDRESS,
        },
    ],
}


def _resolve_network_key(network: str) -> str:
    """Map CAIP-2 or v1 name to a ``DEFAULT_ASSETS`` key (mirrors ``normalize_network``)."""
    if ":" in network:
        supported = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2]
        if network not in supported:
            raise ValueError(f"Unsupported SVM network: {network}")
        return network

    caip2_network = V1_TO_V2_NETWORK_MAP.get(network)
    if not caip2_network:
        raise ValueError(f"Unsupported SVM network: {network}")
    return caip2_network


def get_default_asset(network: str, symbol: str | None = None) -> SvmDefaultAsset:
    """Look up a default asset by network and optional ticker.

    Args:
        network: CAIP-2 or v1 network.
        symbol: Ticker; omit for the network default.

    Returns:
        Matching entry.

    Raises:
        ValueError: If network or ticker is unknown.
    """
    key = _resolve_network_key(network)
    assets = DEFAULT_ASSETS.get(key)
    if not assets:
        raise ValueError(f"No default asset configured for network {network}")
    if not symbol:
        return assets[0]
    normalized = symbol.upper()
    for entry in assets:
        if entry["symbol"].upper() == normalized:
            return entry
    raise ValueError(f"No {symbol} default asset configured for network {network}")


def find_default_asset(asset: str, network: str) -> SvmDefaultAsset | None:
    """Reverse lookup by mint address and network.

    Args:
        asset: Mint address from payment requirements.
        network: CAIP-2 or v1 network.

    Returns:
        Matching entry, or ``None``.
    """
    key = _resolve_network_key(network)
    assets = DEFAULT_ASSETS.get(key)
    if not assets:
        return None
    for entry in assets:
        if entry["asset"] == asset:
            return entry
    return None
