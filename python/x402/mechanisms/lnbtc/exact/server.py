"""Issue a fresh invoice for the actual request before serving a protected resource."""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from decimal import Decimal

from ....interfaces import PaymentFlowConfig
from ....schemas import (
    AssetAmount,
    Network,
    PaymentPayload,
    PaymentRequirements,
    Price,
    SupportedKind,
)
from ....schemas.hooks import AbortResult, SettleContext
from ..binding import RequestBinding
from ..constants import DEFAULT_CLOCK_SKEW, NETWORKS, LightningValidationError, invalid
from ..types import LightningReceiver
from ..validation import validate_amount, validate_invoice, validate_skew, validate_terms

MoneyParser = Callable[[str | int | float, str], AssetAmount | None]


class ExactLnbtcScheme:
    scheme = "exact"
    default_asset_transfer_method = "bolt11"
    payment_flows: dict[str, PaymentFlowConfig] = {
        "bolt11": {"supported": ("upfront",), "default": "upfront"}
    }
    dynamic_extra_fields = ["invoice"]

    def __init__(
        self,
        receiver: LightningReceiver,
        request_binding: Callable[[], RequestBinding],
        *,
        clock: Callable[[], float] = time.time,
        clock_skew: int = DEFAULT_CLOCK_SKEW,
        allow_invoice: Callable[[], bool] | None = None,
    ) -> None:
        validate_skew(clock_skew)
        self._receiver = receiver
        self._request_binding = request_binding
        self._clock = clock
        self._skew = clock_skew
        self._allow_invoice = allow_invoice
        self._money_parsers: list[MoneyParser] = []

    def register_money_parser(self, parser: MoneyParser) -> ExactLnbtcScheme:
        self._money_parsers.append(parser)
        return self

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        if network not in NETWORKS:
            raise LightningValidationError("unsupported_network")
        if isinstance(price, dict):
            price = AssetAmount(**price)
        if isinstance(price, AssetAmount):
            result = price
        elif isinstance(price, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)? sats?", price):
            amount = Decimal(price.split()[0]) * 1000
            if amount != amount.to_integral_value():
                raise invalid("amount")
            result = AssetAmount(asset="BTC", amount=str(int(amount)))
        else:
            result = None
            for parser in self._money_parsers:
                result = parser(price, network)
                if result is not None:
                    break
        if result is None:
            raise ValueError("Use an explicit BTC AssetAmount in millisatoshis")
        if result.asset != "BTC":
            raise invalid("asset")
        validate_amount(result.amount)
        return result

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        requirements = requirements.model_copy(deep=True)
        requirements.extra.setdefault("assetTransferMethod", "bolt11")
        requirements.extra.setdefault("paymentFlow", "upfront")
        requirements.extra.update(self._request_binding().extra())
        validate_terms(requirements, require_invoice=False)
        if self._allow_invoice is not None and not self._allow_invoice():
            raise LightningValidationError("exact_lnbtc_invoice_issuance_denied")
        invoice = self._receiver.create_invoice(
            amount_msat=int(requirements.amount),
            description_hash=requirements.extra["requestHash"],
            expiry_seconds=requirements.max_timeout_seconds,
            network=requirements.network,
        )
        validate_invoice(invoice, requirements, now=self._clock(), clock_skew=self._skew)
        requirements.extra["invoice"] = invoice
        return requirements

    def before_settle(self, context: SettleContext) -> AbortResult | None:
        try:
            if not isinstance(context.payment_payload, PaymentPayload) or not isinstance(
                context.requirements, PaymentRequirements
            ):
                raise LightningValidationError("unsupported_scheme")
            binding = self._request_binding()
            binding.check(context.requirements.extra)
            resource = context.payment_payload.resource
            if resource is None or resource.url != binding.resource_url:
                raise invalid("request_mismatch")
        except LightningValidationError as exc:
            return AbortResult(reason=str(exc))
        return None
