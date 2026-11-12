"""Pay request-bound BOLT11 invoices and return the verified preimage."""

import re
import time
from collections.abc import Callable
from hashlib import sha256
from typing import Any

from ....schemas import PaymentRequired, PaymentRequirements
from ....schemas.hooks import AbortResult, PaymentCreationContext
from ..binding import RequestBinding
from ..constants import DEFAULT_CLOCK_SKEW, LightningValidationError, invalid
from ..types import LightningPayer
from ..validation import validate_invoice, validate_skew, validate_terms


class ExactLnbtcScheme:
    scheme = "exact"

    def __init__(
        self,
        payer: LightningPayer,
        request_binding: Callable[[], RequestBinding],
        *,
        clock: Callable[[], float] = time.time,
        clock_skew: int = DEFAULT_CLOCK_SKEW,
    ) -> None:
        validate_skew(clock_skew)
        self._payer = payer
        self._request_binding = request_binding
        self._clock = clock
        self._skew = clock_skew
        self.scheme_hooks = {"before_payment_creation": self.before_payment_creation}

    def before_payment_creation(self, context: PaymentCreationContext) -> AbortResult | None:
        binding = self._request_binding()
        if not isinstance(context.payment_required, PaymentRequired):
            return AbortResult(reason="unsupported_scheme")
        resource = context.payment_required.resource
        if binding.profile == "http:1" and (
            resource is None or resource.url != binding.resource_url
        ):
            return AbortResult(reason="invalid_exact_lnbtc_request_mismatch")
        return None

    def create_payment_payload(self, requirements: PaymentRequirements) -> dict[str, Any]:
        validate_terms(requirements)
        self._request_binding().check(requirements.extra)
        invoice_text = requirements.extra["invoice"]
        invoice = validate_invoice(
            invoice_text, requirements, now=self._clock(), clock_skew=self._skew
        )
        payment = self._payer.pay_invoice(invoice_text, requirements.network)
        if payment.invoice != invoice_text:
            raise invalid("payer_invoice_mismatch")
        if payment.payment_hash != invoice.payment_hash:
            raise invalid("payer_payment_hash_mismatch")
        if type(payment.amount_msat) is not int or payment.amount_msat != invoice.amount_msat:
            raise invalid("payer_amount_mismatch")
        if payment.status == "in_flight":
            raise LightningValidationError("exact_lnbtc_payment_in_flight")
        if payment.status != "paid":
            raise LightningValidationError("exact_lnbtc_payment_not_paid")
        if payment.preimage is None:
            raise invalid("payer_preimage_required")
        if not isinstance(payment.preimage, str) or not re.fullmatch(
            r"[0-9a-f]{64}", payment.preimage
        ):
            raise invalid("payer_preimage_malformed")
        if sha256(bytes.fromhex(payment.preimage)).hexdigest() != invoice.payment_hash:
            raise invalid("payer_preimage_hash_mismatch")
        return {"preimage": payment.preimage}
