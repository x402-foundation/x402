import inspect
from typing import Callable, Optional
from typing_extensions import (
    TypedDict,
)  # use `typing_extensions.TypedDict` instead of `typing.TypedDict` on Python < 3.12
import httpx
from x402.types import (
    PaymentPayload,
    PaymentRequirements,
    VerifyResponse,
    SettleResponse,
    ListDiscoveryResourcesRequest,
    ListDiscoveryResourcesResponse,
)


class FacilitatorConfig(TypedDict, total=False):
    """Configuration for the X402 facilitator service.

    Attributes:
        url: The base URL for the facilitator service
        create_headers: Optional function to create authentication headers
    """

    url: str
    create_headers: Callable[[], dict[str, dict[str, str]]]


class FacilitatorClient:
    def __init__(self, config: Optional[FacilitatorConfig] = None):
        if config is None:
            config = {"url": "https://x402.org/facilitator"}

        # Validate URL format
        url = config.get("url", "")
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"Invalid URL {url}, must start with http:// or https://")
        if url.endswith("/"):
            url = url[:-1]

        self.config = {"url": url, "create_headers": config.get("create_headers")}

    async def _get_custom_headers(self) -> dict[str, dict[str, str]] | None:
        """Get custom headers, supporting both sync and async create_headers functions."""
        if not self.config.get("create_headers"):
            return None
        result = self.config["create_headers"]()
        if inspect.iscoroutine(result):
            return await result
        return result

    async def verify(
        self, payment: PaymentPayload, payment_requirements: PaymentRequirements
    ) -> VerifyResponse:
        """Verify a payment header is valid and a request should be processed"""
        headers = {"Content-Type": "application/json"}

        custom_headers = await self._get_custom_headers()
        if custom_headers:
            headers.update(custom_headers.get("verify", {}))

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.config['url']}/verify",
                json={
                    "x402Version": payment.x402_version,
                    "paymentPayload": payment.model_dump(by_alias=True),
                    "paymentRequirements": payment_requirements.model_dump(
                        by_alias=True, exclude_none=True
                    ),
                },
                headers=headers,
                follow_redirects=True,
            )

            data = response.json()
            return VerifyResponse(**data)

    async def settle(
        self, payment: PaymentPayload, payment_requirements: PaymentRequirements
    ) -> SettleResponse:
        headers = {"Content-Type": "application/json"}

        custom_headers = await self._get_custom_headers()
        if custom_headers:
            headers.update(custom_headers.get("settle", {}))

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.config['url']}/settle",
                json={
                    "x402Version": payment.x402_version,
                    "paymentPayload": payment.model_dump(by_alias=True),
                    "paymentRequirements": payment_requirements.model_dump(
                        by_alias=True, exclude_none=True
                    ),
                },
                headers=headers,
                follow_redirects=True,
            )
            data = response.json()
            return SettleResponse(**data)

    async def list(
        self, request: Optional[ListDiscoveryResourcesRequest] = None
    ) -> ListDiscoveryResourcesResponse:
        """List discovery resources from the facilitator service.

        Args:
            request: Optional parameters for filtering and pagination

        Returns:
            ListDiscoveryResourcesResponse containing the list of discovery resources and pagination info
        """
        if request is None:
            request = ListDiscoveryResourcesRequest()

        headers = {"Content-Type": "application/json"}

        custom_headers = await self._get_custom_headers()
        if custom_headers:
            headers.update(custom_headers.get("list", {}))

        # Build query parameters, excluding None values
        params = {
            k: str(v)
            for k, v in request.model_dump(by_alias=True).items()
            if v is not None
        }

        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.config['url']}/discovery/resources",
                params=params,
                headers=headers,
                follow_redirects=True,
            )

            if response.status_code != 200:
                raise ValueError(
                    f"Failed to list discovery resources: {response.status_code} {response.text}"
                )

            data = response.json()
            return ListDiscoveryResourcesResponse(**data)
