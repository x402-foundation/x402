"""Unit tests for batch-settlement digest helpers (`digest.py`).

Sanity + edge case coverage for the four pure EIP-712 digest functions:
- `compute_channel_config_digest`
- `compute_voucher_digest`
- `compute_refund_digest`
- `compute_claim_batch_digest`

Cross-language byte-equivalence vs. the TS SDK lives in
`test_byte_equivalence_fixtures.py`; this file covers Python-side invariants
only.
"""

from __future__ import annotations

import pytest

try:
    from eth_utils import keccak

    from x402.mechanisms.evm.batch_settlement.digest import (
        compute_channel_config_digest,
        compute_claim_batch_digest,
        compute_refund_digest,
        compute_voucher_digest,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


# Test vectors aligned with the existing test_channel.py mock pattern
TEST_CHAIN_ID = 84532  # Base Sepolia
PAYER_ADDR = "0x1111111111111111111111111111111111111111"
RECEIVER_ADDR = "0x3333333333333333333333333333333333333333"
RECEIVER_AUTHORIZER_ADDR = "0x4444444444444444444444444444444444444444"
TOKEN_ADDR = "0x5555555555555555555555555555555555555555"
ZERO_SALT = "0x" + "00" * 32


def _basic_config(payer_authorizer: str = PAYER_ADDR) -> ChannelConfig:
    return ChannelConfig(
        payer=PAYER_ADDR,
        payer_authorizer=payer_authorizer,
        receiver=RECEIVER_ADDR,
        receiver_authorizer=RECEIVER_AUTHORIZER_ADDR,
        token=TOKEN_ADDR,
        withdraw_delay=900,
        salt=ZERO_SALT,
    )


class TestComputeChannelConfigDigest:
    def test_returns_32_bytes(self):
        config = _basic_config()
        digest = compute_channel_config_digest(config, TEST_CHAIN_ID)
        assert isinstance(digest, bytes)
        assert len(digest) == 32

    def test_deterministic(self):
        config = _basic_config()
        d1 = compute_channel_config_digest(config, TEST_CHAIN_ID)
        d2 = compute_channel_config_digest(config, TEST_CHAIN_ID)
        assert d1 == d2

    def test_chain_id_affects_digest(self):
        config = _basic_config()
        d_sepolia = compute_channel_config_digest(config, TEST_CHAIN_ID)
        d_mainnet = compute_channel_config_digest(config, 1)
        assert d_sepolia != d_mainnet

    def test_field_change_affects_digest(self):
        """Changing any signed field (here: withdraw_delay) must change the digest."""
        config_a = _basic_config()
        config_b = ChannelConfig(
            payer=PAYER_ADDR,
            payer_authorizer=PAYER_ADDR,
            receiver=RECEIVER_ADDR,
            receiver_authorizer=RECEIVER_AUTHORIZER_ADDR,
            token=TOKEN_ADDR,
            withdraw_delay=901,
            salt=ZERO_SALT,
        )
        d_a = compute_channel_config_digest(config_a, TEST_CHAIN_ID)
        d_b = compute_channel_config_digest(config_b, TEST_CHAIN_ID)
        assert d_a != d_b

    def test_compute_channel_id_wraps_digest(self):
        """`compute_channel_id` must equal `"0x" + compute_channel_config_digest.hex()`."""
        config = _basic_config()
        cid = compute_channel_id(config, TEST_CHAIN_ID)
        digest = compute_channel_config_digest(config, TEST_CHAIN_ID)
        assert cid == "0x" + digest.hex()

    def test_zero_payer_authorizer_normalized(self):
        """payer_authorizer = '0x0...0' should normalize to the zero address."""
        config_zero = _basic_config(payer_authorizer="0x" + "00" * 20)
        config_explicit = _basic_config(
            payer_authorizer="0x0000000000000000000000000000000000000000"
        )
        d_zero = compute_channel_config_digest(config_zero, TEST_CHAIN_ID)
        d_explicit = compute_channel_config_digest(config_explicit, TEST_CHAIN_ID)
        assert d_zero == d_explicit


class TestComputeVoucherDigest:
    def test_returns_32_bytes(self):
        cid = "0x" + "ab" * 32
        d = compute_voucher_digest(cid, 1000, TEST_CHAIN_ID)
        assert isinstance(d, bytes)
        assert len(d) == 32

    def test_accepts_hex_or_bytes_channel_id(self):
        cid_hex = "0x" + "ab" * 32
        cid_bytes = bytes.fromhex("ab" * 32)
        d_hex = compute_voucher_digest(cid_hex, 1000, TEST_CHAIN_ID)
        d_bytes = compute_voucher_digest(cid_bytes, 1000, TEST_CHAIN_ID)
        assert d_hex == d_bytes

    def test_amount_int_or_str_equivalent(self):
        cid = "0x" + "ab" * 32
        d_int = compute_voucher_digest(cid, 1000, TEST_CHAIN_ID)
        d_str = compute_voucher_digest(cid, "1000", TEST_CHAIN_ID)
        assert d_int == d_str

    def test_amount_change_affects_digest(self):
        cid = "0x" + "ab" * 32
        d1 = compute_voucher_digest(cid, 1000, TEST_CHAIN_ID)
        d2 = compute_voucher_digest(cid, 1001, TEST_CHAIN_ID)
        assert d1 != d2

    def test_chain_id_change_affects_digest(self):
        cid = "0x" + "ab" * 32
        d_sepolia = compute_voucher_digest(cid, 1000, TEST_CHAIN_ID)
        d_mainnet = compute_voucher_digest(cid, 1000, 1)
        assert d_sepolia != d_mainnet


class TestComputeRefundDigest:
    def test_returns_32_bytes(self):
        cid = "0x" + "ab" * 32
        d = compute_refund_digest(cid, 0, 500, TEST_CHAIN_ID)
        assert isinstance(d, bytes)
        assert len(d) == 32

    def test_nonce_change_affects_digest(self):
        cid = "0x" + "ab" * 32
        d0 = compute_refund_digest(cid, 0, 500, TEST_CHAIN_ID)
        d1 = compute_refund_digest(cid, 1, 500, TEST_CHAIN_ID)
        assert d0 != d1

    def test_amount_change_affects_digest(self):
        cid = "0x" + "ab" * 32
        d_a = compute_refund_digest(cid, 0, 500, TEST_CHAIN_ID)
        d_b = compute_refund_digest(cid, 0, 501, TEST_CHAIN_ID)
        assert d_a != d_b

    def test_differs_from_voucher_digest_with_overlapping_inputs(self):
        """Refund and Voucher share channelId but use different EIP-712 types.

        Different typeHash should yield different digests even when the
        numeric payloads overlap.
        """
        cid = "0x" + "ab" * 32
        v = compute_voucher_digest(cid, 500, TEST_CHAIN_ID)
        r = compute_refund_digest(cid, 0, 500, TEST_CHAIN_ID)
        assert v != r


class TestComputeClaimBatchDigest:
    def test_returns_32_bytes(self):
        cid = "0x" + "ab" * 32
        d = compute_claim_batch_digest(
            [{"channelId": cid, "maxClaimableAmount": 1000, "totalClaimed": 500}],
            TEST_CHAIN_ID,
        )
        assert isinstance(d, bytes)
        assert len(d) == 32

    def test_empty_claims_pinned(self):
        """Empty claims array digest is pinned to catch encoding drift in unit tests.

        The TS-generated cross-language fixtures (`L2.3`) cover the populated
        case; this pin covers the empty edge case and gives the digest test
        suite a drift sensor even without the TS fixture round-trip.
        """
        d = compute_claim_batch_digest([], TEST_CHAIN_ID)
        assert isinstance(d, bytes)
        assert len(d) == 32
        expected = bytes.fromhex("57b970b91bd540b4ca1aa82be12adbc9b769b6e978e5285b2a859bd989304e9a")
        assert d == expected, f"empty-claims digest changed: 0x{d.hex()}"

    def test_claim_order_affects_digest(self):
        """Array of struct: element order matters in EIP-712 encoding."""
        cid_a = "0x" + "ab" * 32
        cid_b = "0x" + "cd" * 32
        claims_ab = [
            {"channelId": cid_a, "maxClaimableAmount": 1000, "totalClaimed": 500},
            {"channelId": cid_b, "maxClaimableAmount": 2000, "totalClaimed": 800},
        ]
        claims_ba = [
            {"channelId": cid_b, "maxClaimableAmount": 2000, "totalClaimed": 800},
            {"channelId": cid_a, "maxClaimableAmount": 1000, "totalClaimed": 500},
        ]
        d_ab = compute_claim_batch_digest(claims_ab, TEST_CHAIN_ID)
        d_ba = compute_claim_batch_digest(claims_ba, TEST_CHAIN_ID)
        assert d_ab != d_ba

    def test_multiple_claims_differ_from_single(self):
        cid = "0x" + "ab" * 32
        single = compute_claim_batch_digest(
            [{"channelId": cid, "maxClaimableAmount": 1000, "totalClaimed": 500}],
            TEST_CHAIN_ID,
        )
        multi = compute_claim_batch_digest(
            [
                {"channelId": cid, "maxClaimableAmount": 1000, "totalClaimed": 500},
                {"channelId": cid, "maxClaimableAmount": 1000, "totalClaimed": 500},
            ],
            TEST_CHAIN_ID,
        )
        assert single != multi


class TestKeccakSanity:
    """Sanity: our environment's keccak matches the well-known constant.

    Guards against accidental use of SHA3-256 instead of Keccak-256.
    """

    def test_empty_keccak_is_known_value(self):
        expected = bytes.fromhex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        assert keccak(b"") == expected
