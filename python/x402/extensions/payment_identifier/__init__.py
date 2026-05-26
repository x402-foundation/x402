"""Payment-Identifier Extension for x402 v2.

Enables clients to provide an idempotency key (`id`) that resource servers
can use for deduplication of payment requests.

## Usage

### For Resource Servers

```python
from x402.extensions.payment_identifier import (
    declare_payment_identifier_extension,
    PAYMENT_IDENTIFIER,
)

# Advertise support in PaymentRequired response (optional identifier)
payment_required = {
    "x402Version": 2,
    "resource": {...},
    "accepts": [...],
    "extensions": {
        PAYMENT_IDENTIFIER: declare_payment_identifier_extension()
    }
}

# Require payment identifier
payment_required_strict = {
    "x402Version": 2,
    "resource": {...},
    "accepts": [...],
    "extensions": {
        PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=True)
    }
}
```

### For Clients

```python
from x402.extensions.payment_identifier import append_payment_identifier_to_extensions

# Get extensions from server's PaymentRequired response
extensions = {...payment_required.extensions}

# Append payment ID (only if server declared the extension)
append_payment_identifier_to_extensions(extensions)

# Include in PaymentPayload
payment_payload = {
    "x402Version": 2,
    "resource": payment_required.resource,
    "accepted": selected_payment_option,
    "payload": {...},
    "extensions": extensions
}
```

### For Idempotency Implementation

```python
from x402.extensions.payment_identifier import extract_payment_identifier

# In your settle handler
id = extract_payment_identifier(payment_payload)
if id:
    cached = await idempotency_store.get(id)
    if cached:
        return cached  # Return cached response
```
"""

from .client import append_payment_identifier_to_extensions
from .schema import payment_identifier_schema
from .server import (
    PaymentIdentifierResourceServerExtension,
    declare_payment_identifier_extension,
    payment_identifier_resource_server_extension,
)
from .types import (
    PAYMENT_ID_MAX_LENGTH,
    PAYMENT_ID_MIN_LENGTH,
    PAYMENT_ID_PATTERN,
    PAYMENT_IDENTIFIER,
    PaymentIdentifierExtension,
    PaymentIdentifierInfo,
    PaymentIdentifierSchema,
)
from .utils import generate_payment_id, is_valid_payment_id
from .validation import (
    PaymentIdentifierValidationResult,
    extract_and_validate_payment_identifier,
    extract_payment_identifier,
    has_payment_identifier,
    is_payment_identifier_extension,
    is_payment_identifier_required,
    validate_payment_identifier,
    validate_payment_identifier_requirement,
)

__all__ = [
    # Constants
    "PAYMENT_IDENTIFIER",
    "PAYMENT_ID_MIN_LENGTH",
    "PAYMENT_ID_MAX_LENGTH",
    "PAYMENT_ID_PATTERN",
    # Types
    "PaymentIdentifierInfo",
    "PaymentIdentifierExtension",
    "PaymentIdentifierSchema",
    # Schema
    "payment_identifier_schema",
    # Utils
    "generate_payment_id",
    "is_valid_payment_id",
    # Client functions
    "append_payment_identifier_to_extensions",
    # Server functions
    "declare_payment_identifier_extension",
    "PaymentIdentifierResourceServerExtension",
    "payment_identifier_resource_server_extension",
    # Validation functions
    "is_payment_identifier_extension",
    "validate_payment_identifier",
    "extract_payment_identifier",
    "extract_and_validate_payment_identifier",
    "has_payment_identifier",
    "is_payment_identifier_required",
    "validate_payment_identifier_requirement",
    "PaymentIdentifierValidationResult",
]
