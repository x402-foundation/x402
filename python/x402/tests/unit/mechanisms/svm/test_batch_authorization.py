"""Independent byte-level and replay-bound tests for payer bearer proofs."""

import struct

import pytest
from solders.keypair import Keypair
from solders.signature import Signature

from x402.mechanisms.svm.batch_settlement.authorization import (
    encode_batch_authorization_message,
    sign_batch_authorization,
    verify_batch_authorization,
)
from x402.mechanisms.svm.signers import KeypairSigner

PAYER = Keypair.from_seed(bytes(range(32)))
OPERATOR = Keypair.from_seed(bytes(range(1, 33)))
CHANNEL = str(Keypair.from_seed(bytes(range(2, 34))).pubkey())


def test_authorization_matches_spec_bytes_and_ed25519_signature():
    proof = sign_batch_authorization(
        KeypairSigner(PAYER), CHANNEL, str(OPERATOR.pubkey()), "µ-id", 99, 100
    )
    message = (
        b"x402-batch-authorization-v2"
        + bytes(Keypair.from_seed(bytes(range(2, 34))).pubkey())
        + bytes(PAYER.pubkey())
        + bytes(OPERATOR.pubkey())
        + struct.pack("<H", 5)
        + "µ-id".encode()
        + struct.pack("<Qq", 99, 100)
    )
    assert (
        encode_batch_authorization_message(
            CHANNEL, str(PAYER.pubkey()), str(OPERATOR.pubkey()), "µ-id", 99, 100
        )
        == message
    )
    assert proof["signature"] == str(PAYER.sign_message(message))
    assert Signature.from_string(proof["signature"]).verify(PAYER.pubkey(), message)
    assert verify_batch_authorization(proof, str(OPERATOR.pubkey()), 99)
    assert not verify_batch_authorization(proof, str(OPERATOR.pubkey()), 100)
    assert not verify_batch_authorization(proof, str(PAYER.pubkey()), 99)


@pytest.mark.parametrize(
    "field,value",
    [
        ("type", "voucher"),
        ("channelId", str(OPERATOR.pubkey())),
        ("payer", str(OPERATOR.pubkey())),
        ("requestId", "another-request"),
        ("authorizedAmount", "100"),
        ("expiresAt", 101),
        ("signature", str(Signature.default())),
        ("authorizedAmount", "-1"),
        ("authorizedAmount", "١"),
        ("authorizedAmount", "18446744073709551616"),
        ("expiresAt", True),
        ("expiresAt", "100"),
    ],
)
def test_authorization_rejects_changed_or_malformed_fields(field, value):
    proof = sign_batch_authorization(PAYER, CHANNEL, str(OPERATOR.pubkey()), "request", 99, 100)
    proof[field] = value
    assert not verify_batch_authorization(proof, str(OPERATOR.pubkey()), 1)


@pytest.mark.parametrize(
    "request_id,amount,expiry",
    [
        ("", 1, 100),
        ("x" * 257, 1, 100),
        ("µ" * 129, 1, 100),
        ("x", -1, 100),
        ("x", 2**64, 100),
        ("x", True, 100),
        ("x", 1, 0),
        ("x", 1, 2**53),
        ("x", 1, 1.5),
    ],
)
def test_authorization_rejects_out_of_range_inputs(request_id, amount, expiry):
    with pytest.raises(ValueError):
        sign_batch_authorization(PAYER, CHANNEL, str(OPERATOR.pubkey()), request_id, amount, expiry)
