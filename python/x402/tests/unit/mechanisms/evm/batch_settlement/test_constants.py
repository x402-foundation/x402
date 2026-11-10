"""Unit tests for batch-settlement constants.

Mirrors go/mechanisms/evm/batch-settlement/constants_test.go.

Checksums, the withdraw-delay ordering, the typehash derivation, unique
payload discriminators, and the error-code prefix are behavior. Literal
copies of the tables are not.
"""

from __future__ import annotations

import pytest

try:
    from eth_utils import keccak, to_checksum_address

    from x402.mechanisms.evm.batch_settlement import constants as C  # noqa: N812
    from x402.mechanisms.evm.batch_settlement import errors as E  # noqa: N812
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


class TestContractAddresses:
    @pytest.mark.parametrize(
        "address",
        [
            C.BATCH_SETTLEMENT_ADDRESS,
            C.ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
            C.PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
        ],
    )
    def test_address_is_checksum_hex(self, address: str):
        assert address.startswith("0x")
        assert len(address) == 42
        assert address == to_checksum_address(address)


class TestWithdrawDelayBounds:
    def test_min_lt_max(self):
        assert C.MIN_WITHDRAW_DELAY < C.MAX_WITHDRAW_DELAY


class TestChannelConfigType:
    def test_typehash_is_keccak_of_type_string(self):
        assert C.CHANNEL_CONFIG_TYPEHASH == keccak(text=C.CHANNEL_CONFIG_TYPE_STRING)


class TestPayloadTypeDiscriminators:
    def test_unique_values(self):
        values = {
            C.PAYLOAD_TYPE_DEPOSIT,
            C.PAYLOAD_TYPE_VOUCHER,
            C.PAYLOAD_TYPE_REFUND,
            C.PAYLOAD_TYPE_CLAIM,
            C.PAYLOAD_TYPE_SETTLE,
        }
        assert len(values) == 5


class TestErrorCodes:
    """Pin the canonical wire prefix for every error code."""

    WIRE_PREFIX = "invalid_batch_settlement_evm_"

    def test_all_err_constants_share_prefix(self):
        for name in dir(E):
            if not name.startswith("ERR_"):
                continue
            value = getattr(E, name)
            assert isinstance(value, str), name
            assert value.startswith(self.WIRE_PREFIX), (name, value)

    @pytest.mark.parametrize(
        "code",
        [
            E.ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
            E.ERR_CUMULATIVE_AMOUNT_MISMATCH,
            E.ERR_CHANNEL_BUSY,
            E.ERR_MISSING_CHANNEL,
            E.ERR_CHARGE_EXCEEDS_SIGNED_CUMULATIVE,
            E.ERR_REFUND_NO_BALANCE,
            E.ERR_REFUND_AMOUNT_INVALID,
            E.ERR_DEPOSIT_BELOW_MIN_DEPOSIT,
        ],
    )
    def test_documented_codes_present(self, code: str):
        assert code.startswith(self.WIRE_PREFIX)
