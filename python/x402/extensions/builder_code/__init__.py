"""Builder Code Extension for x402 (ERC-8021).

Enables onchain attribution tracking for x402 payments by appending ERC-8021
Schema 2 builder codes to settlement transaction calldata.

Three parties attach their builder code:
- Server: declares ``a`` (app) in the 402 response via ``declare_builder_code_extension``.
- Client: echoes ``a`` and adds ``s`` (service) via ``BuilderCodeClientExtension``.
- Facilitator: optionally adds ``w`` (wallet) at settlement via ``BuilderCodeFacilitatorExtension``.

## Usage

### For Resource Servers

```python
from x402.extensions.builder_code import declare_builder_code_extension, BUILDER_CODE

extensions = {BUILDER_CODE: declare_builder_code_extension("bc_my_service")}
```

### For Clients

```python
from x402.extensions.builder_code import BuilderCodeClientExtension

client.register_extension(BuilderCodeClientExtension("bc_my_client"))
```

### For Facilitators

```python
from x402.extensions.builder_code import BuilderCodeFacilitatorExtension

facilitator.register_extension(
    BuilderCodeFacilitatorExtension(builder_code="bc_my_facilitator")
)
```
"""

from .cbor import encode_builder_code_suffix, parse_builder_code_suffix_from_calldata
from .client import BuilderCodeClientExtension
from .facilitator import BuilderCodeFacilitatorExtension
from .server import (
    BUILDER_CODE_SCHEMA,
    BuilderCodeResourceServerExtension,
    builder_code_resource_server_extension,
    declare_builder_code_extension,
)
from .types import (
    BUILDER_CODE,
    BUILDER_CODE_PATTERN,
    ERC_8021_MARKER,
    MAX_SERVICE_CODES,
    SCHEMA_2_ID,
    BuilderCodeExtensionData,
    BuilderCodeFacilitatorConfig,
)

__all__ = [
    # Constants
    "BUILDER_CODE",
    "BUILDER_CODE_PATTERN",
    "ERC_8021_MARKER",
    "MAX_SERVICE_CODES",
    "SCHEMA_2_ID",
    "BUILDER_CODE_SCHEMA",
    # Types
    "BuilderCodeExtensionData",
    "BuilderCodeFacilitatorConfig",
    # CBOR encoding
    "encode_builder_code_suffix",
    "parse_builder_code_suffix_from_calldata",
    # Resource Server
    "declare_builder_code_extension",
    "BuilderCodeResourceServerExtension",
    "builder_code_resource_server_extension",
    # Client
    "BuilderCodeClientExtension",
    # Facilitator
    "BuilderCodeFacilitatorExtension",
]
