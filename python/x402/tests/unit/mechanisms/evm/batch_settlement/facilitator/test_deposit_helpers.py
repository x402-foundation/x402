"""Unit tests for facilitator-side deposit collector pure helpers.

Mirrors the parity-critical helpers in
go/mechanisms/evm/batch-settlement/facilitator/{deposit_eip3009,deposit_permit2}.go
that can be exercised without an onchain signer.
"""

from __future__ import annotations

import pytest

try:
    from eth_utils import to_checksum_address

    from x402.mechanisms.evm.batch_settlement.constants import (
        ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
        PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    )
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_ERC3009_AUTHORIZATION_REQUIRED,
        ERR_PERMIT2_AUTHORIZATION_REQUIRED,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.deposit_eip3009 import (
        build_eip3009_deposit_collector_data,
        get_eip3009_deposit_collector_address,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.deposit_permit2 import (
        build_permit2_deposit_collector_data,
        get_permit2_deposit_collector_address,
    )
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        DepositAuthorization,
        DepositFields,
        DepositPayload,
        Erc3009Authorization,
        Permit2Authorization,
        Permit2DepositWitness,
        Permit2TokenPermissions,
        VoucherFields,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


CHANNEL_ID = "0x" + "ab" * 32
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
SPENDER = "0x5555555555555555555555555555555555555555"
PAYER = "0x1111111111111111111111111111111111111111"


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer=PAYER,
        payer_authorizer=PAYER,
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token=TOKEN,
        withdraw_delay=900,
        salt="0x" + "00" * 32,
    )


def _voucher() -> VoucherFields:
    return VoucherFields(
        channel_id=CHANNEL_ID,
        max_claimable_amount="100",
        signature="0x" + "11" * 65,
    )


def _erc3009_payload() -> DepositPayload:
    p = DepositPayload()
    p.channel_config = _channel_config()
    p.voucher = _voucher()
    p.deposit = DepositFields(
        amount="1000",
        authorization=DepositAuthorization(
            erc3009_authorization=Erc3009Authorization(
                valid_after="100",
                valid_before="200",
                salt="0x" + "22" * 32,
                signature="0x" + "33" * 65,
            )
        ),
    )
    return p


def _permit2_payload() -> DepositPayload:
    p = DepositPayload()
    p.channel_config = _channel_config()
    p.voucher = _voucher()
    p.deposit = DepositFields(
        amount="1000",
        authorization=DepositAuthorization(
            permit2_authorization=Permit2Authorization(
                from_address=PAYER,
                permitted=Permit2TokenPermissions(token=TOKEN, amount="1000"),
                spender=SPENDER,
                nonce="42",
                deadline="9999999999",
                witness=Permit2DepositWitness(channel_id=CHANNEL_ID),
                signature="0x" + "33" * 65,
            )
        ),
    )
    return p


class TestEip3009CollectorAddress:
    def test_returns_checksummed(self):
        addr = get_eip3009_deposit_collector_address()
        assert addr == to_checksum_address(ERC3009_DEPOSIT_COLLECTOR_ADDRESS)


class TestBuildEip3009DepositCollectorData:
    def test_encodes_to_bytes(self):
        data = build_eip3009_deposit_collector_data(_erc3009_payload())
        assert isinstance(data, bytes)
        # ABI-encoded (uint256, uint256, uint256, bytes) — at minimum 4*32 + sig
        assert len(data) >= 4 * 32

    def test_missing_authorization_raises(self):
        p = DepositPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher()
        p.deposit = DepositFields(amount="1000", authorization=DepositAuthorization())
        with pytest.raises(ValueError, match=ERR_ERC3009_AUTHORIZATION_REQUIRED):
            build_eip3009_deposit_collector_data(p)


class TestPermit2CollectorAddress:
    def test_returns_checksummed(self):
        assert get_permit2_deposit_collector_address() == to_checksum_address(
            PERMIT2_DEPOSIT_COLLECTOR_ADDRESS
        )


class TestBuildPermit2DepositCollectorData:
    def test_encodes_to_bytes(self):
        data = build_permit2_deposit_collector_data(_permit2_payload())
        assert isinstance(data, bytes)
        assert len(data) >= 4 * 32

    def test_includes_eip2612_segment(self):
        bare = build_permit2_deposit_collector_data(_permit2_payload())
        extended = build_permit2_deposit_collector_data(
            _permit2_payload(), eip2612_permit_data=b"\xab" * 32
        )
        assert len(extended) > len(bare)

    def test_missing_authorization_raises(self):
        p = DepositPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher()
        p.deposit = DepositFields(amount="1000", authorization=DepositAuthorization())
        with pytest.raises(ValueError, match=ERR_PERMIT2_AUTHORIZATION_REQUIRED):
            build_permit2_deposit_collector_data(p)
