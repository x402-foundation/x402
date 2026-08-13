"""Hook mutation policy guards for extension and scheme enrichment."""

from __future__ import annotations

import copy
from typing import Any, TypedDict

from .schemas import PaymentRequirements, SettleResponse


def _deep_equal(a: Any, b: Any) -> bool:
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        if set(a.keys()) != set(b.keys()):
            return False
        return all(_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        if len(a) != len(b):
            return False
        return all(_deep_equal(x, y) for x, y in zip(a, b, strict=True))
    return a == b


def is_vacant_string_field(value: str) -> bool:
    return value.strip() == ""


def snapshot_payment_requirements_list(
    requirements: list[PaymentRequirements],
) -> list[PaymentRequirements]:
    return [req.model_copy(update={"extra": copy.deepcopy(req.extra)}) for req in requirements]


def assert_accepts_allowlisted_after_extension_enrich(
    baseline: list[PaymentRequirements],
    current: list[PaymentRequirements],
    extension_key: str,
) -> None:
    if len(baseline) != len(current):
        raise ValueError(
            f'[x402] extension "{extension_key}" violated accepts mutation policy: '
            f"accepts length changed ({len(baseline)} → {len(current)})"
        )

    for i, (b, c) in enumerate(zip(baseline, current, strict=True)):
        if b.scheme != c.scheme or b.network != c.network:
            raise ValueError(
                f'[x402] extension "{extension_key}" violated accepts mutation policy: '
                f"scheme/network are immutable (index {i})"
            )
        if b.max_timeout_seconds != c.max_timeout_seconds:
            raise ValueError(
                f'[x402] extension "{extension_key}" violated accepts mutation policy: '
                f"maxTimeoutSeconds is immutable (index {i})"
            )

        for field in ("pay_to", "amount", "asset"):
            bv = getattr(b, field)
            cv = getattr(c, field)
            if not is_vacant_string_field(bv) and cv != bv:
                raise ValueError(
                    f'[x402] extension "{extension_key}" violated accepts mutation policy: '
                    f'"{field}" may only be set when the resource left it vacant (""); '
                    f"non-vacant values are immutable (index {i})"
                )

        for key in b.extra:
            if key not in c.extra:
                raise ValueError(
                    f'[x402] extension "{extension_key}" violated accepts mutation policy: '
                    f'extra["{key}"] was removed (index {i})'
                )
            if not _deep_equal(c.extra[key], b.extra[key]):
                raise ValueError(
                    f'[x402] extension "{extension_key}" violated accepts mutation policy: '
                    f'extra["{key}"] may not be changed (index {i})'
                )


def assert_accepts_additive_extra_after_scheme_enrich(
    baseline: list[PaymentRequirements],
    current: list[PaymentRequirements],
    scheme: str,
    network: str,
) -> None:
    if len(baseline) != len(current):
        raise ValueError(
            f'[x402] scheme "{scheme}" violated accepts mutation policy: '
            f"accepts length changed ({len(baseline)} → {len(current)})"
        )

    for i, (b, c) in enumerate(zip(baseline, current, strict=True)):
        is_matching_accept = b.scheme == scheme and b.network == network

        if b.scheme != c.scheme or b.network != c.network:
            raise ValueError(
                f'[x402] scheme "{scheme}" violated accepts mutation policy: '
                f"scheme/network are immutable (index {i})"
            )
        if (
            b.max_timeout_seconds != c.max_timeout_seconds
            or b.pay_to != c.pay_to
            or b.amount != c.amount
            or b.asset != c.asset
        ):
            raise ValueError(
                f'[x402] scheme "{scheme}" violated accepts mutation policy: '
                f"payment terms are immutable (index {i})"
            )

        for key in b.extra:
            if key not in c.extra:
                raise ValueError(
                    f'[x402] scheme "{scheme}" violated accepts mutation policy: '
                    f'extra["{key}"] was removed (index {i})'
                )
            if not _deep_equal(c.extra[key], b.extra[key]):
                raise ValueError(
                    f'[x402] scheme "{scheme}" violated accepts mutation policy: '
                    f'extra["{key}"] may not be changed (index {i})'
                )

        if not is_matching_accept and len(c.extra) != len(b.extra):
            raise ValueError(
                f'[x402] scheme "{scheme}" violated accepts mutation policy: '
                f"only matching accepts may receive new extra fields (index {i})"
            )


class SettleResponseCoreSnapshot(TypedDict):
    success: bool
    transaction: str
    network: str
    amount: str | None
    payer: str | None
    error_reason: str | None
    error_message: str | None


def snapshot_settle_response_core(result: SettleResponse) -> SettleResponseCoreSnapshot:
    return {
        "success": result.success,
        "transaction": result.transaction,
        "network": result.network,
        "amount": result.amount,
        "payer": result.payer,
        "error_reason": result.error_reason,
        "error_message": result.error_message,
    }


def assert_settle_response_core_unchanged(
    before: SettleResponseCoreSnapshot,
    after: SettleResponse,
    extension_key: str,
) -> None:
    for key in (
        "success",
        "transaction",
        "network",
        "amount",
        "payer",
        "error_reason",
        "error_message",
    ):
        if not _deep_equal(getattr(after, key), before[key]):
            raise ValueError(
                f'[x402] extension "{extension_key}" violated settlement mutation policy: '
                f'field "{key}" is immutable after facilitator settle'
            )


def _is_plain_record(value: Any) -> bool:
    return isinstance(value, dict)


def assert_additive_payload_enrichment(
    payload: dict[str, Any],
    enrichment: dict[str, Any],
    caller_label: str,
) -> None:
    for key in enrichment:
        if key in payload:
            raise ValueError(
                f"[x402] {caller_label} violated settlement payload enrichment policy: "
                f'"{key}" already exists on the client payload'
            )


def assert_additive_settlement_extra(
    extra: dict[str, Any],
    enrichment: dict[str, Any],
    caller_label: str,
) -> None:
    _assert_additive_record(extra, enrichment, caller_label, "extra")


def merge_additive_settlement_extra(
    extra: dict[str, Any],
    enrichment: dict[str, Any],
) -> dict[str, Any]:
    return _merge_additive_record(extra, enrichment)


def _assert_additive_record(
    target: dict[str, Any],
    enrichment: dict[str, Any],
    caller_label: str,
    path: str,
) -> None:
    for key, enrichment_value in enrichment.items():
        next_path = f'{path}["{key}"]'
        if key not in target:
            continue

        target_value = target[key]
        if _is_plain_record(target_value) and _is_plain_record(enrichment_value):
            _assert_additive_record(target_value, enrichment_value, caller_label, next_path)
            continue

        raise ValueError(
            f"[x402] {caller_label} violated settlement response enrichment policy: "
            f"{next_path} already exists on the settlement result"
        )


def _merge_additive_record(
    target: dict[str, Any],
    enrichment: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(target)
    for key, enrichment_value in enrichment.items():
        target_value = merged.get(key)
        if _is_plain_record(target_value) and _is_plain_record(enrichment_value):
            merged[key] = _merge_additive_record(target_value, enrichment_value)
            continue
        merged[key] = enrichment_value
    return merged
