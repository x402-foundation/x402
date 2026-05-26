"""SVM server implementation for the Exact payment scheme (V2)."""

from collections.abc import Callable

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ..constants import DEFAULT_DECIMALS, SCHEME_EXACT
from ..utils import get_network_config, get_usdc_address, parse_money_to_decimal

# Type alias for money parser (sync)
MoneyParser = Callable[[float, str], AssetAmount | None]


class ExactSvmScheme:
    """SVM server implementation for the Exact payment scheme (V2).

    Parses prices and enhances payment requirements with feePayer info.

    Note: Money/price parsing lives here, not as a standalone utility.
    USD→atomic conversion is scheme-specific.

    Attributes:
        scheme: The scheme identifier ("exact").
    """

    scheme = SCHEME_EXACT

    def __init__(self):
        """Create ExactSvmScheme."""
        self._money_parsers: list[MoneyParser] = []

    def register_money_parser(self, parser: MoneyParser) -> "ExactSvmScheme":
        """Register custom money parser in the parser chain.

        Multiple parsers can be registered - tried in registration order.
        Each parser receives decimal amount (e.g., 1.50 for $1.50).
        If parser returns None, next parser is tried.
        Default parser is always the final fallback.

        Args:
            parser: Custom function to convert amount to AssetAmount.

        Returns:
            Self for chaining.
        """
        self._money_parsers.append(parser)
        return self

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """Parse price into asset amount.

        If price is already AssetAmount, returns it directly.
        If price is Money (str|float), parses and tries custom parsers.
        Falls back to default USDC conversion.

        Args:
            price: Price to parse (string, number, or AssetAmount dict).
            network: Network identifier.

        Returns:
            AssetAmount with amount, asset, and extra fields.

        Raises:
            ValueError: If asset address is missing for AssetAmount input.
        """
        # Already an AssetAmount (dict with 'amount' key)
        if isinstance(price, dict) and "amount" in price:
            if not price.get("asset"):
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return AssetAmount(
                amount=price["amount"],
                asset=price["asset"],
                extra=price.get("extra", {}),
            )

        # Already an AssetAmount object
        if isinstance(price, AssetAmount):
            if not price.asset:
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return price

        # Parse Money to decimal
        decimal_amount = parse_money_to_decimal(price)

        # Try custom parsers (sync)
        for parser in self._money_parsers:
            result = parser(decimal_amount, str(network))
            if result is not None:
                return result

        # Default: convert to USDC
        return self._default_money_conversion(decimal_amount, str(network))

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        """Add scheme-specific enhancements to payment requirements.

        For SVM, adds feePayer from facilitator's supported kind.

        Args:
            requirements: Base payment requirements.
            supported_kind: Supported kind from facilitator (contains feePayer).
            extension_keys: Extension keys being used.

        Returns:
            Enhanced payment requirements with feePayer in extra.
        """
        # Mark unused parameters to satisfy linter
        _ = extension_keys

        config = get_network_config(str(requirements.network))

        # Default asset
        if not requirements.asset:
            requirements.asset = config["default_asset"]["address"]

        # Add feePayer from supportedKind.extra to payment requirements
        # The facilitator provides its address as the fee payer for transaction fees
        if requirements.extra is None:
            requirements.extra = {}

        extra = supported_kind.extra or {}
        if "feePayer" in extra:
            requirements.extra["feePayer"] = extra["feePayer"]

        return requirements

    def _default_money_conversion(self, amount: float, network: str) -> AssetAmount:
        """Convert decimal amount to USDC AssetAmount.

        Args:
            amount: Decimal amount (e.g., 1.50).
            network: Network identifier.

        Returns:
            AssetAmount in USDC.
        """
        # Convert to smallest unit (6 decimals for USDC)
        token_amount = int(amount * (10**DEFAULT_DECIMALS))

        return AssetAmount(
            amount=str(token_amount),
            asset=get_usdc_address(network),
            extra={},
        )
