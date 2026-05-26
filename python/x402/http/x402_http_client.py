"""HTTP-specific client for x402 payment protocol.

Provides both async (x402HTTPClient) and sync (x402HTTPClientSync) implementations.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from typing_extensions import Self

from ..schemas import PaymentPayload, PaymentRequired, PaymentRequiredContext
from ..schemas.hooks import PaymentRequiredHeadersResult
from ..schemas.v1 import PaymentPayloadV1, PaymentRequiredV1
from .x402_http_client_base import (
    OnPaymentRequiredHook,
    ProcessPaymentResult,
    SyncOnPaymentRequiredHook,
    x402HTTPClientBase,
)

if TYPE_CHECKING:
    from ..client import x402Client, x402ClientSync

# Re-export for external use
__all__ = [
    "x402HTTPClient",
    "x402HTTPClientSync",
    "PaymentRoundTripper",
]


# ============================================================================
# Async HTTP Client (Default)
# ============================================================================


class x402HTTPClient(x402HTTPClientBase):
    """Async HTTP-specific client for x402 payment protocol.

    Wraps a x402Client to provide HTTP-specific encoding/decoding
    and automatic payment handling.
    """

    def __init__(self, client: x402Client) -> None:
        """Create x402HTTPClient.

        Args:
            client: Underlying x402Client for payment logic.
        """
        super().__init__()
        self._client = client
        self._payment_required_hooks: list[OnPaymentRequiredHook] = []

    def on_payment_required(self, hook: OnPaymentRequiredHook) -> Self:
        """Register hook for 402 responses. First hook returning headers wins."""
        self._payment_required_hooks.append(hook)
        return self

    async def handle_payment_required(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
    ) -> dict[str, str] | None:
        """Run hooks; return headers for a pre-payment retry, or None to pay."""
        ctx = PaymentRequiredContext(payment_required=payment_required)
        for hook in self._collect_payment_required_hooks(payment_required):
            result = await self._execute_hook(hook, ctx)
            if isinstance(result, PaymentRequiredHeadersResult):
                return result.headers
        return None

    async def _execute_hook(self, hook: Any, context: Any) -> Any:
        result = hook(context)
        if asyncio.iscoroutine(result) or asyncio.isfuture(result):
            return await result
        return result

    async def process_payment_result(
        self,
        payment_payload: PaymentPayload | PaymentPayloadV1,
        get_header: Callable[[str], str | None],
        status: int,
    ) -> ProcessPaymentResult:
        """Parse response headers, run payment response hooks, return recovery signal."""
        ctx, settle_response = self._build_payment_response_context(
            payment_payload, get_header, status
        )
        if ctx is None:
            return ProcessPaymentResult(recovered=False, settle_response=settle_response)
        recovered = await self._client.handle_payment_response(ctx)
        return ProcessPaymentResult(
            recovered=recovered is not None,
            settle_response=settle_response,
        )

    # =========================================================================
    # Payment Creation (async, delegates to x402Client)
    # =========================================================================

    async def create_payment_payload(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
    ) -> PaymentPayload | PaymentPayloadV1:
        """Create payment payload for the given requirements.

        Delegates to the underlying x402Client.

        Args:
            payment_required: Payment required response from server.

        Returns:
            Payment payload to send with retry request.
        """
        return await self._client.create_payment_payload(payment_required)

    # =========================================================================
    # Convenience Methods
    # =========================================================================

    async def handle_402_response(
        self,
        headers: dict[str, str],
        body: bytes | None,
    ) -> tuple[dict[str, str], PaymentPayload | PaymentPayloadV1]:
        """Handle a 402 response and create payment headers.

        Convenience method that:
        1. Detects protocol version
        2. Parses PaymentRequired
        3. Creates PaymentPayload
        4. Returns headers to add to retry request

        Args:
            headers: Response headers.
            body: Response body bytes.

        Returns:
            Tuple of (headers_to_add, payment_payload).
        """
        # Get payment required
        get_header, body_data = self._handle_402_common(headers, body)
        payment_required = self.get_payment_required_response(get_header, body_data)
        hook_headers = await self.handle_payment_required(payment_required)
        if hook_headers:
            return hook_headers, None
        # Create payment
        payment_payload = await self.create_payment_payload(payment_required)
        # Encode headers
        payment_headers = self.encode_payment_signature_header(payment_payload)

        return payment_headers, payment_payload


# ============================================================================
# Sync HTTP Client
# ============================================================================


class x402HTTPClientSync(x402HTTPClientBase):
    """Sync HTTP-specific client for x402 payment protocol.

    Wraps a x402ClientSync to provide HTTP-specific encoding/decoding
    and automatic payment handling.
    """

    def __init__(self, client: x402ClientSync) -> None:
        """Create x402HTTPClientSync.

        Args:
            client: Underlying x402ClientSync for payment logic.

        Raises:
            TypeError: If client has async methods (wrong variant).
        """
        super().__init__()

        # Runtime validation - catch mismatched sync/async early
        create_method = getattr(client, "create_payment_payload", None)
        if create_method and inspect.iscoroutinefunction(create_method):
            raise TypeError(
                f"x402HTTPClientSync requires a sync client, "
                f"but got {type(client).__name__} which has async methods. "
                f"Use x402ClientSync instead of x402Client, "
                f"or use x402HTTPClient (async) with x402Client."
            )

        self._client = client
        self._payment_required_hooks: list[SyncOnPaymentRequiredHook] = []

    def on_payment_required(self, hook: SyncOnPaymentRequiredHook) -> Self:
        """Register hook for 402 responses. First hook returning headers wins."""
        self._payment_required_hooks.append(hook)
        return self

    def handle_payment_required(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
    ) -> dict[str, str] | None:
        """Run hooks; return headers for a pre-payment retry, or None to pay."""
        ctx = PaymentRequiredContext(payment_required=payment_required)
        for hook in self._collect_payment_required_hooks(payment_required):
            result = hook(ctx)
            if asyncio.iscoroutine(result):
                result.close()
                raise TypeError(
                    "Async hooks are not supported in x402HTTPClientSync. "
                    "Use x402HTTPClient for async hook support."
                )
            if isinstance(result, PaymentRequiredHeadersResult):
                return result.headers
        return None

    def process_payment_result(
        self,
        payment_payload: PaymentPayload | PaymentPayloadV1,
        get_header: Callable[[str], str | None],
        status: int,
    ) -> ProcessPaymentResult:
        """Parse response headers, run payment response hooks, return recovery signal."""
        ctx, settle_response = self._build_payment_response_context(
            payment_payload, get_header, status
        )
        if ctx is None:
            return ProcessPaymentResult(recovered=False, settle_response=settle_response)
        recovered = self._client.handle_payment_response(ctx)
        return ProcessPaymentResult(
            recovered=recovered is not None,
            settle_response=settle_response,
        )

    def create_payment_payload(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
    ) -> PaymentPayload | PaymentPayloadV1:
        """Create payment payload for the given requirements.

        Delegates to the underlying x402ClientSync.

        Args:
            payment_required: Payment required response from server.

        Returns:
            Payment payload to send with retry request.
        """
        return self._client.create_payment_payload(payment_required)

    def handle_402_response(
        self,
        headers: dict[str, str],
        body: bytes | None,
    ) -> tuple[dict[str, str], PaymentPayload | PaymentPayloadV1]:
        """Handle a 402 response and create payment headers.

        Convenience method that:
        1. Detects protocol version
        2. Parses PaymentRequired
        3. Creates PaymentPayload
        4. Returns headers to add to retry request

        Args:
            headers: Response headers.
            body: Response body bytes.

        Returns:
            Tuple of (headers_to_add, payment_payload).
        """
        # Get payment required
        get_header, body_data = self._handle_402_common(headers, body)
        payment_required = self.get_payment_required_response(get_header, body_data)
        hook_headers = self.handle_payment_required(payment_required)
        if hook_headers:
            return hook_headers, None
        # Create payment
        payment_payload = self.create_payment_payload(payment_required)

        # Encode headers
        payment_headers = self.encode_payment_signature_header(payment_payload)

        return payment_headers, payment_payload


# ============================================================================
# PaymentRoundTripper (Sync - for requests-style adapters)
# ============================================================================


class PaymentRoundTripper:
    """HTTP transport wrapper with automatic payment handling.

    Wraps an HTTP transport/session to automatically handle 402 responses.
    Can be used with httpx, requests, or any HTTP client that supports
    transport/adapter customization.
    """

    MAX_RETRIES = 1  # Prevent infinite loops

    def __init__(self, x402_client: x402HTTPClientSync) -> None:
        """Create PaymentRoundTripper.

        Args:
            x402_client: Sync HTTP client for payment handling.
        """
        self._x402_client = x402_client
        self._retry_counts: dict[str, int] = {}

    def handle_response(
        self,
        request_id: str,
        status_code: int,
        headers: dict[str, str],
        body: bytes | None,
        retry_func: Callable[[dict[str, str]], Any],
    ) -> Any:
        """Handle HTTP response, automatically paying on 402.

        Args:
            request_id: Unique ID for this request (for retry tracking).
            status_code: Response status code.
            headers: Response headers.
            body: Response body.
            retry_func: Function to retry request with additional headers.

        Returns:
            Original response if not 402, or retried response with payment.
        """
        # Not a 402, return as-is
        if status_code != 402:
            self._retry_counts.pop(request_id, None)
            return None  # Signal to return original response

        # Check retry limit
        retries = self._retry_counts.get(request_id, 0)
        if retries >= self.MAX_RETRIES:
            self._retry_counts.pop(request_id, None)
            raise RuntimeError("Payment retry limit exceeded")

        self._retry_counts[request_id] = retries + 1

        get_header, body_data = self._x402_client._handle_402_common(headers, body)
        payment_required = self._x402_client.get_payment_required_response(get_header, body_data)

        hook_headers = self._x402_client.handle_payment_required(payment_required)
        if hook_headers:
            hook_result = retry_func(hook_headers)
            if getattr(hook_result, "status_code", 402) != 402:
                self._retry_counts.pop(request_id, None)
                return hook_result

        # Create payment payload and encode headers
        payment_payload = self._x402_client.create_payment_payload(payment_required)
        payment_headers = self._x402_client.encode_payment_signature_header(payment_payload)
        # Retry with payment
        paid_result = retry_func(payment_headers)

        if payment_payload is not None:
            paid_headers = getattr(paid_result, "headers", None)

            def paid_get_header(name: str) -> str | None:
                if paid_headers is None:
                    return None
                getter = getattr(paid_headers, "get", None)
                if callable(getter):
                    return getter(name)
                return None

            paid_status = getattr(paid_result, "status_code", 402)
            process_result = self._x402_client.process_payment_result(
                payment_payload,
                paid_get_header,
                paid_status,
            )
            if process_result.recovered:
                fresh_payload = self._x402_client.create_payment_payload(payment_required)
                fresh_headers = self._x402_client.encode_payment_signature_header(fresh_payload)
                recovery_result = retry_func(fresh_headers)
                recovery_headers = getattr(recovery_result, "headers", None)

                def recovery_get_header(name: str) -> str | None:
                    if recovery_headers is None:
                        return None
                    getter = getattr(recovery_headers, "get", None)
                    if callable(getter):
                        return getter(name)
                    return None

                self._x402_client.process_payment_result(
                    fresh_payload,
                    recovery_get_header,
                    getattr(recovery_result, "status_code", paid_status),
                )
                self._retry_counts.pop(request_id, None)
                return recovery_result

        # Clean up
        self._retry_counts.pop(request_id, None)

        return paid_result
