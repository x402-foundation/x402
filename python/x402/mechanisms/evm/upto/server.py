"""EVM server implementation for the Upto payment scheme."""

from collections.abc import Callable

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ..constants import SCHEME_UPTO
from ..utils import (
    get_asset_info,
    get_network_config,
    parse_amount,
    parse_money_to_decimal,
)

MoneyParser = Callable[[float, str], AssetAmount | None]


class UptoEvmScheme:
    """EVM server implementation for the Upto payment scheme.

    Always sets assetTransferMethod=permit2 and injects facilitatorAddress.

    Attributes:
        scheme: The scheme identifier ("upto").
    """

    scheme = SCHEME_UPTO

    def __init__(self):
        self._money_parsers: list[MoneyParser] = []

    def register_money_parser(self, parser: MoneyParser) -> "UptoEvmScheme":
        self._money_parsers.append(parser)
        return self

    def get_asset_decimals(self, _asset: str, network: Network) -> int:
        try:
            asset_info = get_asset_info(str(network), _asset)
            return asset_info["decimals"]
        except ValueError:
            pass
        return 6

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        if isinstance(price, dict) and "amount" in price:
            if not price.get("asset"):
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return AssetAmount(
                amount=price["amount"],
                asset=price["asset"],
                extra=price.get("extra", {}),
            )

        if isinstance(price, AssetAmount):
            if not price.asset:
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return price

        decimal_amount = parse_money_to_decimal(price)

        for parser in self._money_parsers:
            result = parser(decimal_amount, str(network))
            if result is not None:
                return result

        return self._default_money_conversion(decimal_amount, str(network))

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        """Add upto-specific enhancements: always permit2 + facilitatorAddress."""
        config = get_network_config(str(requirements.network))

        if not requirements.asset:
            default = config.get("default_asset")
            if not default or not default.get("address"):
                raise ValueError(
                    f"No default stablecoin configured for network {requirements.network}; "
                    "use register_money_parser or specify an explicit asset address"
                )
            requirements.asset = default["address"]

        try:
            asset_info = get_asset_info(str(requirements.network), requirements.asset)
        except ValueError:
            asset_info = None

        if "." in requirements.amount:
            if asset_info is None:
                raise ValueError(
                    f"Token {requirements.asset} is not a registered asset for network "
                    f"{requirements.network}; provide amount in atomic units"
                )
            requirements.amount = str(parse_amount(requirements.amount, asset_info["decimals"]))

        if requirements.extra is None:
            requirements.extra = {}

        # Upto always uses Permit2
        requirements.extra["assetTransferMethod"] = "permit2"

        if asset_info is not None:
            requirements.extra.setdefault("name", asset_info.get("name"))
            requirements.extra.setdefault("version", asset_info.get("version"))

        # Copy facilitatorAddress from supportedKind.extra (required for upto)
        kind_extra = supported_kind.extra or {}
        facilitator_address = kind_extra.get("facilitatorAddress")
        if not facilitator_address:
            raise ValueError(
                "upto scheme requires facilitatorAddress in supported kinds. "
                "Ensure facilitator get_extra() returns facilitatorAddress."
            )
        requirements.extra["facilitatorAddress"] = facilitator_address

        # Copy extension data declared by the facilitator.
        for key in extension_keys:
            if key in kind_extra:
                requirements.extra[key] = kind_extra[key]

        return requirements

    def _default_money_conversion(self, amount: float, network: str) -> AssetAmount:
        config = get_network_config(network)
        asset = config.get("default_asset")

        if not asset or not asset.get("address"):
            raise ValueError(
                f"No default stablecoin configured for network {network}; "
                "use register_money_parser or specify an explicit AssetAmount"
            )

        token_amount = int(amount * (10 ** asset["decimals"]))

        extra: dict = {
            "assetTransferMethod": "permit2",
        }
        if asset.get("name"):
            extra["name"] = asset["name"]
        if asset.get("version"):
            extra["version"] = asset["version"]

        return AssetAmount(
            amount=str(token_amount),
            asset=asset["address"],
            extra=extra,
        )
