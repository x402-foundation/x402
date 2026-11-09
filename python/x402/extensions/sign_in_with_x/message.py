"""CAIP-122 message construction for SIWX extension."""

from __future__ import annotations

from typing import Any

from .evm import format_siwe_message
from .solana import format_siws_message


def create_siwx_message(server_info: Any, address: str) -> str:
    """Construct CAIP-122 compliant message string for signing."""
    chain_id = server_info.chain_id if hasattr(server_info, "chain_id") else server_info["chainId"]
    if chain_id.startswith("eip155:"):
        return format_siwe_message(server_info, address)
    if chain_id.startswith("solana:"):
        return format_siws_message(server_info, address)
    raise ValueError(
        f"Unsupported chain namespace: {chain_id}. Supported: eip155:* (EVM), solana:* (Solana)"
    )
