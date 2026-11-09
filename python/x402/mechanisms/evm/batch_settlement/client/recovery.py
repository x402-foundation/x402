"""Corrective-402 recovery flows."""

from __future__ import annotations

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequired, PaymentRequirements
from ...utils import get_evm_chain_id
from ..constants import SCHEME_BATCH_SETTLEMENT, VOUCHER_TYPES
from ..errors import ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED, ERR_CUMULATIVE_AMOUNT_MISMATCH
from ..types import ChannelStateExtra, VoucherStateExtra
from ..utils import (
    coerce_bytes32,
    compute_channel_id,
    get_batch_settlement_eip712_domain,
)
from .channel import (
    BatchSettlementClientDeps,
    build_channel_config,
    read_channel_balance_and_total_claimed,
)
from .storage import BatchSettlementClientContext


def process_corrective_payment_required(
    deps: BatchSettlementClientDeps,
    payment_required: PaymentRequired,
) -> bool:
    """Handle a corrective 402 by resyncing local channel state."""
    err = payment_required.error
    if err not in (ERR_CUMULATIVE_AMOUNT_MISMATCH, ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED):
        return False

    accept: PaymentRequirements | None = None
    for a in payment_required.accepts:
        if a.scheme == SCHEME_BATCH_SETTLEMENT:
            accept = a
            break
    if accept is None:
        return False

    extra = accept.extra or {}
    cs_raw = extra.get("channelState")
    vs_raw = extra.get("voucherState")
    channel_state = ChannelStateExtra.from_dict(cs_raw) if isinstance(cs_raw, dict) else None
    voucher_state = VoucherStateExtra.from_dict(vs_raw) if isinstance(vs_raw, dict) else None

    has_sig = (
        channel_state is not None
        and channel_state.charged_cumulative_amount is not None
        and voucher_state is not None
        and voucher_state.signed_max_claimable is not None
        and voucher_state.signature is not None
    )

    if not has_sig:
        return recover_from_onchain_state(deps, accept)

    assert channel_state is not None and voucher_state is not None
    return recover_from_signature(deps, accept, channel_state, voucher_state)


def recover_from_signature(
    deps: BatchSettlementClientDeps,
    accept: PaymentRequirements,
    channel_state: ChannelStateExtra,
    voucher_state: VoucherStateExtra,
) -> bool:
    """Recover when the corrective 402 includes a server-stored voucher signature."""
    if (
        channel_state.charged_cumulative_amount is None
        or voucher_state.signed_max_claimable is None
        or voucher_state.signature is None
    ):
        return False

    charged = int(channel_state.charged_cumulative_amount)
    signed = int(voucher_state.signed_max_claimable)
    sig = voucher_state.signature

    if charged > signed:
        return False

    config = build_channel_config(deps, accept)
    channel_id = compute_channel_id(config, str(accept.network))

    if not hasattr(deps.signer, "read_contract"):
        return False
    ch_balance, ch_total_claimed = read_channel_balance_and_total_claimed(deps.signer, channel_id)

    if charged < ch_total_claimed:
        return False

    chain_id = get_evm_chain_id(str(accept.network))
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = {
        "channelId": coerce_bytes32(channel_id),
        "maxClaimableAmount": signed,
    }

    signable = encode_typed_data(
        domain_data=domain,
        message_types=VOUCHER_TYPES,
        message_data=message,
    )
    sig_bytes = bytes.fromhex(sig.removeprefix("0x"))
    recovered = Account.recover_message(signable, signature=sig_bytes)

    if deps.payer_authorizer is not None:
        expected = to_checksum_address(deps.payer_authorizer)
    elif deps.voucher_signer is not None:
        expected = to_checksum_address(deps.voucher_signer.address)
    else:
        expected = to_checksum_address(deps.signer.address)

    if to_checksum_address(recovered) != expected:
        return False

    ctx = BatchSettlementClientContext(
        charged_cumulative_amount=str(charged),
        signed_max_claimable=str(signed),
        signature=sig,
        balance=str(ch_balance),
        total_claimed=str(ch_total_claimed),
    )
    deps.storage.set(channel_id.lower(), ctx)
    return True


def recover_from_onchain_state(
    deps: BatchSettlementClientDeps,
    accept: PaymentRequirements,
) -> bool:
    """Recover channel state purely from on-chain `channels(channelId)`."""
    if not hasattr(deps.signer, "read_contract"):
        return False
    config = build_channel_config(deps, accept)
    channel_id = compute_channel_id(config, str(accept.network))
    ch_balance, ch_total_claimed = read_channel_balance_and_total_claimed(deps.signer, channel_id)
    ctx = BatchSettlementClientContext(
        charged_cumulative_amount=str(ch_total_claimed),
        balance=str(ch_balance),
        total_claimed=str(ch_total_claimed),
    )
    deps.storage.set(channel_id.lower(), ctx)
    return True


__all__ = [
    "process_corrective_payment_required",
    "recover_from_signature",
    "recover_from_onchain_state",
]
