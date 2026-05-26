"""Exact EVM payment scheme for x402."""

from .client import ExactEvmScheme as ExactEvmClientScheme
from .facilitator import ExactEvmScheme as ExactEvmFacilitatorScheme
from .facilitator import ExactEvmSchemeConfig
from .register import (
    register_exact_evm_client,
    register_exact_evm_facilitator,
    register_exact_evm_server,
)
from .server import ExactEvmScheme as ExactEvmServerScheme

# Unified export (context determines which is used)
ExactEvmScheme = ExactEvmClientScheme  # Most common use case

__all__ = [
    "ExactEvmScheme",
    "ExactEvmClientScheme",
    "ExactEvmServerScheme",
    "ExactEvmFacilitatorScheme",
    "ExactEvmSchemeConfig",
    "register_exact_evm_client",
    "register_exact_evm_server",
    "register_exact_evm_facilitator",
]
