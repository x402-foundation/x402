"""Permit2 helpers for the exact EVM payment scheme."""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger("x402.permit2")

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from ....interfaces import FacilitatorContext  # noqa: E402
from ....schemas import (  # noqa: E402
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..constants import (  # noqa: E402
    BALANCE_OF_ABI,
    ERC20_ALLOWANCE_ABI,
    ERR_INSUFFICIENT_BALANCE,
    ERR_NETWORK_MISMATCH,
    ERR_PERMIT2_ALLOWANCE_REQUIRED,
    ERR_PERMIT2_AMOUNT_MISMATCH,
    ERR_PERMIT2_DEADLINE_EXPIRED,
    ERR_PERMIT2_INVALID_SIGNATURE,
    ERR_PERMIT2_INVALID_SPENDER,
    ERR_PERMIT2_NOT_YET_VALID,
    ERR_PERMIT2_RECIPIENT_MISMATCH,
    ERR_PERMIT2_TOKEN_MISMATCH,
    ERR_TRANSACTION_FAILED,
    ERR_UNSUPPORTED_SCHEME,
    PERMIT2_ADDRESS,
    PERMIT2_WITNESS_TYPES,
    SCHEME_EXACT,
    TX_STATUS_SUCCESS,
    X402_EXACT_PERMIT2_PROXY_ABI,
    X402_EXACT_PERMIT2_PROXY_ADDRESS,
    X402_EXACT_PERMIT2_PROXY_SETTLE_WITH_PERMIT_ABI,
)
from ..signer import ClientEvmSigner, FacilitatorEvmSigner  # noqa: E402
from ..types import (  # noqa: E402
    ExactPermit2Authorization,
    ExactPermit2Payload,
    ExactPermit2TokenPermissions,
    ExactPermit2Witness,
    TypedDataField,
)
from ..utils import (  # noqa: E402
    create_permit2_nonce,
    get_evm_chain_id,
    hex_to_bytes,
    normalize_address,
)


def create_permit2_payload(
    signer: ClientEvmSigner,
    requirements: PaymentRequirements,
) -> dict[str, Any]:
    """Create a signed Permit2 PermitWitnessTransferFrom payload.

    The spender is always x402ExactPermit2Proxy, which enforces that funds
    can only be sent to the witness.to address (requirements.pay_to).

    Args:
        signer: EVM signer for signing the Permit2 authorization.
        requirements: Payment requirements from server.

    Returns:
        Inner payload dict (permit2Authorization + signature).
    """
    now = int(time.time())
    nonce = create_permit2_nonce()

    # Lower time bound - allow clock skew
    valid_after = str(now - 600)
    # Upper time bound - permit2 deadline
    deadline = str(now + (requirements.max_timeout_seconds or 3600))

    permit2_authorization = ExactPermit2Authorization(
        from_address=signer.address,
        permitted=ExactPermit2TokenPermissions(
            token=normalize_address(requirements.asset),
            amount=requirements.amount,
        ),
        spender=X402_EXACT_PERMIT2_PROXY_ADDRESS,
        nonce=nonce,
        deadline=deadline,
        witness=ExactPermit2Witness(
            to=normalize_address(requirements.pay_to),
            valid_after=valid_after,
        ),
    )

    signature = _sign_permit2_authorization(signer, permit2_authorization, requirements)

    payload = ExactPermit2Payload(
        permit2_authorization=permit2_authorization,
        signature=signature,
    )
    return payload.to_dict()


def _sign_permit2_authorization(
    signer: ClientEvmSigner,
    permit2_authorization: ExactPermit2Authorization,
    requirements: PaymentRequirements,
) -> str:
    """Sign a Permit2 PermitWitnessTransferFrom using EIP-712.

    The Permit2 domain has NO version field — only name, chainId, verifyingContract.
    We pass the domain as a raw dict to support signers whose protocol expects
    TypedDataDomain (which requires version), using the dict fallback path in
    EthAccountSigner.sign_typed_data().

    Args:
        signer: EVM signer.
        permit2_authorization: The authorization to sign.
        requirements: Payment requirements (used for chain ID).

    Returns:
        Hex-encoded signature with 0x prefix.
    """
    chain_id = get_evm_chain_id(str(requirements.network))
    domain_dict, typed_fields, primary_type, message = _build_permit2_typed_data(
        permit2_authorization, chain_id
    )

    sig_bytes = signer.sign_typed_data(
        domain_dict,  # type: ignore[arg-type]
        typed_fields,
        primary_type,
        message,
    )
    return "0x" + sig_bytes.hex()


def verify_permit2(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context: FacilitatorContext | None = None,
) -> VerifyResponse:
    """Verify a Permit2 payment payload.

    Verification cascade (cheap to expensive):
    1. Scheme check
    2. Network check
    3. Spender check (must be x402ExactPermit2Proxy)
    4. Recipient check (witness.to must match requirements.pay_to)
    5. Deadline check (must not be expired)
    6. validAfter check (must not be in the future)
    7. Amount check
    8. Token check
    9. Signature verification
    10. Allowance check (with extension fallbacks)
    11. Balance check

    Args:
        signer: Facilitator EVM signer for on-chain reads.
        payload: Payment payload from client.
        requirements: Payment requirements.
        context: Optional facilitator context for extension lookup.

    Returns:
        VerifyResponse with is_valid and payer.
    """
    permit2_payload = ExactPermit2Payload.from_dict(payload.payload)
    payer = permit2_payload.permit2_authorization.from_address

    # 1. Scheme check
    if payload.accepted.scheme != SCHEME_EXACT:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer=payer)

    # 2. Network check
    if payload.accepted.network != requirements.network:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer=payer)

    chain_id = get_evm_chain_id(str(requirements.network))
    token_address = normalize_address(requirements.asset)

    # 3. Spender check
    try:
        spender_norm = normalize_address(permit2_payload.permit2_authorization.spender)
        proxy_norm = normalize_address(X402_EXACT_PERMIT2_PROXY_ADDRESS)
    except Exception:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SPENDER, payer=payer
        )

    if spender_norm != proxy_norm:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SPENDER, payer=payer
        )

    # 4. Recipient check
    try:
        witness_to = normalize_address(permit2_payload.permit2_authorization.witness.to)
        pay_to = normalize_address(requirements.pay_to)
    except Exception:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_RECIPIENT_MISMATCH, payer=payer
        )

    if witness_to != pay_to:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_RECIPIENT_MISMATCH, payer=payer
        )

    now = int(time.time())

    # 5-7. Parse numeric fields from untrusted input before comparison
    try:
        deadline_val = int(permit2_payload.permit2_authorization.deadline)
        valid_after_val = int(permit2_payload.permit2_authorization.witness.valid_after)
        amount_val = int(permit2_payload.permit2_authorization.permitted.amount)
    except (ValueError, TypeError):
        return VerifyResponse(
            is_valid=False, invalid_reason="invalid_permit2_payload_format", payer=payer
        )

    # 5. Deadline check (6 second buffer)
    if deadline_val < now + 6:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_DEADLINE_EXPIRED, payer=payer
        )

    # 6. validAfter check
    if valid_after_val > now:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_PERMIT2_NOT_YET_VALID, payer=payer)

    # 7. Amount check
    if amount_val != int(requirements.amount):
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_AMOUNT_MISMATCH, payer=payer
        )

    # 8. Token check
    try:
        permitted_token = normalize_address(permit2_payload.permit2_authorization.permitted.token)
    except Exception:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_TOKEN_MISMATCH, payer=payer
        )

    if permitted_token != token_address:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_TOKEN_MISMATCH, payer=payer
        )

    # 9. Signature verification
    if not permit2_payload.signature:
        logger.warning("Permit2 verify: missing signature")
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SIGNATURE, payer=payer
        )

    try:
        sig_bytes = hex_to_bytes(permit2_payload.signature)
        logger.info(
            "Permit2 verify: checking signature for payer=%s chain_id=%s sig_len=%d",
            payer,
            chain_id,
            len(sig_bytes),
        )
        is_valid_sig = _verify_permit2_signature(
            signer,
            payer,
            permit2_payload.permit2_authorization,
            chain_id,
            sig_bytes,
        )
        if not is_valid_sig:
            logger.warning("Permit2 verify: signature verification returned False")
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SIGNATURE, payer=payer
            )
        logger.info("Permit2 verify: signature OK")
    except Exception as e:
        logger.warning("Permit2 verify: signature exception: %s", e, exc_info=True)
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_PERMIT2_INVALID_SIGNATURE, payer=payer
        )

    # 10. Allowance check — with extension fallbacks
    allowance_result = _verify_permit2_allowance(
        signer, payload, requirements, payer, token_address, context
    )
    if allowance_result is not None:
        logger.warning(
            "Permit2 verify: allowance check failed: %s", allowance_result.invalid_reason
        )
        return allowance_result
    logger.info("Permit2 verify: allowance OK")

    # 11. Balance check (fail closed — RPC failure rejects rather than allowing underfunded payments)
    try:
        balance = signer.read_contract(token_address, BALANCE_OF_ABI, "balanceOf", payer)
        if int(balance) < int(requirements.amount):
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_INSUFFICIENT_BALANCE, payer=payer
            )
    except Exception:
        logger.warning("Permit2 verify: balance check failed for payer=%s", payer, exc_info=True)
        return VerifyResponse(is_valid=False, invalid_reason="balance_check_failed", payer=payer)

    return VerifyResponse(is_valid=True, payer=payer)


def _verify_permit2_allowance(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payer: str,
    token_address: str,
    context: FacilitatorContext | None,
) -> VerifyResponse | None:
    """Check Permit2 allowance with extension fallbacks.

    Returns a VerifyResponse if verification should stop (failure),
    or None to continue with remaining checks.

    Fallback order (matching TS/Go):
    1. On-chain allowance sufficient -> None (continue)
    2. EIP-2612 gas sponsoring extension valid -> None (continue)
    3. ERC-20 approval gas sponsoring extension valid -> None (continue)
    4. Fail with permit2_allowance_required
    """
    from ....extensions.eip2612_gas_sponsoring import (
        extract_eip2612_gas_sponsoring_info,
        validate_eip2612_permit_for_payment,
    )
    from ....extensions.erc20_approval_gas_sponsoring import (
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
        Erc20ApprovalFacilitatorExtension,
        extract_erc20_approval_gas_sponsoring_info,
        validate_erc20_approval_for_payment,
    )

    needs_extension = True
    try:
        allowance = signer.read_contract(
            token_address,
            ERC20_ALLOWANCE_ABI,
            "allowance",
            payer,
            PERMIT2_ADDRESS,
        )
        if int(allowance) >= int(requirements.amount):
            needs_extension = False
    except Exception:
        logger.warning("Permit2 verify: allowance check failed for payer=%s", payer, exc_info=True)

    if not needs_extension:
        return None

    # Try EIP-2612 gas sponsoring extension first
    eip2612_info = extract_eip2612_gas_sponsoring_info(payload)
    if eip2612_info is not None:
        reason = validate_eip2612_permit_for_payment(eip2612_info, payer, token_address)
        if reason:
            return VerifyResponse(is_valid=False, invalid_reason=reason, payer=payer)
        return None  # Valid EIP-2612 extension, allowance will be set atomically

    # Try ERC-20 approval gas sponsoring extension
    erc20_info = extract_erc20_approval_gas_sponsoring_info(payload)
    if erc20_info is not None and context is not None:
        ext = context.get_extension(ERC20_APPROVAL_GAS_SPONSORING_KEY)
        if isinstance(ext, Erc20ApprovalFacilitatorExtension):
            extension_signer = ext.resolve_signer(str(payload.accepted.network))
            if extension_signer is not None:
                reason, _msg = validate_erc20_approval_for_payment(erc20_info, payer, token_address)
                if reason:
                    return VerifyResponse(is_valid=False, invalid_reason=reason, payer=payer)
                return None  # Valid ERC-20 approval extension

    return VerifyResponse(
        is_valid=False, invalid_reason=ERR_PERMIT2_ALLOWANCE_REQUIRED, payer=payer
    )


def settle_permit2(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context: FacilitatorContext | None = None,
) -> SettleResponse:
    """Settle a Permit2 payment on-chain.

    Routes to the appropriate settlement path:
    1. EIP-2612 extension -> settleWithPermit (atomic single tx)
    2. ERC-20 approval extension -> send_transactions (approval + settle)
    3. Standard -> settle directly (allowance already on-chain)

    Args:
        signer: Facilitator EVM signer for on-chain writes.
        payload: Verified payment payload.
        requirements: Payment requirements.
        context: Optional facilitator context for extension lookup.

    Returns:
        SettleResponse with success, transaction, and payer.
    """
    from ....extensions.eip2612_gas_sponsoring import extract_eip2612_gas_sponsoring_info
    from ....extensions.erc20_approval_gas_sponsoring import (
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
        Erc20ApprovalFacilitatorExtension,
        extract_erc20_approval_gas_sponsoring_info,
    )

    permit2_payload = ExactPermit2Payload.from_dict(payload.payload)
    payer = permit2_payload.permit2_authorization.from_address
    network = str(requirements.network)

    # Re-verify before settling
    verify_result = verify_permit2(signer, payload, requirements, context)
    if not verify_result.is_valid:
        return SettleResponse(
            success=False,
            error_reason=verify_result.invalid_reason,
            network=network,
            payer=payer,
            transaction="",
        )

    # Branch: EIP-2612 gas sponsoring (atomic settleWithPermit)
    eip2612_info = extract_eip2612_gas_sponsoring_info(payload)
    if eip2612_info is not None:
        return _settle_permit2_with_eip2612(signer, payload, permit2_payload, eip2612_info)

    # Branch: ERC-20 approval gas sponsoring (broadcast approval + settle)
    erc20_info = extract_erc20_approval_gas_sponsoring_info(payload)
    if erc20_info is not None and context is not None:
        ext = context.get_extension(ERC20_APPROVAL_GAS_SPONSORING_KEY)
        if isinstance(ext, Erc20ApprovalFacilitatorExtension):
            extension_signer = ext.resolve_signer(str(payload.accepted.network))
            if extension_signer is not None:
                return _settle_permit2_with_erc20_approval(
                    extension_signer, payload, permit2_payload, erc20_info
                )

    # Branch: standard settle (allowance already on-chain)
    return _settle_permit2_direct(signer, payload, permit2_payload)


def _build_permit2_settle_args(
    permit2_payload: ExactPermit2Payload,
) -> tuple:
    """Build common settle call arguments from a Permit2 payload.

    Returns (permit_tuple, owner_addr, witness_tuple, sig_bytes).
    """
    sig_bytes = hex_to_bytes(permit2_payload.signature or "")
    permit_tuple = (
        (
            to_checksum_address(permit2_payload.permit2_authorization.permitted.token),
            int(permit2_payload.permit2_authorization.permitted.amount),
        ),
        int(permit2_payload.permit2_authorization.nonce),
        int(permit2_payload.permit2_authorization.deadline),
    )
    owner_addr = to_checksum_address(permit2_payload.permit2_authorization.from_address)
    witness_tuple = (
        to_checksum_address(permit2_payload.permit2_authorization.witness.to),
        int(permit2_payload.permit2_authorization.witness.valid_after),
    )
    return permit_tuple, owner_addr, witness_tuple, sig_bytes


def _settle_permit2_direct(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    permit2_payload: ExactPermit2Payload,
) -> SettleResponse:
    """Standard Permit2 settle — allowance is already on-chain."""
    payer = permit2_payload.permit2_authorization.from_address
    network = str(payload.accepted.network)

    try:
        permit_tuple, owner_addr, witness_tuple, sig_bytes = _build_permit2_settle_args(
            permit2_payload
        )

        tx_hash = signer.write_contract(
            X402_EXACT_PERMIT2_PROXY_ADDRESS,
            X402_EXACT_PERMIT2_PROXY_ABI,
            "settle",
            permit_tuple,
            owner_addr,
            witness_tuple,
            sig_bytes,
        )

        receipt = signer.wait_for_transaction_receipt(tx_hash)
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                transaction=tx_hash,
                network=network,
                payer=payer,
            )

        return SettleResponse(
            success=True,
            transaction=tx_hash,
            network=network,
            payer=payer,
        )

    except Exception as e:
        return _map_settle_error(e, network, payer)


def _settle_permit2_with_eip2612(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    permit2_payload: ExactPermit2Payload,
    eip2612_info: Any,
) -> SettleResponse:
    """Settle via settleWithPermit — includes the EIP-2612 permit atomically."""
    payer = permit2_payload.permit2_authorization.from_address
    network = str(payload.accepted.network)

    try:
        permit_tuple, owner_addr, witness_tuple, sig_bytes = _build_permit2_settle_args(
            permit2_payload
        )

        sig_hex = eip2612_info.signature
        sig_raw = hex_to_bytes(sig_hex)
        if len(sig_raw) != 65:
            return _map_settle_error(
                ValueError("EIP-2612 signature must be 65 bytes"), network, payer
            )
        r = sig_raw[:32]
        s = sig_raw[32:64]
        v = sig_raw[64]

        permit2612_tuple = (
            int(eip2612_info.amount),
            int(eip2612_info.deadline),
            r,
            s,
            v,
        )

        tx_hash = signer.write_contract(
            X402_EXACT_PERMIT2_PROXY_ADDRESS,
            X402_EXACT_PERMIT2_PROXY_SETTLE_WITH_PERMIT_ABI,
            "settleWithPermit",
            permit2612_tuple,
            permit_tuple,
            owner_addr,
            witness_tuple,
            sig_bytes,
        )

        receipt = signer.wait_for_transaction_receipt(tx_hash)
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                transaction=tx_hash,
                network=network,
                payer=payer,
            )

        return SettleResponse(
            success=True,
            transaction=tx_hash,
            network=network,
            payer=payer,
        )

    except Exception as e:
        return _map_settle_error(e, network, payer)


def _settle_permit2_with_erc20_approval(
    extension_signer: Any,
    payload: PaymentPayload,
    permit2_payload: ExactPermit2Payload,
    erc20_info: Any,
) -> SettleResponse:
    """Settle via extension signer's send_transactions (approval + settle)."""
    payer = permit2_payload.permit2_authorization.from_address
    network = str(payload.accepted.network)

    try:
        permit_tuple, owner_addr, witness_tuple, sig_bytes = _build_permit2_settle_args(
            permit2_payload
        )

        from ....extensions.erc20_approval_gas_sponsoring.types import WriteContractCall

        tx_hashes = extension_signer.send_transactions(
            [
                erc20_info.signed_transaction,
                WriteContractCall(
                    address=X402_EXACT_PERMIT2_PROXY_ADDRESS,
                    abi=X402_EXACT_PERMIT2_PROXY_ABI,
                    function="settle",
                    args=[permit_tuple, owner_addr, witness_tuple, sig_bytes],
                ),
            ]
        )

        settle_tx_hash = tx_hashes[-1] if tx_hashes else ""
        receipt = extension_signer.wait_for_transaction_receipt(settle_tx_hash)
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                transaction=settle_tx_hash,
                network=network,
                payer=payer,
            )

        return SettleResponse(
            success=True,
            transaction=settle_tx_hash,
            network=network,
            payer=payer,
        )

    except Exception as e:
        return _map_settle_error(e, network, payer)


def _map_settle_error(error: Exception, network: str, payer: str) -> SettleResponse:
    """Map contract revert errors to structured SettleResponse."""
    error_msg = str(error)
    error_reason = ERR_TRANSACTION_FAILED
    if "Permit2612AmountMismatch" in error_msg:
        error_reason = "permit2_2612_amount_mismatch"
    elif "InvalidAmount" in error_msg:
        error_reason = "invalid_permit2_amount"
    elif "InvalidDestination" in error_msg:
        error_reason = "invalid_permit2_destination"
    elif "InvalidOwner" in error_msg:
        error_reason = "invalid_permit2_owner"
    elif "PaymentTooEarly" in error_msg:
        error_reason = "permit2_payment_too_early"
    elif "InvalidSignature" in error_msg or "SignatureExpired" in error_msg:
        error_reason = ERR_PERMIT2_INVALID_SIGNATURE
    elif "InvalidNonce" in error_msg:
        error_reason = "permit2_invalid_nonce"
    elif "erc20_approval_tx_failed" in error_msg:
        error_reason = "erc20_approval_tx_failed"

    return SettleResponse(
        success=False,
        error_reason=error_reason,
        error_message=error_msg[:500],
        network=network,
        payer=payer,
        transaction="",
    )


def _build_permit2_typed_data(
    permit2_authorization: ExactPermit2Authorization,
    chain_id: int,
) -> tuple[dict[str, Any], dict[str, list[TypedDataField]], str, dict[str, Any]]:
    """Build EIP-712 typed data components for Permit2 signature verification.

    Returns (domain_dict, types, primary_type, message) suitable for both
    client signing and facilitator verification.
    """
    domain_dict: dict[str, Any] = {
        "name": "Permit2",
        "chainId": chain_id,
        "verifyingContract": PERMIT2_ADDRESS,
    }

    message = {
        "permitted": {
            "token": permit2_authorization.permitted.token,
            "amount": int(permit2_authorization.permitted.amount),
        },
        "spender": permit2_authorization.spender,
        "nonce": int(permit2_authorization.nonce),
        "deadline": int(permit2_authorization.deadline),
        "witness": {
            "to": permit2_authorization.witness.to,
            "validAfter": int(permit2_authorization.witness.valid_after),
        },
    }

    typed_fields: dict[str, list[TypedDataField]] = {
        type_name: [TypedDataField(name=f["name"], type=f["type"]) for f in fields]
        for type_name, fields in PERMIT2_WITNESS_TYPES.items()
    }

    return domain_dict, typed_fields, "PermitWitnessTransferFrom", message


def _verify_permit2_signature(
    signer: FacilitatorEvmSigner,
    payer: str,
    permit2_authorization: ExactPermit2Authorization,
    chain_id: int,
    signature: bytes,
) -> bool:
    """Verify a Permit2 EIP-712 signature.

    Delegates to signer.verify_typed_data which supports EOA, EIP-1271,
    and ERC-6492 verification (matching TS/Go universal signature verification).

    Args:
        signer: Facilitator signer with verify_typed_data capability.
        payer: Expected signer address.
        permit2_authorization: The authorization that was signed.
        chain_id: Chain ID.
        signature: Signature bytes.

    Returns:
        True if signature is valid.
    """
    domain_dict, typed_fields, primary_type, message = _build_permit2_typed_data(
        permit2_authorization, chain_id
    )

    return signer.verify_typed_data(
        payer,
        domain_dict,  # type: ignore[arg-type]
        typed_fields,
        primary_type,
        message,
        signature,
    )
