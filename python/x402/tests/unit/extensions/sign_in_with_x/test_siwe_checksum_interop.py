"""EIP-4361 requires the EIP-55 checksum on the SIWE address line.

Any other casing is a different message and a different EIP-191 digest.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from x402.extensions.sign_in_with_x import (
    SIWxVerifyOptions,
    create_siwx_payload,
    verify_siwx_signature,
)
from x402.extensions.sign_in_with_x.evm import format_siwe_message

pytest.importorskip("siwe")


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


async def _signed_payload_with_address(address_case: str):
    from eth_account import Account

    account = Account.create()
    info = {
        "domain": "api.example.com",
        "uri": "https://api.example.com/data",
        "version": "1",
        "chainId": "eip155:8453",
        "type": "eip191",
        "nonce": "abcdef12345678",
        "issuedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "resources": ["https://api.example.com/data"],
    }
    payload = await create_siwx_payload(info, account, info["uri"])
    hex_part = account.address[2:]
    address = "0x" + (hex_part.lower() if address_case == "lower" else hex_part.upper())
    return account.address, payload.model_copy(update={"address": address})


@pytest.mark.asyncio
@pytest.mark.parametrize("address_case", ["lower", "upper"])
async def test_verify_returns_checksummed_payer(address_case: str) -> None:
    checksummed, payload = await _signed_payload_with_address(address_case)
    assert payload.address != checksummed

    result = await verify_siwx_signature(payload)

    assert result.is_valid, result.invalid_message
    assert result.payer == checksummed


@pytest.mark.asyncio
@pytest.mark.parametrize("address_case", ["lower", "upper"])
async def test_verify_passes_checksummed_address_to_evm_verifier(address_case: str) -> None:
    checksummed, payload = await _signed_payload_with_address(address_case)
    seen: list[tuple[str, str]] = []

    async def verifier(*, address: str, message: str, signature: str) -> bool:
        seen.append((address, message))
        return True

    result = await verify_siwx_signature(payload, SIWxVerifyOptions(evm_verifier=verifier))

    assert result.is_valid
    assert result.payer == checksummed
    assert len(seen) == 1
    assert seen[0][0] == checksummed
    assert seen[0][1].split("\n")[1] == checksummed
