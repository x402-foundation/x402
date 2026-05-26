"""Mock "cash" scheme implementation for testing.

This provides a simple mock payment scheme that simulates cash payments
for testing the core x402Client, x402ResourceServer, and x402Facilitator
integration without needing real blockchain infrastructure.
"""

import time
from typing import Any

from x402.facilitator import x402Facilitator, x402FacilitatorSync
from x402.schemas import (
    AssetAmount,
    Network,
    PaymentPayload,
    PaymentRequirements,
    Price,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)


class CashSchemeNetworkClient:
    """Client-side mock "cash" scheme implementation.

    Creates payment payloads with a simple signature format.

    Attributes:
        scheme: The scheme identifier ("cash").
    """

    scheme = "cash"

    def __init__(self, payer: str) -> None:
        """Create a CashSchemeNetworkClient.

        Args:
            payer: The name of the payer (used in signature).
        """
        self._payer = payer

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
    ) -> dict[str, Any]:
        """Create a cash payment payload.

        The payload contains:
        - signature: ~{payer_name}
        - validUntil: timestamp when payment expires
        - name: payer's name

        Args:
            requirements: The payment requirements.

        Returns:
            Inner payload dict with signature and validity.
        """
        valid_until = int(time.time() * 1000) + (requirements.max_timeout_seconds * 1000)
        return {
            "signature": f"~{self._payer}",
            "validUntil": str(valid_until),
            "name": self._payer,
        }


class CashSchemeNetworkFacilitator:
    """Facilitator-side mock "cash" scheme implementation.

    Verifies cash payments by checking signature format and expiration.

    Attributes:
        scheme: The scheme identifier ("cash").
        caip_family: The CAIP family pattern ("x402:*").
    """

    scheme = "cash"
    caip_family = "x402:*"

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get extra data for supported kinds.

        Args:
            network: The network identifier.

        Returns:
            Empty dict for cash scheme.
        """
        return {}

    def get_signers(self, network: Network) -> list[str]:
        """Get signer addresses.

        Args:
            network: The network identifier.

        Returns:
            Empty list for cash scheme.
        """
        return []

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        """Verify a cash payment.

        Checks:
        1. Signature matches expected format (~{name})
        2. Payment hasn't expired

        Args:
            payload: The payment payload.
            requirements: The payment requirements.
            context: Optional facilitator context.

        Returns:
            VerifyResponse with is_valid=True or False.
        """
        inner = payload.payload

        # Check signature format
        expected_sig = f"~{inner.get('name', '')}"
        if inner.get("signature") != expected_sig:
            return VerifyResponse(
                is_valid=False,
                invalid_reason="invalid_signature",
                payer=None,
            )

        # Check expiration
        valid_until = int(inner.get("validUntil", "0"))
        if valid_until < int(time.time() * 1000):
            return VerifyResponse(
                is_valid=False,
                invalid_reason="expired_signature",
                payer=None,
            )

        return VerifyResponse(
            is_valid=True,
            invalid_reason=None,
            payer=inner.get("signature"),
        )

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        """Settle a cash payment.

        First verifies the payment, then creates a settlement transaction.

        Args:
            payload: The payment payload.
            requirements: The payment requirements.

        Returns:
            SettleResponse with success=True or False.
        """
        verify_result = self.verify(payload, requirements, context)

        if not verify_result.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verify_result.invalid_reason,
                payer=verify_result.payer,
                transaction="",
                network=requirements.network,
            )

        name = payload.payload.get("name", "Unknown")
        transaction = (
            f"{name} transferred {requirements.amount} "
            f"{requirements.asset} to {requirements.pay_to}"
        )

        return SettleResponse(
            success=True,
            error_reason=None,
            payer=payload.payload.get("signature"),
            transaction=transaction,
            network=requirements.network,
        )


class CashSchemeNetworkServer:
    """Server-side mock "cash" scheme implementation.

    Parses prices and enhances payment requirements.

    Attributes:
        scheme: The scheme identifier ("cash").
    """

    scheme = "cash"

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """Parse a price into AssetAmount.

        Handles:
        - AssetAmount objects (passthrough)
        - String prices like "$10" or "10 USD"
        - Numeric prices

        Args:
            price: The price to parse.
            network: The network identifier.

        Returns:
            AssetAmount with amount and asset.
        """
        # Handle AssetAmount object
        if isinstance(price, AssetAmount):
            return AssetAmount(
                amount=price.amount,
                asset=price.asset or "USD",
                extra={},
            )

        # Handle string prices
        if isinstance(price, str):
            clean_price = price.lstrip("$").rstrip(" USD").rstrip(" usd").strip()
            return AssetAmount(
                amount=clean_price,
                asset="USD",
                extra={},
            )

        # Handle numeric prices
        if isinstance(price, int | float):
            return AssetAmount(
                amount=str(price),
                asset="USD",
                extra={},
            )

        raise ValueError(f"Invalid price format: {price}")

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extensions: list[str],
    ) -> PaymentRequirements:
        """Enhance payment requirements.

        Cash scheme doesn't need any enhancements.

        Args:
            requirements: Base payment requirements.
            supported_kind: The supported kind from facilitator.
            extensions: Extension keys.

        Returns:
            Unmodified payment requirements.
        """
        return requirements


class CashFacilitatorClient:
    """Mock FacilitatorClient that wraps an x402Facilitator (async).

    Used for testing the server integration without HTTP.

    Attributes:
        scheme: The scheme identifier ("cash").
        network: The network identifier ("x402:cash").
    """

    scheme = "cash"
    network = "x402:cash"
    x402_version = 2

    def __init__(self, facilitator: x402Facilitator) -> None:
        """Create a CashFacilitatorClient.

        Args:
            facilitator: The x402Facilitator to wrap.
        """
        self._facilitator = facilitator

    async def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify a payment through the facilitator.

        Args:
            payload: The payment payload.
            requirements: The payment requirements.

        Returns:
            VerifyResponse from the facilitator.
        """
        return await self._facilitator.verify(payload, requirements)

    async def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle a payment through the facilitator.

        Args:
            payload: The payment payload.
            requirements: The payment requirements.

        Returns:
            SettleResponse from the facilitator.
        """
        return await self._facilitator.settle(payload, requirements)

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds.

        Returns:
            SupportedResponse with cash scheme support.
        """
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=self.x402_version,
                    scheme=self.scheme,
                    network=self.network,
                    extra={},
                )
            ],
            extensions=[],
            signers={},
        )


class CashFacilitatorClientSync:
    """Mock FacilitatorClient that wraps an x402FacilitatorSync.

    Used for testing the server integration without HTTP.

    Attributes:
        scheme: The scheme identifier ("cash").
        network: The network identifier ("x402:cash").
    """

    scheme = "cash"
    network = "x402:cash"
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync) -> None:
        """Create a CashFacilitatorClientSync.

        Args:
            facilitator: The x402FacilitatorSync to wrap.
        """
        self._facilitator = facilitator

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify a payment through the facilitator.

        Args:
            payload: The payment payload.
            requirements: The payment requirements.

        Returns:
            VerifyResponse from the facilitator.
        """
        return self._facilitator.verify(payload, requirements)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle a payment through the facilitator.

        Args:
            payload: The payment payload.
            requirements: The payment requirements.

        Returns:
            SettleResponse from the facilitator.
        """
        return self._facilitator.settle(payload, requirements)

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds.

        Returns:
            SupportedResponse with cash scheme support.
        """
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=self.x402_version,
                    scheme=self.scheme,
                    network=self.network,
                    extra={},
                )
            ],
            extensions=[],
            signers={},
        )


def build_cash_payment_requirements(
    pay_to: str,
    asset: str,
    amount: str,
) -> PaymentRequirements:
    """Build payment requirements for the cash scheme.

    Args:
        pay_to: The recipient address/name.
        asset: The asset being paid (e.g., "USD").
        amount: The amount to pay.

    Returns:
        PaymentRequirements for cash scheme.
    """
    return PaymentRequirements(
        scheme="cash",
        network="x402:cash",
        asset=asset,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=1000,
        extra={},
    )
