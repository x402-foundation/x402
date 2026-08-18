"""Default USD-pegged assets for EVM payment schemes.

Index 0 of each network list is the ``"$0.10"`` default. Extra entries enable
suffixed prices such as ``"1 USDT"`` via core ``parse_money``.
"""

from __future__ import annotations

from typing import TypedDict

from .v1.constants import V1_NETWORK_CHAIN_IDS


class _ExactDefaultAssetInfoRequired(TypedDict):
    asset: str
    name: str
    version: str
    decimals: int
    symbol: str


class ExactDefaultAssetInfo(_ExactDefaultAssetInfoRequired, total=False):
    """Default stablecoin entry for EVM exact/upto/batch-settlement schemes."""

    asset_transfer_method: str
    supports_eip2612: bool


DEFAULT_ASSETS: dict[str, list[ExactDefaultAssetInfo]] = {
    "eip155:8453": [
        {
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Base mainnet USDC
    "eip155:84532": [
        {
            "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Base Sepolia USDC
    "eip155:4326": [
        {
            "asset": "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
            "name": "MegaUSD",
            "version": "1",
            "decimals": 18,
            "symbol": "MegaUSD",
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    ],  # MegaETH mainnet MegaUSD (no EIP-3009, supports EIP-2612)
    "eip155:143": [
        {
            "asset": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Monad mainnet USDC
    "eip155:988": [
        {
            "asset": "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
            "name": "USDT0",
            "version": "1",
            "decimals": 6,
            "symbol": "USDT0",
        },
    ],  # Stable mainnet USDT0
    "eip155:2201": [
        {
            "asset": "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9",
            "name": "USDT0",
            "version": "1",
            "decimals": 6,
            "symbol": "USDT0",
        },
    ],  # Stable testnet USDT0
    "eip155:137": [
        {
            "asset": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Polygon mainnet USDC
    "eip155:42161": [
        {
            "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Arbitrum One USDC
    "eip155:421614": [
        {
            "asset": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Arbitrum Sepolia USDC
    "eip155:31612": [
        {
            "asset": "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
            "name": "Mezo USD",
            "version": "1",
            "decimals": 18,
            "symbol": "mUSD",
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    ],  # Mezo mainnet mUSD (no EIP-3009, supports EIP-2612)
    "eip155:31611": [
        {
            "asset": "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
            "name": "Mezo USD",
            "version": "1",
            "decimals": 18,
            "symbol": "mUSD",
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    ],  # Mezo Testnet mUSD (no EIP-3009, supports EIP-2612)
    "eip155:723487": [
        {
            "asset": "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb",
            "name": "Stable Coin",
            "version": "1",
            "decimals": 6,
            "symbol": "SBC",
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    ],  # Radius Network SBC (no EIP-3009, supports EIP-2612)
    "eip155:72344": [
        {
            "asset": "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb",
            "name": "Stable Coin",
            "version": "1",
            "decimals": 6,
            "symbol": "SBC",
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    ],  # Radius Testnet SBC (no EIP-3009, supports EIP-2612)
    "eip155:36900": [
        {
            "asset": "0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2",
            "name": "USDC.e",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC.e",
        },
    ],  # ADI Chain USDC.e (EIP-3009 supported)
    "eip155:190415": [
        {
            "asset": "0x401eCb1D350407f13ba348573E5630B83638E30D",
            "name": "Bridged USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC.e",
        },
    ],  # HPP mainnet USDC.e
    "eip155:181228": [
        {
            "asset": "0x401eCb1D350407f13ba348573E5630B83638E30D",
            "name": "Bridged USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC.e",
        },
    ],  # HPP Sepolia USDC.e
    "eip155:50": [
        {
            "asset": "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # XDC Network mainnet USDC (Bridged USDC Standard, EIP-3009 supported)
    "eip155:51": [
        {
            "asset": "0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # XDC Apothem testnet USDC (Bridged USDC Standard, EIP-3009 supported)
    "eip155:38833": [
        {
            "asset": "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7",
            "name": "USDC",
            "version": "1",
            "decimals": 6,
            "symbol": "USDC",
            "asset_transfer_method": "permit2",
        },
    ],  # Igra mainnet USDC (no EIP-3009, no EIP-2612)
    "eip155:14": [
        {
            "asset": "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
            "name": "USD\u20ae0",
            "version": "1",
            "decimals": 6,
            "symbol": "USDT0",
        },
    ],  # Flare mainnet USD₮0 (EIP-3009 supported)
    "eip155:42220": [
        {
            "asset": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Celo mainnet USDC (EIP-3009 supported)
    "eip155:11142220": [
        {
            "asset": "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
            "symbol": "USDC",
        },
    ],  # Celo Sepolia testnet USDC (EIP-3009 supported)
}


def _resolve_network_key(network: str) -> str:
    """Map CAIP-2 or v1 legacy name to a ``DEFAULT_ASSETS`` key."""
    if network in DEFAULT_ASSETS:
        return network
    chain_id = V1_NETWORK_CHAIN_IDS.get(network)
    if chain_id is not None:
        return f"eip155:{chain_id}"
    return network


def get_default_asset(network: str, symbol: str | None = None) -> ExactDefaultAssetInfo:
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


def find_default_asset(asset: str, network: str) -> ExactDefaultAssetInfo | None:
    """Reverse lookup by asset id (case-insensitive) and network.

    Args:
        asset: Asset address from payment requirements.
        network: CAIP-2 or v1 network.

    Returns:
        Matching entry, or ``None``.
    """
    key = _resolve_network_key(network)
    assets = DEFAULT_ASSETS.get(key)
    if not assets:
        return None
    normalized = asset.lower()
    for entry in assets:
        if entry["asset"].lower() == normalized:
            return entry
    return None
