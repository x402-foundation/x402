"""Shared EIP-3009 helpers for exact EVM facilitators."""

from __future__ import annotations

from dataclasses import dataclass

from ..constants import (
    AUTHORIZATION_STATE_ABI,
    BALANCE_OF_ABI,
    ERR_EIP3009_NOT_SUPPORTED,
    ERR_INSUFFICIENT_BALANCE,
    ERR_NONCE_ALREADY_USED,
    ERR_TOKEN_NAME_MISMATCH,
    ERR_TOKEN_VERSION_MISMATCH,
    ERR_TRANSACTION_SIMULATION_FAILED,
    FUNCTION_TRANSFER_WITH_AUTHORIZATION,
    NAME_ABI,
    TRANSFER_WITH_AUTHORIZATION_BYTES_ABI,
    TRANSFER_WITH_AUTHORIZATION_VRS_ABI,
    VERSION_ABI,
)
from ..eip712 import build_typed_data_for_signing
from ..erc6492 import has_deployment_info, parse_erc6492_signature
from ..multicall import MulticallCall, encode_contract_call, multicall
from ..signer import FacilitatorEvmSigner
from ..types import ERC6492SignatureData, ExactEIP3009Authorization
from ..utils import bytes_to_hex, hex_to_bytes


@dataclass
class ParsedEIP3009Authorization:
    """Parsed authorization values ready for contract calls."""

    from_address: str
    to: str
    value: int
    valid_after: int
    valid_before: int
    nonce: bytes


@dataclass
class EIP3009SignatureClassification:
    """How the facilitator should treat a signature before simulation."""

    valid: bool
    is_smart_wallet: bool
    is_undeployed: bool
    sig_data: ERC6492SignatureData


def parse_eip3009_authorization(
    authorization: ExactEIP3009Authorization,
) -> ParsedEIP3009Authorization:
    """Parse string-encoded authorization fields into contract-call values."""
    nonce = hex_to_bytes(authorization.nonce)
    if len(nonce) != 32:
        raise ValueError(f"invalid nonce length: got {len(nonce)} bytes, want 32")

    return ParsedEIP3009Authorization(
        from_address=authorization.from_address,
        to=authorization.to,
        value=int(authorization.value),
        valid_after=int(authorization.valid_after),
        valid_before=int(authorization.valid_before),
        nonce=nonce,
    )


def classify_eip3009_signature(
    signer: FacilitatorEvmSigner,
    authorization: ExactEIP3009Authorization,
    signature: bytes,
    chain_id: int,
    token_address: str,
    token_name: str,
    token_version: str,
) -> EIP3009SignatureClassification:
    """Classify the signature before deciding whether simulation may rescue it."""
    sig_data = parse_erc6492_signature(signature)
    domain, types, primary_type, message = build_typed_data_for_signing(
        authorization,
        chain_id,
        token_address,
        token_name,
        token_version,
    )

    is_smart_wallet = has_deployment_info(sig_data) or len(sig_data.inner_signature) != 65
    valid = signer.verify_typed_data(
        authorization.from_address,
        domain,
        types,
        primary_type,
        message,
        sig_data.inner_signature,
    )
    if valid:
        return EIP3009SignatureClassification(
            valid=True,
            is_smart_wallet=is_smart_wallet,
            is_undeployed=False,
            sig_data=sig_data,
        )

    code = signer.get_code(authorization.from_address)
    if len(code) > 0:
        return EIP3009SignatureClassification(
            valid=False,
            is_smart_wallet=True,
            is_undeployed=False,
            sig_data=sig_data,
        )

    if has_deployment_info(sig_data):
        return EIP3009SignatureClassification(
            valid=False,
            is_smart_wallet=True,
            is_undeployed=True,
            sig_data=sig_data,
        )

    return EIP3009SignatureClassification(
        valid=False,
        is_smart_wallet=is_smart_wallet,
        is_undeployed=is_smart_wallet,
        sig_data=sig_data,
    )


def simulate_eip3009_transfer(
    signer: FacilitatorEvmSigner,
    token_address: str,
    parsed: ParsedEIP3009Authorization,
    sig_data: ERC6492SignatureData,
) -> bool:
    """Simulate `transferWithAuthorization` and return whether it succeeds."""
    if has_deployment_info(sig_data):
        transfer_calldata = encode_contract_call(
            TRANSFER_WITH_AUTHORIZATION_BYTES_ABI,
            FUNCTION_TRANSFER_WITH_AUTHORIZATION,
            parsed.from_address,
            parsed.to,
            parsed.value,
            parsed.valid_after,
            parsed.valid_before,
            parsed.nonce,
            sig_data.inner_signature,
        )
        try:
            results = multicall(
                signer,
                [
                    MulticallCall(
                        address=bytes_to_hex(sig_data.factory),
                        call_data=sig_data.factory_calldata,
                    ),
                    MulticallCall(address=token_address, call_data=transfer_calldata),
                ],
            )
        except Exception:
            return False
        return len(results) >= 2 and results[1].success

    if len(sig_data.inner_signature) == 65:
        v, r, s = _split_signature_parts(sig_data.inner_signature)
        try:
            signer.read_contract(
                token_address,
                TRANSFER_WITH_AUTHORIZATION_VRS_ABI,
                FUNCTION_TRANSFER_WITH_AUTHORIZATION,
                parsed.from_address,
                parsed.to,
                parsed.value,
                parsed.valid_after,
                parsed.valid_before,
                parsed.nonce,
                v,
                r,
                s,
            )
        except Exception:
            return False
        return True

    try:
        signer.read_contract(
            token_address,
            TRANSFER_WITH_AUTHORIZATION_BYTES_ABI,
            FUNCTION_TRANSFER_WITH_AUTHORIZATION,
            parsed.from_address,
            parsed.to,
            parsed.value,
            parsed.valid_after,
            parsed.valid_before,
            parsed.nonce,
            sig_data.inner_signature,
        )
    except Exception:
        return False
    return True


def diagnose_eip3009_simulation_failure(
    signer: FacilitatorEvmSigner,
    token_address: str,
    authorization: ExactEIP3009Authorization,
    required_amount: int,
    token_name: str,
    token_version: str,
) -> str:
    """Map a failed transfer simulation to the most specific invalid reason."""
    try:
        results = multicall(
            signer,
            [
                MulticallCall(
                    address=token_address,
                    abi=BALANCE_OF_ABI,
                    function_name="balanceOf",
                    args=(authorization.from_address,),
                ),
                MulticallCall(address=token_address, abi=NAME_ABI, function_name="name"),
                MulticallCall(
                    address=token_address,
                    abi=VERSION_ABI,
                    function_name="version",
                ),
                MulticallCall(
                    address=token_address,
                    abi=AUTHORIZATION_STATE_ABI,
                    function_name="authorizationState",
                    args=(authorization.from_address, hex_to_bytes(authorization.nonce)),
                ),
            ],
        )
    except Exception:
        return ERR_TRANSACTION_SIMULATION_FAILED

    if len(results) < 4:
        return ERR_TRANSACTION_SIMULATION_FAILED

    authorization_state = results[3]
    if not authorization_state.success:
        return ERR_EIP3009_NOT_SUPPORTED
    if bool(authorization_state.result):
        return ERR_NONCE_ALREADY_USED

    name_result = results[1]
    if token_name and name_result.success and isinstance(name_result.result, str):
        if name_result.result != token_name:
            return ERR_TOKEN_NAME_MISMATCH

    version_result = results[2]
    if token_version and version_result.success and isinstance(version_result.result, str):
        if version_result.result != token_version:
            return ERR_TOKEN_VERSION_MISMATCH

    balance_result = results[0]
    if balance_result.success:
        try:
            if int(balance_result.result) < required_amount:
                return ERR_INSUFFICIENT_BALANCE
        except (TypeError, ValueError):
            pass

    return ERR_TRANSACTION_SIMULATION_FAILED


def execute_transfer_with_authorization(
    signer: FacilitatorEvmSigner,
    token_address: str,
    parsed: ParsedEIP3009Authorization,
    sig_data: ERC6492SignatureData,
) -> str:
    """Execute `transferWithAuthorization` using the correct ABI overload."""
    if len(sig_data.inner_signature) == 65:
        v, r, s = _split_signature_parts(sig_data.inner_signature)
        return signer.write_contract(
            token_address,
            TRANSFER_WITH_AUTHORIZATION_VRS_ABI,
            FUNCTION_TRANSFER_WITH_AUTHORIZATION,
            parsed.from_address,
            parsed.to,
            parsed.value,
            parsed.valid_after,
            parsed.valid_before,
            parsed.nonce,
            v,
            r,
            s,
        )

    return signer.write_contract(
        token_address,
        TRANSFER_WITH_AUTHORIZATION_BYTES_ABI,
        FUNCTION_TRANSFER_WITH_AUTHORIZATION,
        parsed.from_address,
        parsed.to,
        parsed.value,
        parsed.valid_after,
        parsed.valid_before,
        parsed.nonce,
        sig_data.inner_signature,
    )


def _split_signature_parts(signature: bytes) -> tuple[int, bytes, bytes]:
    if len(signature) != 65:
        raise ValueError(f"invalid ECDSA signature length: expected 65, got {len(signature)}")

    v = signature[64]
    if v in (0, 1):
        v += 27
    return (v, signature[:32], signature[32:64])
