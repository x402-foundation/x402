"""Facilitator-side claimWithSignature execution."""

from __future__ import annotations

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, SettleResponse
from ...settle_receipt import wait_for_receipt_and_build_response
from ...signer import FacilitatorEvmSigner
from ...utils import truncate_error_message
from ..abi import BATCH_SETTLEMENT_ABI
from ..authorizer_signer import sign_claim_batch
from ..constants import BATCH_SETTLEMENT_ADDRESS
from ..errors import (
    ERR_AUTHORIZER_ADDRESS_MISMATCH,
    ERR_AUTHORIZER_NOT_CONFIGURED,
    ERR_CLAIM_SIMULATION_FAILED,
    ERR_CLAIM_TRANSACTION_FAILED,
)
from ..types import AuthorizerSigner, ClaimPayload, VoucherClaim
from .utils import to_contract_channel_config


def build_voucher_claim_args(claims: list[VoucherClaim]) -> list[tuple]:
    """Convert VoucherClaim list into onchain tuple format for claimWithSignature()."""
    return [
        (
            (
                to_contract_channel_config(c.channel),
                int(c.max_claimable_amount),
            ),
            bytes.fromhex(c.signature.removeprefix("0x")),
            int(c.total_claimed),
        )
        for c in claims
    ]


def execute_claim_with_signature(
    signer: FacilitatorEvmSigner,
    payload: ClaimPayload,
    requirements: PaymentRequirements,
    authorizer_signer: AuthorizerSigner | None,
    data_suffix: str | None = None,
) -> SettleResponse:
    """Submit a batch claim via claimWithSignature()."""
    network = str(requirements.network)
    claim_args = build_voucher_claim_args(payload.claims)

    sig_hex = payload.claim_authorizer_signature
    if not sig_hex:
        if authorizer_signer is None:
            return SettleResponse(
                success=False,
                error_reason=ERR_AUTHORIZER_NOT_CONFIGURED,
                transaction="",
                network=network,
            )
        for claim in payload.claims:
            if to_checksum_address(claim.channel.receiver_authorizer) != to_checksum_address(
                authorizer_signer.address
            ):
                return SettleResponse(
                    success=False,
                    error_reason=ERR_AUTHORIZER_ADDRESS_MISMATCH,
                    transaction="",
                    network=network,
                )
        sig_hex = sign_claim_batch(authorizer_signer, payload.claims, network)

    sig_bytes = bytes.fromhex(sig_hex.removeprefix("0x"))
    target = to_checksum_address(BATCH_SETTLEMENT_ADDRESS)

    try:
        signer.read_contract(
            target, BATCH_SETTLEMENT_ABI, "claimWithSignature", claim_args, sig_bytes
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_CLAIM_SIMULATION_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
        )

    try:
        tx = signer.write_contract(
            target,
            BATCH_SETTLEMENT_ABI,
            "claimWithSignature",
            claim_args,
            sig_bytes,
            data_suffix=data_suffix,
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_CLAIM_TRANSACTION_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
        )

    return wait_for_receipt_and_build_response(
        signer,
        tx,
        network,
        None,
        failed_reason=ERR_CLAIM_TRANSACTION_FAILED,
    )


__all__ = ["build_voucher_claim_args", "execute_claim_with_signature"]
