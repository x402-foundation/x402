"""Data-suffix plumbing for appending ERC-8021 suffixes to settlement calldata.

Structural coupling only: this module never imports the builder-code extension
package. It duck-types ``context.get_extension(BUILDER_CODE_KEY).build_data_suffix``
so any extension exposing that method can contribute a settlement calldata suffix.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ...interfaces import FacilitatorContext
    from ...schemas import PaymentPayload, PaymentRequirements

BUILDER_CODE_KEY = "builder-code"


def _is_empty_suffix(suffix: str | None) -> bool:
    return not suffix or suffix == "0x" or len(suffix) <= 2


def resolve_data_suffix(
    context: FacilitatorContext | None,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
) -> str | None:
    """Resolve the builder-code data suffix from the registered extension, if any.

    Args:
        context: Facilitator context used to look up registered extensions.
        payload: The payment payload being settled.
        requirements: The matched payment requirements.

    Returns:
        The hex-encoded suffix, or ``None`` when no extension contributes one.
    """
    if context is None:
        return None

    extension: Any = context.get_extension(BUILDER_CODE_KEY)
    if extension is None:
        return None

    build_data_suffix = getattr(extension, "build_data_suffix", None)
    if build_data_suffix is None:
        return None

    suffix = build_data_suffix(payload, requirements)
    if _is_empty_suffix(suffix):
        return None
    return suffix


def append_data_suffix(calldata: str, suffix: str | None) -> str:
    """Append a hex data suffix to encoded contract calldata.

    Args:
        calldata: Base encoded function calldata (with or without ``0x`` prefix).
        suffix: Optional hex suffix (with or without ``0x`` prefix).

    Returns:
        The calldata with the suffix appended, or the original calldata when the
        suffix is empty.
    """
    if _is_empty_suffix(suffix):
        return calldata
    suffix_hex = suffix[2:] if suffix.startswith("0x") else suffix  # type: ignore[union-attr]
    return f"{calldata}{suffix_hex}"
