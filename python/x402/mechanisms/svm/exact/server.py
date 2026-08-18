"""SVM server implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ....schemas.helpers import convert_to_token_amount, parse_money
from ..constants import SCHEME_EXACT
from ..default_assets import find_default_asset, get_default_asset

if TYPE_CHECKING:
    from solana.rpc.api import Client as SolanaClient

# Type alias for money parser (sync)
MoneyParser = Callable[[str | int | float, str], AssetAmount | None]


class ExactSvmScheme:
    """SVM server implementation for the Exact payment scheme (V2).

    Parses prices and enhances payment requirements with feePayer info.

    Note: parse_price orchestrates shared helpers plus scheme asset/extra.

    Attributes:
        scheme: The scheme identifier ("exact").
    """

    scheme = SCHEME_EXACT

    def __init__(self, rpc_url: str | None = None):
        """Create ExactSvmScheme.

        Args:
            rpc_url: Optional RPC URL used to add blockhash construction hints.
        """
        self._money_parsers: list[MoneyParser] = []
        self._rpc_client: SolanaClient | None = None
        if rpc_url:
            try:
                from solana.rpc.api import Client as SolanaClient
            except ImportError as e:
                raise ImportError(
                    "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
                ) from e
            self._rpc_client = SolanaClient(rpc_url)

    def register_money_parser(self, parser: MoneyParser) -> ExactSvmScheme:
        """Register custom money parser in the parser chain.

        Multiple parsers can be registered - tried in registration order.
        Each parser receives a decimal string (e.g., "1.50" for $1.50).
        If parser returns None, next parser is tried.
        Default parser is always the final fallback.

        Args:
            parser: Custom function to convert amount to AssetAmount.

        Returns:
            Self for chaining.
        """
        self._money_parsers.append(parser)
        return self

    def get_asset_decimals(self, asset: str, network: Network) -> int | None:
        found = find_default_asset(asset, str(network))
        return found["decimals"] if found is not None else None

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

        parsed = parse_money(price)
        decimal_amount = parsed["amount"]
        symbol = parsed.get("symbol")

        # Try custom parsers (sync)
        for parser in self._money_parsers:
            result = parser(decimal_amount, str(network))
            if result is not None:
                return result

        return self._default_money_conversion(decimal_amount, str(network), symbol)

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

        if not requirements.asset:
            requirements.asset = get_default_asset(str(requirements.network))["asset"]

        # Add feePayer from supportedKind.extra to payment requirements
        # The facilitator provides its address as the fee payer for transaction fees
        if requirements.extra is None:
            requirements.extra = {}

        extra = supported_kind.extra or {}
        if "feePayer" in extra:
            requirements.extra["feePayer"] = extra["feePayer"]

        if self._rpc_client:
            try:
                blockhash = self._rpc_client.get_latest_blockhash().value
                requirements.extra["recentBlockhash"] = str(blockhash.blockhash)
                requirements.extra["lastValidBlockHeight"] = str(blockhash.last_valid_block_height)
            except Exception:
                requirements.extra.pop("recentBlockhash", None)
                requirements.extra.pop("lastValidBlockHeight", None)

        return requirements

    def _default_money_conversion(
        self, amount: str, network: str, symbol: str | None = None
    ) -> AssetAmount:
        asset = get_default_asset(network, symbol)
        token_amount = convert_to_token_amount(amount, asset["decimals"])

        return AssetAmount(
            amount=str(token_amount),
            asset=asset["asset"],
            extra={},
        )
