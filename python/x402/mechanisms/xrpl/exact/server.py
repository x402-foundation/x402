"""XRPL resource-server helpers for the exact payment scheme."""

from __future__ import annotations

from collections.abc import Callable

from ....schemas import AssetAmount, Network, PaymentRequirements, Price, SupportedKind
from ..constants import ASSET_XRP, MAX_DESTINATION_TAG, SCHEME_EXACT
from ..types import is_asset_transfer_method
from ..utils import (
    is_classic_address,
    is_destination_tag,
    is_issued_currency_value,
    normalize_currency_code,
    parse_drops,
    parse_money_to_decimal,
)

# Converts a decimal money amount into an XRPL asset amount, or returns None
# to pass the value to the next parser in the chain.
MoneyParser = Callable[[float, Network], AssetAmount | None]


def _require_asset_transfer_method(extra: dict[str, object] | None) -> None:
    """Reject a transfer method the facilitator would not accept.

    Args:
        extra: Scheme-specific extra fields, if any.

    Raises:
        ValueError: If the method is present and unsupported.
    """
    method = (extra or {}).get("assetTransferMethod")
    if method is not None and not is_asset_transfer_method(method):
        raise ValueError(f"Unsupported assetTransferMethod: {method!r}")


class ExactXrplScheme:
    """Prices and enriches payment requirements for XRPL networks."""

    scheme = SCHEME_EXACT

    def __init__(self) -> None:
        """Create the server scheme."""
        self._money_parsers: list[MoneyParser] = []

    def register_money_parser(self, parser: MoneyParser) -> ExactXrplScheme:
        """Register a custom money parser in the parser chain.

        Parsers are tried in registration order; each receives the decimal
        amount and the network, and returns an :class:`AssetAmount` or None to
        defer to the next parser. XRPL has no on-ledger rate, so there is no
        default conversion behind the chain.

        Args:
            parser: Converts a decimal amount into an asset amount.

        Returns:
            Self, for chaining.
        """
        self._money_parsers.append(parser)
        return self

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """Normalise a configured price into an explicit asset amount.

        An explicit :class:`AssetAmount` (drops for XRP, or the
        issued-currency value) is validated and passed through. A money
        price such as ``"$0.01"`` is dispatched to the registered parsers,
        since XRPL has no on-ledger rate to convert it here.

        Args:
            price: Configured price.
            network: Target network.

        Returns:
            The normalised amount.

        Raises:
            ValueError: If the price is malformed for its asset, or is a money
                value no registered parser converts.
        """
        if isinstance(price, AssetAmount):
            return self._validated(price, network)
        if isinstance(price, dict) and "amount" in price:
            return self._validated(
                AssetAmount(
                    amount=price["amount"], asset=price.get("asset", ""), extra=price.get("extra")
                ),
                network,
            )

        if not isinstance(price, str | int | float):
            raise ValueError(f"Unsupported price format on {network}: {price!r}")

        decimal_amount = parse_money_to_decimal(price)
        for parser in self._money_parsers:
            result = parser(decimal_amount, network)
            if result is not None:
                # Parser output is validated like explicit configuration,
                # starting with its type, so a wrong return raises the
                # ValueError this function documents.
                if not isinstance(result, AssetAmount):
                    raise ValueError(
                        f"A money parser must return an AssetAmount or None, got {result!r}"
                    )
                return self._validated(result, network)

        raise ValueError(
            f"XRPL prices must be an explicit AssetAmount on {network}: there is no "
            "on-ledger rate to convert a money price. Use drops for XRP, the "
            "issued-currency value, or register a money parser."
        )

    def _validated(self, amount: AssetAmount, network: Network) -> AssetAmount:
        """Validate an asset amount for XRPL.

        Args:
            amount: Candidate asset amount.
            network: Target network, for error messages.

        Returns:
            The validated amount.

        Raises:
            ValueError: If the amount is malformed for its asset.
        """
        if not amount.asset:
            raise ValueError(f"Asset is required for an AssetAmount on {network}")

        _require_asset_transfer_method(amount.extra)
        if amount.asset == ASSET_XRP:
            if parse_drops(amount.amount) is None:
                raise ValueError(
                    f"XRP amounts are drops: a non-negative integer string, got {amount.amount!r}"
                )
        else:
            # A missing issuer is the server's own misconfiguration; caught
            # here rather than failing every payment at verification.
            issuer = (amount.extra or {}).get("issuer")
            if not is_classic_address(issuer):
                raise ValueError(
                    f"{amount.asset} payments require extra.issuer to be an XRPL classic "
                    f"address, got {issuer!r}"
                )
            if not is_issued_currency_value(amount.amount):
                raise ValueError(
                    f"{amount.asset} amounts are a non-negative decimal string, "
                    f"got {amount.amount!r}"
                )
            if normalize_currency_code(amount.asset) is None:
                raise ValueError(
                    "Issued currencies are a 3-character code or 40 hex characters, "
                    f"got {amount.asset!r}"
                )
        return amount

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        """Add the scheme fields a payer needs to build a valid transaction.

        Args:
            requirements: Base requirements.
            supported_kind: The facilitator's advertised capability.
            extension_keys: Enabled extension keys, unused by this scheme.

        Returns:
            The enriched requirements.
        """
        _ = extension_keys

        extra = dict(requirements.extra or {})
        # Fail here, where the configuration is, rather than as an opaque
        # rejection of every payment made against it.
        _require_asset_transfer_method(extra)
        invoice_id = extra.get("invoiceId")
        if invoice_id is not None and (not isinstance(invoice_id, str) or invoice_id == ""):
            raise ValueError(f"extra.invoiceId must be a non-empty string, got {invoice_id!r}")
        destination_tag = extra.get("destinationTag")
        if destination_tag is not None and not is_destination_tag(destination_tag):
            raise ValueError(
                f"extra.destinationTag must be an integer between 0 and "
                f"{MAX_DESTINATION_TAG}, got {destination_tag!r}"
            )
        # Overwritten rather than defaulted: a configured True would propagate
        # and fail every payment while blaming the payer.
        extra["areFeesSponsored"] = False
        # A named method is binding on the client, so only a method the
        # facilitator explicitly pinned is propagated; a default here would
        # forbid clients from electing ticketSequence.
        supported_method = (supported_kind.extra or {}).get("assetTransferMethod")
        if supported_method is not None:
            if not is_asset_transfer_method(supported_method):
                raise ValueError(f"Unsupported assetTransferMethod: {supported_method!r}")
            extra.setdefault("assetTransferMethod", supported_method)
        requirements.extra = extra
        return requirements
