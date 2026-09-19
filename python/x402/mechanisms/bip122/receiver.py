"""Lightning receiver protocol definitions."""

from typing import Protocol

from .types import LightningInvoiceStatus


class LightningReceiver(Protocol):
    """Server/facilitator-side Lightning receiver adapter."""

    def create_invoice(
        self,
        amount_msat: int,
        memo: str,
        expiry_seconds: int,
        network: str,
    ) -> str:
        """Create a BOLT11 invoice for the requested amount."""
        ...

    def lookup_invoice(self, invoice: str, network: str) -> LightningInvoiceStatus | None:
        """Look up the current state of an invoice."""
        ...
