"""Lightning node adapters; credentials remain with the application."""

from dataclasses import dataclass, field
from typing import Literal, Protocol


@dataclass(frozen=True)
class LightningPayment:
    invoice: str
    payment_hash: str
    amount_msat: int
    status: Literal["paid", "unpaid", "in_flight"]
    preimage: str | None = field(default=None, repr=False)


class LightningPayer(Protocol):
    def pay_invoice(self, invoice: str, network: str) -> LightningPayment: ...


class LightningReceiver(Protocol):
    def create_invoice(
        self, *, amount_msat: int, description_hash: str, expiry_seconds: int, network: str
    ) -> str: ...
