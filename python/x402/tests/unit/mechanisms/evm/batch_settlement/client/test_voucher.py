"""Unit tests for client voucher signing."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_keys import keys
    from eth_utils import keccak, to_checksum_address

    from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
    from x402.mechanisms.evm.batch_settlement.constants import VOUCHER_TYPES
    from x402.mechanisms.evm.batch_settlement.types import VoucherFields
    from x402.mechanisms.evm.batch_settlement.utils import (
        coerce_bytes32,
        get_batch_settlement_eip712_domain,
    )
    from x402.mechanisms.evm.signers import EthAccountSigner
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"
CHAIN_ID = 8453
TEST_PRIVATE_KEY = "0xb1c0e5f8d2a3b4d5e6c7a8b9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9"


def _signer() -> EthAccountSigner:
    return EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY))


def _recover(message: dict, signature: str) -> str:
    domain = get_batch_settlement_eip712_domain(CHAIN_ID)
    signable = encode_typed_data(
        domain_data=domain, message_types=VOUCHER_TYPES, message_data=message
    )
    digest = keccak(b"\x19" + signable.version + signable.header + signable.body)
    sig_bytes = bytearray(bytes.fromhex(signature.removeprefix("0x")))
    if sig_bytes[64] >= 27:
        sig_bytes[64] -= 27
    sig_obj = keys.Signature(bytes(sig_bytes))
    return to_checksum_address(sig_obj.recover_public_key_from_msg_hash(digest).to_address())


class TestSignVoucher:
    def test_returns_voucher_fields(self):
        signer = _signer()
        channel_id = "0x" + "ab" * 32
        v = sign_voucher(signer, channel_id, 1000, NETWORK)
        assert isinstance(v, VoucherFields)
        assert v.channel_id == channel_id
        assert v.max_claimable_amount == "1000"
        assert v.signature.startswith("0x")
        assert len(v.signature) == 132

    def test_signature_recovers_to_signer(self):
        signer = _signer()
        channel_id = "0x" + "ab" * 32
        v = sign_voucher(signer, channel_id, 1000, NETWORK)
        message = {
            "channelId": coerce_bytes32(channel_id),
            "maxClaimableAmount": 1000,
        }
        recovered = _recover(message, v.signature)
        assert recovered == signer.address

    def test_amount_is_stringified(self):
        signer = _signer()
        v_int = sign_voucher(signer, "0x" + "ab" * 32, 1000, NETWORK)
        v_str = sign_voucher(signer, "0x" + "ab" * 32, "1000", NETWORK)
        assert v_int.max_claimable_amount == v_str.max_claimable_amount == "1000"
        assert v_int.signature == v_str.signature

    def test_different_amounts_produce_different_signatures(self):
        signer = _signer()
        a = sign_voucher(signer, "0x" + "ab" * 32, 1000, NETWORK)
        b = sign_voucher(signer, "0x" + "ab" * 32, 1001, NETWORK)
        assert a.signature != b.signature
