"""ERC-6492 signature parsing utilities."""

try:
    from eth_abi import decode
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .constants import ERC6492_MAGIC_VALUE
from .types import ERC6492SignatureData


def is_erc6492_signature(signature: bytes) -> bool:
    """Check if signature has ERC-6492 magic suffix.

    ERC-6492 signatures end with 32-byte magic value.

    Args:
        signature: Signature bytes.

    Returns:
        True if signature is ERC-6492 wrapped.
    """
    if len(signature) < 32:
        return False
    return signature[-32:] == ERC6492_MAGIC_VALUE


def parse_erc6492_signature(signature: bytes) -> ERC6492SignatureData:
    """Parse ERC-6492 wrapped signature.

    ERC-6492 Format:
        abi.encode((address factory, bytes factoryCalldata, bytes signature)) + magicBytes

    If not ERC-6492, returns original signature as inner_signature
    with empty factory/calldata.

    Args:
        signature: Signature bytes (may or may not be ERC-6492).

    Returns:
        Parsed signature data.

    Raises:
        ValueError: If ERC-6492 format is invalid.
    """
    if not is_erc6492_signature(signature):
        return ERC6492SignatureData(
            factory=bytes(20),
            factory_calldata=b"",
            inner_signature=signature,
        )

    # Strip magic value
    payload = signature[:-32]

    # Decode ABI: (address, bytes, bytes)
    try:
        factory, factory_calldata, inner_signature = decode(
            ["address", "bytes", "bytes"],
            payload,
        )

        # Convert factory address to bytes
        if isinstance(factory, str):
            factory_bytes = bytes.fromhex(factory.removeprefix("0x"))
        else:
            factory_bytes = factory

        return ERC6492SignatureData(
            factory=factory_bytes,
            factory_calldata=factory_calldata,
            inner_signature=inner_signature,
        )
    except Exception as e:
        raise ValueError(f"Invalid ERC-6492 signature format: {e}") from e


def is_eoa_signature(sig_data: ERC6492SignatureData) -> bool:
    """Check if signature is from an EOA (65 bytes, no factory).

    Args:
        sig_data: Parsed signature data.

    Returns:
        True if EOA signature.
    """
    zero_factory = bytes(20)
    return len(sig_data.inner_signature) == 65 and sig_data.factory == zero_factory


def has_deployment_info(sig_data: ERC6492SignatureData) -> bool:
    """Check if signature has smart wallet deployment info.

    Args:
        sig_data: Parsed signature data.

    Returns:
        True if has factory and calldata for deployment.
    """
    zero_factory = bytes(20)
    return sig_data.factory != zero_factory and len(sig_data.factory_calldata) > 0
