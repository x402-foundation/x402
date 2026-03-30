"""Lightning payer protocol definitions."""

from typing import Protocol

from .types import LightningInvoiceStatus


class LightningPayer(Protocol):
    """Client-side Lightning payer used to settle a BOLT11 invoice."""

    def pay_invoice(self, invoice: str, network: str) -> LightningInvoiceStatus:
        """Pay an invoice and return the resulting invoice state."""
        ...
