"""Facilitator-side ERC-3009 deposit helpers."""

from __future__ import annotations

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, VerifyResponse
from ...erc6492 import parse_erc6492_signature
from ...signer import FacilitatorEvmSigner
from ..constants import (
    ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
    RECEIVE_AUTHORIZATION_TYPES,
)
from ..encoding import build_erc3009_collector_data, build_erc3009_deposit_nonce
from ..errors import (
    ERR_ERC3009_AUTHORIZATION_REQUIRED,
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
) -> VerifyResponse | None:
    """Validate ERC-3009 timing + typed-data signature. Returns None when valid."""
    assert payload.deposit is not None and payload.voucher is not None
    assert payload.channel_config is not None
    deposit = payload.deposit
    voucher = payload.voucher
    payer = payload.channel_config.payer
    auth = deposit.authorization.erc3009_authorization

    if auth is None:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_ERC3009_AUTHORIZATION_REQUIRED, payer=payer
        )

    extra = requirements.extra or {}
    name = extra.get("name")
    version = extra.get("version")
    if not name or not version:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_MISSING_EIP712_DOMAIN, payer=payer)

    time_invalid = erc3009_authorization_time_invalid_reason(
        int(auth.valid_after), int(auth.valid_before)
    )
    if time_invalid:
        return VerifyResponse(is_valid=False, invalid_reason=time_invalid, payer=payer)

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
        signature=auth.signature,
    )
    if not ok:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_INVALID_RECEIVE_AUTHORIZATION_SIGNATURE,
            payer=payer,
        )

    return None


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
        return signer.verify_typed_data(
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
