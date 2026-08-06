"""Signature verification for SIWX extension."""

from __future__ import annotations

from .evm import extract_evm_chain_id, format_siwe_message, verify_evm_signature
from .solana import decode_base58, format_siws_message, verify_solana_signature
from .types import SIWxPayload, SIWxVerifyCode, SIWxVerifyOptions, SIWxVerifyResult


def _verify_failure(invalid_reason: SIWxVerifyCode, invalid_message: str) -> SIWxVerifyResult:
    return SIWxVerifyResult(
        is_valid=False,
        invalid_reason=invalid_reason,
        invalid_message=invalid_message,
    )


async def verify_siwx_signature(
    payload: SIWxPayload,
    options: SIWxVerifyOptions | None = None,
) -> SIWxVerifyResult:
    """Verify SIWX signature cryptographically."""
    opts = options or SIWxVerifyOptions()
    if payload.chain_id.startswith("eip155:"):
        return await _verify_evm_payload(payload, opts)
    if payload.chain_id.startswith("solana:"):
        return _verify_solana_payload(payload)
    return _verify_failure(
        "invalid_siwx_unsupported_chain",
        (
            f"Unsupported chain namespace: {payload.chain_id}. "
            "Supported: eip155:* (EVM), solana:* (Solana)"
        ),
    )


async def _verify_evm_payload(payload: SIWxPayload, options: SIWxVerifyOptions) -> SIWxVerifyResult:
    try:
        extract_evm_chain_id(payload.chain_id)
    except ValueError as error:
        return _verify_failure("invalid_siwx_chain_id", str(error))

    message = format_siwe_message(payload, payload.address)
    try:
        valid = await verify_evm_signature(
            message,
            payload.address,
            payload.signature,
            options.evm_verifier,
            provider=options.provider,
        )
        if not valid:
            return _verify_failure("invalid_siwx_signature", "Signature verification failed")
        return SIWxVerifyResult(is_valid=True, payer=payload.address)
    except Exception as error:
        return _verify_failure(
            "invalid_siwx_verifier_error",
            str(error) if str(error) else "Signature verification failed",
        )


def _verify_solana_payload(payload: SIWxPayload) -> SIWxVerifyResult:
    message = format_siws_message(payload, payload.address)
    try:
        signature = decode_base58(payload.signature)
        public_key = decode_base58(payload.address)
    except ValueError as error:
        return _verify_failure(
            "invalid_siwx_malformed_signature",
            f"Invalid Base58 encoding: {error}",
        )

    if len(signature) != 64:
        return _verify_failure(
            "invalid_siwx_malformed_signature",
            f"Invalid signature length: expected 64 bytes, got {len(signature)}",
        )
    if len(public_key) != 32:
        return _verify_failure(
            "invalid_siwx_malformed_signature",
            f"Invalid public key length: expected 32 bytes, got {len(public_key)}",
        )

    if not verify_solana_signature(message, signature, public_key):
        return _verify_failure("invalid_siwx_signature", "Solana signature verification failed")
    return SIWxVerifyResult(is_valid=True, payer=payload.address)
