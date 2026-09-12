"""BIP-122 server implementation for the Exact payment scheme (V2)."""

from collections.abc import Callable

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ..constants import (
    BTC_ASSET,
    DEFAULT_INVOICE_DESCRIPTION,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
    SCHEME_EXACT,
)
from ..receiver import LightningReceiver
from ..utils import decode_invoice, normalize_network, sat_to_msat

MoneyParser = Callable[[str | int | float, str], AssetAmount | None]


class ExactBip122Scheme:
    """BIP-122 server implementation for the Exact payment scheme (V2)."""

    scheme = SCHEME_EXACT

    def __init__(
        self,
        receiver: LightningReceiver,
        default_description: str = DEFAULT_INVOICE_DESCRIPTION,
    ):
        self._receiver = receiver
        self._default_description = default_description
        self._money_parsers: list[MoneyParser] = []

    def register_money_parser(self, parser: MoneyParser) -> "ExactBip122Scheme":
        """Register a custom parser for money inputs."""
        self._money_parsers.append(parser)
        return self

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """Parse price into a BTC-denominated AssetAmount measured in millisatoshis."""
        network_str = normalize_network(str(network))

        if isinstance(price, dict) and "amount" in price:
            if price.get("asset") != BTC_ASSET:
                raise ValueError("Lightning AssetAmount must use BTC")
            return AssetAmount(
                amount=price["amount"],
                asset=price["asset"],
                extra=price.get("extra", {}),
            )

        if isinstance(price, AssetAmount):
            if price.asset != BTC_ASSET:
                raise ValueError("Lightning AssetAmount must use BTC")
            return price

        for parser in self._money_parsers:
            result = parser(price, network_str)
            if result is not None:
                return result

        return AssetAmount(amount=str(sat_to_msat(price)), asset=BTC_ASSET, extra={})

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        """Add Lightning-specific fields and generate a fresh invoice."""
        _ = supported_kind
        _ = extension_keys

        requirements.asset = BTC_ASSET
        requirements.pay_to = PAY_TO_ANONYMOUS
        if requirements.extra is None:
            requirements.extra = {}

        description = str(requirements.extra.get("description") or self._default_description)
        network = normalize_network(str(requirements.network))
        invoice = self._receiver.create_invoice(
            amount_msat=int(requirements.amount),
            memo=description,
            expiry_seconds=requirements.max_timeout_seconds,
            network=network,
        )

        decoded = decode_invoice(invoice)
        invoice_amount_msat = int(decoded.amount_msat or 0)
        if invoice_amount_msat != int(requirements.amount):
            raise ValueError("Receiver returned invoice with mismatched amount")

        requirements.extra["paymentMethod"] = PAYMENT_METHOD_LIGHTNING
        requirements.extra["invoice"] = invoice
        return requirements
