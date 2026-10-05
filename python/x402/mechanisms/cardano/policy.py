"""Normalize confirmation policy without coercing untrusted wire values."""

from dataclasses import dataclass
from typing import Any

from .constants import DEFAULT_L1_CONFIRMATIONS, MAX_L1_CONFIRMATIONS, MIN_L1_CONFIRMATIONS
from .types import CardanoConfirmationPolicy

_UNSET = object()


@dataclass(frozen=True)
class ResolvedCardanoPolicies:
    confirmation_policy: CardanoConfirmationPolicy


def normalize_confirmation_policy(value: object = _UNSET) -> CardanoConfirmationPolicy | None:
    """Use the default only for an absent policy; JSON null is invalid."""
    if value is _UNSET:
        return CardanoConfirmationPolicy(DEFAULT_L1_CONFIRMATIONS)
    if not isinstance(value, dict) or set(value) != {"l1Confirmations"}:
        return None
    depth = value["l1Confirmations"]
    if type(depth) is not int or not MIN_L1_CONFIRMATIONS <= depth <= MAX_L1_CONFIRMATIONS:
        return None
    return CardanoConfirmationPolicy(depth)


def resolve_cardano_policies(extra: dict[str, Any] | None = None) -> ResolvedCardanoPolicies | None:
    policy = normalize_confirmation_policy((extra or {}).get("confirmationPolicy", _UNSET))
    return ResolvedCardanoPolicies(policy) if policy is not None else None


def confirmations_satisfy(observed: int, required: int) -> bool:
    return observed >= required
