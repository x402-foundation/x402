"""x402HTTPClient base classes and types.

Contains shared logic for HTTP client implementations.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ..schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequiredContext,
    PaymentResponseContext,
    SettleResponse,
)
from ..schemas.v1 import PaymentPayloadV1, PaymentRequiredV1
from .constants import (
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X_PAYMENT_HEADER,
    X_PAYMENT_RESPONSE_HEADER,
)
from .utils import (
    decode_payment_required_header,
    decode_payment_response_header,
    encode_payment_signature_header,
)

OnPaymentRequiredHook = Callable[
    [PaymentRequiredContext],
    Awaitable[Any] | Any,
]
SyncOnPaymentRequiredHook = Callable[[PaymentRequiredContext], Any]


@dataclass
class ProcessPaymentResult:
    """Outcome of process_payment_result for transport wrappers."""

    recovered: bool
    settle_response: SettleResponse | None = None


# ============================================================================
# Base HTTP Client
# ============================================================================


class x402HTTPClientBase:
    """Base class with shared logic for x402 HTTP clients.

    Contains header encoding/decoding logic.
    """

    def __init__(self) -> None:
        self._payment_required_hooks: list[Any] = []
        self._client: Any = None

    def _collect_payment_required_hooks(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
    ) -> list[Any]:
        hooks = list(self._payment_required_hooks)
        declared = getattr(payment_required, "extensions", None)
        if not declared or self._client is None:
            return hooks

        for extension in self._client.get_extensions():
            transport_hooks = getattr(extension, "transport_hooks", None)
            if transport_hooks is None:
                continue
            http_hooks = getattr(transport_hooks, "http", None)
            if http_hooks is None:
                continue
            ext_hook = getattr(http_hooks, "on_payment_required", None)
            if ext_hook is None or extension.key not in declared:
                continue
            declaration = declared[extension.key]

            def extension_hook(
                ctx: PaymentRequiredContext,
                *,
                _declaration: Any = declaration,
                _hook: Any = ext_hook,
            ) -> Any:
                return _hook(_declaration, ctx)

            hooks.append(extension_hook)
        return hooks

    def encode_payment_signature_header(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
    ) -> dict[str, str]:
        """Encode payment payload into HTTP headers.

        Returns appropriate header based on protocol version:
        - V2: { "PAYMENT-SIGNATURE": base64 }
        - V1: { "X-PAYMENT": base64 }

        Args:
            payload: Payment payload to encode.

        Returns:
            Dict with single header name -> value.
        """
        encoded = encode_payment_signature_header(payload)

        if payload.x402_version == 2:
            return {PAYMENT_SIGNATURE_HEADER: encoded}
        elif payload.x402_version == 1:
            return {X_PAYMENT_HEADER: encoded}
        else:
            raise ValueError(f"Unsupported x402 version: {payload.x402_version}")

    def get_payment_required_response(
        self,
        get_header: Callable[[str], str | None],
        body: Any = None,
    ) -> PaymentRequired | PaymentRequiredV1:
        """Extract payment required from HTTP response.

        Handles both V1 (body) and V2 (header) formats.

        Args:
            get_header: Function to get header by name (case-insensitive).
            body: Response body (for V1 compatibility).

        Returns:
            Decoded PaymentRequired.

        Raises:
            ValueError: If no payment required info found.
        """
        header = get_header(PAYMENT_REQUIRED_HEADER)
        if isinstance(header, str) and header:
            return decode_payment_required_header(header)

        if body:
            if isinstance(body, dict) and body.get("x402Version") == 1:
                return PaymentRequiredV1.model_validate(body)
            if isinstance(body, bytes):
                data = json.loads(body.decode("utf-8"))
                if data.get("x402Version") == 1:
                    return PaymentRequiredV1.model_validate(data)

        raise ValueError("Invalid payment required response")

    def get_payment_settle_response(
        self,
        get_header: Callable[[str], str | None],
    ) -> SettleResponse:
        """Extract settlement response from HTTP headers.

        Args:
            get_header: Function to get header by name.

        Returns:
            Decoded SettleResponse.

        Raises:
            ValueError: If no payment response header found.
        """
        header = get_header(PAYMENT_RESPONSE_HEADER)
        if isinstance(header, str) and header:
            return decode_payment_response_header(header)

        header = get_header(X_PAYMENT_RESPONSE_HEADER)
        if isinstance(header, str) and header:
            return decode_payment_response_header(header)

        raise ValueError("Payment response header not found")

    def _handle_402_common(
        self,
        headers: dict[str, str],
        body: bytes | None,
    ) -> tuple[Callable[[str], str | None], Any]:
        """Common logic for handling 402 responses.

        Args:
            headers: Response headers.
            body: Response body bytes.

        Returns:
            Tuple of (get_header function, parsed body data).
        """
        normalized = {k.upper(): v for k, v in headers.items()}

        def get_header(name: str) -> str | None:
            return normalized.get(name.upper())

        body_data = None
        if body:
            try:
                body_data = json.loads(body)
            except json.JSONDecodeError:
                pass

        return get_header, body_data

    def _build_payment_response_context(
        self,
        payment_payload: PaymentPayload | PaymentPayloadV1,
        get_header: Callable[[str], str | None],
        status: int,
    ) -> tuple[PaymentResponseContext | None, SettleResponse | None]:
        settle_response: SettleResponse | None = None
        try:
            settle_response = self.get_payment_settle_response(get_header)
        except ValueError:
            pass

        if payment_payload.x402_version == 1:
            return None, settle_response

        payment_required: PaymentRequired | PaymentRequiredV1 | None = None
        if settle_response is None and status == 402:
            try:
                payment_required = self.get_payment_required_response(get_header)
            except ValueError:
                pass

        if settle_response is None and payment_required is None:
            return None, settle_response

        requirements = payment_payload.accepted
        if requirements is None:
            raise ValueError("Invalid x402 v2 payment payload: missing `accepted`")

        return (
            PaymentResponseContext(
                payment_payload=payment_payload,
                requirements=requirements,
                settle_response=settle_response,
                payment_required=payment_required,
            ),
            settle_response,
        )
