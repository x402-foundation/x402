from typing import Optional
import requests
import json
from requests.adapters import HTTPAdapter
from eth_account import Account
from x402.clients.base import (
    x402Client,
    PaymentError,
    PaymentSelectorCallable,
)
from x402.types import x402PaymentRequiredResponse
import copy


class x402HTTPAdapter(HTTPAdapter):
    """HTTP adapter for handling x402 payment required responses."""

    def __init__(self, client: x402Client, **kwargs):
        """Initialize the adapter with an x402Client.

        Args:
            client: x402Client instance for handling payments
            **kwargs: Additional arguments to pass to HTTPAdapter
        """
        super().__init__(**kwargs)
        self.client = client
        self._is_retry = False

    def send(self, request, **kwargs):
        """Send a request with payment handling for 402 responses.

        Args:
            request: The PreparedRequest being sent
            **kwargs: Additional arguments to pass to the adapter

        Returns:
            Response object
        """
        if self._is_retry:
            self._is_retry = False
            return super().send(request, **kwargs)

        response = super().send(request, **kwargs)

        if response.status_code != 402:
            return response

        try:
            # Save the content before we parse it to avoid consuming it
            content = copy.deepcopy(response.content)

            # Parse the JSON content without using response.json() which consumes it
            data = json.loads(content.decode("utf-8"))
            payment_response = x402PaymentRequiredResponse(**data)

            # Select payment requirements
            selected_requirements = self.client.select_payment_requirements(
                payment_response.accepts
            )

            # Create payment header
            payment_header = self.client.create_payment_header(
                selected_requirements, payment_response.x402_version
            )

            # Mark as retry and add payment header
            self._is_retry = True
            request.headers["X-Payment"] = payment_header
            request.headers["Access-Control-Expose-Headers"] = "X-Payment-Response"

            retry_response = super().send(request, **kwargs)

            # Copy the retry response data to the original response
            response.status_code = retry_response.status_code
            response.headers = retry_response.headers
            response._content = retry_response.content
            return response

        except PaymentError as e:
            self._is_retry = False
            raise e
        except Exception as e:
            self._is_retry = False
            raise PaymentError(f"Failed to handle payment: {str(e)}") from e


def x402_http_adapter(
    account: Account,
    max_value: Optional[int] = None,
    payment_requirements_selector: Optional[PaymentSelectorCallable] = None,
    **kwargs,
) -> x402HTTPAdapter:
    """Create an HTTP adapter that handles 402 Payment Required responses.

    Args:
        account: eth_account.Account instance for signing payments
        max_value: Optional maximum allowed payment amount in base units
        payment_requirements_selector: Optional custom selector for payment requirements.
            Should be a callable that takes (accepts, network_filter, scheme_filter, max_value)
            and returns a PaymentRequirements object.
        **kwargs: Additional arguments to pass to HTTPAdapter

    Returns:
        x402HTTPAdapter instance that can be mounted to a requests session
    """
    client = x402Client(
        account,
        max_value=max_value,
        payment_requirements_selector=payment_requirements_selector,
    )
    return x402HTTPAdapter(client, **kwargs)


def x402_requests(
    account: Account,
    max_value: Optional[int] = None,
    payment_requirements_selector: Optional[PaymentSelectorCallable] = None,
    **kwargs,
) -> requests.Session:
    """Create a requests session with x402 payment handling.

    Args:
        account: eth_account.Account instance for signing payments
        max_value: Optional maximum allowed payment amount in base units
        payment_requirements_selector: Optional custom selector for payment requirements.
            Should be a callable that takes (accepts, network_filter, scheme_filter, max_value)
            and returns a PaymentRequirements object.
        **kwargs: Additional arguments to pass to HTTPAdapter

    Returns:
        Session with x402 payment handling configured
    """
    session = requests.Session()
    adapter = x402_http_adapter(
        account,
        max_value=max_value,
        payment_requirements_selector=payment_requirements_selector,
        **kwargs,
    )

    # Mount the adapter for both HTTP and HTTPS
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    return session
