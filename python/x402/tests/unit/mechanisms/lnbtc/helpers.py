"""Locally signed test invoices; no node, network calls or real payments."""

from dataclasses import replace
from hashlib import sha256

from bolt11 import Bolt11, encode
from bolt11.models.tags import Tag, TagChar, Tags

from x402.mechanisms.lnbtc import LightningPayment
from x402.mechanisms.lnbtc.constants import NETWORKS
from x402.mechanisms.lnbtc.validation import decode_invoice

NOW = 1700000000
KEY = "0" * 63 + "1"  # Published test key from the accepted specification.
PAYEE = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
PREIMAGE = "42" * 32


def invoice(
    digest,
    *,
    preimage=PREIMAGE,
    amount=21000,
    expiry=300,
    date=NOW,
    currency="bc",
    key=KEY,
    inline_description=False,
):
    tags = [
        Tag(TagChar.payment_hash, sha256(bytes.fromhex(preimage)).hexdigest()),
        Tag(TagChar.payment_secret, "23" * 32),
        Tag(TagChar.expire_time, expiry),
        Tag(
            TagChar.description if inline_description else TagChar.description_hash,
            "test" if inline_description else digest,
        ),
    ]
    return encode(
        Bolt11(currency=currency, amount_msat=amount, date=date, tags=Tags(tags)), private_key=key
    )


class Receiver:
    def __init__(self):
        self.invoices = {}

    def create_invoice(self, *, amount_msat, description_hash, expiry_seconds, network):
        preimage = sha256(str(len(self.invoices)).encode()).hexdigest()
        value = invoice(
            description_hash,
            preimage=preimage,
            amount=amount_msat,
            expiry=expiry_seconds,
            currency=NETWORKS[network],
        )
        self.invoices[value] = preimage
        return value


class Payer:
    def __init__(self, receiver=None, **overrides):
        self.receiver = receiver
        self.overrides = overrides
        self.calls = 0

    def pay_invoice(self, value, network):
        self.calls += 1
        decoded = decode_invoice(value)
        result = LightningPayment(
            invoice=value,
            payment_hash=decoded.payment_hash,
            amount_msat=int(decoded.amount_msat),
            status="paid",
            preimage=self.receiver.invoices[value] if self.receiver else PREIMAGE,
        )
        return replace(result, **self.overrides)
