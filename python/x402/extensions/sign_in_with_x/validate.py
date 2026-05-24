"""Message validation for SIWX extension."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urlparse

from .types import SIWxPayload, SIWxValidationOptions, SIWxValidationResult

DEFAULT_MAX_AGE_MS = 5 * 60 * 1000


async def validate_siwx_message(
    message: SIWxPayload,
    expected_resource_uri: str,
    options: SIWxValidationOptions | None = None,
) -> SIWxValidationResult:
    """Validate SIWX payload fields before cryptographic verification."""
    opts = options or SIWxValidationOptions()
    expected = urlparse(expected_resource_uri)
    max_age = opts.max_age if opts.max_age is not None else DEFAULT_MAX_AGE_MS

    if message.domain != expected.hostname:
        return SIWxValidationResult(
            valid=False,
            error=f'Domain mismatch: expected "{expected.hostname}", got "{message.domain}"',
        )

    if not message.uri.startswith(f"{expected.scheme}://{expected.netloc}"):
        origin = f"{expected.scheme}://{expected.netloc}"
        return SIWxValidationResult(
            valid=False,
            error=f'URI mismatch: expected origin "{origin}", got "{message.uri}"',
        )

    try:
        issued_at = datetime.fromisoformat(message.issued_at.replace("Z", "+00:00"))
    except ValueError:
        return SIWxValidationResult(valid=False, error="Invalid issuedAt timestamp")

    now = datetime.now(timezone.utc)
    if issued_at.tzinfo is None:
        issued_at = issued_at.replace(tzinfo=timezone.utc)
    age_ms = (now - issued_at).total_seconds() * 1000
    if age_ms > max_age:
        return SIWxValidationResult(
            valid=False,
            error=f"Message too old: {round(age_ms / 1000)}s exceeds {max_age / 1000}s limit",
        )
    if age_ms < 0:
        return SIWxValidationResult(valid=False, error="issuedAt is in the future")

    if message.expiration_time:
        try:
            expiration = datetime.fromisoformat(message.expiration_time.replace("Z", "+00:00"))
        except ValueError:
            return SIWxValidationResult(valid=False, error="Invalid expirationTime timestamp")
        if expiration.tzinfo is None:
            expiration = expiration.replace(tzinfo=timezone.utc)
        if expiration < now:
            return SIWxValidationResult(valid=False, error="Message expired")

    if message.not_before:
        try:
            not_before = datetime.fromisoformat(message.not_before.replace("Z", "+00:00"))
        except ValueError:
            return SIWxValidationResult(valid=False, error="Invalid notBefore timestamp")
        if not_before.tzinfo is None:
            not_before = not_before.replace(tzinfo=timezone.utc)
        if now < not_before:
            return SIWxValidationResult(
                valid=False,
                error="Message not yet valid (notBefore is in the future)",
            )

    if opts.check_nonce is not None:
        nonce_valid = opts.check_nonce(message.nonce)
        if hasattr(nonce_valid, "__await__"):
            nonce_valid = await nonce_valid
        if not nonce_valid:
            return SIWxValidationResult(
                valid=False,
                error="Nonce validation failed (possible replay attack)",
            )

    return SIWxValidationResult(valid=True)
