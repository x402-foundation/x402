"""Client channel deps + state-reconciliation helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, SettleResponse
from ....evm.signer import ClientEvmSigner, ClientEvmSignerWithReadContract
from ..abi import BATCH_SETTLEMENT_ABI
from ..constants import BATCH_SETTLEMENT_ADDRESS, MIN_WITHDRAW_DELAY
from ..types import ChannelConfig, ChannelStateExtra
from ..utils import compute_channel_id
from .storage import BatchSettlementClientContext, ClientChannelStorage

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


@dataclass
class BatchSettlementClientDeps:
    """Runtime dependency bag shared by every storage-bound client helper."""

    signer: ClientEvmSigner
    storage: ClientChannelStorage
    salt: str
    payer_authorizer: str | None = None
    voucher_signer: ClientEvmSigner | None = None


def _read_response_channel_state(extra: dict[str, Any] | None) -> ChannelStateExtra | None:
    if not isinstance(extra, dict):
        return None
    cs = extra.get("channelState")
    if not isinstance(cs, dict):
        return None
    try:
        return ChannelStateExtra.from_dict(cs)
    except (KeyError, ValueError):
        return None


def build_channel_config(
    deps: BatchSettlementClientDeps,
    requirements: PaymentRequirements,
) -> ChannelConfig:
    """Build the immutable `ChannelConfig` from deps + payment requirements."""
    extra = requirements.extra or {}
    receiver_authorizer = extra.get("receiverAuthorizer")
    if not receiver_authorizer or to_checksum_address(receiver_authorizer) == ZERO_ADDRESS:
        raise ValueError("Payment requirements must include a non-zero extra.receiverAuthorizer")

    if deps.payer_authorizer is not None:
        payer_authorizer = deps.payer_authorizer
    elif deps.voucher_signer is not None:
        payer_authorizer = deps.voucher_signer.address
    else:
        payer_authorizer = deps.signer.address

    withdraw_delay = extra.get("withdrawDelay")
    if not isinstance(withdraw_delay, int) or isinstance(withdraw_delay, bool):
        withdraw_delay = MIN_WITHDRAW_DELAY

    return ChannelConfig(
        payer=to_checksum_address(deps.signer.address),
        payer_authorizer=to_checksum_address(payer_authorizer),
        receiver=to_checksum_address(requirements.pay_to),
        receiver_authorizer=to_checksum_address(receiver_authorizer),
        token=to_checksum_address(requirements.asset),
        withdraw_delay=int(withdraw_delay),
        salt=deps.salt,
    )


def process_settle_response(
    storage: ClientChannelStorage,
    settle: SettleResponse,
) -> None:
    """Update local channel state from a parsed `SettleResponse`."""
    extra = settle.extra or {}
    channel_state = _read_response_channel_state(extra)
    if channel_state is None:
        return

    key = channel_state.channel_id.lower()
    prev = storage.get(key)
    nxt = prev.copy() if prev is not None else BatchSettlementClientContext()

    if channel_state.charged_cumulative_amount is not None:
        nxt.charged_cumulative_amount = str(channel_state.charged_cumulative_amount)
    if channel_state.balance is not None:
        nxt.balance = str(channel_state.balance)
    if channel_state.total_claimed is not None:
        nxt.total_claimed = str(channel_state.total_claimed)

    storage.set(key, nxt)


def update_channel_after_refund(
    storage: ClientChannelStorage,
    channel_key: str,
    settle_extra: dict[str, Any] | None,
) -> None:
    """Reconcile local channel state with the outcome of a cooperative refund.

    After a partial refund updates local balance from the server snapshot.
    After a full refund (balance == 0) keeps a sentinel record so subsequent
    refund attempts fail locally with "no remaining balance" rather than
    triggering unnecessary network I/O.
    """
    channel_state = _read_response_channel_state(settle_extra)
    if channel_state is None:
        storage.delete(channel_key)
        return

    try:
        balance_after = int(channel_state.balance)
    except (ValueError, TypeError):
        storage.delete(channel_key)
        return

    prev = storage.get(channel_key)
    nxt = prev.copy() if prev is not None else BatchSettlementClientContext()
    nxt.balance = str(balance_after)
    if channel_state.charged_cumulative_amount is not None:
        nxt.charged_cumulative_amount = str(channel_state.charged_cumulative_amount)
    if channel_state.total_claimed is not None:
        nxt.total_claimed = str(channel_state.total_claimed)
    storage.set(channel_key, nxt)


def read_channel_balance_and_total_claimed(
    signer: ClientEvmSigner,
    channel_id: str,
) -> tuple[int, int]:
    """Read `channels(channelId)` returning `(balance, totalClaimed)`."""
    if not isinstance(signer, ClientEvmSignerWithReadContract) and not hasattr(
        signer, "read_contract"
    ):
        raise RuntimeError(
            "read_channel_balance_and_total_claimed requires a signer with read_contract"
        )
    result = cast(ClientEvmSignerWithReadContract, signer).read_contract(
        BATCH_SETTLEMENT_ADDRESS,
        BATCH_SETTLEMENT_ABI,
        "channels",
        channel_id,
    )
    if isinstance(result, (list, tuple)) and len(result) >= 2:
        return int(result[0]), int(result[1])
    raise RuntimeError(f"Unexpected channels() return shape: {result!r}")


def recover_channel(
    deps: BatchSettlementClientDeps,
    requirements: PaymentRequirements,
) -> BatchSettlementClientContext:
    """Recover a channel record from on-chain state."""
    if not hasattr(deps.signer, "read_contract"):
        raise RuntimeError("recover_channel requires signer.read_contract")

    config = build_channel_config(deps, requirements)
    channel_id = compute_channel_id(config, str(requirements.network))
    balance, total_claimed = read_channel_balance_and_total_claimed(deps.signer, channel_id)

    ctx = BatchSettlementClientContext(
        charged_cumulative_amount=str(total_claimed),
        balance=str(balance),
        total_claimed=str(total_claimed),
    )
    deps.storage.set(channel_id.lower(), ctx)
    return ctx


def has_channel(storage: ClientChannelStorage, channel_id: str) -> bool:
    """Return True if a local channel record exists for the channel id."""
    return storage.get(channel_id.lower()) is not None


def get_channel(
    storage: ClientChannelStorage,
    channel_id: str,
) -> BatchSettlementClientContext | None:
    """Return the local channel context for a channel, if present."""
    return storage.get(channel_id.lower())


__all__ = [
    "BatchSettlementClientDeps",
    "build_channel_config",
    "process_settle_response",
    "update_channel_after_refund",
    "read_channel_balance_and_total_claimed",
    "recover_channel",
    "has_channel",
    "get_channel",
]
