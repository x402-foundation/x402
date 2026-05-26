"""Facilitator-side claimWithSignature execution."""

from __future__ import annotations

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, SettleResponse
from ...constants import TX_STATUS_SUCCESS
from ...signer import FacilitatorEvmSigner
from ..abi import BATCH_SETTLEMENT_ABI
from ..authorizer_signer import sign_claim_batch
from ..constants import BATCH_SETTLEMENT_ADDRESS
from ..errors import (
    ERR_AUTHORIZER_ADDRESS_MISMATCH,
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
    authorizer_signer: AuthorizerSigner,
) -> SettleResponse:
    """Submit a batch claim via claimWithSignature()."""
    network = str(requirements.network)
    claim_args = build_voucher_claim_args(payload.claims)

    sig_hex = payload.claim_authorizer_signature
    if not sig_hex:
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
            error_message=str(e)[:500],
            transaction="",
            network=network,
        )

    try:
        tx = signer.write_contract(
            target, BATCH_SETTLEMENT_ABI, "claimWithSignature", claim_args, sig_bytes
        )
        receipt = signer.wait_for_transaction_receipt(tx)
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=ERR_CLAIM_TRANSACTION_FAILED,
                error_message=f"transaction reverted (receipt status {receipt.status})",
                transaction=tx,
                network=network,
            )
        return SettleResponse(
            success=True,
            transaction=tx,
            network=network,
            amount="",
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_CLAIM_TRANSACTION_FAILED,
            error_message=str(e)[:500],
            transaction="",
            network=network,
        )


__all__ = ["build_voucher_claim_args", "execute_claim_with_signature"]
