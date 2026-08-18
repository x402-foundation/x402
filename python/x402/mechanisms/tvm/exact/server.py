"""TVM server implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

from collections.abc import Callable

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ....schemas.helpers import convert_to_token_amount, parse_money
from ..codecs.common import (
    encode_base64_boc,
    make_zero_bit_cell,
    normalize_address,
    parse_amount,
)
from ..constants import (
    SCHEME_EXACT,
)
from ..default_assets import find_default_asset, get_default_asset

MoneyParser = Callable[[str | int | float, str], AssetAmount | None]


class ExactTvmScheme:
    """TVM server implementation for the Exact payment scheme (V2)."""

    scheme = SCHEME_EXACT

    def __init__(self) -> None:
        self._money_parsers: list[MoneyParser] = []

    def register_money_parser(self, parser: MoneyParser) -> ExactTvmScheme:
        """Register a custom money parser."""
        self._money_parsers.append(parser)
        return self

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """Parse price into a normalized AssetAmount."""
        if isinstance(price, dict) and "amount" in price:
            if not price.get("asset"):
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return AssetAmount(
                amount=price["amount"],
                asset=normalize_address(price["asset"]),
                extra=price.get("extra", {}),
            )

        if isinstance(price, AssetAmount):
            if not price.asset:
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return AssetAmount(
                amount=price.amount,
                asset=normalize_address(price.asset),
                extra=price.extra,
            )

        parsed = parse_money(price)
        decimal_amount = parsed["amount"]
        symbol = parsed.get("symbol")
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
        """Add TVM-specific fields to payment requirements."""
        _ = extension_keys

        if not requirements.asset:
            requirements.asset = get_default_asset(str(requirements.network))["asset"]
        requirements.asset = normalize_address(requirements.asset)
        requirements.pay_to = normalize_address(requirements.pay_to)

        if "." in requirements.amount:
            extra = requirements.extra or {}
            if "decimals" in extra:
                decimals = int(extra["decimals"])
            else:
                decimals = self.get_asset_decimals(requirements.asset, requirements.network)
            requirements.amount = str(parse_amount(requirements.amount, decimals))

        if requirements.extra is None:
            requirements.extra = {}
        if (
            "responseDestination" in requirements.extra
            and requirements.extra["responseDestination"] is not None
        ):
            requirements.extra["responseDestination"] = normalize_address(
                requirements.extra["responseDestination"]
            )
        if "areFeesSponsored" not in requirements.extra:
            requirements.extra["areFeesSponsored"] = (supported_kind.extra or {}).get(
                "areFeesSponsored",
                True,
            )

        return requirements

    def _default_money_conversion(
        self, amount: str, network: str, symbol: str | None = None
    ) -> AssetAmount:
        asset = get_default_asset(network, symbol)
        return AssetAmount(
            amount=convert_to_token_amount(amount, asset["decimals"]),
            asset=asset["asset"],
            extra={
                "areFeesSponsored": True,
                "forwardPayload": encode_base64_boc(make_zero_bit_cell()),
                "forwardTonAmount": "0",
            },
        )

    def get_asset_decimals(self, asset: str, network: Network) -> int:
        found = find_default_asset(asset, str(network))
        if found is None:
            raise ValueError(
                f"Token {asset} is not a registered asset; provide amount in atomic units "
                "or extra.decimals"
            )
        return found["decimals"]
