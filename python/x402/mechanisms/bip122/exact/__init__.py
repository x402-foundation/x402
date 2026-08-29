"""Exact BIP-122 payment scheme for x402."""

from .client import ExactBip122Scheme as ExactBip122ClientScheme
from .facilitator import ExactBip122Scheme as ExactBip122FacilitatorScheme
from .register import (
    register_exact_bip122_client,
    register_exact_bip122_facilitator,
    register_exact_bip122_server,
)
from .server import ExactBip122Scheme as ExactBip122ServerScheme

ExactBip122Scheme = ExactBip122ClientScheme

__all__ = [
    "ExactBip122Scheme",
    "ExactBip122ClientScheme",
    "ExactBip122ServerScheme",
    "ExactBip122FacilitatorScheme",
    "register_exact_bip122_client",
    "register_exact_bip122_server",
    "register_exact_bip122_facilitator",
]
