"""Foundation types for the x402 Python SDK."""

from typing import Any, TypeAlias

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# Current protocol version
X402_VERSION: int = 2

# Type aliases
Network: TypeAlias = str
"""CAIP-2 format network identifier (e.g., "eip155:8453", "solana:mainnet")."""

Money: TypeAlias = str | int | float
"""User-friendly price format (e.g., "$1.50", 1.50, "0.10")."""


class BaseX402Model(BaseModel):
    """Base class for all x402 models with camelCase JSON serialization.

    All Pydantic models in the SDK should inherit from this class.
    Do NOT repeat model_config in individual models.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        from_attributes=True,
    )


class AssetAmount(BaseX402Model):
    """Amount in smallest unit with asset identifier.

    Attributes:
        amount: Amount in smallest unit (e.g., "1500000" for 1.5 USDC with 6 decimals).
        asset: Asset address/identifier.
        extra: Optional additional metadata.
    """

    amount: str
    asset: str
    extra: dict[str, Any] | None = None


# Price can be user-friendly Money or explicit AssetAmount
Price: TypeAlias = Money | AssetAmount
"""Price can be Money (user-friendly) or AssetAmount (explicit)."""
