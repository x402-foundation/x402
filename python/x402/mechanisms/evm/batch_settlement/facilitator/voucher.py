"""Facilitator-side voucher verification."""

from __future__ import annotations

from typing import Any

from .....schemas import PaymentRequirements, VerifyResponse
from ...signer import FacilitatorEvmSigner
from ...utils import get_evm_chain_id
from ..errors import (
    ERR_CHANNEL_NOT_FOUND,
    ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
    ERR_CUMULATIVE_EXCEEDS_BALANCE,
    ERR_INVALID_VOUCHER_SIGNATURE,
)
from ..types import ChannelConfig
from .utils import (
    read_channel_state,
    validate_channel_config,
    verify_batch_settlement_voucher_typed_data,
)


def verify_voucher(
    signer: FacilitatorEvmSigner,
    payload: dict[str, Any],
    requirements: PaymentRequirements,
    channel_config: ChannelConfig,
) -> VerifyResponse:
    """Verify a cumulative voucher payload against onchain channel state."""
    voucher = payload["voucher"]
    channel_id = voucher["channelId"]
    chain_id = get_evm_chain_id(str(requirements.network))
    payer = channel_config.payer

    config_err = validate_channel_config(channel_config, channel_id, requirements)
    if config_err:
        return VerifyResponse(is_valid=False, invalid_reason=config_err, payer=payer)

    voucher_ok = verify_batch_settlement_voucher_typed_data(
        signer,
        channel_id=channel_id,
        max_claimable_amount=str(voucher["maxClaimableAmount"]),
        payer_authorizer=channel_config.payer_authorizer,
        payer=channel_config.payer,
        signature=voucher["signature"],
        chain_id=chain_id,
    )
    if not voucher_ok:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_INVALID_VOUCHER_SIGNATURE,
            payer=payer,
        )

    try:
        state = read_channel_state(signer, channel_id)
    except Exception as e:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_CHANNEL_NOT_FOUND,
            invalid_message=str(e)[:200],
            payer=payer,
        )

    if state.balance == 0:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_CHANNEL_NOT_FOUND, payer=payer)

    max_claimable_amount = int(voucher["maxClaimableAmount"])
    if max_claimable_amount > state.balance:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_CUMULATIVE_EXCEEDS_BALANCE,
            payer=payer,
        )

    is_refund = payload.get("type") == "refund"
    if is_refund:
        below_claimed = max_claimable_amount < state.total_claimed
    else:
        below_claimed = max_claimable_amount <= state.total_claimed
    if below_claimed:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
            payer=payer,
        )

    return VerifyResponse(
        is_valid=True,
        payer=payer,
        extra={
            "channelId": channel_id,
            "balance": str(state.balance),
            "totalClaimed": str(state.total_claimed),
            "withdrawRequestedAt": state.withdraw_requested_at,
            "refundNonce": str(state.refund_nonce),
        },
    )


__all__ = ["verify_voucher"]
