"""Exact SVM payment scheme V1 (legacy) for x402."""

from .client import ExactSvmSchemeV1 as ExactSvmSchemeV1Client
from .facilitator import ExactSvmSchemeV1 as ExactSvmSchemeV1Facilitator

# Re-export with role-agnostic name (context determines which)
ExactSvmSchemeV1 = ExactSvmSchemeV1Client

__all__ = [
    "ExactSvmSchemeV1",
    "ExactSvmSchemeV1Client",
    "ExactSvmSchemeV1Facilitator",
]
