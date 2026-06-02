"""Cooperative refund flow (client side)."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from .....http.utils import (
    decode_payment_required_header,
    decode_payment_response_header,
    encode_payment_signature_header,
)
from .....schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
)
from ..constants import SCHEME_BATCH_SETTLEMENT
from ..errors import ERR_REFUND_AMOUNT_INVALID, ERR_REFUND_NO_BALANCE
from ..types import RefundPayload
from ..utils import compute_channel_id
from .channel import (
    BatchSettlementClientDeps,
    build_channel_config,
    recover_channel,
    update_channel_after_refund,
)
from .recovery import process_corrective_payment_required
from .voucher import sign_voucher

# Refund-specific server errors the client cannot recover from automatically.
NON_RECOVERABLE_REFUND_ERRORS: frozenset[str] = frozenset(
    {ERR_REFUND_NO_BALANCE, ERR_REFUND_AMOUNT_INVALID}
)


@dataclass
class _RefundResponse:
    """Normalised view of a sync HTTP response used by `refund_channel`."""

    status: int
    headers: Mapping[str, str] = field(default_factory=dict)

    def header(self, name: str) -> str | None:
        if name in self.headers:
            return self.headers[name]
        lower = name.lower()
        for k, v in self.headers.items():
            if k.lower() == lower:
                return v
        return None


RefundFetch = Callable[[str, dict[str, str]], _RefundResponse]


@dataclass
class RefundOptions:
    """Caller-facing options for `refund_channel`."""

    amount: str | None = None
    fetch: RefundFetch | None = None


def refund_channel(
    deps: BatchSettlementClientDeps,
    url: str,
    options: RefundOptions | None = None,
    *,
    _url_cache: dict[str, str] | None = None,
) -> SettleResponse:
    """Send a cooperative refund request to the channel that backs `url`.

    The `fetch` callable signature is `(url, headers) -> _RefundResponse`. A
    default implementation backed by `httpx` is used when none is supplied.

    `_url_cache` is an optional caller-managed dict mapping URL → channel_id.
    When provided, a cached channel_id enables a local pre-check that avoids any
    network I/O when the channel is already drained.
    """
    opts = options or RefundOptions()
    fetch = opts.fetch or _default_fetch
    refund_amount = _normalize_refund_amount(opts.amount)

    # Fast-path: if we have a cached channel_id for this URL, check balance
    # locally before making any network request.
    if _url_cache is not None:
        cached_id = _url_cache.get(url)
        if cached_id is not None:
            ch = deps.storage.get(cached_id)
            if ch is not None:
                charged = ch.charged_cumulative_amount or "0"
                if ch.balance is not None and int(ch.balance) <= int(charged):
                    raise RuntimeError(
                        f"Refund failed: channel has no remaining balance "
                        f"(balance={ch.balance}, chargedCumulativeAmount={charged})"
                    )

    probe = _probe_refund_requirements(url, fetch)

    # Populate cache with the channel_id discovered from the probe requirements.
    if _url_cache is not None:
        _url_cache[url] = _channel_key(deps, probe.requirements)

    return _execute_refund(deps, url, probe, refund_amount, fetch)


@dataclass
class _Probe:
    payment_required: PaymentRequired
    requirements: PaymentRequirements


def _probe_refund_requirements(url: str, fetch: RefundFetch) -> _Probe:
    response = fetch(url, {})
    if response.status != 402:
        raise RuntimeError(f"Refund probe expected 402, got {response.status}")
    header = response.header("PAYMENT-REQUIRED")
    if not header:
        raise RuntimeError("Refund probe response missing PAYMENT-REQUIRED header")
    payment_required = decode_payment_required_header(header)
    requirements = next(
        (a for a in payment_required.accepts if a.scheme == SCHEME_BATCH_SETTLEMENT),
        None,
    )
    if requirements is None:
        raise RuntimeError(f"No {SCHEME_BATCH_SETTLEMENT} payment option at {url}")
    extra = requirements.extra or {}
    if not extra.get("receiverAuthorizer"):
        raise RuntimeError("Refund requires a configured receiverAuthorizer on the receiver")
    return _Probe(payment_required=payment_required, requirements=requirements)


def _execute_refund(
    deps: BatchSettlementClientDeps,
    url: str,
    probe: _Probe,
    refund_amount: str | None,
    fetch: RefundFetch,
) -> SettleResponse:
    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        payment_payload = _build_refund_payment_payload(
            deps, probe.payment_required, probe.requirements, refund_amount
        )
        headers = {"PAYMENT-SIGNATURE": encode_payment_signature_header(payment_payload)}

        response = fetch(url, headers)

        if response.status == 402:
            non_recoverable = _get_non_recoverable_refund_failure(response)
            if non_recoverable:
                raise RuntimeError(non_recoverable)

        settle_header = response.header("PAYMENT-RESPONSE")
        settle_response = decode_payment_response_header(settle_header) if settle_header else None

        if settle_response is not None:
            channel_id_key = _channel_key(deps, probe.requirements)
            update_channel_after_refund(
                deps.storage,
                channel_id_key,
                settle_response.extra or {},
            )
            if response.status == 402:
                # Treat as failure even if PAYMENT-RESPONSE present.
                raise RuntimeError(_format_refund_failure(settle_response))
            return settle_response

        if response.status == 402:
            payment_required = _get_refund_payment_required(response)
            # Best-effort state resync before retrying; ignore return value.
            process_corrective_payment_required(deps, payment_required)
            if attempt < max_attempts:
                continue
            raise RuntimeError(f"Refund failed: server returned 402 after {attempt} attempt(s)")

        raise RuntimeError(
            f"Refund response missing PAYMENT-RESPONSE header (status {response.status})"
        )

    raise RuntimeError("Refund failed: retry budget exhausted")


def _channel_key(
    deps: BatchSettlementClientDeps,
    requirements: PaymentRequirements,
) -> str:
    config = build_channel_config(deps, requirements)
    return compute_channel_id(config, str(requirements.network)).lower()


def _build_refund_payment_payload(
    deps: BatchSettlementClientDeps,
    payment_required: PaymentRequired,
    requirements: PaymentRequirements,
    refund_amount: str | None,
) -> PaymentPayload:
    config = build_channel_config(deps, requirements)
    channel_id = compute_channel_id(config, str(requirements.network))
    key = channel_id.lower()

    channel = deps.storage.get(key)
    if channel is None and hasattr(deps.signer, "read_contract"):
        channel = recover_channel(deps, requirements)
    if channel is None:
        raise RuntimeError(
            "Refund requires an existing channel record; deposit first or call from a "
            "context with an EVM RPC"
        )

    charged = channel.charged_cumulative_amount or "0"
    if channel.balance is not None and int(channel.balance) <= int(charged):
        raise RuntimeError(
            f"Refund failed: channel has no remaining balance "
            f"(balance={channel.balance}, chargedCumulativeAmount={charged})"
        )

    voucher_signer = deps.voucher_signer or deps.signer
    voucher = sign_voucher(voucher_signer, channel_id, charged, str(requirements.network))

    payload = RefundPayload()
    payload.channel_config = config
    payload.voucher = voucher
    if refund_amount is not None:
        payload.amount = refund_amount

    return PaymentPayload(
        x402_version=2,
        accepted=requirements,
        payload=payload.to_dict(),
        resource=payment_required.resource,
        extensions=payment_required.extensions,
    )


def _get_non_recoverable_refund_failure(response: _RefundResponse) -> str | None:
    settle_header = response.header("PAYMENT-RESPONSE")
    if settle_header:
        return _format_refund_failure(decode_payment_response_header(settle_header))
    payment_required = _get_refund_payment_required(response)
    err = payment_required.error
    if err and err in NON_RECOVERABLE_REFUND_ERRORS:
        return f"Refund failed: {err}"
    return None


def _get_refund_payment_required(response: _RefundResponse) -> PaymentRequired:
    header = response.header("PAYMENT-REQUIRED")
    if not header:
        raise RuntimeError("Refund 402 missing PAYMENT-REQUIRED header")
    pr = decode_payment_required_header(header)
    if not isinstance(pr, PaymentRequired):
        raise RuntimeError("Refund 402 decoded as V1; expected V2")
    return pr


def _format_refund_failure(settle: SettleResponse) -> str:
    reason = settle.error_reason or "unknown_settlement_error"
    message = settle.error_message
    if message and message != reason:
        return f"Refund failed: {reason}: {message}"
    return f"Refund failed: {reason}"


_AMOUNT_RE = re.compile(r"^\d+$")


def _normalize_refund_amount(amount: str | None) -> str | None:
    if amount is None:
        return None
    if not _AMOUNT_RE.match(amount) or amount == "0":
        raise ValueError(f'Invalid refund amount "{amount}": must be a positive integer string')
    return amount


def _default_fetch(url: str, headers: dict[str, str]) -> _RefundResponse:
    try:
        import httpx
    except ImportError as e:  # pragma: no cover - exercised when httpx missing
        raise RuntimeError(
            "refund_channel default fetch requires httpx (install x402[httpx])"
        ) from e
    response = httpx.get(url, headers=headers)
    return _RefundResponse(
        status=response.status_code,
        headers=dict(response.headers),
    )


__all__ = ["RefundOptions", "refund_channel"]
