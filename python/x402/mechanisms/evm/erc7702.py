"""ERC-7702 delegation designation detection utilities.

NOTE: These helpers are diagnostic only. The signature-verification path does
not branch on 7702 detection — it routes by code.length via
`verify_typed_data_strict`, and the delegate's `isValidSignature` decides.
Use these for telemetry, logging, or surfacing wallet types in UIs.
"""

_ERC7702_PREFIX = b"\xef\x01\x00"
_ERC7702_LENGTH = 23  # 3-byte prefix + 20-byte delegate address


def is_erc7702_delegation(code: bytes) -> bool:
    """Return True if code is a valid ERC-7702 delegation designation.

    The designation is exactly 23 bytes: the prefix 0xef0100 followed by a
    20-byte delegate address. Length and prefix are both validated.
    """
    return len(code) == _ERC7702_LENGTH and code[:3] == _ERC7702_PREFIX


def get_erc7702_delegate_address(code: bytes) -> str | None:
    """Extract the delegate address from a 7702 delegation designation.

    Returns the address in **lowercase** hex with a ``0x`` prefix.
    The Go equivalent (``GetERC7702DelegateAddress``) returns a checksummed EIP-55 address.
    The TypeScript equivalent also returns lowercase. Normalise with
    ``eth_utils.to_checksum_address()`` when comparing cross-SDK outputs.
    Returns ``None`` if *code* is not a valid 7702 delegation.
    """
    if not is_erc7702_delegation(code):
        return None
    return "0x" + code[3:23].hex()
