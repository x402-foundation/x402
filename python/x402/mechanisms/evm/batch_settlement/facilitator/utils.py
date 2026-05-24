"""Facilitator-side helpers shared by deposit/voucher/claim/refund/settle handlers."""

from __future__ import annotations

import time
from typing import Any

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements
from ...multicall import MulticallCall, multicall
from ...signer import FacilitatorEvmSigner
from ..abi import BATCH_SETTLEMENT_ABI
from ..constants import (
    BATCH_SETTLEMENT_ADDRESS,
    MAX_WITHDRAW_DELAY,
    MIN_WITHDRAW_DELAY,
    VOUCHER_TYPES,
)
from ..errors import (
    ERR_CHANNEL_ID_MISMATCH,
    ERR_RECEIVER_AUTHORIZER_MISMATCH,
    ERR_RECEIVER_MISMATCH,
    ERR_RPC_READ_FAILED,
    ERR_TOKEN_MISMATCH,
    ERR_VALID_AFTER_IN_FUTURE,
    ERR_VALID_BEFORE_EXPIRED,
    ERR_WITHDRAW_DELAY_MISMATCH,
    ERR_WITHDRAW_DELAY_OUT_OF_RANGE,
)
from ..types import ChannelConfig, ChannelState
from ..utils import coerce_bytes32, compute_channel_id, get_batch_settlement_eip712_domain

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def to_contract_channel_config(config: ChannelConfig) -> tuple:
    """Normalize a ChannelConfig into the checksummed-address tuple expected by the contract."""
    return (
        to_checksum_address(config.payer),
        to_checksum_address(config.payer_authorizer)
        if int(config.payer_authorizer, 16) != 0
        else ZERO_ADDRESS,
        to_checksum_address(config.receiver),
        to_checksum_address(config.receiver_authorizer),
        to_checksum_address(config.token),
        int(config.withdraw_delay),
        coerce_bytes32(config.salt),
    )


def channel_ids_equal(a: str, b: Any) -> bool:
    """Case-insensitive comparison of two channel id hex strings."""
    if not isinstance(b, str) or not b:
        return False

    def norm(x: str) -> str:
        s = x.lower()
        if s.startswith("0x"):
            s = s[2:]
        return "0x" + s

    return norm(a) == norm(b)


def erc3009_authorization_time_invalid_reason(valid_after: int, valid_before: int) -> str | None:
    """Validates the time window of an ERC-3009 ReceiveWithAuthorization."""
    now = int(time.time())
    if valid_before < now + 6:
        return ERR_VALID_BEFORE_EXPIRED
    if valid_after > now:
        return ERR_VALID_AFTER_IN_FUTURE
    return None


def _signature_to_bytes(signature: str | bytes) -> bytes:
    if isinstance(signature, bytes):
        return signature
    return bytes.fromhex(signature.removeprefix("0x"))


def verify_batch_settlement_voucher_typed_data(
    signer: FacilitatorEvmSigner,
    channel_id: str,
    max_claimable_amount: str,
    payer_authorizer: str,
    payer: str,
    signature: str,
    chain_id: int,
) -> bool:
    """Dual-path voucher signature verification.

    When `payer_authorizer` is a non-zero address, the signature is verified
    off-chain via ECDSA recovery against that address. When `payer_authorizer`
    is the zero address, verification falls back to an ERC-1271
    `isValidSignature` call via the facilitator signer.
    """
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = {
        "channelId": coerce_bytes32(channel_id),
        "maxClaimableAmount": int(max_claimable_amount),
    }

    sig_bytes = _signature_to_bytes(signature)
    is_zero = int(payer_authorizer, 16) == 0

    if not is_zero:
        try:
            signable = encode_typed_data(
                domain_data=domain,
                message_types=VOUCHER_TYPES,
                message_data=message,
            )
            recovered = Account.recover_message(signable, signature=sig_bytes)
            return to_checksum_address(recovered) == to_checksum_address(payer_authorizer)
        except Exception:
            return False

    try:
        return signer.verify_typed_data(
            address=to_checksum_address(payer),
            domain=domain,
            types=VOUCHER_TYPES,
            primary_type="Voucher",
            message=message,
            signature=sig_bytes,
        )
    except Exception:
        return False


def validate_channel_config(
    config: ChannelConfig,
    channel_id: str,
    requirements: PaymentRequirements,
) -> str | None:
    """Validate that a ChannelConfig is consistent with the claimed channelId and requirements."""
    computed_id = compute_channel_id(config, str(requirements.network))
    if computed_id.lower() != channel_id.lower():
        return ERR_CHANNEL_ID_MISMATCH

    if to_checksum_address(config.receiver) != to_checksum_address(requirements.pay_to):
        return ERR_RECEIVER_MISMATCH

    extra = requirements.extra or {}
    required_receiver_authorizer = extra.get("receiverAuthorizer")

    if (
        not required_receiver_authorizer
        or to_checksum_address(required_receiver_authorizer) == ZERO_ADDRESS
        or to_checksum_address(config.receiver_authorizer)
        != to_checksum_address(required_receiver_authorizer)
    ):
        return ERR_RECEIVER_AUTHORIZER_MISMATCH

    if to_checksum_address(config.token) != to_checksum_address(requirements.asset):
        return ERR_TOKEN_MISMATCH

    extra_withdraw_delay = extra.get("withdrawDelay")
    if extra_withdraw_delay is not None and config.withdraw_delay != int(extra_withdraw_delay):
        return ERR_WITHDRAW_DELAY_MISMATCH

    if config.withdraw_delay < MIN_WITHDRAW_DELAY or config.withdraw_delay > MAX_WITHDRAW_DELAY:
        return ERR_WITHDRAW_DELAY_OUT_OF_RANGE

    return None


def read_channel_state(signer: FacilitatorEvmSigner, channel_id: str) -> ChannelState:
    """Read onchain channel state via a 3-call multicall."""
    target = to_checksum_address(BATCH_SETTLEMENT_ADDRESS)
    channel_id_bytes = coerce_bytes32(channel_id)

    results = multicall(
        signer,
        [
            MulticallCall(
                address=target,
                abi=BATCH_SETTLEMENT_ABI,
                function_name="channels",
                args=(channel_id_bytes,),
            ),
            MulticallCall(
                address=target,
                abi=BATCH_SETTLEMENT_ABI,
                function_name="pendingWithdrawals",
                args=(channel_id_bytes,),
            ),
            MulticallCall(
                address=target,
                abi=BATCH_SETTLEMENT_ABI,
                function_name="refundNonce",
                args=(channel_id_bytes,),
            ),
        ],
    )

    if any(not r.success for r in results):
        raise RuntimeError(f"{ERR_RPC_READ_FAILED}: multicall returned failure for {channel_id}")

    ch_balance, ch_total_claimed = _unpack_pair(results[0].result)
    _, wd_initiated_at = _unpack_pair(results[1].result)
    refund_nonce = results[2].result

    return ChannelState(
        balance=int(ch_balance),
        total_claimed=int(ch_total_claimed),
        withdraw_requested_at=int(wd_initiated_at),
        refund_nonce=int(refund_nonce),
    )


def _unpack_pair(value: Any) -> tuple[int, int]:
    if isinstance(value, list | tuple) and len(value) >= 2:
        return int(value[0]), int(value[1])
    raise ValueError(f"expected (uint, uint) pair, got {value!r}")


__all__ = [
    "ZERO_ADDRESS",
    "to_contract_channel_config",
    "channel_ids_equal",
    "erc3009_authorization_time_invalid_reason",
    "verify_batch_settlement_voucher_typed_data",
    "validate_channel_config",
    "read_channel_state",
]
