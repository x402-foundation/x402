"""ABI-encoding helpers for the batch-settlement deposit collectors."""

from __future__ import annotations

try:
    from eth_abi import encode as abi_encode
    from eth_utils import keccak
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e


def _to_int(hex_or_int: str | int) -> int:
    if isinstance(hex_or_int, int):
        return hex_or_int
    s = hex_or_int.strip()
    if s.startswith("0x") or s.startswith("0X"):
        return int(s, 16)
    return int(s)


def _to_bytes(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        return value
    return bytes.fromhex(value.removeprefix("0x"))


def build_erc3009_deposit_nonce(channel_id: str, salt: str) -> str:
    """Compute the ERC-3009 nonce used by the deposit collector.

    `keccak256(abi.encode(bytes32 channelId, uint256 salt))`

    Args:
        channel_id: 0x-prefixed bytes32 channel id.
        salt: Random per-deposit salt (hex string of 32 bytes).

    Returns:
        0x-prefixed bytes32 nonce.
    """
    encoded = abi_encode(["bytes32", "uint256"], [_to_bytes(channel_id), _to_int(salt)])
    return "0x" + keccak(encoded).hex()


def build_erc3009_collector_data(
    valid_after: str,
    valid_before: str,
    salt: str,
    signature: str,
) -> bytes:
    """Encode `collectorData` for `ERC3009DepositCollector.collect()`.

    `abi.encode(uint256 validAfter, uint256 validBefore, uint256 salt, bytes signature)`
    """
    return abi_encode(
        ["uint256", "uint256", "uint256", "bytes"],
        [
            _to_int(valid_after),
            _to_int(valid_before),
            _to_int(salt),
            _to_bytes(signature),
        ],
    )


def build_eip2612_permit_data(
    value: str,
    deadline: str,
    v: int,
    r: str,
    s: str,
) -> bytes:
    """Encode an optional EIP-2612 permit segment for `Permit2DepositCollector`.

    `abi.encode(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`
    """
    return abi_encode(
        ["uint256", "uint256", "uint8", "bytes32", "bytes32"],
        [_to_int(value), _to_int(deadline), int(v), _to_bytes(r), _to_bytes(s)],
    )


def build_permit2_collector_data(
    nonce: str,
    deadline: str,
    permit2_signature: str,
    eip2612_permit_data: bytes | str = b"",
) -> bytes:
    """Encode `collectorData` for `Permit2DepositCollector.collect()`.

    `abi.encode(uint256 nonce, uint256 deadline, bytes permit2Sig, bytes eip2612Permit)`
    """
    if isinstance(eip2612_permit_data, str):
        eip2612 = _to_bytes(eip2612_permit_data) if eip2612_permit_data else b""
    else:
        eip2612 = eip2612_permit_data

    return abi_encode(
        ["uint256", "uint256", "bytes", "bytes"],
        [_to_int(nonce), _to_int(deadline), _to_bytes(permit2_signature), eip2612],
    )


__all__ = [
    "build_erc3009_deposit_nonce",
    "build_erc3009_collector_data",
    "build_eip2612_permit_data",
    "build_permit2_collector_data",
]
