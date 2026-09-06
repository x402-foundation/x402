"""Client channel deps + state-reconciliation helpers."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypedDict, cast

from typing_extensions import NotRequired

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....http.utils import decode_payment_response_header
from .....schemas import PaymentRequirements
from ....evm.signer import ClientEvmSigner, ClientEvmSignerWithReadContract
from ..abi import BATCH_SETTLEMENT_ABI
from ..constants import BATCH_SETTLEMENT_ADDRESS, MIN_WITHDRAW_DELAY
from ..types import ChannelConfig
from ..utils import compute_channel_id
from .storage import BatchSettlementClientContext, ClientChannelStorage

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

_NON_NEGATIVE_INT = re.compile(r"^\d+$")


@dataclass
class BatchSettlementClientDeps:
    """Runtime dependency bag shared by every storage-bound client helper."""

    signer: ClientEvmSigner
    storage: ClientChannelStorage
    salt: str
    payer_authorizer: str | None = None
    voucher_signer: ClientEvmSigner | None = None


class ChannelSettleLocal(TypedDict):
    """Local inputs for applying a deposit or voucher settle.

    `request_amount` is the per-request maximum (`PaymentRequirements.amount`);
    the voucher ceiling was `charged_cumulative_amount + request_amount`.
    `deposit_amount` is `payload.deposit.amount` for this payment and is added to
    previous local `balance` after settle. Omit it on voucher-only.
    """

    channel_id: str
    request_amount: str
    deposit_amount: NotRequired[str]


class _ChannelSettleServer(TypedDict, total=False):
    charged_amount: str
    charged_cumulative_amount: str


class _ChannelSettleInput(TypedDict):
    server: _ChannelSettleServer
    local: ChannelSettleLocal


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


def update_channel_from_settle(
    storage: ClientChannelStorage,
    input: _ChannelSettleInput,
) -> None:
    """Update local channel state after a deposit or voucher settle.

    Next cumulative is previous local `charged_cumulative_amount` plus
    `server.charged_amount` (capped at `local.request_amount`). Next balance is
    previous local `balance` plus `local.deposit_amount` when present;
    voucher-only leaves balance unchanged. The write is skipped when extra
    `charged_cumulative_amount` is present and is not a non-negative integer
    equal to that next cumulative. Server `channelState` fields are never copied.
    """
    server = input["server"]
    local = input["local"]
    charged_amount = 0
    if "charged_amount" in server:
        raw_charged = server["charged_amount"]
        if not _NON_NEGATIVE_INT.match(raw_charged):
            raise ValueError("invalid chargedAmount: not a non-negative integer")
        charged_amount = int(raw_charged)
    request_amount = int(local["request_amount"])
    if charged_amount > request_amount:
        raise ValueError("settle response chargedAmount exceeds PaymentRequirements.amount")

    key = local["channel_id"].lower()
    previous = storage.get(key)
    deposit_amount = None if "deposit_amount" not in local else int(local["deposit_amount"])

    if previous is None and charged_amount == 0 and deposit_amount is None:
        return

    previous_charged = previous.charged_cumulative_amount if previous is not None else None
    next_charged_cumulative = int(previous_charged or "0") + charged_amount
    if "charged_cumulative_amount" in server:
        raw_cumulative = server["charged_cumulative_amount"]
        if (
            not _NON_NEGATIVE_INT.match(raw_cumulative)
            or int(raw_cumulative) != next_charged_cumulative
        ):
            return

    nxt = previous.copy() if previous is not None else BatchSettlementClientContext()
    nxt.charged_cumulative_amount = str(next_charged_cumulative)

    if deposit_amount is not None:
        previous_balance = int(previous.balance or "0") if previous is not None else 0
        nxt.balance = str(previous_balance + deposit_amount)

    storage.set(key, nxt)


def update_channel_after_refund(
    storage: ClientChannelStorage,
    channel_key: str,
    refund_amount: str | None = None,
) -> None:
    """Update local channel state after a cooperative refund the client signed.

    Omitted `refund_amount` is a full refund: delete the local record. Otherwise
    the signed amount is capped to the locally expected refundable balance.
    Delete the record when that drains the refundable balance; otherwise subtract
    the effective refund from balance. Cumulative is unchanged, and server
    `channelState` is not an input.
    """
    if refund_amount is None:
        storage.delete(channel_key)
        return

    amount = int(refund_amount)
    previous = storage.get(channel_key)
    previous_balance = int(previous.balance or "0") if previous is not None else 0
    charged_cumulative_amount = (
        int(previous.charged_cumulative_amount or "0") if previous is not None else 0
    )
    refundable_balance = (
        previous_balance - charged_cumulative_amount
        if previous_balance > charged_cumulative_amount
        else 0
    )
    if amount >= refundable_balance:
        storage.delete(channel_key)
        return

    nxt = previous.copy() if previous is not None else BatchSettlementClientContext()
    nxt.balance = str(previous_balance - amount)
    storage.set(channel_key, nxt)


def process_payment_response(
    storage: ClientChannelStorage,
    get_header: Callable[[str], str | None],
    local: ChannelSettleLocal,
) -> None:
    """Process the `PAYMENT-RESPONSE` header after a successful request.

    Decodes the untrusted header and delegates to `update_channel_from_settle`
    with server `chargedAmount`, optional extra cumulative, and the caller-supplied
    local channel inputs.
    """
    raw = get_header("PAYMENT-RESPONSE")
    if not raw:
        return

    settle = decode_payment_response_header(raw)
    if not settle.success:
        return

    extra = settle.extra
    charged_amount: str | None = None
    if extra is not None and "chargedAmount" in extra:
        raw_charged = extra["chargedAmount"]
        if not isinstance(raw_charged, str):
            raise ValueError("invalid chargedAmount: not a non-negative integer")
        charged_amount = raw_charged
    channel_state = extra.get("channelState") if extra else None
    charged_cumulative: str | None = None
    if isinstance(channel_state, dict):
        raw_cumulative = channel_state.get("chargedCumulativeAmount")
        if isinstance(raw_cumulative, str):
            charged_cumulative = raw_cumulative
    server: _ChannelSettleServer = {}
    if charged_amount is not None:
        server["charged_amount"] = charged_amount
    if charged_cumulative is not None:
        server["charged_cumulative_amount"] = charged_cumulative
    update_channel_from_settle(storage, {"server": server, "local": local})


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
    "ChannelSettleLocal",
    "build_channel_config",
    "process_payment_response",
    "update_channel_after_refund",
    "update_channel_from_settle",
    "read_channel_balance_and_total_claimed",
    "recover_channel",
    "has_channel",
    "get_channel",
]
