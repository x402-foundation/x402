"""Cross-implementation interop: the EVM SIWE message must carry the EIP-55
checksummed address.

EIP-4361 requires the account line to be "conformant to capitalization encoded
checksum specified in EIP-55", and the TypeScript library
(@signinwithethereum/siwe) always checksums it. If this Python facilitator
rebuilds the message from a non-checksummed payload address without
checksumming, it produces a different message, a different EIP-191 hash, and
rejects an otherwise valid signature produced by a client using another
implementation.
"""

from __future__ import annotations

from x402.extensions.sign_in_with_x.evm import format_siwe_message


def test_format_siwe_message_checksums_address() -> None:
    checksummed = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    info = {
        "domain": "api.example.com",
        "uri": "https://api.example.com/data",
        "version": "1",
        "chainId": "eip155:8453",
        "nonce": "abcdef12345678",
        "issuedAt": "2024-01-01T00:00:00.000Z",
    }
    msg = format_siwe_message(info, checksummed.lower())
    address_line = msg.split("\n")[1]
    assert address_line == checksummed, (
        f"address line {address_line!r} is not EIP-55 checksummed {checksummed!r}"
    )
