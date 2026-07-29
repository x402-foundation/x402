"""Facilitator-side extension for the Builder Code Extension.

At settlement time, the facilitator encodes its wallet code (``w``) into the
ERC-8021 suffix when configured. App code (``a``) and service code(s) (``s``) are
read from the client payment payload extensions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ...interfaces import FacilitatorExtension
from ...schemas import PaymentPayload, PaymentRequirements
from .cbor import encode_builder_code_suffix
from .types import (
    BUILDER_CODE,
    BUILDER_CODE_PATTERN,
    MAX_SERVICE_CODES,
    BuilderCodeExtensionData,
)


def _extract_client_info(extensions: dict[str, Any] | None) -> dict[str, Any] | None:
    """Read the client builder-code ``info`` object from payment-payload extensions."""
    if not extensions:
        return None
    ext = extensions.get(BUILDER_CODE)
    if not isinstance(ext, dict):
        return None
    info = ext.get("info")
    if not isinstance(info, dict):
        return None
    return info


def _resolve_service_codes(raw: Any) -> list[str]:
    """Normalize and validate ``s`` from the client payload, keeping valid entries in order and truncating to MAX_SERVICE_CODES."""
    candidates = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
    valid = [c for c in candidates if isinstance(c, str) and BUILDER_CODE_PATTERN.match(c)]
    return valid[:MAX_SERVICE_CODES]


@dataclass(frozen=True)
class BuilderCodeFacilitatorExtension(FacilitatorExtension):
    """Facilitator extension that manages builder code attribution at settlement.

    Example:
        ```python
        from x402.extensions.builder_code import BuilderCodeFacilitatorExtension

        facilitator.register_extension(
            BuilderCodeFacilitatorExtension(builder_code="bc_my_facilitator")
        )
        ```
    """

    key: str = BUILDER_CODE
    builder_code: str | None = None

    def __post_init__(self) -> None:
        if self.builder_code and not BUILDER_CODE_PATTERN.match(self.builder_code):
            raise ValueError(
                f'Invalid builder code: "{self.builder_code}". '
                "Must be 1-32 characters, lowercase alphanumeric and underscores only."
            )

    def build_data_suffix(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> str | None:
        """Build the ERC-8021 Schema 2 calldata suffix for a settlement transaction.

        ``a`` and ``s`` are read from the client's payment payload extensions; ``w`` is
        the facilitator's own code when configured.

        Args:
            payload: The payment payload being settled.
            requirements: The matched payment requirements (unused; attribution comes
                from the client payload echo).

        Returns:
            Hex-encoded ERC-8021 builder-code calldata suffix, or ``None`` when no
            attribution is present.
        """
        info = _extract_client_info(payload.extensions)
        raw_a = info.get("a") if info else None
        a = raw_a if isinstance(raw_a, str) and BUILDER_CODE_PATTERN.match(raw_a) else None
        s = _resolve_service_codes(info.get("s") if info else None)

        data = BuilderCodeExtensionData(a=a, w=self.builder_code, s=s or None)
        if not data.a and not data.w and not data.s:
            return None

        return encode_builder_code_suffix(data)
