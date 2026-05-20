"""Hook result types and contexts for the x402 Python SDK.

Shared hook types used by x402Client, x402ResourceServer, and x402Facilitator.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from .payments import PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo
    from .responses import SettleResponse, VerifyResponse
    from .v1 import PaymentPayloadV1, PaymentRequiredV1, PaymentRequirementsV1


# ============================================================================
# Hook Result Types
# ============================================================================


@dataclass
class AbortResult:
    """Return from before hook to abort the operation.

    Attributes:
        reason: Human-readable reason for aborting.
    """

    reason: str


@dataclass
class RecoveredPayloadResult:
    """Return from client failure hook to recover with a payload.

    Attributes:
        payload: The recovered payment payload.
    """

    payload: "PaymentPayload | PaymentPayloadV1"


@dataclass
class RecoveredVerifyResult:
    """Return from verify failure hook to recover with a result.

    Attributes:
        result: The recovered verify response.
    """

    result: "VerifyResponse"


@dataclass
class RecoveredSettleResult:
    """Return from settle failure hook to recover with a result.

    Attributes:
        result: The recovered settle response.
    """

    result: "SettleResponse"


@dataclass
class SkipVerifyResult:
    """Return from before-verify hook to skip facilitator verification.

    Attributes:
        result: Verify response to use instead of calling the facilitator.
    """

    result: "VerifyResponse"


@dataclass
class SkipSettleResult:
    """Return from before-settle hook to skip facilitator settlement.

    Attributes:
        result: Settle response to use instead of calling the facilitator.
    """

    result: "SettleResponse"


@dataclass
class SkipHandlerDirective:
    """In-process response when an after-verify hook skips the resource handler.

    Attributes:
        content_type: Optional Content-Type for the handler response.
        body: Optional response body.
    """

    content_type: str | None = None
    body: Any = None


@dataclass
class SkipHandlerResult:
    """Return from after-verify hook to skip the resource handler."""

    response: SkipHandlerDirective | None = None


VerifiedPaymentCancellationReason = Literal["handler_threw", "handler_failed"]


@dataclass
class VerifiedPaymentCancelOptions:
    """Options passed when canceling a verified payment attempt."""

    reason: VerifiedPaymentCancellationReason
    error: Any = None
    response_status: int | None = None


@dataclass
class GrantAccessResult:
    """Return from on_protected_request to bypass payment."""

    grant_access: Literal[True] = True


@dataclass
class AbortProtectedRequestResult:
    """Return from on_protected_request to deny the request."""

    abort: Literal[True] = True
    reason: str = ""


ProtectedRequestHookResult = GrantAccessResult | AbortProtectedRequestResult


class PaymentCancellationDispatcher:
    """Cancels a verified payment when the protected handler fails."""

    def __init__(
        self,
        server: Any,
        payment_payload: "PaymentPayload | PaymentPayloadV1",
        requirements: "PaymentRequirements | PaymentRequirementsV1",
        declared_extensions: dict[str, Any] | None,
        transport_context: Any,
    ) -> None:
        self._server = server
        self._payment_payload = payment_payload
        self._requirements = requirements
        self._declared_extensions = declared_extensions or {}
        self._transport_context = transport_context
        self._done = False

    async def cancel(self, options: VerifiedPaymentCancelOptions) -> None:
        """Dispatch cancellation hooks (async server)."""
        if self._done:
            return
        self._done = True
        await self._server._dispatch_verified_payment_canceled(
            self._payment_payload,
            self._requirements,
            self._declared_extensions,
            options,
            self._transport_context,
        )

    def cancel_sync(self, options: VerifiedPaymentCancelOptions) -> None:
        """Dispatch cancellation hooks (sync server)."""
        if self._done:
            return
        self._done = True
        self._server._dispatch_verified_payment_canceled_sync(
            self._payment_payload,
            self._requirements,
            self._declared_extensions,
            options,
            self._transport_context,
        )


class ResourceVerifyResponse:
    """Verify outcome with optional in-process skip-handler directive."""

    def __init__(
        self,
        verify: "VerifyResponse",
        skip_handler: SkipHandlerDirective | None = None,
    ) -> None:
        self.verify = verify
        self.skip_handler = skip_handler

    @property
    def is_valid(self) -> bool:
        return self.verify.is_valid

    @property
    def invalid_reason(self) -> str | None:
        return self.verify.invalid_reason

    @property
    def invalid_message(self) -> str | None:
        return self.verify.invalid_message

    @property
    def payer(self) -> str | None:
        return self.verify.payer

    def __getattr__(self, name: str) -> Any:
        return getattr(self.verify, name)


# ============================================================================
# Verify Hook Contexts
# ============================================================================


@dataclass
class VerifyContext:
    """Context for verify hooks.

    Attributes:
        payment_payload: The payment payload being verified.
        requirements: The requirements being verified against.
        payload_bytes: Raw payload bytes (escape hatch for extensions).
        requirements_bytes: Raw requirements bytes (escape hatch for extensions).
    """

    payment_payload: "PaymentPayload | PaymentPayloadV1"
    requirements: "PaymentRequirements | PaymentRequirementsV1"
    payload_bytes: bytes | None = None
    requirements_bytes: bytes | None = None
    declared_extensions: dict[str, Any] | None = None
    transport_context: Any = None


@dataclass
class VerifyResultContext(VerifyContext):
    """Context for after-verify hooks.

    Attributes:
        result: The verification result.
    """

    result: "VerifyResponse" = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.result is None:
            raise ValueError("result is required for VerifyResultContext")


@dataclass
class VerifyFailureContext(VerifyContext):
    """Context for verify failure hooks.

    Attributes:
        error: The exception that caused the failure.
    """

    error: Exception = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.error is None:
            raise ValueError("error is required for VerifyFailureContext")


# ============================================================================
# Settle Hook Contexts
# ============================================================================


@dataclass
class SettleContext:
    """Context for settle hooks.

    Attributes:
        payment_payload: The payment payload being settled.
        requirements: The requirements for settlement.
        payload_bytes: Raw payload bytes (escape hatch for extensions).
        requirements_bytes: Raw requirements bytes (escape hatch for extensions).
    """

    payment_payload: "PaymentPayload | PaymentPayloadV1"
    requirements: "PaymentRequirements | PaymentRequirementsV1"
    payload_bytes: bytes | None = None
    requirements_bytes: bytes | None = None
    declared_extensions: dict[str, Any] | None = None
    transport_context: Any = None


@dataclass
class SettleResultContext(SettleContext):
    """Context for after-settle hooks.

    Attributes:
        result: The settlement result.
    """

    result: "SettleResponse" = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.result is None:
            raise ValueError("result is required for SettleResultContext")


@dataclass
class SettleFailureContext(SettleContext):
    """Context for settle failure hooks.

    Attributes:
        error: The exception that caused the failure.
    """

    error: Exception = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.error is None:
            raise ValueError("error is required for SettleFailureContext")


@dataclass
class VerifiedPaymentCanceledContext(SettleContext):
    """Context for verified-payment cancellation hooks."""

    reason: VerifiedPaymentCancellationReason = "handler_failed"  # type: ignore[assignment]
    error: Any = None
    response_status: int | None = None

    def __post_init__(self) -> None:
        if self.reason is None:
            raise ValueError("reason is required for VerifiedPaymentCanceledContext")


# ============================================================================
# Payment Creation Hook Contexts (for x402Client)
# ============================================================================


@dataclass
class PaymentCreationContext:
    """Context for payment creation hooks.

    Attributes:
        payment_required: The 402 response from the server.
        selected_requirements: The selected payment requirements.
    """

    payment_required: "PaymentRequired | PaymentRequiredV1"
    selected_requirements: "PaymentRequirements | PaymentRequirementsV1"


@dataclass
class PaymentCreatedContext(PaymentCreationContext):
    """Context for after-payment-creation hooks.

    Attributes:
        payment_payload: The created payment payload.
    """

    payment_payload: "PaymentPayload | PaymentPayloadV1" = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.payment_payload is None:
            raise ValueError("payment_payload is required for PaymentCreatedContext")


@dataclass
class PaymentCreationFailureContext(PaymentCreationContext):
    """Context for payment creation failure hooks.

    Attributes:
        error: The exception that caused the failure.
    """

    error: Exception = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.error is None:
            raise ValueError("error is required for PaymentCreationFailureContext")


# ============================================================================
# Payment Response Hook Contexts (for x402Client)
# ============================================================================


@dataclass
class PaymentResponseContext:
    """Context for payment response hooks after a paid HTTP request."""

    payment_payload: "PaymentPayload | PaymentPayloadV1"
    requirements: "PaymentRequirements | PaymentRequirementsV1"
    settle_response: "SettleResponse | None" = None
    payment_required: "PaymentRequired | PaymentRequiredV1 | None" = None
    error: Any = None


@dataclass
class RecoveredResponseResult:
    """Return from on_payment_response to signal transport recovery."""

    recovered: Literal[True] = True


# ============================================================================
# Server Payment Required Enrichment Context
# ============================================================================


@dataclass
class ServerPaymentRequiredContext:
    """Context for server enrich_payment_required_response hooks."""

    requirements: list["PaymentRequirements"]
    resource_info: "ResourceInfo | None"
    error: str | None
    payment_required_response: "PaymentRequired"
    transport_context: Any = None
    payment_payload: "PaymentPayload | None" = None


# ============================================================================
# HTTP Payment Required Hook Contexts (for x402HTTPClient)
# ============================================================================


@dataclass
class PaymentRequiredContext:
    """Context for HTTP on_payment_required hooks."""

    payment_required: "PaymentRequired | PaymentRequiredV1"


@dataclass
class PaymentRequiredHeadersResult:
    """Return from on_payment_required to retry before paying."""

    headers: dict[str, str]
