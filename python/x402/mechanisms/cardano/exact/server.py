"""Cardano server implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace

from ....interfaces import SchemePaymentRequiredContext
from ....schemas import AssetAmount, PaymentPayload, PaymentRequirements, Price, SupportedKind
from ....schemas.helpers import convert_to_token_amount, parse_money
from ....schemas.hooks import AbortResult, VerifyResultContext
from .. import constants as c
from ..default_assets import find_default_asset, get_default_asset
from ..policy import resolve_cardano_policies
from ..utils import decode_cardano_transaction
from .masumi.digests import build_signed_terms, compute_terms_digest
from .masumi.schema import validate_masumi_extra
from .masumi.storage import InMemoryMasumiTermsStorage, MasumiTerms, MasumiTermsStorage
from .masumi_issuer import (
    MasumiIssuerConfig,
    MasumiQuoteIssuer,
    is_masumi_extra,
    is_masumi_template,
)

MoneyParser = Callable[[str | int | float, str], AssetAmount | None]


def _terms_digest(requirements: PaymentRequirements) -> str:
    return compute_terms_digest(build_signed_terms(requirements.extra, requirements))


class ExactCardanoScheme:
    """Parse Cardano prices and bind issued Masumi quotes to a single transaction."""

    scheme = c.SCHEME_EXACT
    default_asset_transfer_method = "default"
    payment_flows = {
        method: {"supported": ("authorization",), "default": "authorization"}
        for method in ("default", "masumi", "script")
    }

    def __init__(
        self,
        *,
        masumi_storage: MasumiTermsStorage | None = None,
        masumi: MasumiIssuerConfig | None = None,
    ):
        """Configure pricing and optional per-request Masumi quote issuance.

        Args:
            masumi_storage: Atomic issued-quote storage. The default is process-local;
                replicas serving the same routes need a shared implementation.
            masumi: Seller and request-commitment configuration for route templates.
        """
        self._money_parsers: list[MoneyParser] = []
        self._storage = masumi_storage or InMemoryMasumiTermsStorage()
        self._issuer = MasumiQuoteIssuer(masumi) if masumi else None

    def register_money_parser(self, parser: MoneyParser) -> ExactCardanoScheme:
        """Append a price parser; return this scheme for fluent configuration.

        Parsers run in registration order and return None to defer to the next
        parser or the network's default asset.
        """
        self._money_parsers.append(parser)
        return self

    def parse_price(self, price: Price, network: str) -> AssetAmount:
        """Resolve a price to a canonical asset and positive atomic amount.

        Args:
            price: Explicit AssetAmount or a price understood by the SDK money parser.
            network: Canonical Cardano network identifier or supported CIP-34 alias.

        Returns:
            AssetAmount suitable for Cardano payment requirements.

        Raises:
            ValueError: The price, asset or atomic amount is invalid or unsupported.
        """
        if isinstance(price, dict) and "amount" in price:
            if not price.get("asset"):
                raise ValueError(f"Asset unit must be specified for AssetAmount on {network}")
            return self._validate_amount(AssetAmount(**price))
        if isinstance(price, AssetAmount):
            return self._validate_amount(price)
        parsed = parse_money(price)
        for parser in self._money_parsers:
            result = parser(parsed["amount"], network)
            if result is not None:
                return self._validate_amount(result)
        asset = get_default_asset(network, parsed.get("symbol"))
        return self._validate_amount(
            AssetAmount(
                asset=asset["asset"],
                amount=convert_to_token_amount(parsed["amount"], asset["decimals"]),
                extra={},
            )
        )

    @staticmethod
    def _validate_amount(value: AssetAmount) -> AssetAmount:
        if not c.POSITIVE_CANONICAL_AMOUNT_REGEX.fullmatch(value.amount):
            raise ValueError("Cardano amount must be a positive canonical integer")
        if not c.CANONICAL_CARDANO_ASSET_REGEX.fullmatch(value.asset):
            raise ValueError("Cardano asset must use canonical lowercase form")
        return value

    def get_asset_decimals(self, asset: str, network: str) -> int | None:
        """Return known default-asset decimals, or None for an unrecognized asset."""
        found = find_default_asset(asset, network)
        return found["decimals"] if found else None

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        """Validate route requirements against advertised facilitator capabilities.

        Args:
            requirements: Route requirements, which may contain a Masumi template.
            supported_kind: Facilitator methods and confirmation range for the route.
            extension_keys: Extension identifiers supplied by the SDK.

        Returns:
            A copy of the requirements with the facilitator's fee-sponsorship flag.

        Raises:
            ValueError: The route requests an unsupported capability or invalid quote.
        """
        if not c.is_cardano_network(supported_kind.network):
            raise ValueError(f"Unsupported Cardano network: {supported_kind.network}")
        if is_masumi_template(requirements.extra):
            if self._issuer is None:
                raise ValueError(
                    "Masumi requirements must carry seller-signed terms or configure a masumi issuer"
                )
            self._issuer.assert_template(requirements)
        self._assert_capabilities(requirements, supported_kind)
        extra = dict(requirements.extra)
        sponsored = (supported_kind.extra or {}).get("areFeesSponsored")
        if type(sponsored) is bool:
            extra["areFeesSponsored"] = sponsored
        return requirements.model_copy(update={"extra": extra})

    @staticmethod
    def _assert_capabilities(
        requirements: PaymentRequirements, supported_kind: SupportedKind
    ) -> None:
        capabilities = supported_kind.extra
        if capabilities is None:
            return
        if not isinstance(capabilities, dict):
            raise ValueError("Cardano facilitator advertised a malformed capability block")
        methods = capabilities.get("assetTransferMethods")
        method = requirements.extra.get("assetTransferMethod", "default")
        if not isinstance(methods, list) or method not in methods:
            raise ValueError(f"Cardano facilitator does not support assetTransferMethod {method}")
        policy = resolve_cardano_policies(requirements.extra)
        if policy is None:
            raise ValueError("Cardano requirements carry an invalid confirmation policy")
        interval = capabilities.get("l1Confirmations")
        if not isinstance(interval, dict):
            raise ValueError("Cardano facilitator did not advertise an l1Confirmations range")
        minimum, maximum = interval.get("minimum"), interval.get("maximum")
        if (
            type(minimum) is not int
            or type(maximum) is not int
            or not minimum <= policy.confirmation_policy.l1_confirmations <= maximum
        ):
            raise ValueError(
                "Cardano facilitator confirmation range does not include the requested depth"
            )
        if method == "masumi" and not is_masumi_template(requirements.extra):
            result = validate_masumi_extra(requirements.extra, requirements.network)
            if not result.ok:
                raise ValueError(f"Cardano Masumi requirements are invalid: {result.detail}")

    def enrich_payment_required_response(
        self, context: SchemePaymentRequiredContext
    ) -> list[PaymentRequirements] | None:
        # Core invokes this hook once per accept, without passing the current index.
        # Private response state survives its model_copy calls and is never serialized.
        visited = getattr(context.payment_required_response, "_cardano_enriched_accepts", None)
        if visited is None:
            visited = set()
            object.__setattr__(
                context.payment_required_response, "_cardano_enriched_accepts", visited
            )
        replaced = None
        for index, requirement in enumerate(context.requirements):
            if (
                requirement.scheme != self.scheme
                or not c.is_cardano_network(requirement.network)
                or index in visited
            ):
                continue
            visited.add(index)
            if not is_masumi_extra(requirement.extra):
                return None
            served = requirement
            if is_masumi_template(requirement.extra):
                if self._issuer is None:
                    raise ValueError(
                        "Masumi requirements must carry seller-signed terms or configure a masumi issuer"
                    )
                paid = self._issuer.paid_payload(context.payment_payload, context.transport_context)
                commitment = self._issuer.commitment(
                    requirement, context.resource_info, context.transport_context
                )
                served = self._stored_quote_for(
                    paid, requirement, self._issuer.commitment_digest(commitment)
                ) or self._issuer.issue(
                    requirement,
                    context.resource_info,
                    context.transport_context,
                    commitment=commitment,
                )
                replaced = list(context.requirements)
                replaced[index] = served
            digest = _terms_digest(served)
            stored = served.model_copy(deep=True)
            self._remember_quote(MasumiTerms(digest, stored))
            break
        return replaced

    def _remember_quote(self, quote: MasumiTerms) -> None:
        self._storage.update_terms(quote.terms_digest, lambda current: current or quote)

    def _stored_quote_for(
        self, payload: PaymentPayload | None, template: PaymentRequirements, input_digest: str
    ) -> PaymentRequirements | None:
        if payload is None:
            return None
        accepted = payload.accepted
        if (
            accepted.scheme != template.scheme
            or c.normalize_cardano_network(accepted.network)
            != c.normalize_cardano_network(template.network)
            or not is_masumi_extra(accepted.extra)
            or not validate_masumi_extra(accepted.extra, accepted.network).ok
        ):
            return None
        record = self._storage.get(_terms_digest(accepted))
        if record is None:
            return None
        stored = record.requirements
        if stored.extra["inputCommitment"]["digest"] != input_digest:
            return None
        if any(
            getattr(stored, key) != getattr(template, key)
            for key in ("scheme", "network", "pay_to", "amount", "asset", "max_timeout_seconds")
        ):
            return None
        if any(stored.extra.get(key) != value for key, value in template.extra.items()):
            return None
        return stored.model_copy(deep=True)

    def after_verify(self, context: VerifyResultContext) -> AbortResult | None:
        """Allow retries of the same transaction, but reject quote substitution or reuse."""
        if not context.result.is_valid or not isinstance(context.payment_payload, PaymentPayload):
            return None
        accepted = context.payment_payload.accepted
        if not is_masumi_extra(accepted.extra):
            return None
        try:
            digest = _terms_digest(accepted)
            tx_hash = decode_cardano_transaction(
                context.payment_payload.payload["transaction"]
            ).tx_hash
        except Exception as exc:
            return AbortResult(c.ERR_INVALID_PAYLOAD, str(exc))

        def claim(current: MasumiTerms | None) -> MasumiTerms | None:
            if (
                current is None
                or accepted != current.requirements
                or current.claimed_tx_hash is not None
            ):
                return current
            return replace(current, claimed_tx_hash=tx_hash)

        stored = self._storage.update_terms(digest, claim).terms
        if stored is None:
            return AbortResult(
                c.ERR_MASUMI_TERMS_UNKNOWN, "Masumi payment quotes terms this server did not issue"
            )
        if accepted != stored.requirements:
            return AbortResult(
                c.ERR_MASUMI_TERMS_MISMATCH,
                "Masumi payment altered the issued payment requirements",
            )
        if stored.claimed_tx_hash != tx_hash:
            return AbortResult(
                c.ERR_DUPLICATE_SETTLEMENT,
                "Masumi terms are already bound to a different Cardano transaction",
            )
        return None
