"""EIP-712 digest helpers for the batch-settlement EVM scheme.

These pure functions expose the raw 32-byte EIP-712 message digest for each
signing-time primitive: ``ChannelConfig``, ``Voucher``, ``Refund``, and
``ClaimBatch``. The internal computation mirrors ``compute_channel_id`` in
``.utils`` but returns the digest as ``bytes`` rather than a 0x-prefixed hex
string and covers all four signing surfaces in one module.

The existing ``compute_channel_id`` is kept as a thin wrapper over
``compute_channel_config_digest`` for the common case where the caller wants
the channelId as a wire-shape hex string.

Use cases beyond cross-language byte-equivalence testing:

- Client-side pre-computation of a digest before delegating signing to a
  hardware wallet or remote KMS.
- Debug / observability of EIP-712 wire payloads.
- Future Go / Java SDK conformance against shared JSON fixtures.
"""

from __future__ import annotations

from typing import Any

try:
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .constants import (
    CHANNEL_CONFIG_TYPES,
    CLAIM_BATCH_TYPES,
    REFUND_TYPES,
    VOUCHER_TYPES,
)
from .types import ChannelConfig
from .utils import (
    channel_config_to_signing_message,
    coerce_bytes32,
    get_batch_settlement_eip712_domain,
)


def _eip712_digest(
    domain: dict[str, Any],
    types: dict[str, list[dict[str, str]]],
    message: dict[str, Any],
) -> bytes:
    """Compute the EIP-712 32-byte digest from (domain, types, message).

    Internal helper. Mirrors the well-formed signing path in ``eth_account``:
    ``digest = keccak(0x19 || 0x01 || domainSeparator || structHash)``.
    """
    signable = encode_typed_data(
        domain_data=domain,
        message_types=types,
        message_data=message,
    )
    # SignableMessage exposes .version = b"\x01", .header = domainSeparator,
    # .body = structHash. The 0x19 prefix is prepended explicitly.
    return keccak(b"\x19" + signable.version + signable.header + signable.body)


def compute_channel_config_digest(config: ChannelConfig, chain_id: int) -> bytes:
    """Return the EIP-712 digest of a ``ChannelConfig`` (used as channelId).

    Returns the digest as raw 32 bytes. Callers that want the 0x-hex form
    should use ``compute_channel_id`` in ``.utils``, which wraps this function.

    Args:
        config: Immutable channel configuration.
        chain_id: Numeric EVM chain id (bound into the EIP-712 domain).
    """
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = channel_config_to_signing_message(config)
    return _eip712_digest(domain, CHANNEL_CONFIG_TYPES, message)


def compute_voucher_digest(
    channel_id: str | bytes,
    max_claimable_amount: int | str,
    chain_id: int,
) -> bytes:
    """Return the EIP-712 digest of a ``Voucher`` (channelId + maxClaimableAmount).

    Args:
        channel_id: 0x-prefixed hex string or raw 32 bytes.
        max_claimable_amount: Cumulative ceiling as int or numeric string.
        chain_id: Numeric EVM chain id.
    """
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = {
        "channelId": coerce_bytes32(channel_id),
        "maxClaimableAmount": int(max_claimable_amount),
    }
    return _eip712_digest(domain, VOUCHER_TYPES, message)


def compute_refund_digest(
    channel_id: str | bytes,
    nonce: int | str,
    amount: int | str,
    chain_id: int,
) -> bytes:
    """Return the EIP-712 digest of a ``Refund`` (channelId + nonce + amount).

    Args:
        channel_id: 0x-prefixed hex string or raw 32 bytes.
        nonce: Refund replay-protection nonce.
        amount: Refund amount (uint128 range).
        chain_id: Numeric EVM chain id.
    """
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = {
        "channelId": coerce_bytes32(channel_id),
        "nonce": int(nonce),
        "amount": int(amount),
    }
    return _eip712_digest(domain, REFUND_TYPES, message)


def compute_claim_batch_digest(
    claims: list[dict[str, Any]],
    chain_id: int,
) -> bytes:
    """Return the EIP-712 digest of a ``ClaimBatch`` (array of ClaimEntry).

    Args:
        claims: List of dicts, each with ``channelId`` (0x-hex or bytes),
            ``maxClaimableAmount`` (int or numeric string), and ``totalClaimed``
            (int or numeric string).
        chain_id: Numeric EVM chain id.
    """
    domain = get_batch_settlement_eip712_domain(chain_id)
    normalized_claims = [
        {
            "channelId": coerce_bytes32(c["channelId"]),
            "maxClaimableAmount": int(c["maxClaimableAmount"]),
            "totalClaimed": int(c["totalClaimed"]),
        }
        for c in claims
    ]
    message = {"claims": normalized_claims}
    return _eip712_digest(domain, CLAIM_BATCH_TYPES, message)


__all__ = [
    "compute_channel_config_digest",
    "compute_voucher_digest",
    "compute_refund_digest",
    "compute_claim_batch_digest",
]
