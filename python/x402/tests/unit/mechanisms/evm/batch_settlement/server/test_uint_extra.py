"""Canonical parsing of facilitator-reported uint values (``totalClaimed``) on the server."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.server.verify import _read_required_uint_extra
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)

MAX_SAFE_INTEGER = 2**53 - 1


def _read(value):
    return _read_required_uint_extra({"totalClaimed": value}, "totalClaimed")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("0", "0"),
        ("500", "500"),
        ("340282366920938463463374607431768211455", "340282366920938463463374607431768211455"),
        (0, "0"),
        (500, "500"),
        (MAX_SAFE_INTEGER, str(MAX_SAFE_INTEGER)),
    ],
)
def test_accepts_canonical_values(value, expected):
    assert _read(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "007",
        "00",
        "+5",
        "-1",
        "-0",
        "",
        " 5",
        "5\n",
        "1.5",
        "٣",
        MAX_SAFE_INTEGER + 1,
        10**30,
        -1,
        1.5,
        True,
        False,
        None,
    ],
)
def test_rejects_non_canonical_values(value):
    assert _read(value) is None


def test_rejects_missing_key():
    assert _read_required_uint_extra({}, "totalClaimed") is None
