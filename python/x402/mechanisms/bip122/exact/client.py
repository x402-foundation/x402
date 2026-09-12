"""BIP-122 client implementation for the Exact payment scheme (V2)."""

from typing import Any

from ....schemas import PaymentRequirements
from ..constants import (
    ERR_INVALID_PAYMENT_METHOD,
    ERR_INVOICE_MISMATCH,
    ERR_MISSING_INVOICE,
    ERR_UNSUPPORTED_SCHEME,
    PAYMENT_METHOD_LIGHTNING,
    SCHEME_EXACT,
)
from ..payer import LightningPayer
from ..types import ExactBip122Payload
from ..utils import decode_invoice, normalize_network


class ExactBip122Scheme:
    """BIP-122 client implementation for the Exact payment scheme (V2)."""

    scheme = SCHEME_EXACT

    def __init__(self, payer: LightningPayer):
        self._payer = payer

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
    ) -> dict[str, Any]:
        """Pay the invoice referenced by the requirements and return the inner payload."""
        if requirements.scheme != SCHEME_EXACT:
            raise ValueError(ERR_UNSUPPORTED_SCHEME)

        network = normalize_network(str(requirements.network))
        extra = requirements.extra or {}
        payment_method = extra.get("paymentMethod")
        if payment_method != PAYMENT_METHOD_LIGHTNING:
            raise ValueError(ERR_INVALID_PAYMENT_METHOD)

        invoice = extra.get("invoice")
        if not invoice or not isinstance(invoice, str):
            raise ValueError(ERR_MISSING_INVOICE)

        decoded = decode_invoice(invoice)
        invoice_amount_msat = int(decoded.amount_msat or 0)
        if invoice_amount_msat != int(requirements.amount):
            raise ValueError(ERR_INVOICE_MISMATCH)

        status = self._payer.pay_invoice(invoice, network)
        if status.invoice != invoice or status.payment_hash != decoded.payment_hash:
            raise ValueError(ERR_INVOICE_MISMATCH)
        if status.status != "paid":
            raise ValueError(f"Invoice payment did not complete: {status.status}")

        return ExactBip122Payload(invoice=invoice).to_dict()
