"""Signature verification for SIWX extension."""

from __future__ import annotations

from .evm import format_siwe_message, verify_evm_signature
from .solana import decode_base58, format_siws_message, verify_solana_signature
from .types import SIWxPayload, SIWxVerifyOptions, SIWxVerifyResult


async def verify_siwx_signature(
    payload: SIWxPayload,
    options: SIWxVerifyOptions | None = None,
) -> SIWxVerifyResult:
    """Verify SIWX signature cryptographically."""
    opts = options or SIWxVerifyOptions()
    try:
        if payload.chain_id.startswith("eip155:"):
            return await _verify_evm_payload(payload, opts)
        if payload.chain_id.startswith("solana:"):
            return _verify_solana_payload(payload)
        return SIWxVerifyResult(
            valid=False,
            error=(
                f"Unsupported chain namespace: {payload.chain_id}. "
                "Supported: eip155:* (EVM), solana:* (Solana)"
            ),
        )
    except Exception as e:
        return SIWxVerifyResult(valid=False, error=str(e))


async def _verify_evm_payload(payload: SIWxPayload, options: SIWxVerifyOptions) -> SIWxVerifyResult:
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
            return SIWxVerifyResult(valid=False, error="Signature verification failed")
        return SIWxVerifyResult(valid=True, address=payload.address)
    except Exception as e:
        return SIWxVerifyResult(valid=False, error=str(e))


def _verify_solana_payload(payload: SIWxPayload) -> SIWxVerifyResult:
    message = format_siws_message(payload, payload.address)
    try:
        signature = decode_base58(payload.signature)
        public_key = decode_base58(payload.address)
    except ValueError as e:
        return SIWxVerifyResult(valid=False, error=f"Invalid Base58 encoding: {e}")

    if len(signature) != 64:
        return SIWxVerifyResult(
            valid=False,
            error=f"Invalid signature length: expected 64 bytes, got {len(signature)}",
        )
    if len(public_key) != 32:
        return SIWxVerifyResult(
            valid=False,
            error=f"Invalid public key length: expected 32 bytes, got {len(public_key)}",
        )

    if not verify_solana_signature(message, signature, public_key):
        return SIWxVerifyResult(valid=False, error="Solana signature verification failed")
    return SIWxVerifyResult(valid=True, address=payload.address)
