"""Facilitator-side ERC-3009 deposit helpers."""

from __future__ import annotations

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, VerifyResponse
from ...erc6492 import has_deployment_info, parse_erc6492_signature
from ...signer import FacilitatorEvmSigner
from ...types import ERC6492SignatureData
from ...utils import bytes_to_hex
from ...verify import verify_typed_data_strict
from ..constants import (
    ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
    RECEIVE_AUTHORIZATION_TYPES,
)
from ..encoding import build_erc3009_collector_data, build_erc3009_deposit_nonce
from ..errors import (
    ERR_ERC3009_AUTHORIZATION_REQUIRED,
    ERR_FACTORY_NOT_ALLOWED,
    ERR_INVALID_RECEIVE_AUTHORIZATION_SIGNATURE,
    ERR_MISSING_EIP712_DOMAIN,
)
from ..types import DepositPayload
from ..utils import coerce_bytes32
from .utils import erc3009_authorization_time_invalid_reason


def get_eip3009_deposit_collector_address() -> str:
    return to_checksum_address(ERC3009_DEPOSIT_COLLECTOR_ADDRESS)


def build_eip3009_deposit_collector_data(payload: DepositPayload) -> bytes:
    """ABI-encode collector data, stripping any ERC-6492 wrapping from the signature."""
    assert payload.deposit is not None
    auth = payload.deposit.authorization.erc3009_authorization
    if auth is None:
        raise ValueError(ERR_ERC3009_AUTHORIZATION_REQUIRED)

    sig_bytes = bytes.fromhex(auth.signature.removeprefix("0x"))
    parsed = parse_erc6492_signature(sig_bytes)
    inner_hex = "0x" + parsed.inner_signature.hex()

    return build_erc3009_collector_data(auth.valid_after, auth.valid_before, auth.salt, inner_hex)


def verify_eip3009_deposit_authorization(
    signer: FacilitatorEvmSigner,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    chain_id: int,
    allowed_factories: list[str] | None = None,
) -> tuple[ERC6492SignatureData | None, VerifyResponse | None]:
    """Validate ERC-3009 timing + typed-data signature.

    Returns ``(counterfactual_sig_data, None)`` when the deposit is from an undeployed
    ERC-6492 wallet whose factory is allowlisted — the caller must then validate the inner
    signature via the deploy+deposit simulation (the wallet has no code yet, so a direct
    signature check cannot succeed). Returns ``(None, None)`` when a deployed wallet / plain
    EOA signature is valid, and ``(None, VerifyResponse)`` on any rejection.
    """
    assert payload.deposit is not None and payload.voucher is not None
    assert payload.channel_config is not None
    deposit = payload.deposit
    voucher = payload.voucher
    payer = payload.channel_config.payer
    auth = deposit.authorization.erc3009_authorization

    if auth is None:
        return None, VerifyResponse(
            is_valid=False, invalid_reason=ERR_ERC3009_AUTHORIZATION_REQUIRED, payer=payer
        )

    extra = requirements.extra or {}
    name = extra.get("name")
    version = extra.get("version")
    if not name or not version:
        return None, VerifyResponse(
            is_valid=False, invalid_reason=ERR_MISSING_EIP712_DOMAIN, payer=payer
        )

    time_invalid = erc3009_authorization_time_invalid_reason(
        int(auth.valid_after), int(auth.valid_before)
    )
    if time_invalid:
        return None, VerifyResponse(is_valid=False, invalid_reason=time_invalid, payer=payer)

    try:
        sig_data = parse_erc6492_signature(bytes.fromhex(auth.signature.removeprefix("0x")))
    except Exception:
        return None, VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_INVALID_RECEIVE_AUTHORIZATION_SIGNATURE,
            payer=payer,
        )

    # Counterfactual detection: only fetch code when there is deployment info so the common
    # (already-deployed / plain EOA) path keeps a single RPC round-trip.
    if has_deployment_info(sig_data):
        code = signer.get_code(to_checksum_address(payer))
        if len(code) == 0:
            allowed = [f.strip().lower() for f in (allowed_factories or [])]
            if bytes_to_hex(sig_data.factory).lower() not in allowed:
                return None, VerifyResponse(
                    is_valid=False, invalid_reason=ERR_FACTORY_NOT_ALLOWED, payer=payer
                )
            # Counterfactual + allowlisted: defer signature validation to the
            # deploy+deposit simulation performed by the caller.
            return sig_data, None
        # Already deployed despite the wrapper — fall through and validate the inner
        # signature against its EIP-1271 validator like any other deployed wallet.

    erc3009_nonce = build_erc3009_deposit_nonce(voucher.channel_id, auth.salt)
    ok = _verify_receive_auth(
        signer,
        payer=payer,
        asset=requirements.asset,
        name=name,
        version=version,
        chain_id=chain_id,
        amount=deposit.amount,
        valid_after=int(auth.valid_after),
        valid_before=int(auth.valid_before),
        nonce=erc3009_nonce,
        signature="0x" + sig_data.inner_signature.hex(),
    )
    if not ok:
        return None, VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_INVALID_RECEIVE_AUTHORIZATION_SIGNATURE,
            payer=payer,
        )

    return None, None


def _verify_receive_auth(
    signer: FacilitatorEvmSigner,
    *,
    payer: str,
    asset: str,
    name: str,
    version: str,
    chain_id: int,
    amount: str,
    valid_after: int,
    valid_before: int,
    nonce: str,
    signature: str,
) -> bool:
    try:
        sig_bytes = bytes.fromhex(signature.removeprefix("0x"))
        domain = {
            "name": name,
            "version": version,
            "chainId": chain_id,
            "verifyingContract": to_checksum_address(asset),
        }
        message = {
            "from": to_checksum_address(payer),
            "to": to_checksum_address(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
            "value": int(amount),
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": coerce_bytes32(nonce),
        }
        # Uses the strict primitive that mirrors on-chain SignatureChecker (code-routed, no ECDSA fallback).
        return verify_typed_data_strict(
            signer,
            address=to_checksum_address(payer),
            domain=domain,
            types=RECEIVE_AUTHORIZATION_TYPES,
            primary_type="ReceiveWithAuthorization",
            message=message,
            signature=sig_bytes,
        )
    except Exception:
        return False


__all__ = [
    "get_eip3009_deposit_collector_address",
    "build_eip3009_deposit_collector_data",
    "verify_eip3009_deposit_authorization",
]
