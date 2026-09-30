import time
from typing import Optional, Callable, Dict, Any, List
from eth_account import Account
from x402.exact import sign_payment_header
from x402.types import (
    PaymentRequirements,
    UnsupportedSchemeException,
)
from x402.common import x402_VERSION
import secrets
from x402.encoding import safe_base64_decode
import json

# Define type for the payment requirements selector
PaymentSelectorCallable = Callable[
    [List[PaymentRequirements], Optional[str], Optional[str], Optional[int]],
    PaymentRequirements,
]


def decode_x_payment_response(header: str) -> Dict[str, Any]:
    """Decode the X-PAYMENT-RESPONSE header.

    Args:
        header: The X-PAYMENT-RESPONSE header to decode

    Returns:
        The decoded payment response containing:
        - success: bool
        - transaction: str (hex)
        - network: str
        - payer: str (address)
    """
    decoded = safe_base64_decode(header)
    result = json.loads(decoded)
    return result


class PaymentError(Exception):
    """Base class for payment-related errors."""

    pass


class PaymentAmountExceededError(PaymentError):
    """Raised when payment amount exceeds maximum allowed value."""

    pass


class MissingRequestConfigError(PaymentError):
    """Raised when request configuration is missing."""

    pass


class PaymentAlreadyAttemptedError(PaymentError):
    """Raised when payment has already been attempted."""

    pass


class x402Client:
    """Base client for handling x402 payments."""

    def __init__(
        self,
        account: Account,
        max_value: Optional[int] = None,
        payment_requirements_selector: Optional[PaymentSelectorCallable] = None,
    ):
        """Initialize the x402 client.

        Args:
            account: eth_account.Account instance for signing payments
            max_value: Optional maximum allowed payment amount in base units
            payment_requirements_selector: Optional custom selector for payment requirements
        """
        self.account = account
        self.max_value = max_value
        self._payment_requirements_selector = (
            payment_requirements_selector or self.default_payment_requirements_selector
        )

    @staticmethod
    def default_payment_requirements_selector(
        accepts: List[PaymentRequirements],
        network_filter: Optional[str] = None,
        scheme_filter: Optional[str] = None,
        max_value: Optional[int] = None,
    ) -> PaymentRequirements:
        """Select payment requirements from the list of accepted requirements.

        Args:
            accepts: List of accepted payment requirements
            network_filter: Optional network to filter by
            scheme_filter: Optional scheme to filter by
            max_value: Optional maximum allowed payment amount

        Returns:
            Selected payment requirements (PaymentRequirements instance from x402.types)

        Raises:
            UnsupportedSchemeException: If no supported scheme is found
            PaymentAmountExceededError: If payment amount exceeds max_value
        """
        for paymentRequirements in accepts:
            scheme = paymentRequirements.scheme
            network = paymentRequirements.network

            # Check scheme filter
            if scheme_filter and scheme != scheme_filter:
                continue

            # Check network filter
            if network_filter and network != network_filter:
                continue

            if scheme == "exact":
                # Check max value if set
                if max_value is not None:
                    max_amount = int(paymentRequirements.max_amount_required)
                    if max_amount > max_value:
                        raise PaymentAmountExceededError(
                            f"Payment amount {max_amount} exceeds maximum allowed value {max_value}"
                        )

                return paymentRequirements

        raise UnsupportedSchemeException("No supported payment scheme found")

    def select_payment_requirements(
        self,
        accepts: List[PaymentRequirements],
        network_filter: Optional[str] = None,
        scheme_filter: Optional[str] = None,
    ) -> PaymentRequirements:
        """Select payment requirements using the configured selector.

        Args:
            accepts: List of accepted payment requirements (PaymentRequirements models)
            network_filter: Optional network to filter by
            scheme_filter: Optional scheme to filter by

        Returns:
            Selected payment requirements (PaymentRequirements instance from x402.types)

        Raises:
            UnsupportedSchemeException: If no supported scheme is found
            PaymentAmountExceededError: If payment amount exceeds max_value
        """
        return self._payment_requirements_selector(
            accepts, network_filter, scheme_filter, self.max_value
        )

    def create_payment_header(
        self,
        payment_requirements: PaymentRequirements,
        x402_version: int = x402_VERSION,
    ) -> str:
        """Create a payment header for the given requirements.

        Args:
            payment_requirements: Selected payment requirements
            x402_version: x402 protocol version

        Returns:
            Signed payment header
        """
        unsigned_header = {
            "x402Version": x402_version,
            "scheme": payment_requirements.scheme,
            "network": payment_requirements.network,
            "payload": {
                "signature": None,
                "authorization": {
                    "from": self.account.address,
                    "to": payment_requirements.pay_to,
                    "value": payment_requirements.max_amount_required,
                    "validAfter": str(int(time.time()) - 60),  # 60 seconds before
                    "validBefore": str(
                        int(time.time()) + payment_requirements.max_timeout_seconds
                    ),
                    "nonce": self.generate_nonce(),
                },
            },
        }

        signed_header = sign_payment_header(
            self.account,
            payment_requirements,
            unsigned_header,
        )
        return signed_header

    def generate_nonce(self):
        # Generate a random nonce (32 bytes = 64 hex chars)
        nonce = secrets.token_hex(32)
        return nonce
