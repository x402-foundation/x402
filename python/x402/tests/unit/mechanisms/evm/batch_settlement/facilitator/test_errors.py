"""Wire-contract parity tests for batch-settlement error codes.

The error strings are part of the cross-SDK wire contract and must:
- Share the `invalid_batch_settlement_evm_` prefix.
- Be non-empty.
- Be unique.
"""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement import errors as err_mod
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


WIRE_PREFIX = "invalid_batch_settlement_evm_"


def _all_error_constants() -> dict[str, str]:
    out: dict[str, str] = {}
    for name in dir(err_mod):
        if not name.startswith("ERR_"):
            continue
        value = getattr(err_mod, name)
        if isinstance(value, str):
            out[name] = value
    return out


class TestErrorConstants:
    def test_module_has_error_constants(self):
        assert len(_all_error_constants()) > 0

    def test_all_constants_use_wire_prefix(self):
        for name, value in _all_error_constants().items():
            assert value.startswith(WIRE_PREFIX), f"{name} = {value!r}"

    def test_all_constants_are_non_empty(self):
        for name, value in _all_error_constants().items():
            assert value.strip() != "", f"{name} is empty"

    def test_all_constants_are_unique(self):
        consts = _all_error_constants()
        values = list(consts.values())
        assert len(values) == len(set(values))

    def test_known_codes_unchanged(self):
        """Sentinel values for codes that are particularly load-bearing on the wire."""
        assert err_mod.ERR_INVALID_SCHEME == "invalid_batch_settlement_evm_scheme"
        assert err_mod.ERR_NETWORK_MISMATCH == "invalid_batch_settlement_evm_network_mismatch"
        assert err_mod.ERR_INVALID_PAYLOAD_TYPE == "invalid_batch_settlement_evm_payload_type"
        assert (
            err_mod.ERR_CUMULATIVE_AMOUNT_MISMATCH
            == "invalid_batch_settlement_evm_cumulative_amount_mismatch"
        )
        assert (
            err_mod.ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED
            == "invalid_batch_settlement_evm_cumulative_below_claimed"
        )
