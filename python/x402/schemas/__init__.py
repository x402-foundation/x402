"""x402 Types - Core type definitions for the x402 Python SDK.

This module provides all core types including:
- Base types (Network, Money, Price, AssetAmount)
- V2 payment types (PaymentRequirements, PaymentPayload, PaymentRequired)
- V1 legacy types
- Response types (VerifyResponse, SettleResponse, SupportedResponse)
- View protocols for version-agnostic code
- Hook types and contexts
- Error types
- Configuration types
- Helper utilities
"""

# Base types
from .base import (
    X402_VERSION,
    AssetAmount,
    BaseX402Model,
    Money,
    Network,
    Price,
)

# Configuration types
from .config import (
    FacilitatorConfig,
    PaywallConfig,
    ResourceConfig,
    RouteConfigDict,
    RoutesConfig,
)

# Error types
from .errors import (
    NoMatchingRequirementsError,
    PaymentAbortedError,
    PaymentError,
    SchemeNotFoundError,
    SettleError,
    VerifyError,
)

# Extension types
from .extensions import ResourceServerExtension

# Helper utilities
from .helpers import (
    derive_network_pattern,
    detect_version,
    find_schemes_by_network,
    get_scheme_and_network,
    match_payload_to_requirements,
    matches_network_pattern,
    parse_payment_payload,
    parse_payment_required,
    parse_payment_requirements,
)

# Hook types
from .hooks import (
    AbortProtectedRequestResult,
    AbortResult,
    GrantAccessResult,
    PaymentCancellationDispatcher,
    PaymentCreatedContext,
    PaymentCreationContext,
    PaymentCreationFailureContext,
    PaymentRequiredContext,
    PaymentRequiredHeadersResult,
    PaymentResponseContext,
    ProtectedRequestHookResult,
    RecoveredPayloadResult,
    RecoveredResponseResult,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    ResourceVerifyResponse,
    ServerPaymentRequiredContext,
    SettleContext,
    SettleFailureContext,
    SettleResultContext,
    SkipHandlerDirective,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    VerifiedPaymentCanceledContext,
    VerifiedPaymentCancellationReason,
    VerifiedPaymentCancelOptions,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)

# V2 Payment types
from .payments import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
)

# Response types
from .responses import (
    SettleRequest,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyRequest,
    VerifyResponse,
)

# V1 Legacy types
from .v1 import (
    PaymentPayloadV1,
    PaymentRequiredV1,
    PaymentRequirementsV1,
    SupportedResponseV1,
)

# View protocols
from .views import PaymentPayloadView, PaymentRequirementsView

__all__ = [
    # Base
    "X402_VERSION",
    "Network",
    "Money",
    "Price",
    "AssetAmount",
    "BaseX402Model",
    # V2 Payments
    "ResourceInfo",
    "PaymentRequirements",
    "PaymentRequired",
    "PaymentPayload",
    # Responses
    "VerifyRequest",
    "VerifyResponse",
    "SettleRequest",
    "SettleResponse",
    "SupportedKind",
    "SupportedResponse",
    # V1 Legacy
    "PaymentRequirementsV1",
    "PaymentRequiredV1",
    "PaymentPayloadV1",
    "SupportedResponseV1",
    # Views
    "PaymentRequirementsView",
    "PaymentPayloadView",
    # Extensions
    "ResourceServerExtension",
    # Config
    "ResourceConfig",
    "FacilitatorConfig",
    "PaywallConfig",
    "RouteConfigDict",
    "RoutesConfig",
    # Helpers
    "detect_version",
    "get_scheme_and_network",
    "match_payload_to_requirements",
    "parse_payment_required",
    "parse_payment_payload",
    "parse_payment_requirements",
    "matches_network_pattern",
    "derive_network_pattern",
    "find_schemes_by_network",
    # Hooks
    "AbortResult",
    "RecoveredPayloadResult",
    "RecoveredVerifyResult",
    "RecoveredSettleResult",
    "ResourceVerifyResponse",
    "SkipHandlerDirective",
    "SkipHandlerResult",
    "SkipSettleResult",
    "SkipVerifyResult",
    "VerifiedPaymentCancelOptions",
    "VerifiedPaymentCanceledContext",
    "VerifiedPaymentCancellationReason",
    "PaymentCancellationDispatcher",
    "GrantAccessResult",
    "AbortProtectedRequestResult",
    "ProtectedRequestHookResult",
    "VerifyContext",
    "VerifyResultContext",
    "VerifyFailureContext",
    "SettleContext",
    "SettleResultContext",
    "SettleFailureContext",
    "PaymentCreationContext",
    "PaymentCreatedContext",
    "PaymentCreationFailureContext",
    "PaymentResponseContext",
    "RecoveredResponseResult",
    "PaymentRequiredContext",
    "PaymentRequiredHeadersResult",
    "ServerPaymentRequiredContext",
    # Errors
    "PaymentError",
    "VerifyError",
    "SettleError",
    "SchemeNotFoundError",
    "NoMatchingRequirementsError",
    "PaymentAbortedError",
]
