"""Bazaar Discovery Extension for x402 v2 and v1.

Enables facilitators to automatically catalog and index x402-enabled resources
by following the server's provided discovery instructions.

## V2 Usage

The v2 extension follows a pattern where:
- `info`: Contains the actual discovery data (the values)
- `schema`: JSON Schema that validates the structure of `info`

### For Resource Servers (V2)

```python
from x402.extensions.bazaar import declare_discovery_extension, BAZAAR

# Declare a GET endpoint
extension = declare_discovery_extension(
    input={"query": "example"},
    input_schema={
        "properties": {"query": {"type": "string"}},
        "required": ["query"]
    }
)

# Include in PaymentRequired response
extensions = {
    **extension,  # Adds {"bazaar": {...}}
}
```

### For Facilitators (V2 and V1)

```python
from x402.extensions.bazaar import extract_discovery_info

# V2: Extensions are in PaymentPayload.extensions (client copied from PaymentRequired)
# V1: Discovery info is in PaymentRequirements.output_schema
info = extract_discovery_info(payment_payload, payment_requirements)

if info:
    # Catalog info in Bazaar
    print(f"Resource: {info.resource_url}")
    print(f"Method: {info.method}")
```

## V1 Support

V1 discovery information is stored in the `output_schema` field of PaymentRequirements.
The `extract_discovery_info` function automatically handles v1 format as a fallback.
"""

from .facilitator import (
    DiscoveredResource,
    ValidationResult,
    extract_discovery_info,
    extract_discovery_info_from_extension,
    validate_and_extract,
    validate_discovery_extension,
)
from .facilitator_client import (
    BazaarClientExtension,
    BazaarExtendedClient,
    BazaarExtension,
    DiscoveryResource,
    DiscoveryResourcesResponse,
    ListDiscoveryResourcesParams,
    Pagination,
    SearchDiscoveryResourcesParams,
    SearchDiscoveryResourcesResponse,
    SearchPagination,
    with_bazaar,
)
from .resource_service import (
    DeclareBodyDiscoveryConfig,
    DeclareMcpDiscoveryConfig,
    DeclareQueryDiscoveryConfig,
    OutputConfig,
    declare_discovery_extension,
    declare_mcp_discovery_extension,
)
from .server import bazaar_resource_server_extension
from .types import (
    BAZAAR,
    BodyDiscoveryExtension,
    BodyDiscoveryInfo,
    BodyInput,
    BodyMethods,
    BodyType,
    DiscoveryExtension,
    DiscoveryInfo,
    McpDiscoveryExtension,
    McpDiscoveryInfo,
    McpInput,
    McpTransport,
    OutputInfo,
    QueryDiscoveryExtension,
    QueryDiscoveryInfo,
    QueryInput,
    QueryParamMethods,
)

__all__ = [
    # Constants
    "BAZAAR",
    # Method types
    "QueryParamMethods",
    "BodyMethods",
    "BodyType",
    # Input types
    "QueryInput",
    "BodyInput",
    "McpInput",
    "McpTransport",
    "OutputInfo",
    # Discovery info types
    "QueryDiscoveryInfo",
    "BodyDiscoveryInfo",
    "McpDiscoveryInfo",
    "DiscoveryInfo",
    # Extension types
    "QueryDiscoveryExtension",
    "BodyDiscoveryExtension",
    "McpDiscoveryExtension",
    "DiscoveryExtension",
    # Config types
    "DeclareQueryDiscoveryConfig",
    "DeclareBodyDiscoveryConfig",
    "DeclareMcpDiscoveryConfig",
    "OutputConfig",
    # Result types
    "ValidationResult",
    "DiscoveredResource",
    # Server extension
    "bazaar_resource_server_extension",
    # Client extension types
    "ListDiscoveryResourcesParams",
    "SearchDiscoveryResourcesParams",
    "DiscoveryResource",
    "DiscoveryResourcesResponse",
    "Pagination",
    "SearchDiscoveryResourcesResponse",
    "SearchPagination",
    "BazaarClientExtension",
    "BazaarExtension",
    "BazaarExtendedClient",
    # Functions
    "declare_discovery_extension",
    "declare_mcp_discovery_extension",
    "validate_discovery_extension",
    "extract_discovery_info",
    "extract_discovery_info_from_extension",
    "validate_and_extract",
    "with_bazaar",
]
