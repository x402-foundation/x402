"""Facilitator-side Permit2 deposit helpers.

The bundled approval+deposit pre-flight simulation step is skipped;
correctness is preserved — only the optional simulation is missing.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....interfaces import FacilitatorContext
from .....schemas import PaymentPayload, PaymentRequirements, VerifyResponse
from ...constants import PERMIT2_ADDRESS, PERMIT2_DEADLINE_BUFFER
from ...erc6492 import parse_erc6492_signature
from ...signer import FacilitatorEvmSigner
from ...verify import verify_typed_data_strict
from ..constants import (
    BATCH_PERMIT2_WITNESS_TYPES,
    PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
)
from ..encoding import build_eip2612_permit_data, build_permit2_collector_data
from ..errors import (
    ERR_CHANNEL_ID_MISMATCH,
    ERR_EIP2612_AMOUNT_MISMATCH,
    ERR_ERC20_APPROVAL_UNAVAILABLE,
    ERR_INVALID_PAYLOAD_TYPE,
    ERR_PERMIT2_ALLOWANCE_REQUIRED,
    ERR_PERMIT2_AMOUNT_MISMATCH,
    ERR_PERMIT2_AUTHORIZATION_REQUIRED,
    ERR_PERMIT2_DEADLINE_EXPIRED,
    ERR_PERMIT2_INVALID_SIGNATURE,
    ERR_PERMIT2_INVALID_SPENDER,
    ERR_TOKEN_MISMATCH,
)
from ..types import DepositPayload

if TYPE_CHECKING:
    from .....extensions.eip2612_gas_sponsoring.types import Eip2612GasSponsoringInfo
    from .....extensions.erc20_approval_gas_sponsoring.types import (
        Erc20ApprovalGasSponsoringSigner,
    )

ERC20_ALLOWANCE_ABI: list[dict[str, Any]] = [
    {
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    }
]


@dataclass
class Permit2DepositBranch:
    """Resolved setup branch + encoded collector data for a Permit2 deposit."""

    kind: str  # "standard" | "eip2612" | "erc20Approval"
    collector_data: bytes
    signed_transaction: str | None = None
    extension_signer: Erc20ApprovalGasSponsoringSigner | None = None


def get_permit2_deposit_collector_address() -> str:
    return to_checksum_address(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS)


def build_permit2_deposit_collector_data(
    payload: DepositPayload, eip2612_permit_data: bytes = b""
) -> bytes:
    """Encode the Permit2 collector data, stripping any ERC-6492 wrapping."""
    assert payload.deposit is not None
    auth = payload.deposit.authorization.permit2_authorization
    if auth is None:
        raise ValueError(ERR_PERMIT2_AUTHORIZATION_REQUIRED)

    sig_bytes = bytes.fromhex(auth.signature.removeprefix("0x"))
    parsed = parse_erc6492_signature(sig_bytes)
    inner_hex = "0x" + parsed.inner_signature.hex()

    return build_permit2_collector_data(auth.nonce, auth.deadline, inner_hex, eip2612_permit_data)


def verify_permit2_deposit_authorization(
    signer: FacilitatorEvmSigner,
    payment: PaymentPayload,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    chain_id: int,
    context: FacilitatorContext | None = None,
) -> VerifyResponse | None:
    """Validate Permit2 typed-data and resolve the setup branch."""
    typed = _verify_permit2_typed_data(signer, payload, requirements, chain_id)
    if typed is not None:
        return typed

    branch = resolve_permit2_deposit_branch(signer, payment, payload, requirements, context)
    if isinstance(branch, VerifyResponse):
        return branch

    return None


def resolve_permit2_deposit_branch(
    signer: FacilitatorEvmSigner,
    payment: PaymentPayload,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    context: FacilitatorContext | None = None,
) -> Permit2DepositBranch | VerifyResponse:
    """Choose the Permit2 setup path (eip2612 / erc20Approval / standard)."""
    from .....extensions.eip2612_gas_sponsoring import (
        extract_eip2612_gas_sponsoring_info,
    )
    from .....extensions.erc20_approval_gas_sponsoring import (
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
        Erc20ApprovalFacilitatorExtension,
        extract_erc20_approval_gas_sponsoring_info,
        validate_erc20_approval_for_payment,
    )

    assert payload.channel_config is not None and payload.deposit is not None
    payer = payload.channel_config.payer
    token_address = to_checksum_address(requirements.asset)

    eip2612_info = extract_eip2612_gas_sponsoring_info(payment)
    if eip2612_info:
        invalid_reason = _validate_batch_eip2612_permit(
            eip2612_info, payer, token_address, payload.deposit.amount
        )
        if invalid_reason:
            return VerifyResponse(is_valid=False, invalid_reason=invalid_reason, payer=payer)

        v, r, s = _split_eip2612_signature(eip2612_info.signature)
        eip2612_data = build_eip2612_permit_data(
            eip2612_info.amount, eip2612_info.deadline, v, r, s
        )
        return Permit2DepositBranch(
            kind="eip2612",
            collector_data=build_permit2_deposit_collector_data(payload, eip2612_data),
        )

    erc20_info = extract_erc20_approval_gas_sponsoring_info(payment)
    if erc20_info:
        extension = None
        if context is not None:
            extension = context.get_extension(ERC20_APPROVAL_GAS_SPONSORING_KEY)
        extension_signer: Erc20ApprovalGasSponsoringSigner | None = None
        if isinstance(extension, Erc20ApprovalFacilitatorExtension):
            extension_signer = extension.resolve_signer(str(requirements.network))

        if extension_signer is None:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_ERC20_APPROVAL_UNAVAILABLE,
                payer=payer,
            )

        reason, message = validate_erc20_approval_for_payment(erc20_info, payer, token_address)
        if reason:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=reason,
                invalid_message=message or None,
                payer=payer,
            )

        return Permit2DepositBranch(
            kind="erc20Approval",
            collector_data=build_permit2_deposit_collector_data(payload),
            signed_transaction=erc20_info.signed_transaction,
            extension_signer=extension_signer,
        )

    try:
        allowance = signer.read_contract(
            token_address,
            ERC20_ALLOWANCE_ABI,
            "allowance",
            to_checksum_address(payer),
            to_checksum_address(PERMIT2_ADDRESS),
        )
        if int(allowance) < int(payload.deposit.amount):
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_PERMIT2_ALLOWANCE_REQUIRED,
                payer=payer,
            )
    except Exception:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_PERMIT2_ALLOWANCE_REQUIRED,
            payer=payer,
        )

    return Permit2DepositBranch(
        kind="standard",
        collector_data=build_permit2_deposit_collector_data(payload),
    )


def _verify_permit2_typed_data(
    signer: FacilitatorEvmSigner,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    chain_id: int,
) -> VerifyResponse | None:
    assert payload.channel_config is not None and payload.deposit is not None
    assert payload.voucher is not None
    auth = payload.deposit.authorization.permit2_authorization
    payer = payload.channel_config.payer

    if auth is None:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_AUTHORIZATION_REQUIRED, payer=payer
        )

    if to_checksum_address(auth.from_address) != to_checksum_address(payer):
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SIGNATURE, payer=payer
        )

    if to_checksum_address(auth.spender) != get_permit2_deposit_collector_address():
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SPENDER, payer=payer
        )

    if to_checksum_address(auth.permitted.token) != to_checksum_address(requirements.asset):
        return VerifyResponse(is_valid=False, invalid_reason=ERR_TOKEN_MISMATCH, payer=payer)

    if int(auth.permitted.amount) != int(payload.deposit.amount):
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_AMOUNT_MISMATCH, payer=payer
        )

    if auth.witness.channel_id.lower() != payload.voucher.channel_id.lower():
        return VerifyResponse(is_valid=False, invalid_reason=ERR_CHANNEL_ID_MISMATCH, payer=payer)

    now = int(time.time())
    if int(auth.deadline) < now + PERMIT2_DEADLINE_BUFFER:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_DEADLINE_EXPIRED, payer=payer
        )

    try:
        sig_bytes = bytes.fromhex(auth.signature.removeprefix("0x"))
        domain = {
            "name": "Permit2",
            "chainId": chain_id,
            "verifyingContract": to_checksum_address(PERMIT2_ADDRESS),
        }
        message = {
            "permitted": {
                "token": to_checksum_address(auth.permitted.token),
                "amount": int(auth.permitted.amount),
            },
            "spender": to_checksum_address(auth.spender),
            "nonce": int(auth.nonce),
            "deadline": int(auth.deadline),
            "witness": {"channelId": _to_bytes32(auth.witness.channel_id)},
        }
        # Uses the strict primitive that mirrors on-chain SignatureChecker (code-routed, no ECDSA fallback).
        ok = verify_typed_data_strict(
            signer,
            address=to_checksum_address(auth.from_address),
            domain=domain,
            types=BATCH_PERMIT2_WITNESS_TYPES,
            primary_type="PermitWitnessTransferFrom",
            message=message,
            signature=sig_bytes,
        )
        if not ok:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SIGNATURE, payer=payer
            )
    except Exception:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SIGNATURE, payer=payer
        )

    return None


def _validate_batch_eip2612_permit(
    info: Eip2612GasSponsoringInfo,
    payer: str,
    token_address: str,
    deposit_amount: str,
) -> str | None:
    """Apply batch-specific check on top of shared Permit2 validation."""
    from .....extensions.eip2612_gas_sponsoring import validate_eip2612_permit_for_payment

    baseline = validate_eip2612_permit_for_payment(info, payer, token_address)
    if baseline:
        return baseline or ERR_INVALID_PAYLOAD_TYPE
    if int(info.amount) != int(deposit_amount):
        return ERR_EIP2612_AMOUNT_MISMATCH
    return None


def _split_eip2612_signature(signature: str) -> tuple[int, str, str]:
    """Split a 65-byte ECDSA signature into v, r, s components."""
    sig_bytes = bytes.fromhex(signature.removeprefix("0x"))
    if len(sig_bytes) != 65:
        raise ValueError(f"expected 65-byte EIP-2612 signature, got {len(sig_bytes)}")
    r = "0x" + sig_bytes[0:32].hex()
    s = "0x" + sig_bytes[32:64].hex()
    v = sig_bytes[64]
    if v < 27:
        v += 27
    return v, r, s


def _to_bytes32(value: str) -> bytes:
    raw = bytes.fromhex(value.removeprefix("0x"))
    if len(raw) > 32:
        raise ValueError(f"channelId longer than 32 bytes: {value}")
    return raw.rjust(32, b"\x00")


__all__ = [
    "Permit2DepositBranch",
    "get_permit2_deposit_collector_address",
    "build_permit2_deposit_collector_data",
    "verify_permit2_deposit_authorization",
    "resolve_permit2_deposit_branch",
]
