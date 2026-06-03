"""EIP-712 utilities for the batch-settlement EVM scheme."""

from __future__ import annotations

from typing import Any

try:
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak, to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from ..utils import get_evm_chain_id
from .constants import (
    BATCH_SETTLEMENT_ADDRESS,
    BATCH_SETTLEMENT_DOMAIN_NAME,
    BATCH_SETTLEMENT_DOMAIN_VERSION,
    CHANNEL_CONFIG_TYPES,
)
from .types import ChannelConfig


def get_batch_settlement_eip712_domain(chain_id: int) -> dict[str, Any]:
    """Return the EIP-712 domain for a given chain.

    Args:
        chain_id: Numeric EVM chain id.

    Returns:
        Dict with `name`, `version`, `chainId`, `verifyingContract`.
    """
    return {
        "name": BATCH_SETTLEMENT_DOMAIN_NAME,
        "version": BATCH_SETTLEMENT_DOMAIN_VERSION,
        "chainId": chain_id,
        "verifyingContract": to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
    }


def _resolve_chain_id(network_or_chain_id: str | int) -> int:
    if isinstance(network_or_chain_id, int):
        return network_or_chain_id
    return get_evm_chain_id(network_or_chain_id)


def _channel_config_message(config: ChannelConfig) -> dict[str, Any]:
    return {
        "payer": to_checksum_address(config.payer),
        "payerAuthorizer": to_checksum_address(config.payer_authorizer)
        if int(config.payer_authorizer, 16) != 0
        else "0x0000000000000000000000000000000000000000",
        "receiver": to_checksum_address(config.receiver),
        "receiverAuthorizer": to_checksum_address(config.receiver_authorizer),
        "token": to_checksum_address(config.token),
        "withdrawDelay": int(config.withdraw_delay),
        "salt": coerce_bytes32(config.salt),
    }


def coerce_bytes32(value: str | bytes) -> bytes:
    """Validate and decode a bytes32 input."""
    if isinstance(value, bytes):
        if len(value) != 32:
            raise ValueError(f"bytes32 must be 32 bytes, got {len(value)}")
        return value
    raw = value.removeprefix("0x")
    if len(raw) != 64:
        raise ValueError(f"bytes32 hex must be 64 chars, got {len(raw)}")
    return bytes.fromhex(raw)


def compute_channel_id(config: ChannelConfig, network_or_chain_id: str | int) -> str:
    """Compute the chain-bound channel id for a `ChannelConfig`.

    Args:
        config: Immutable channel configuration.
        network_or_chain_id: CAIP-2 network identifier or numeric chain id.

    Returns:
        0x-prefixed bytes32 channel id.
    """
    chain_id = _resolve_chain_id(network_or_chain_id)
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = _channel_config_message(config)

    signable = encode_typed_data(
        domain_data=domain,
        message_types=CHANNEL_CONFIG_TYPES,
        message_data=message,
    )
    # SignableMessage: .version = b"\x01", .header = domainSeparator, .body = structHash.
    # EIP-712 digest is keccak(0x19 || 0x01 || domainSeparator || structHash).
    digest = keccak(b"\x19" + signable.version + signable.header + signable.body)
    return "0x" + digest.hex()


def channel_config_to_signing_message(config: ChannelConfig) -> dict[str, Any]:
    """Public helper exposing the EIP-712 message form of a ChannelConfig."""
    return _channel_config_message(config)


__all__ = [
    "get_batch_settlement_eip712_domain",
    "compute_channel_id",
    "channel_config_to_signing_message",
    "coerce_bytes32",
]
