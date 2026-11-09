"""Message validation for SIWX extension."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urlparse

from .types import SIWxPayload, SIWxValidationOptions, SIWxValidationResult

DEFAULT_MAX_AGE_MS = 5 * 60 * 1000


def _url_origin(parsed_url) -> str:
    return f"{parsed_url.scheme}://{parsed_url.netloc}"


async def validate_siwx_message(
    message: SIWxPayload,
    expected_origin: str,
    options: SIWxValidationOptions | None = None,
) -> SIWxValidationResult:
    """Validate SIWX payload fields before cryptographic verification."""
    opts = options or SIWxValidationOptions()
    expected = urlparse(expected_origin)
    max_age = opts.max_age if opts.max_age is not None else DEFAULT_MAX_AGE_MS

    if message.domain != expected.netloc:
        return SIWxValidationResult(
            is_valid=False,
            invalid_reason="invalid_siwx_domain_mismatch",
            invalid_message=(
                f'Domain mismatch: expected "{expected.netloc}", got "{message.domain}"'
            ),
        )

    message_uri = urlparse(message.uri)
    if not message_uri.scheme or not message_uri.netloc:
        return SIWxValidationResult(
            is_valid=False,
            invalid_reason="invalid_siwx_uri_mismatch",
            invalid_message=f'Invalid URI: "{message.uri}" is not a valid URL',
        )

    if _url_origin(message_uri) != expected_origin:
        return SIWxValidationResult(
            is_valid=False,
            invalid_reason="invalid_siwx_uri_mismatch",
            invalid_message=(
                f'URI mismatch: expected origin "{expected_origin}", '
                f'got "{_url_origin(message_uri)}"'
            ),
        )

    try:
        issued_at = datetime.fromisoformat(message.issued_at.replace("Z", "+00:00"))
    except ValueError:
        return SIWxValidationResult(
            is_valid=False,
            invalid_reason="invalid_siwx_issued_at",
            invalid_message="Invalid issuedAt timestamp",
        )

    now = datetime.now(timezone.utc)
    if issued_at.tzinfo is None:
        issued_at = issued_at.replace(tzinfo=timezone.utc)
    age_ms = (now - issued_at).total_seconds() * 1000
    if age_ms > max_age:
        return SIWxValidationResult(
            is_valid=False,
            invalid_reason="invalid_siwx_issued_at_too_old",
            invalid_message=(
                f"Message too old: {round(age_ms / 1000)}s exceeds {max_age / 1000}s limit"
            ),
        )
    if age_ms < 0:
        return SIWxValidationResult(
            is_valid=False,
            invalid_reason="invalid_siwx_issued_at_in_future",
            invalid_message="issuedAt is in the future",
        )

    if message.expiration_time:
        try:
            expiration = datetime.fromisoformat(message.expiration_time.replace("Z", "+00:00"))
        except ValueError:
            return SIWxValidationResult(
                is_valid=False,
                invalid_reason="invalid_siwx_expiration_time",
                invalid_message="Invalid expirationTime timestamp",
            )
        if expiration.tzinfo is None:
            expiration = expiration.replace(tzinfo=timezone.utc)
        if expiration < now:
            return SIWxValidationResult(
                is_valid=False,
                invalid_reason="invalid_siwx_expired",
                invalid_message="Message expired",
            )

    if message.not_before:
        try:
            not_before = datetime.fromisoformat(message.not_before.replace("Z", "+00:00"))
        except ValueError:
            return SIWxValidationResult(
                is_valid=False,
                invalid_reason="invalid_siwx_not_before",
                invalid_message="Invalid notBefore timestamp",
            )
        if not_before.tzinfo is None:
            not_before = not_before.replace(tzinfo=timezone.utc)
        if now < not_before:
            return SIWxValidationResult(
                is_valid=False,
                invalid_reason="invalid_siwx_not_yet_valid",
                invalid_message="Message not yet valid (notBefore is in the future)",
            )

    if opts.check_nonce is not None:
        nonce_valid = opts.check_nonce(message.nonce)
        if hasattr(nonce_valid, "__await__"):
            nonce_valid = await nonce_valid
        if not nonce_valid:
            return SIWxValidationResult(
                is_valid=False,
                invalid_reason="invalid_siwx_nonce",
                invalid_message="Nonce validation failed (possible replay attack)",
            )

    return SIWxValidationResult(is_valid=True)
