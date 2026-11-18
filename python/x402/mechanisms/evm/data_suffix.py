"""Data-suffix plumbing for appending ERC-8021 suffixes to settlement calldata.

Structural coupling only: this module never imports the builder-code extension
package. It duck-types ``context.get_extension(BUILDER_CODE_KEY).build_data_suffix``
so any extension exposing that method can contribute a settlement calldata suffix.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ...interfaces import FacilitatorContext
    from ...schemas import PaymentPayload, PaymentRequirements

BUILDER_CODE_KEY = "builder-code"


@dataclass
class DataSuffixContext:
    """Settlement payload, requirements, and optional facilitator metadata.

    ``metadata`` is encoded as the ERC-8021 Schema 2 ``m`` field when the
    registered extension accepts it. Mechanisms that have no metadata leave it
    unset.
    """

    payload: PaymentPayload
    requirements: PaymentRequirements
    metadata: dict[str, Any] | None = None


def _is_empty_suffix(suffix: str | None) -> bool:
    return not suffix or suffix == "0x" or len(suffix) <= 2


def resolve_data_suffix(
    context: FacilitatorContext | None,
    payload: PaymentPayload | DataSuffixContext,
    requirements: PaymentRequirements | None = None,
    metadata: dict[str, Any] | None = None,
) -> str | None:
    """Resolve the builder-code data suffix from the registered extension, if any.

    Args:
        context: Facilitator context used to look up registered extensions.
        payload: The payment payload being settled, or a ``DataSuffixContext``.
        requirements: The matched payment requirements. Required when ``payload``
            is not a ``DataSuffixContext``.
        metadata: Facilitator-authored settlement metadata forwarded to the
            extension as ``m``. A ``DataSuffixContext`` can carry it instead.

    Returns:
        The hex-encoded suffix, or ``None`` when no extension contributes one.
    """
    if context is None:
        return None

    settled_metadata = metadata
    if isinstance(payload, DataSuffixContext):
        settled_payload = payload.payload
        settled_requirements = payload.requirements
        if settled_metadata is None:
            settled_metadata = payload.metadata
    elif requirements is None:
        raise TypeError("requirements is required")
    else:
        settled_payload = payload
        settled_requirements = requirements

    extension: Any = context.get_extension(BUILDER_CODE_KEY)
    if extension is None:
        return None

    build_data_suffix = getattr(extension, "build_data_suffix", None)
    if build_data_suffix is None:
        return None

    if settled_metadata is None:
        suffix = build_data_suffix(settled_payload, settled_requirements)
    else:
        suffix = build_data_suffix(settled_payload, settled_requirements, settled_metadata)
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
