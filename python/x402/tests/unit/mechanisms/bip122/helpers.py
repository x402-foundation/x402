"""Test helpers for the BIP-122 Lightning mechanism."""

from __future__ import annotations

import hashlib
import time

from bolt11 import Bolt11, encode
from bolt11.models.tags import Tag, TagChar, Tags

from x402.mechanisms.bip122 import (
    BTC_MAINNET_CAIP2,
    LightningInvoiceStatus,
    decode_invoice,
)
from x402.mechanisms.bip122.constants import NETWORK_CONFIGS

TEST_INVOICE_PRIVATE_KEY = "1" * 64


def build_invoice(
    amount_msat: int,
    memo: str = "test payment",
    network: str = BTC_MAINNET_CAIP2,
    expiry_seconds: int = 3600,
    payment_hash: str | None = None,
    issued_at: int | None = None,
) -> tuple[str, str]:
    """Build a signed BOLT11 invoice for testing."""
    if network not in NETWORK_CONFIGS:
        raise ValueError(f"Unsupported BIP-122 network: {network}")

    issue_time = issued_at if issued_at is not None else int(time.time())
    invoice_hash = (
        payment_hash
        or hashlib.sha256(
            f"{network}:{amount_msat}:{memo}:{issue_time}:{expiry_seconds}".encode()
        ).hexdigest()
    )
    payment_secret = hashlib.sha256(f"secret:{invoice_hash}".encode()).hexdigest()

    invoice = Bolt11(
        currency=NETWORK_CONFIGS[network]["currency"],
        amount_msat=amount_msat,
        date=issue_time,
        tags=Tags(
            [
                Tag(TagChar.description, memo),
                Tag(TagChar.payment_hash, invoice_hash),
                Tag(TagChar.payment_secret, payment_secret),
                Tag(TagChar.expire_time, expiry_seconds),
                Tag(TagChar.min_final_cltv_expiry, 18),
            ]
        ),
    )
    return encode(invoice, private_key=TEST_INVOICE_PRIVATE_KEY), invoice_hash


class InMemoryLightningReceiver:
    """Simple receiver adapter that stores invoices in memory."""

    def __init__(self) -> None:
        self._statuses: dict[str, LightningInvoiceStatus] = {}
        self._networks: dict[str, str] = {}

    def create_invoice(
        self,
        amount_msat: int,
        memo: str,
        expiry_seconds: int,
        network: str,
    ) -> str:
        invoice, payment_hash = build_invoice(
            amount_msat=amount_msat,
            memo=memo,
            network=network,
            expiry_seconds=expiry_seconds,
        )
        self._statuses[invoice] = LightningInvoiceStatus(
            invoice=invoice,
            payment_hash=payment_hash,
            amount_msat=amount_msat,
            status="unpaid",
        )
        self._networks[invoice] = network
        return invoice

    def add_invoice(
        self,
        invoice: str,
        network: str,
        status: str = "unpaid",
        payer: str | None = None,
        settled_at: int | None = None,
    ) -> LightningInvoiceStatus:
        """Store an externally created invoice for later lookup."""
        decoded = decode_invoice(invoice)
        stored = LightningInvoiceStatus(
            invoice=invoice,
            payment_hash=decoded.payment_hash,
            amount_msat=int(decoded.amount_msat or 0),
            status=status,
            payer=payer,
            settled_at=settled_at,
        )
        self._statuses[invoice] = stored
        self._networks[invoice] = network
        return stored

    def lookup_invoice(self, invoice: str, network: str) -> LightningInvoiceStatus | None:
        if self._networks.get(invoice) != network:
            return None
        return self._statuses.get(invoice)

    def set_status(
        self,
        invoice: str,
        status: str,
        payer: str | None = None,
        settled_at: int | None = None,
    ) -> LightningInvoiceStatus:
        current = self._statuses[invoice]
        updated = LightningInvoiceStatus(
            invoice=current.invoice,
            payment_hash=current.payment_hash,
            amount_msat=current.amount_msat,
            status=status,
            payer=payer,
            settled_at=settled_at,
        )
        self._statuses[invoice] = updated
        return updated


class InMemoryLightningPayer:
    """Simple payer adapter backed by an in-memory receiver."""

    def __init__(
        self,
        receiver: InMemoryLightningReceiver,
        payer: str = "payer",
        final_status: str = "paid",
    ) -> None:
        self._receiver = receiver
        self._payer = payer
        self._final_status = final_status

    def pay_invoice(self, invoice: str, network: str) -> LightningInvoiceStatus:
        status = self._receiver.lookup_invoice(invoice, network)
        if status is None:
            decoded = decode_invoice(invoice)
            return LightningInvoiceStatus(
                invoice=invoice,
                payment_hash=decoded.payment_hash,
                amount_msat=int(decoded.amount_msat or 0),
                status="unpaid",
            )

        if self._final_status == "paid":
            return self._receiver.set_status(
                invoice,
                "paid",
                payer=self._payer,
                settled_at=int(time.time()),
            )
        if self._final_status == "in_flight":
            return self._receiver.set_status(invoice, "in_flight", payer=self._payer)
        return self._receiver.set_status(invoice, "unpaid", payer=self._payer)
