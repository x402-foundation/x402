"""HTTP layer for x402 Python SDK.

Provides HTTP-specific components for client-side payment handling,
server-side resource protection, and facilitator communication.
"""

from .constants import (
    DEFAULT_FACILITATOR_URL,
    HTTP_STATUS_PAYMENT_REQUIRED,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X_PAYMENT_HEADER,
    X_PAYMENT_RESPONSE_HEADER,
)
from .facilitator_client import (
    AuthHeaders,
    AuthProvider,
    CreateHeadersAuthProvider,
    FacilitatorClient,
    FacilitatorClientSync,
    FacilitatorConfig,
    HTTPFacilitatorClient,
    HTTPFacilitatorClientSync,
)
from .types import (
    CompiledRoute,
    DynamicPayTo,
    DynamicPrice,
    HTTPAdapter,
    HTTPProcessResult,
    HTTPRequestContext,
    HTTPResponseBody,
    HTTPResponseInstructions,
    PaymentOption,
    PaywallConfig,
    ProcessSettleResult,
    RouteConfig,
    RouteConfigurationError,
    RoutesConfig,
    RouteValidationError,
    SettlementFailedResponseBody,
    UnpaidResponseBody,
)
from .utils import (
    decode_payment_required_header,
    decode_payment_response_header,
    decode_payment_signature_header,
    detect_payment_required_version,
    encode_payment_required_header,
    encode_payment_response_header,
    encode_payment_signature_header,
    safe_base64_decode,
    safe_base64_encode,
)
from .x402_http_client import PaymentRoundTripper, x402HTTPClient, x402HTTPClientSync
from .x402_http_server import (
    PaywallProvider,
    x402HTTPResourceServer,
    x402HTTPResourceServerSync,
)

# HTTP clients (imported on demand to avoid requiring httpx/requests)
# from .clients import (
#     wrapHttpxWithPayment,
#     wrapRequestsWithPayment,
#     x402_httpx_hooks,
#     x402_requests,
#     x402HttpxClient,
#     x402HTTPAdapter,
# )

# HTTP middleware (imported on demand to avoid requiring fastapi/flask)
# from .middleware import (
#     fastapi_payment_middleware,
#     flask_payment_middleware,
#     FlaskPaymentMiddleware,
# )

__all__ = [
    # Constants
    "PAYMENT_SIGNATURE_HEADER",
    "PAYMENT_REQUIRED_HEADER",
    "PAYMENT_RESPONSE_HEADER",
    "X_PAYMENT_HEADER",
    "X_PAYMENT_RESPONSE_HEADER",
    "HTTP_STATUS_PAYMENT_REQUIRED",
    "DEFAULT_FACILITATOR_URL",
    # Facilitator client
    "HTTPFacilitatorClient",
    "HTTPFacilitatorClientSync",
    "FacilitatorClient",
    "FacilitatorClientSync",
    "FacilitatorConfig",
    "AuthProvider",
    "AuthHeaders",
    "CreateHeadersAuthProvider",
    # HTTP client
    "x402HTTPClient",
    "x402HTTPClientSync",
    "PaymentRoundTripper",
    # HTTP server
    "x402HTTPResourceServer",
    "x402HTTPResourceServerSync",
    "PaywallProvider",
    # Types
    "HTTPAdapter",
    "HTTPRequestContext",
    "HTTPResponseInstructions",
    "HTTPProcessResult",
    "ProcessSettleResult",
    "PaywallConfig",
    "PaymentOption",
    "RouteConfig",
    "RoutesConfig",
    "CompiledRoute",
    "DynamicPayTo",
    "DynamicPrice",
    "HTTPResponseBody",
    "SettlementFailedResponseBody",
    "UnpaidResponseBody",
    "RouteValidationError",
    "RouteConfigurationError",
    # Utils
    "safe_base64_encode",
    "safe_base64_decode",
    "encode_payment_signature_header",
    "decode_payment_signature_header",
    "encode_payment_required_header",
    "decode_payment_required_header",
    "encode_payment_response_header",
    "decode_payment_response_header",
    "detect_payment_required_version",
]
