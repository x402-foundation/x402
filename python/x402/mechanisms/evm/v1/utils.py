"""V1 legacy network utilities for EVM mechanisms."""

from ..constants import AssetInfo
from ..default_assets import find_default_asset
from ..utils import _to_asset_info
from .constants import V1_NETWORK_CHAIN_IDS


def get_evm_chain_id(network: str) -> int:
    """Extract chain ID from a v1 legacy network name.

    Args:
        network: V1 network name (e.g., "base-sepolia", "polygon").

    Returns:
        Numeric chain ID.

    Raises:
        ValueError: If network is not a known v1 network.
    """
    if network in V1_NETWORK_CHAIN_IDS:
        return V1_NETWORK_CHAIN_IDS[network]

    raise ValueError(f"Unknown v1 network: {network}")


def get_asset_info(network: str, asset_address: str) -> AssetInfo:
    """Get asset info for a v1 network by legacy network name.

    Args:
        network: V1 legacy network name (e.g., "base", "polygon").
        asset_address: Asset contract address (0x...).

    Returns:
        Asset information.

    Raises:
        ValueError: If the network is not a v1 name, has no known default asset, or the
            address does not match the registered asset for the network.
    """
    if network not in V1_NETWORK_CHAIN_IDS:
        raise ValueError(f"Unknown v1 network: {network}")

    found = find_default_asset(asset_address, network)
    if found is None:
        raise ValueError(
            f"Token {asset_address} is not a registered asset for v1 network {network}."
        )
    return _to_asset_info(found)
