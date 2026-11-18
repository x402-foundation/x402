"""Test data builders for TVM mechanism unit tests."""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass

from pytoniq_core import begin_cell
from pytoniq_core.crypto.keys import mnemonic_to_wallet_key

from x402.mechanisms.tvm import TVM_TESTNET, ParsedJettonTransfer, ParsedTvmSettlement
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

PAYER = "0:" + "1" * 64
MERCHANT = "0:" + "2" * 64
ASSET = "0:" + "3" * 64
SOURCE_WALLET = "0:" + "4" * 64
RECEIVER_WALLET = "0:" + "5" * 64
RESPONSE_DESTINATION = "0:" + "6" * 64
FACILITATOR = "0:" + "f" * 64

TEST_MNEMONIC = (
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
)

EMPTY_FORWARD_PAYLOAD = begin_cell().store_bit(0).end_cell()
EMPTY_FORWARD_PAYLOAD_B64 = base64.b64encode(EMPTY_FORWARD_PAYLOAD.to_boc()).decode("ascii")
SPONSORED_FORWARDING_EXTRA = {
    "areFeesSponsored": True,
    "forwardPayload": EMPTY_FORWARD_PAYLOAD_B64,
    "forwardTonAmount": "0",
}
SPONSORED_EXTRA = {
    "areFeesSponsored": True,
    "forwardTonAmount": "0",
}


def derive_test_secret_key() -> bytes:
    """Return a deterministic secret key used across signer tests."""
    _, secret_key = mnemonic_to_wallet_key(TEST_MNEMONIC.split())
    return secret_key


def make_tvm_requirements(
    *,
    default_extra: dict[str, object] | None = None,
    extra: dict[str, object] | None = None,
    **overrides: object,
) -> PaymentRequirements:
    merged_extra = dict(default_extra or {})
    merged_extra.update(extra or {})
    return PaymentRequirements(
        scheme="exact",
        network=overrides.pop("network", TVM_TESTNET),
        asset=overrides.pop("asset", ASSET),
        amount=overrides.pop("amount", "100"),
        pay_to=overrides.pop("pay_to", MERCHANT),
        max_timeout_seconds=overrides.pop("max_timeout_seconds", 300),
        extra=merged_extra,
        **overrides,
    )


def make_tvm_payload(
    *,
    default_accepted_extra: dict[str, object] | None = None,
    accepted_extra: dict[str, object] | None = None,
    payload: dict[str, object] | None = None,
    **overrides: object,
) -> PaymentPayload:
    merged_extra = dict(default_accepted_extra or {})
    merged_extra.update(accepted_extra or {})
    resolved_payload = payload or {
        "settlementBoc": overrides.pop("settlement_boc", "base64-boc=="),
        "asset": overrides.pop("payload_asset", ASSET),
    }
    return PaymentPayload(
        x402_version=overrides.pop("x402_version", 2),
        resource=ResourceInfo(
            url="http://example.com/protected",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=PaymentRequirements(
            scheme=overrides.pop("accepted_scheme", "exact"),
            network=overrides.pop("accepted_network", TVM_TESTNET),
            asset=overrides.pop("accepted_asset", ASSET),
            amount=overrides.pop("accepted_amount", "100"),
            pay_to=overrides.pop("accepted_pay_to", MERCHANT),
            max_timeout_seconds=overrides.pop("accepted_max_timeout_seconds", 300),
            extra=merged_extra,
        ),
        payload=resolved_payload,
        **overrides,
    )


@dataclass
class FakeCell:
    hash: bytes


def make_tvm_settlement(**overrides: object) -> ParsedTvmSettlement:
    transfer = ParsedJettonTransfer(
        source_wallet=overrides.pop("source_wallet", SOURCE_WALLET),
        destination=overrides.pop("destination", MERCHANT),
        response_destination=overrides.pop("response_destination", None),
        jetton_amount=overrides.pop("jetton_amount", 100),
        attached_ton_amount=overrides.pop("attached_ton_amount", 500_000),
        forward_ton_amount=overrides.pop("forward_ton_amount", 0),
        forward_payload=overrides.pop("forward_payload", EMPTY_FORWARD_PAYLOAD),
        body_hash=overrides.pop("body_hash", b"transfer-body-hash"),
    )
    return ParsedTvmSettlement(
        payer=overrides.pop("payer", PAYER),
        wallet_id=overrides.pop("wallet_id", 777),
        valid_until=overrides.pop("valid_until", int(time.time()) + 120),
        seqno=overrides.pop("seqno", 12),
        settlement_hash=overrides.pop("settlement_hash", "settlement-hash-1"),
        body=overrides.pop("body", FakeCell(b"body-hash")),
        signed_slice_hash=overrides.pop("signed_slice_hash", b"signed-slice"),
        signature=overrides.pop("signature", b"signature"),
        state_init=overrides.pop("state_init", None),
        transfer=transfer,
        **overrides,
    )
