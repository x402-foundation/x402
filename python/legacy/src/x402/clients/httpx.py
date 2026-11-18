from typing import Optional, Dict, List
from httpx import Request, Response, AsyncClient
from eth_account import Account
from x402.clients.base import (
    x402Client,
    MissingRequestConfigError,
    PaymentError,
    PaymentSelectorCallable,
)
from x402.types import x402PaymentRequiredResponse


class HttpxHooks:
    def __init__(self, client: x402Client):
        self.client = client
        self._is_retry = False

    async def on_request(self, request: Request):
        """Handle request before it is sent."""
        pass

    async def on_response(self, response: Response) -> Response:
        """Handle response after it is received."""

        # If this is not a 402, just return the response
        if response.status_code != 402:
            return response

        # If this is a retry response, just return it
        if self._is_retry:
            return response

        try:
            if not response.request:
                raise MissingRequestConfigError("Missing request configuration")

            # Read the response content before parsing
            await response.aread()

            data = response.json()

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
            request = response.request

            request.headers["X-Payment"] = payment_header
            request.headers["Access-Control-Expose-Headers"] = "X-Payment-Response"

            # Retry the request
            async with AsyncClient() as client:
                retry_response = await client.send(request)

                # Copy the retry response data to the original response
                response.status_code = retry_response.status_code
                response.headers = retry_response.headers
                response._content = retry_response._content
                return response

        except PaymentError as e:
            self._is_retry = False
            raise e
        except Exception as e:
            self._is_retry = False
            raise PaymentError(f"Failed to handle payment: {str(e)}") from e


def x402_payment_hooks(
    account: Account,
    max_value: Optional[int] = None,
    payment_requirements_selector: Optional[PaymentSelectorCallable] = None,
) -> Dict[str, List]:
    """Create httpx event hooks dictionary for handling 402 Payment Required responses.

    Args:
        account: eth_account.Account instance for signing payments
        max_value: Optional maximum allowed payment amount in base units
        payment_requirements_selector: Optional custom selector for payment requirements.
            Should be a callable that takes (accepts, network_filter, scheme_filter, max_value)
            and returns a PaymentRequirements object.

    Returns:
        Dictionary of event hooks that can be directly assigned to client.event_hooks
    """
    # Create x402Client
    client = x402Client(
        account,
        max_value=max_value,
        payment_requirements_selector=payment_requirements_selector,
    )

    # Create hooks
    hooks = HttpxHooks(client)

    # Return event hooks dictionary
    return {
        "request": [hooks.on_request],
        "response": [hooks.on_response],
    }


class x402HttpxClient(AsyncClient):
    """AsyncClient with built-in x402 payment handling."""

    def __init__(
        self,
        account: Account,
        max_value: Optional[int] = None,
        payment_requirements_selector: Optional[PaymentSelectorCallable] = None,
        **kwargs,
    ):
        """Initialize an AsyncClient with x402 payment handling.

        Args:
            account: eth_account.Account instance for signing payments
            max_value: Optional maximum allowed payment amount in base units
            payment_requirements_selector: Optional custom selector for payment requirements.
                Should be a callable that takes (accepts, network_filter, scheme_filter, max_value)
                and returns a PaymentRequirements object.
            **kwargs: Additional arguments to pass to AsyncClient
        """
        super().__init__(**kwargs)
        self.event_hooks = x402_payment_hooks(
            account, max_value, payment_requirements_selector
        )
