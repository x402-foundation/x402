"""Tests for the upto Permit2 payment types and type guards."""

from __future__ import annotations

import time

from x402.mechanisms.evm.constants import X402_UPTO_PERMIT2_PROXY_ADDRESS
from x402.mechanisms.evm.types import (
    ExactPermit2TokenPermissions,
    UptoPermit2Authorization,
    UptoPermit2Payload,
    UptoPermit2Witness,
    is_permit2_payload,
    is_upto_permit2_payload,
)

PAYER = "0x1234567890123456789012345678901234567890"
RECIPIENT = "0x0987654321098765432109876543210987654321"
FACILITATOR = "0x1111111111111111111111111111111111111111"
TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
AMOUNT = "1000"


def make_upto_authorization(
    *,
    from_address: str = PAYER,
    token: str = TOKEN_ADDRESS,
    amount: str = AMOUNT,
) -> UptoPermit2Authorization:
    now = int(time.time())
    return UptoPermit2Authorization(
        from_address=from_address,
        permitted=ExactPermit2TokenPermissions(token=token, amount=amount),
        spender=X402_UPTO_PERMIT2_PROXY_ADDRESS,
        nonce="12345678901234567890",
        deadline=str(now + 3600),
        witness=UptoPermit2Witness(
            to=RECIPIENT,
            facilitator=FACILITATOR,
            valid_after=str(now - 600),
        ),
    )


class TestUptoPermit2PayloadSerialization:
    def test_to_dict_and_from_dict_roundtrip(self):
        auth = make_upto_authorization()
        original = UptoPermit2Payload(permit2_authorization=auth, signature="0x" + "ff" * 65)

        d = original.to_dict()
        restored = UptoPermit2Payload.from_dict(d)

        assert restored.permit2_authorization.from_address == auth.from_address
        assert restored.permit2_authorization.spender == auth.spender
        assert restored.permit2_authorization.nonce == auth.nonce
        assert restored.permit2_authorization.deadline == auth.deadline
        assert restored.permit2_authorization.permitted.token == auth.permitted.token
        assert restored.permit2_authorization.permitted.amount == auth.permitted.amount
        assert restored.permit2_authorization.witness.to == auth.witness.to
        assert restored.permit2_authorization.witness.facilitator == auth.witness.facilitator
        assert restored.permit2_authorization.witness.valid_after == auth.witness.valid_after
        assert restored.signature == original.signature

    def test_to_dict_keys_are_camel_case(self):
        auth = make_upto_authorization()
        payload = UptoPermit2Payload(permit2_authorization=auth, signature="0xsig")
        d = payload.to_dict()

        assert "permit2Authorization" in d
        p2 = d["permit2Authorization"]
        assert "from" in p2
        assert "permitted" in p2
        assert "spender" in p2
        assert "nonce" in p2
        assert "deadline" in p2
        assert "witness" in p2
        assert "to" in p2["witness"]
        assert "facilitator" in p2["witness"]
        assert "validAfter" in p2["witness"]

    def test_to_dict_omits_signature_when_none(self):
        auth = make_upto_authorization()
        payload = UptoPermit2Payload(permit2_authorization=auth, signature=None)
        d = payload.to_dict()
        assert "signature" not in d


class TestIsUptoPermit2Payload:
    def test_detects_upto_permit2_payload(self):
        auth = make_upto_authorization()
        payload = UptoPermit2Payload(permit2_authorization=auth, signature="0x").to_dict()
        assert is_upto_permit2_payload(payload) is True

    def test_rejects_exact_permit2_payload(self):
        payload = {
            "permit2Authorization": {
                "from": PAYER,
                "witness": {"to": RECIPIENT, "validAfter": "123"},
            },
            "signature": "0x",
        }
        assert is_upto_permit2_payload(payload) is False

    def test_rejects_eip3009_payload(self):
        payload = {"authorization": {"from": PAYER}, "signature": "0x"}
        assert is_upto_permit2_payload(payload) is False

    def test_rejects_empty_dict(self):
        assert is_upto_permit2_payload({}) is False

    def test_exact_is_permit2_payload_also_detects_upto(self):
        """is_permit2_payload (exact) returns True for upto payloads too (both have permit2Authorization)."""
        auth = make_upto_authorization()
        payload = UptoPermit2Payload(permit2_authorization=auth, signature="0x").to_dict()
        assert is_permit2_payload(payload) is True
