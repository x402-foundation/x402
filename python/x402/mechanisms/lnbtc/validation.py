"""Validation shared by Lightning clients, resource servers and facilitators."""

from __future__ import annotations

import re
from hashlib import sha256
from typing import Any

from bech32 import CHARSET, bech32_decode
from bolt11 import Bolt11, decode
from coincurve import PublicKey

from ...schemas import PaymentRequirements
from .binding import canonical, validate_binding
from .constants import NETWORKS, LightningValidationError, invalid

_HEX = re.compile(r"[0-9a-f]{64}")
_AMOUNT = re.compile(r"[0-9]+")


def validate_skew(skew: int) -> None:
    if type(skew) is not int or skew < 0:
        raise ValueError("clock_skew must be a non-negative integer")


def validate_amount(amount: Any) -> int:
    if not isinstance(amount, str) or not _AMOUNT.fullmatch(amount):
        raise invalid("amount")
    try:
        value = int(amount)
    except ValueError as exc:
        raise invalid("amount") from exc
    if value <= 0:
        raise invalid("amount")
    return value


def validate_terms(requirements: PaymentRequirements, *, require_invoice: bool = True) -> None:
    if requirements.scheme != "exact":
        raise LightningValidationError("unsupported_scheme")
    if requirements.network not in NETWORKS:
        raise LightningValidationError("unsupported_network")
    if requirements.asset != "BTC":
        raise invalid("asset")
    validate_amount(requirements.amount)
    if type(requirements.max_timeout_seconds) is not int or requirements.max_timeout_seconds <= 0:
        raise invalid("max_timeout")
    payee = requirements.pay_to
    if not isinstance(payee, str) or not re.fullmatch(r"0[23][0-9a-f]{64}", payee):
        raise invalid("pay_to_malformed")
    try:
        PublicKey(bytes.fromhex(payee))
    except ValueError as exc:
        raise invalid("pay_to_malformed") from exc
    extra = requirements.extra
    if extra.get("assetTransferMethod", "bolt11") != "bolt11":
        raise invalid("asset_transfer_method")
    if extra.get("paymentFlow") != "upfront":
        raise invalid("payment_flow")
    validate_binding(extra)
    if require_invoice and (not isinstance(extra.get("invoice"), str) or not extra["invoice"]):
        raise invalid("invoice_missing")


def match_requirements(accepted: PaymentRequirements, required: PaymentRequirements) -> None:
    if accepted.scheme != "exact" or required.scheme != "exact":
        raise LightningValidationError("unsupported_scheme")
    if accepted.network != required.network:
        raise LightningValidationError("network_mismatch")
    if accepted.asset != "BTC" or required.asset != "BTC":
        raise invalid("asset")
    validate_amount(accepted.amount)
    validate_amount(required.amount)
    for attribute, reason in (
        ("amount", "amount_mismatch"),
        ("pay_to", "pay_to_mismatch"),
        ("max_timeout_seconds", "max_timeout_mismatch"),
    ):
        if getattr(accepted, attribute) != getattr(required, attribute):
            raise invalid(reason)
    validate_terms(required)
    validate_terms(accepted)
    binding_keys = {"requestHash", "requestBindingProfile", "requestBindingParams"}
    for key in binding_keys:
        if canonical(accepted.extra[key]) != canonical(required.extra[key]):
            raise invalid("request_mismatch")
    for key, value in required.extra.items():
        if key in binding_keys | {"invoice", "assetTransferMethod", "paymentFlow"}:
            continue
        if key not in accepted.extra or canonical(accepted.extra[key]) != canonical(value):
            raise invalid("extra_mismatch")


def decode_invoice(invoice: str) -> Bolt11:
    """Check fields the dependency deliberately skips or rounds during decoding."""
    try:
        hrp, words = bech32_decode(invoice)
        if hrp is None or words is None or len(words) < 111:
            raise invalid("invoice_decode_failed")
        amount = re.fullmatch(r"ln(bcrt|tbs|bc|tb)([0-9]+)([munp]?)", hrp)
        if amount is None or (amount[3] == "p" and int(amount[2]) % 10):
            raise invalid("invoice_decode_failed")
        tags: dict[str, list[list[int]]] = {}
        position, end = 7, len(words) - 104
        while position < end:
            if position + 3 > end:
                raise invalid("invoice_decode_failed")
            name = CHARSET[words[position]]
            length = words[position + 1] * 32 + words[position + 2]
            position += 3
            if position + length > end:
                raise invalid("invoice_decode_failed")
            tags.setdefault(name, []).append(words[position : position + length])
            position += length
        if len(tags.get("h", [])) != 1 or "d" in tags:
            raise invalid("invoice_description")
        for name in ("p", "h", "s"):
            fields = tags.get(name, [])
            if len(fields) != 1 or len(fields[0]) != 52 or fields[0][-1] & 15:
                raise invalid("invoice_decode_failed")
        for name in ("n", "x", "c", "9"):
            if len(tags.get(name, [])) > 1:
                raise invalid("invoice_decode_failed")
        if "n" in tags and (len(tags["n"][0]) != 53 or tags["n"][0][-1] & 1):
            raise invalid("invoice_decode_failed")
        result = decode(invoice)
        if (
            result.amount_msat is None
            or result.amount_msat <= 0
            or result.signature is None
            or result.payee is None
        ):
            raise invalid("invoice_decode_failed")
        result.signature.verify(result.payee)
        return result
    except LightningValidationError:
        raise
    except Exception as exc:
        # Decoder exceptions contain input-dependent details; do not return them on the wire.
        raise invalid("invoice_decode_failed") from exc


def validate_invoice(
    invoice: str,
    requirements: PaymentRequirements,
    *,
    now: float,
    clock_skew: int,
    check_expiry: bool = True,
) -> Bolt11:
    decoded = decode_invoice(invoice)
    if decoded.description_hash != requirements.extra["requestHash"]:
        raise invalid("invoice_request_mismatch")
    if decoded.payee != requirements.pay_to:
        raise invalid("invoice_payee_mismatch")
    if decoded.currency != NETWORKS[requirements.network]:
        raise invalid("invoice_currency_mismatch")
    if decoded.amount_msat != int(requirements.amount):
        raise invalid("invoice_amount_mismatch")
    if decoded.expiry != requirements.max_timeout_seconds:
        raise invalid("invoice_expiry_mismatch")
    if decoded.date > now + clock_skew:
        raise invalid("invoice_created_in_future")
    if check_expiry and now > decoded.date + decoded.expiry:
        raise invalid("invoice_expired")
    return decoded


def validate_preimage(payload: dict[str, Any], payment_hash: str) -> None:
    if "preimage" not in payload or payload["preimage"] is None:
        raise invalid("preimage_missing")
    preimage = payload["preimage"]
    if not isinstance(preimage, str) or not re.fullmatch(r"[0-9a-f]*", preimage):
        raise invalid("preimage_malformed")
    if not _HEX.fullmatch(preimage):
        raise invalid("preimage_length")
    if sha256(bytes.fromhex(preimage)).hexdigest() != payment_hash:
        raise invalid("preimage_hash_mismatch")
