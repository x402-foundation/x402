"""x402 Python SDK - Payment protocol implementation.

This SDK provides client-side, server-side, and facilitator components
for implementing the x402 payment protocol.

Both async (default) and sync variants are available:
- x402Client / x402ClientSync
- x402ResourceServer / x402ResourceServerSync
- x402Facilitator / x402FacilitatorSync

Quick Start (Async - Recommended):
    ```python
    from x402 import x402Client, x402ResourceServer, x402Facilitator

    # Client-side: Create payment payloads
    client = x402Client()
    client.register("eip155:8453", ExactEvmScheme(signer=my_signer))
    payload = await client.create_payment_payload(payment_required)

    # Server-side: Protect resources
    server = x402ResourceServer(facilitator_client)
    server.register("eip155:8453", ExactEvmServerScheme())
    server.initialize()
    result = await server.verify_payment(payload, requirements)

    # Facilitator: Verify and settle payments
    facilitator = x402Facilitator()
    facilitator.register(["eip155:8453"], ExactEvmFacilitatorScheme(wallet))
    result = await facilitator.verify(payload, requirements)
    ```

Quick Start (Sync):
    ```python
    from x402 import x402ClientSync, x402ResourceServerSync, x402FacilitatorSync

    # Client-side: Create payment payloads
    client = x402ClientSync()
    client.register("eip155:8453", ExactEvmScheme(signer=my_signer))
    payload = client.create_payment_payload(payment_required)

    # Server-side: Protect resources
    server = x402ResourceServerSync(facilitator_client)
    server.register("eip155:8453", ExactEvmServerScheme())
    server.initialize()
    result = server.verify_payment(payload, requirements)

    # Facilitator: Verify and settle payments
    facilitator = x402FacilitatorSync()
    facilitator.register(["eip155:8453"], ExactEvmFacilitatorScheme(wallet))
    result = facilitator.verify(payload, requirements)
    ```
"""

# Core components - Async (default)
from .client import (
    SchemeRegistration,
    default_payment_selector,
    max_amount,
    prefer_network,
    prefer_scheme,
    x402Client,
    x402ClientConfig,
    x402ClientSync,
)
from .facilitator import x402Facilitator, x402FacilitatorSync

# Interfaces (for implementing custom schemes)
from .interfaces import (
    SchemeNetworkClient,
    SchemeNetworkClientV1,
    SchemeNetworkFacilitator,
    SchemeNetworkFacilitatorV1,
    SchemeNetworkServer,
)

# Types (re-export commonly used types)
from .schemas import (
    # Base
    X402_VERSION,
    # Hooks
    AbortResult,
    AssetAmount,
    # Config
    FacilitatorConfig,
    Money,
    Network,
    # Errors
    NoMatchingRequirementsError,
    PaymentAbortedError,
    PaymentCreatedContext,
    PaymentCreationContext,
    PaymentCreationFailureContext,
    PaymentError,
    # V2 Payments
    PaymentPayload,
    # V1 Legacy
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequiredV1,
    PaymentRequirements,
    PaymentRequirementsV1,
    PaywallConfig,
    Price,
    RecoveredPayloadResult,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    ResourceConfig,
    ResourceInfo,
    RoutesConfig,
    SchemeNotFoundError,
    SettleContext,
    SettleError,
    SettleFailureContext,
    # Responses
    SettleResponse,
    SettleResultContext,
    SupportedKind,
    SupportedResponse,
    VerifyContext,
    VerifyError,
    VerifyFailureContext,
    VerifyResponse,
    VerifyResultContext,
    # Helpers
    derive_network_pattern,
    detect_version,
    find_schemes_by_network,
    match_payload_to_requirements,
    matches_network_pattern,
    parse_payment_payload,
    parse_payment_required,
)
from .server import (
    FacilitatorClient,
    FacilitatorClientSync,
    x402ResourceServer,
    x402ResourceServerSync,
)

__version__ = "2.9.0"

__all__ = [
    # Version
    "__version__",
    # Core components - Async (default)
    "x402Client",
    "x402ResourceServer",
    "x402Facilitator",
    # Core components - Sync
    "x402ClientSync",
    "x402ResourceServerSync",
    "x402FacilitatorSync",
    # Config types
    "SchemeRegistration",
    "x402ClientConfig",
    # Protocols
    "FacilitatorClient",
    "FacilitatorClientSync",
    # Policies
    "default_payment_selector",
    "prefer_network",
    "prefer_scheme",
    "max_amount",
    # Interfaces
    "SchemeNetworkClient",
    "SchemeNetworkClientV1",
    "SchemeNetworkServer",
    "SchemeNetworkFacilitator",
    "SchemeNetworkFacilitatorV1",
    # Types - Base
    "X402_VERSION",
    "Network",
    "Money",
    "Price",
    "AssetAmount",
    # Types - V2 Payments
    "ResourceInfo",
    "PaymentRequirements",
    "PaymentRequired",
    "PaymentPayload",
    # Types - V1 Legacy
    "PaymentRequirementsV1",
    "PaymentRequiredV1",
    "PaymentPayloadV1",
    # Types - Responses
    "VerifyResponse",
    "SettleResponse",
    "SupportedKind",
    "SupportedResponse",
    # Types - Config
    "ResourceConfig",
    "FacilitatorConfig",
    "PaywallConfig",
    "RoutesConfig",
    # Types - Hooks
    "AbortResult",
    "RecoveredPayloadResult",
    "RecoveredVerifyResult",
    "RecoveredSettleResult",
    "VerifyContext",
    "VerifyResultContext",
    "VerifyFailureContext",
    "SettleContext",
    "SettleResultContext",
    "SettleFailureContext",
    "PaymentCreationContext",
    "PaymentCreatedContext",
    "PaymentCreationFailureContext",
    # Types - Errors
    "PaymentError",
    "VerifyError",
    "SettleError",
    "SchemeNotFoundError",
    "NoMatchingRequirementsError",
    "PaymentAbortedError",
    # Types - Helpers
    "detect_version",
    "match_payload_to_requirements",
    "matches_network_pattern",
    "derive_network_pattern",
    "find_schemes_by_network",
    "parse_payment_required",
    "parse_payment_payload",
]
