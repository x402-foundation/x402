"""Unit tests for batch-settlement EIP-712 utilities.

Mirrors go/mechanisms/evm/batch-settlement/utils_test.go.
"""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import (
        coerce_bytes32,
        compute_channel_id,
        get_batch_settlement_eip712_domain,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"


def _sample_config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token="0x5555555555555555555555555555555555555555",
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


class TestComputeChannelId:
    def test_deterministic(self):
        a = compute_channel_id(_sample_config(), NETWORK)
        b = compute_channel_id(_sample_config(), NETWORK)
        assert a == b
        assert a.startswith("0x") and len(a) == 66

    def test_distinct_salts_differ(self):
        a = compute_channel_id(_sample_config(), NETWORK)
        cfg2 = _sample_config()
        cfg2.salt = "0x" + "00" * 31 + "02"
        b = compute_channel_id(cfg2, NETWORK)
        assert a != b

    def test_distinct_withdraw_delay_differs(self):
        a = compute_channel_id(_sample_config(), NETWORK)
        cfg2 = _sample_config()
        cfg2.withdraw_delay = 901
        b = compute_channel_id(cfg2, NETWORK)
        assert a != b

    def test_distinct_chain_id_differs(self):
        cfg = _sample_config()
        a = compute_channel_id(cfg, "eip155:8453")
        b = compute_channel_id(cfg, "eip155:84532")
        assert a != b

    def test_accepts_integer_chain_id(self):
        cfg = _sample_config()
        a = compute_channel_id(cfg, NETWORK)
        b = compute_channel_id(cfg, 8453)
        assert a == b


class TestGetBatchSettlementEip712Domain:
    def test_fields(self):
        d = get_batch_settlement_eip712_domain(8453)
        assert d["name"] == "x402 Batch Settlement"
        assert d["version"] == "1"
        assert d["chainId"] == 8453
        # verifyingContract is the batch-settlement deployment.
        from x402.mechanisms.evm.batch_settlement.constants import (
            BATCH_SETTLEMENT_ADDRESS,
        )

        assert d["verifyingContract"].lower() == BATCH_SETTLEMENT_ADDRESS.lower()


class TestCoerceBytes32:
    def test_accepts_32_byte_hex(self):
        value = "0x" + "01" * 32
        out = coerce_bytes32(value)
        assert isinstance(out, bytes) and len(out) == 32

    def test_rejects_short_hex(self):
        # Unlike Go's hexToBytes32 which left-pads, the Python helper validates
        # length strictly. Document that by asserting it.
        with pytest.raises(ValueError):
            coerce_bytes32("0x01")

    def test_rejects_long_hex(self):
        with pytest.raises(ValueError):
            coerce_bytes32("0x" + "ab" * 33)

    def test_rejects_short_bytes(self):
        with pytest.raises(ValueError):
            coerce_bytes32(b"\x01")
