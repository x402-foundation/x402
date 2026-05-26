"""TVM server implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

import re
from collections.abc import Callable
from decimal import Decimal

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ..codecs.common import (
    encode_base64_boc,
    make_zero_bit_cell,
    normalize_address,
    parse_amount,
    parse_money_to_decimal,
)
from ..constants import (
    DEFAULT_DECIMALS,
    SCHEME_EXACT,
    TVM_MAINNET,
    TVM_TESTNET,
    USDT_MAINNET_MINTER,
    USDT_TESTNET_MINTER,
)

MoneyParser = Callable[[float, str], AssetAmount | None]


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

        if isinstance(price, int):
            exact_decimal_amount = Decimal(price)
        elif isinstance(price, float):
            exact_decimal_amount = Decimal(str(price))
        else:
            clean = price.strip()
            clean = clean.lstrip("$")
            clean = re.sub(r"\s*(USD|USDT|usd|usdt)\s*$", "", clean)
            exact_decimal_amount = Decimal(clean.strip())

        decimal_amount = parse_money_to_decimal(price)
        for parser in self._money_parsers:
            result = parser(decimal_amount, str(network))
            if result is not None:
                return result

        return self._default_money_conversion(exact_decimal_amount, str(network))

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        """Add TVM-specific fields to payment requirements."""
        _ = extension_keys

        if not requirements.asset:
            requirements.asset = self._get_default_asset(str(requirements.network))
        requirements.asset = normalize_address(requirements.asset)
        requirements.pay_to = normalize_address(requirements.pay_to)

        if "." in requirements.amount:
            requirements.amount = str(
                parse_amount(requirements.amount, self._get_asset_decimals(requirements))
            )

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

    def _default_money_conversion(self, amount: Decimal, network: str) -> AssetAmount:
        return AssetAmount(
            amount=str(parse_amount(format(amount, "f"), DEFAULT_DECIMALS)),
            asset=self._get_default_asset(network),
            extra={
                "areFeesSponsored": True,
                "forwardPayload": encode_base64_boc(make_zero_bit_cell()),
                "forwardTonAmount": "0",
            },
        )

    def _get_default_asset(self, network: str) -> str:
        if network == TVM_MAINNET:
            return USDT_MAINNET_MINTER
        if network == TVM_TESTNET:
            return USDT_TESTNET_MINTER
        raise ValueError(
            f"No default stablecoin configured for network {network}; specify an explicit asset"
        )

    def _get_asset_decimals(self, requirements: PaymentRequirements) -> int:
        extra = requirements.extra or {}
        if "decimals" in extra:
            return int(extra["decimals"])
        if normalize_address(requirements.asset) in {
            USDT_MAINNET_MINTER,
            USDT_TESTNET_MINTER,
        }:
            return DEFAULT_DECIMALS
        raise ValueError(
            f"Token {requirements.asset} is not a registered asset for network "
            f"{requirements.network}; provide amount in atomic units or extra.decimals"
        )
