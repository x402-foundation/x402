"""Type definitions for the Builder Code Extension (ERC-8021).

Enables attribution tracking for x402 payments by appending ERC-8021 Schema 2
builder codes to settlement transaction calldata.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Extension identifier constant
BUILDER_CODE = "builder-code"

# ERC-8021 marker bytes (16 bytes) appended at the end of every suffix
ERC_8021_MARKER = "80218021802180218021802180218021"

# Schema 2 identifier byte
SCHEMA_2_ID = 0x02

# Pattern for valid builder codes (lowercase alphanumeric + underscore, 1-32 chars)
BUILDER_CODE_PATTERN = re.compile(r"^[a-z0-9_]{1,32}$")

# Maximum number of service codes (`s`) encoded onchain at settlement
MAX_SERVICE_CODES = 5


@dataclass
class BuilderCodeExtensionData:
    """Builder code fields as they appear in the extension and CBOR suffix.

    Maps to ERC-8021 Schema 2 fields:
    - a: app code — the x402 service that exposed the paid endpoint.
    - w: wallet code — the facilitator that settled the payment onchain.
    - s: service code(s) — client-provided attribution. Accepts a single string
      or a list of strings on input; the encoded suffix always normalizes it to a
      CBOR array.
    """

    a: str | None = None
    w: str | None = None
    s: str | list[str] | None = None


@dataclass
class BuilderCodeFacilitatorConfig:
    """Configuration for the builder code facilitator extension.

    Attributes:
        builder_code: The facilitator's own builder code, set as the ``w`` field at
            settlement when provided.
    """

    builder_code: str | None = None
