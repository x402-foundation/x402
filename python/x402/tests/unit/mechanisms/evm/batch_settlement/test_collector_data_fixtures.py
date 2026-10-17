"""Compare Python collector ABI encoding with static viem 2.48.11 fixtures.

L2.5-L2.8 cover the ERC-3009 nonce and collector data, EIP-2612 permit
segment, and Permit2 collector data. See the fixture directory's
COLLECTOR_DATA.md for provenance and independent regeneration instructions.
These tests do not execute the TypeScript SDK or require #2489.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.encoding import (
        build_eip2612_permit_data,
        build_erc3009_collector_data,
        build_erc3009_deposit_nonce,
        build_permit2_collector_data,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


# Path: this test file lives at
#   python/x402/tests/unit/mechanisms/evm/batch_settlement/test_collector_data_fixtures.py
# parents[4] resolves to `python/x402/tests/`, then we append the fixture path.
FIXTURE_DIR = Path(__file__).parents[4] / "fixtures" / "batch-settlement-byte-equivalence" / "v0"


FIXTURE_NAMES = [
    "L2.5-erc3009-deposit-nonce",
    "L2.6-erc3009-collector-data",
    "L2.7-eip2612-permit-data",
    "L2.8-permit2-collector-data",
]


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text())


def _normalize_to_bytes(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        return value
    s = value[2:] if value.startswith(("0x", "0X")) else value
    return bytes.fromhex(s)


def _python_encoding_for(fixture: dict[str, Any]) -> str | bytes:
    """Dispatch to the Python helper matching the fixture's ``function`` field."""
    fn = fixture["function"]
    inp = fixture["input"]

    if fn == "build_erc3009_deposit_nonce":
        return build_erc3009_deposit_nonce(inp["channelId"], inp["salt"])
    if fn == "build_erc3009_collector_data":
        return build_erc3009_collector_data(
            inp["validAfter"],
            inp["validBefore"],
            inp["salt"],
            inp["signature"],
        )
    if fn == "build_eip2612_permit_data":
        return build_eip2612_permit_data(
            inp["value"],
            inp["deadline"],
            inp["v"],
            inp["r"],
            inp["s"],
        )
    if fn == "build_permit2_collector_data":
        return build_permit2_collector_data(
            inp["nonce"],
            inp["deadline"],
            inp["permit2Signature"],
            inp["eip2612PermitData"],
        )
    raise AssertionError(f"unknown function in fixture: {fn}")


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_collector_byte_equivalence(name: str) -> None:
    fixture = _load_fixture(name)
    expected_hex = fixture["expected_bytes"]
    assert expected_hex.startswith("0x"), f"{name}: expected_bytes must be 0x-prefixed"
    expected_bytes = _normalize_to_bytes(expected_hex)

    actual = _python_encoding_for(fixture)
    actual_bytes = _normalize_to_bytes(actual)
    assert actual_bytes == expected_bytes, (
        f"{name}: Python SDK encoding does not match the viem reference fixture.\n"
        f"  expected (viem): {expected_hex}\n"
        f"  actual (Py):   0x{actual_bytes.hex()}"
    )


def test_all_fixture_files_present() -> None:
    """Guard: every entry in FIXTURE_NAMES has a matching JSON file."""
    for name in FIXTURE_NAMES:
        path = FIXTURE_DIR / f"{name}.json"
        assert path.exists(), f"missing fixture: {path}"


def test_fixture_dir_exists() -> None:
    """Guard against accidental relocation: the fixture directory must resolve."""
    assert FIXTURE_DIR.is_dir(), f"fixture directory missing: {FIXTURE_DIR}"
