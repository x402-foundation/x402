"""Unit tests for the receiver-authorizer EIP-712 signer."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_keys import keys
    from eth_utils import keccak, to_checksum_address

    from x402.mechanisms.evm.batch_settlement.authorizer_signer import (
        LocalAuthorizerSigner,
        sign_claim_batch,
        sign_refund,
    )
    from x402.mechanisms.evm.batch_settlement.constants import (
        CLAIM_BATCH_TYPES,
        REFUND_TYPES,
    )
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        VoucherClaim,
    )
    from x402.mechanisms.evm.batch_settlement.utils import (
        coerce_bytes32,
        compute_channel_id,
        get_batch_settlement_eip712_domain,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"
CHAIN_ID = 8453

# A known private key (NOT secret — only used for deterministic test signatures).
TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token="0x5555555555555555555555555555555555555555",
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


def _signer_from_test_key() -> LocalAuthorizerSigner:
    return LocalAuthorizerSigner(TEST_PRIVATE_KEY)


def _recover_signer_address(domain: dict, types: dict, message: dict, signature: str) -> str:
    signable = encode_typed_data(domain_data=domain, message_types=types, message_data=message)
    digest = keccak(b"\x19" + signable.version + signable.header + signable.body)
    sig_bytes = bytearray(bytes.fromhex(signature.removeprefix("0x")))
    # eth_keys expects v in {0, 1}; signers emit 27/28.
    if sig_bytes[64] >= 27:
        sig_bytes[64] -= 27
    sig_obj = keys.Signature(bytes(sig_bytes))
    return to_checksum_address(sig_obj.recover_public_key_from_msg_hash(digest).to_address())


class TestLocalAuthorizerSigner:
    def test_address_matches_account(self):
        signer = _signer_from_test_key()
        expected = Account.from_key(TEST_PRIVATE_KEY).address
        assert signer.address == to_checksum_address(expected)

    def test_construct_from_local_account(self):
        account = Account.from_key(TEST_PRIVATE_KEY)
        signer = LocalAuthorizerSigner(account)
        assert signer.address == to_checksum_address(account.address)

    def test_signature_recovers_to_signer_address(self):
        signer = _signer_from_test_key()
        domain = get_batch_settlement_eip712_domain(CHAIN_ID)
        message = {
            "channelId": coerce_bytes32("0x" + "ab" * 32),
            "nonce": 0,
            "amount": 100,
        }
        sig = signer.sign_typed_data(
            domain=domain,
            types=REFUND_TYPES,
            primary_type="Refund",
            message=message,
        )
        assert sig.startswith("0x") and len(sig) == 132
        recovered = _recover_signer_address(domain, REFUND_TYPES, message, sig)
        assert recovered == signer.address

    def test_signature_is_deterministic(self):
        signer = _signer_from_test_key()
        domain = get_batch_settlement_eip712_domain(CHAIN_ID)
        message = {
            "channelId": coerce_bytes32("0x" + "01" * 32),
            "nonce": 7,
            "amount": 250,
        }
        kwargs = {
            "domain": domain,
            "types": REFUND_TYPES,
            "primary_type": "Refund",
            "message": message,
        }
        assert signer.sign_typed_data(**kwargs) == signer.sign_typed_data(**kwargs)


class TestSignClaimBatch:
    def test_signs_claim_batch_to_signer_address(self):
        signer = _signer_from_test_key()
        cfg = _channel_config()
        claims = [
            VoucherClaim(
                channel=cfg,
                max_claimable_amount="1000",
                signature="0x",
                total_claimed="0",
            )
        ]
        sig = sign_claim_batch(signer, claims, NETWORK)
        assert sig.startswith("0x")

        # Re-derive the EIP-712 message the way sign_claim_batch does.
        cid = compute_channel_id(cfg, CHAIN_ID)
        message = {
            "claims": [
                {
                    "channelId": coerce_bytes32(cid),
                    "maxClaimableAmount": 1000,
                    "totalClaimed": 0,
                }
            ]
        }
        recovered = _recover_signer_address(
            get_batch_settlement_eip712_domain(CHAIN_ID),
            CLAIM_BATCH_TYPES,
            message,
            sig,
        )
        assert recovered == signer.address

    def test_empty_claims_signs_empty_batch(self):
        signer = _signer_from_test_key()
        sig = sign_claim_batch(signer, [], NETWORK)
        assert sig.startswith("0x") and len(sig) == 132

    def test_different_claims_produce_different_signatures(self):
        signer = _signer_from_test_key()
        cfg = _channel_config()
        sig_a = sign_claim_batch(
            signer,
            [
                VoucherClaim(
                    channel=cfg, max_claimable_amount="1", signature="0x", total_claimed="0"
                )
            ],
            NETWORK,
        )
        sig_b = sign_claim_batch(
            signer,
            [
                VoucherClaim(
                    channel=cfg, max_claimable_amount="2", signature="0x", total_claimed="0"
                )
            ],
            NETWORK,
        )
        assert sig_a != sig_b


class TestSignRefund:
    def test_signs_refund(self):
        signer = _signer_from_test_key()
        cid = "0x" + "ab" * 32
        sig = sign_refund(signer, cid, amount=100, nonce=0, network=NETWORK)

        message = {
            "channelId": coerce_bytes32(cid),
            "nonce": 0,
            "amount": 100,
        }
        recovered = _recover_signer_address(
            get_batch_settlement_eip712_domain(CHAIN_ID),
            REFUND_TYPES,
            message,
            sig,
        )
        assert recovered == signer.address

    def test_accepts_string_amount_and_nonce(self):
        signer = _signer_from_test_key()
        cid = "0x" + "ab" * 32
        sig_int = sign_refund(signer, cid, amount=100, nonce=0, network=NETWORK)
        sig_str = sign_refund(signer, cid, amount="100", nonce="0", network=NETWORK)
        assert sig_int == sig_str

    def test_different_nonce_produces_different_signature(self):
        signer = _signer_from_test_key()
        cid = "0x" + "ab" * 32
        a = sign_refund(signer, cid, 100, 0, NETWORK)
        b = sign_refund(signer, cid, 100, 1, NETWORK)
        assert a != b
