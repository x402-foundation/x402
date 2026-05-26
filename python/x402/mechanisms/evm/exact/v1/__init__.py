"""Exact EVM payment scheme V1 (legacy) for x402."""

from .client import ExactEvmSchemeV1 as ExactEvmSchemeV1Client
from .facilitator import ExactEvmSchemeV1 as ExactEvmSchemeV1Facilitator
from .facilitator import ExactEvmSchemeV1Config

# Re-export with role-agnostic name (context determines which)
ExactEvmSchemeV1 = ExactEvmSchemeV1Client

__all__ = [
    "ExactEvmSchemeV1",
    "ExactEvmSchemeV1Client",
    "ExactEvmSchemeV1Facilitator",
    "ExactEvmSchemeV1Config",
]
