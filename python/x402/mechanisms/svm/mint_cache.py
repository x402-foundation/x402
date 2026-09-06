"""Helpers for caching immutable SPL mint metadata."""

from dataclasses import dataclass
from typing import Any

from solders.pubkey import Pubkey

from .constants import TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS


@dataclass(frozen=True)
class MintMetadata:
    """Stable fields needed to build SPL token transfers."""

    decimals: int
    token_program: Pubkey


MintMetadataCache = dict[tuple[str, str], MintMetadata]


def get_cached_mint_metadata(
    client: Any,
    network: str,
    mint: Pubkey,
    cache: MintMetadataCache,
) -> MintMetadata:
    """Get cached mint decimals and token program, fetching once per network/mint."""
    key = (network, str(mint))
    cached = cache.get(key)
    if cached:
        return cached

    mint_info = client.get_account_info(mint)
    if not mint_info.value:
        raise ValueError(f"Token mint not found: {mint}")

    mint_owner = str(mint_info.value.owner)
    if mint_owner == TOKEN_PROGRAM_ADDRESS:
        token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    elif mint_owner == TOKEN_2022_PROGRAM_ADDRESS:
        token_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)
    else:
        raise ValueError(f"Unknown token program: {mint_owner}")

    metadata = MintMetadata(
        decimals=mint_info.value.data[44],
        token_program=token_program,
    )
    cache[key] = metadata
    return metadata
