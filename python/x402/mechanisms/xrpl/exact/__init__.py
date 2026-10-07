"""Exact payment scheme for XRPL networks."""

from .client import ExactXrplScheme as ExactXrplClientScheme
from .client import XrplClientOptions
from .facilitator import ExactXrplScheme as ExactXrplFacilitatorScheme
from .server import ExactXrplScheme as ExactXrplServerScheme

# Unified export (context determines which is used)
ExactXrplScheme = ExactXrplClientScheme  # Most common use case

__all__ = [
    "ExactXrplScheme",
    "ExactXrplClientScheme",
    "ExactXrplServerScheme",
    "ExactXrplFacilitatorScheme",
    "XrplClientOptions",
]
