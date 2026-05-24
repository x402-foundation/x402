"""Facilitator-side cooperative refund execution."""

from __future__ import annotations

import time

try:
    from eth_utils import to_checksum_address
    from web3 import Web3
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, SettleResponse
from ...constants import TX_STATUS_SUCCESS
from ...signer import FacilitatorEvmSigner
from ..abi import BATCH_SETTLEMENT_ABI
from ..authorizer_signer import sign_claim_batch, sign_refund
from ..constants import BATCH_SETTLEMENT_ADDRESS
from ..errors import (
    ERR_AUTHORIZER_ADDRESS_MISMATCH,
    ERR_REFUND_NO_BALANCE,
    ERR_REFUND_SIMULATION_FAILED,
    ERR_REFUND_TRANSACTION_FAILED,
)
from ..types import (
    AuthorizerSigner,
    ChannelState,
    EnrichedRefundPayload,
)
from ..utils import compute_channel_id
from .claim import build_voucher_claim_args
from .utils import read_channel_state, to_contract_channel_config

_REFUND_STATE_POLL_S = 2.0
_REFUND_STATE_POLL_INTERVAL_S = 0.15


def _get_refundable_amount(
    payload: EnrichedRefundPayload,
    pre_state: ChannelState,
    channel_id: str,
    network: str,
) -> int | None:
    """Compute the token amount `refundWithSignature` would transfer after claims."""
    post_claim_total = pre_state.total_claimed
    for claim in payload.claims:
        claim_channel_id = compute_channel_id(claim.channel, network)
        if claim_channel_id.lower() != channel_id.lower():
            continue
        total_claimed = int(claim.total_claimed)
        if total_claimed > post_claim_total:
            post_claim_total = total_claimed

    if post_claim_total > pre_state.balance:
        return None

    requested = int(payload.amount)
    if requested == 0:
        return None

    available = pre_state.balance - post_claim_total
    return available if requested > available else requested


def _build_refund_extra(
    payload: EnrichedRefundPayload,
    channel_id: str,
    pre_state: ChannelState | None,
) -> tuple[str, dict]:
    pre_total = pre_state.total_claimed if pre_state else 0
    pre_balance = pre_state.balance if pre_state else 0
    pre_refund_nonce = pre_state.refund_nonce if pre_state else 0

    last_claim_total = int(payload.claims[-1].total_claimed) if payload.claims else pre_total
    post_claim_total = max(last_claim_total, pre_total)

    available = pre_balance - post_claim_total
    requested = int(payload.amount)
    actual = available if requested > available else requested

    return str(actual), {
        "channelState": {
            "channelId": channel_id,
            "balance": str(pre_balance - actual),
            "totalClaimed": str(post_claim_total),
            "withdrawRequestedAt": 0,
            "refundNonce": str(pre_refund_nonce + 1),
        }
    }


def _build_refund_extra_from_post_state(
    channel_id: str,
    pre_state: ChannelState,
    post_state: ChannelState,
) -> tuple[str, dict]:
    actual = pre_state.balance - post_state.balance if pre_state.balance > post_state.balance else 0
    return str(actual), {
        "channelState": {
            "channelId": channel_id,
            "balance": str(post_state.balance),
            "totalClaimed": str(post_state.total_claimed),
            "withdrawRequestedAt": post_state.withdraw_requested_at,
            "refundNonce": str(post_state.refund_nonce),
        }
    }


def _read_post_refund_state(
    signer: FacilitatorEvmSigner, channel_id: str, submitted_nonce: str
) -> ChannelState | None:
    expected = int(submitted_nonce) + 1
    deadline = time.time() + _REFUND_STATE_POLL_S
    while True:
        try:
            state = read_channel_state(signer, channel_id)
        except Exception:
            return None
        if state.refund_nonce >= expected:
            return state
        if time.time() >= deadline:
            return None
        time.sleep(_REFUND_STATE_POLL_INTERVAL_S)


def _encode_calldata(function_name: str, args: list) -> bytes:
    w3 = Web3()
    contract = w3.eth.contract(
        address=to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
        abi=BATCH_SETTLEMENT_ABI,
    )
    encoded = contract.encode_abi(abi_element_identifier=function_name, args=args)
    return bytes.fromhex(encoded.removeprefix("0x"))


def execute_refund_with_signature(
    signer: FacilitatorEvmSigner,
    payload: EnrichedRefundPayload,
    requirements: PaymentRequirements,
    authorizer_signer: AuthorizerSigner,
) -> SettleResponse:
    """Submit a cooperative refund via `refundWithSignature`, optionally batched with claims."""
    network = str(requirements.network)
    assert payload.channel_config is not None

    try:
        channel_id = compute_channel_id(payload.channel_config, network)
        pre_state = read_channel_state(signer, channel_id)
        contract_addr = to_checksum_address(BATCH_SETTLEMENT_ADDRESS)
        refundable = _get_refundable_amount(payload, pre_state, channel_id, network)

        if refundable == 0:
            return SettleResponse(
                success=False,
                error_reason=ERR_REFUND_NO_BALANCE,
                error_message="Nothing to refund",
                transaction="",
                network=network,
            )

        has_client_sig = payload.refund_authorizer_signature is not None
        authorizer_mismatch = to_checksum_address(
            payload.channel_config.receiver_authorizer
        ) != to_checksum_address(authorizer_signer.address)

        if not has_client_sig and authorizer_mismatch:
            return SettleResponse(
                success=False,
                error_reason=ERR_AUTHORIZER_ADDRESS_MISMATCH,
                transaction="",
                network=network,
            )

        refund_sig_hex = payload.refund_authorizer_signature or sign_refund(
            authorizer_signer,
            channel_id,
            payload.amount,
            payload.refund_nonce,
            network,
        )
        refund_sig_bytes = bytes.fromhex(refund_sig_hex.removeprefix("0x"))

        contract_channel = to_contract_channel_config(payload.channel_config)
        refund_args = [
            contract_channel,
            int(payload.amount),
            int(payload.refund_nonce),
            refund_sig_bytes,
        ]

        if payload.claims:
            claim_sig_hex = payload.claim_authorizer_signature or sign_claim_batch(
                authorizer_signer, payload.claims, network
            )
            claim_sig_bytes = bytes.fromhex(claim_sig_hex.removeprefix("0x"))
            claim_args = [build_voucher_claim_args(payload.claims), claim_sig_bytes]

            claim_calldata = _encode_calldata("claimWithSignature", claim_args)
            refund_calldata = _encode_calldata("refundWithSignature", refund_args)
            multicall_args = [[claim_calldata, refund_calldata]]

            try:
                signer.read_contract(
                    contract_addr, BATCH_SETTLEMENT_ABI, "multicall", *multicall_args
                )
            except Exception as e:
                return SettleResponse(
                    success=False,
                    error_reason=ERR_REFUND_SIMULATION_FAILED,
                    error_message=str(e)[:500],
                    transaction="",
                    network=network,
                )

            tx = signer.write_contract(
                contract_addr, BATCH_SETTLEMENT_ABI, "multicall", *multicall_args
            )
        else:
            try:
                signer.read_contract(
                    contract_addr,
                    BATCH_SETTLEMENT_ABI,
                    "refundWithSignature",
                    *refund_args,
                )
            except Exception as e:
                return SettleResponse(
                    success=False,
                    error_reason=ERR_REFUND_SIMULATION_FAILED,
                    error_message=str(e)[:500],
                    transaction="",
                    network=network,
                )

            tx = signer.write_contract(
                contract_addr,
                BATCH_SETTLEMENT_ABI,
                "refundWithSignature",
                *refund_args,
            )

        receipt = signer.wait_for_transaction_receipt(tx)
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=ERR_REFUND_TRANSACTION_FAILED,
                error_message=f"transaction reverted (receipt status {receipt.status})",
                transaction=tx,
                network=network,
            )

        post_state = (
            _read_post_refund_state(signer, channel_id, payload.refund_nonce)
            if pre_state and pre_state.withdraw_requested_at != 0
            else None
        )
        if pre_state and post_state:
            amount, extra = _build_refund_extra_from_post_state(channel_id, pre_state, post_state)
        else:
            amount, extra = _build_refund_extra(payload, channel_id, pre_state)

        return SettleResponse(
            success=True,
            transaction=tx,
            network=network,
            payer=payload.channel_config.payer,
            amount=amount,
            extra=extra,
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_REFUND_TRANSACTION_FAILED,
            error_message=str(e)[:500],
            transaction="",
            network=network,
        )


__all__ = ["execute_refund_with_signature"]
