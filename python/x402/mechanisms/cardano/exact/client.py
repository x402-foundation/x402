"""Cardano client implementation for the Exact payment scheme (V2)."""

from contextvars import ContextVar
from typing import Any

from ....schemas import PaymentRequired, PaymentRequirements, ResourceInfo
from ....schemas.hooks import PaymentCreationContext
from ..constants import (
    CANONICAL_CARDANO_ASSET_REGEX,
    CARDANO_ADDRESS_REGEX,
    CARDANO_UTXO_REF_REGEX,
    POSITIVE_CANONICAL_AMOUNT_REGEX,
    SCHEME_EXACT,
    is_cardano_network,
)
from ..default_assets import find_default_asset
from ..policy import resolve_cardano_policies
from ..signer import ClientCardanoSigner, ClientCardanoSignInput


class ExactCardanoScheme:
    """Create signed, unbroadcast payments through a Cardano wallet signer."""

    scheme = SCHEME_EXACT
    find_default_asset = staticmethod(find_default_asset)

    def __init__(self, signer: ClientCardanoSigner):
        """Initialize the client with a wallet that signs without broadcasting.

        Args:
            signer: Synchronous wallet implementation used to construct payments.
        """
        self._signer = signer
        self._creation_context: ContextVar[
            tuple[PaymentRequirements, ResourceInfo | None] | None
        ] = ContextVar("cardano_payment_creation", default=None)
        self.scheme_hooks = {"before_payment_creation": self.before_payment_creation}

    def before_payment_creation(self, context: PaymentCreationContext) -> None:
        """Carry resource information through the existing per-payment hook."""
        if isinstance(context.payment_required, PaymentRequired) and isinstance(
            context.selected_requirements, PaymentRequirements
        ):
            self._creation_context.set(
                (context.selected_requirements, context.payment_required.resource)
            )

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any] | None = None,
        *,
        resource: ResourceInfo | None = None,
    ) -> dict[str, Any]:
        """Create the inner payment payload for the selected requirements.

        Args:
            requirements: Network, destination, atomic amount and method-specific terms.
            extensions: Extension metadata supplied by the SDK.
            resource: Resource bound to Masumi authorization, normally supplied by
                the payment-creation hook.

        Returns:
            Signed transaction bytes as base64 and the funding-input nonce.

        Raises:
            ValueError: Requirements or the signer's returned payload are invalid.
        """
        context = self._creation_context.get()
        self._creation_context.set(None)
        if resource is None and context is not None and context[0] is requirements:
            resource = context[1]
        if not is_cardano_network(requirements.network):
            raise ValueError(f"Unsupported Cardano network: {requirements.network}")
        if not CARDANO_ADDRESS_REGEX.fullmatch(requirements.pay_to):
            raise ValueError("Invalid Cardano pay-to address")
        if not CANONICAL_CARDANO_ASSET_REGEX.fullmatch(requirements.asset):
            raise ValueError("Cardano asset must use canonical lowercase form")
        if not POSITIVE_CANONICAL_AMOUNT_REGEX.fullmatch(requirements.amount):
            raise ValueError("Amount must be a positive canonical integer")
        if resolve_cardano_policies(requirements.extra) is None:
            raise ValueError("Cardano payment requirements carry an invalid confirmation policy")
        result = self._signer.build_and_sign_payment_transaction(
            ClientCardanoSignInput(
                network=requirements.network,
                pay_to=requirements.pay_to,
                asset=requirements.asset,
                amount=requirements.amount,
                max_timeout_seconds=requirements.max_timeout_seconds,
                extra=requirements.extra,
                resource=resource,
            )
        )
        if not result or not isinstance(result.transaction, str) or not result.transaction:
            raise ValueError("Cardano signer returned an empty transaction")
        if not result.nonce or not CARDANO_UTXO_REF_REGEX.fullmatch(result.nonce):
            raise ValueError("Cardano signer returned an invalid nonce")
        return result.to_dict()
