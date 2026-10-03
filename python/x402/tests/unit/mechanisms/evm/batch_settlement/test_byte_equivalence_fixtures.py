"""Cross-language byte-equivalence verification for batch-settlement EIP-712 digests.

Each JSON fixture under ``tests/fixtures/batch-settlement-byte-equivalence/v0/``
was produced by the TS-side ``_generator.ts`` (using ``viem.hashTypedData``) and
records the input plus the ``expected_digest``. This module re-computes the
digest via the Python SDK and asserts byte-for-byte equivalence.

A failure here means TS SDK / Python SDK / spec drift has been introduced and
the silent corruption invariant (``ecrecover`` returning a different signer
between the two implementations) is no longer prevented.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.constants import (
        BATCH_SETTLEMENT_ADDRESS,
        BATCH_SETTLEMENT_DOMAIN_NAME,
        BATCH_SETTLEMENT_DOMAIN_VERSION,
    )
    from x402.mechanisms.evm.batch_settlement.digest import (
        compute_channel_config_digest,
        compute_claim_batch_digest,
        compute_refund_digest,
        compute_voucher_digest,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


def _assert_fixture_domain_matches_python(fixture: dict[str, Any]) -> None:
    """Defense-in-depth: fixture-recorded domain matches Python SDK constants.

    The byte-equivalence assertion below catches any drift at the digest layer,
    but explicit domain crosscheck gives more actionable failure messages
    (e.g. ``domain.name drifted`` vs the bare ``digest mismatch``).
    """
    d = fixture["domain"]
    assert d["name"] == BATCH_SETTLEMENT_DOMAIN_NAME, (
        f"fixture domain.name {d['name']!r} drifted from "
        f"BATCH_SETTLEMENT_DOMAIN_NAME {BATCH_SETTLEMENT_DOMAIN_NAME!r}"
    )
    assert d["version"] == BATCH_SETTLEMENT_DOMAIN_VERSION, (
        f"fixture domain.version {d['version']!r} drifted from "
        f"BATCH_SETTLEMENT_DOMAIN_VERSION {BATCH_SETTLEMENT_DOMAIN_VERSION!r}"
    )
    assert d["verifyingContract"].lower() == BATCH_SETTLEMENT_ADDRESS.lower(), (
        f"fixture domain.verifyingContract {d['verifyingContract']!r} drifted "
        f"from BATCH_SETTLEMENT_ADDRESS {BATCH_SETTLEMENT_ADDRESS!r}"
    )


# Path: this test file lives at
#   python/x402/tests/unit/mechanisms/evm/batch_settlement/test_byte_equivalence_fixtures.py
# parents[4] resolves to `python/x402/tests/`, then we append the fixture path.
FIXTURE_DIR = Path(__file__).parents[4] / "fixtures" / "batch-settlement-byte-equivalence" / "v0"


FIXTURE_NAMES = [
    "L2.1-channel-config",
    "L2.2-voucher",
    "L2.3-claim-batch",
    "L2.4-refund",
]


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text())


def _python_digest_for(fixture: dict[str, Any]) -> bytes:
    """Dispatch to the Python digest helper matching the fixture's primaryType."""
    primary = fixture["primaryType"]
    chain_id = int(fixture["domain"]["chainId"])
    inp = fixture["input"]

    if primary == "ChannelConfig":
        config = ChannelConfig(
            payer=inp["payer"],
            payer_authorizer=inp["payerAuthorizer"],
            receiver=inp["receiver"],
            receiver_authorizer=inp["receiverAuthorizer"],
            token=inp["token"],
            withdraw_delay=int(inp["withdrawDelay"]),
            salt=inp["salt"],
        )
        return compute_channel_config_digest(config, chain_id)
    if primary == "Voucher":
        return compute_voucher_digest(
            inp["channelId"],
            inp["maxClaimableAmount"],
            chain_id,
        )
    if primary == "Refund":
        return compute_refund_digest(
            inp["channelId"],
            inp["nonce"],
            inp["amount"],
            chain_id,
        )
    if primary == "ClaimBatch":
        return compute_claim_batch_digest(
            inp["claims"],
            chain_id,
        )
    raise AssertionError(f"unknown primaryType in fixture: {primary}")


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_byte_equivalence(name: str) -> None:
    fixture = _load_fixture(name)
    _assert_fixture_domain_matches_python(fixture)
    expected_hex = fixture["expected_digest"]
    assert expected_hex.startswith("0x"), f"{name}: expected_digest must be 0x-prefixed"
    expected_bytes = bytes.fromhex(expected_hex[2:])
    assert len(expected_bytes) == 32, f"{name}: expected_digest must decode to 32 bytes"

    actual_bytes = _python_digest_for(fixture)
    assert actual_bytes == expected_bytes, (
        f"{name}: Python SDK digest does not match TS-generated fixture.\n"
        f"  expected (TS): {expected_hex}\n"
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
