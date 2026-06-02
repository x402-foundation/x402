"""Facilitator-side deposit verify + settle."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....interfaces import FacilitatorContext
from .....schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ...constants import TX_STATUS_SUCCESS
from ...multicall import MulticallCall, multicall
from ...signer import FacilitatorEvmSigner
from ...utils import get_evm_chain_id
from ..abi import BATCH_SETTLEMENT_ABI, ERC20_BALANCE_OF_ABI
from ..constants import BATCH_SETTLEMENT_ADDRESS
from ..errors import (
    ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
    ERR_CUMULATIVE_EXCEEDS_BALANCE,
    ERR_DEPOSIT_SIMULATION_FAILED,
    ERR_DEPOSIT_TRANSACTION_FAILED,
    ERR_INSUFFICIENT_BALANCE,
    ERR_INVALID_PAYLOAD_TYPE,
    ERR_INVALID_VOUCHER_SIGNATURE,
    ERR_RPC_READ_FAILED,
)
from ..types import DepositPayload
from ..utils import coerce_bytes32
from .deposit_eip3009 import (
    build_eip3009_deposit_collector_data,
    get_eip3009_deposit_collector_address,
    verify_eip3009_deposit_authorization,
)
from .deposit_permit2 import (
    get_permit2_deposit_collector_address,
    resolve_permit2_deposit_branch,
    verify_permit2_deposit_authorization,
)
from .utils import (
    read_channel_state,
    to_contract_channel_config,
    validate_channel_config,
    verify_batch_settlement_voucher_typed_data,
)


@dataclass
class _DepositExecution:
    kind: str  # "direct" | "erc20Approval"
    collector: str
    collector_data: bytes
    signed_transaction: str | None = None
    extension_signer: Any | None = None
    skip_direct_simulation: bool = False


@dataclass
class _SharedDepositState:
    chain_id: int
    deposit_amount: int
    payer: str
    ch_balance: int
    ch_total_claimed: int
    wd_initiated_at: int
    refund_nonce_val: int


def verify_deposit(
    signer: FacilitatorEvmSigner,
    payment: PaymentPayload,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    context: FacilitatorContext | None = None,
) -> VerifyResponse:
    """Validate the full deposit envelope without submitting an onchain transaction."""
    assert payload.channel_config is not None and payload.voucher is not None
    assert payload.deposit is not None
    payer = payload.channel_config.payer
    chain_id = get_evm_chain_id(str(requirements.network))

    config_err = validate_channel_config(
        payload.channel_config, payload.voucher.channel_id, requirements
    )
    if config_err:
        return VerifyResponse(is_valid=False, invalid_reason=config_err, payer=payer)

    transfer_method = _resolve_deposit_transfer_method(payload, requirements)
    if transfer_method == "permit2" and payload.deposit.authorization.permit2_authorization is None:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_PAYLOAD_TYPE, payer=payer)

    if transfer_method == "permit2":
        method_err = verify_permit2_deposit_authorization(
            signer, payment, payload, requirements, chain_id, context
        )
    else:
        method_err = verify_eip3009_deposit_authorization(signer, payload, requirements, chain_id)
    if method_err is not None:
        return method_err

    shared = _verify_shared_deposit_state(signer, payload, requirements)
    if isinstance(shared, VerifyResponse):
        return shared

    execution = _resolve_deposit_execution(signer, payment, payload, requirements, context)
    if isinstance(execution, VerifyResponse):
        return execution

    if not execution.skip_direct_simulation:
        try:
            signer.read_contract(
                to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
                BATCH_SETTLEMENT_ABI,
                "deposit",
                to_contract_channel_config(payload.channel_config),
                shared.deposit_amount,
                execution.collector,
                execution.collector_data,
            )
        except Exception as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_DEPOSIT_SIMULATION_FAILED,
                invalid_message=str(e)[:500],
                payer=payer,
            )

    return VerifyResponse(
        is_valid=True,
        payer=payer,
        extra={
            "channelId": payload.voucher.channel_id,
            "balance": str(shared.ch_balance),
            "totalClaimed": str(shared.ch_total_claimed),
            "withdrawRequestedAt": shared.wd_initiated_at,
            "refundNonce": str(shared.refund_nonce_val),
        },
    )


def settle_deposit(
    signer: FacilitatorEvmSigner,
    payment: PaymentPayload,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    context: FacilitatorContext | None = None,
) -> SettleResponse:
    """Verify then execute a deposit onchain via the appropriate collector."""
    assert payload.channel_config is not None and payload.voucher is not None
    assert payload.deposit is not None
    network = str(requirements.network)
    config = payload.channel_config
    payer = config.payer
    deposit = payload.deposit
    voucher = payload.voucher

    verified = verify_deposit(signer, payment, payload, requirements, context)
    if not verified.is_valid:
        reason = verified.invalid_reason or ERR_INVALID_PAYLOAD_TYPE
        return SettleResponse(
            success=False,
            error_reason=reason,
            error_message=verified.invalid_message or reason,
            transaction="",
            network=network,
            payer=verified.payer,
        )

    try:
        execution = _resolve_deposit_execution(signer, payment, payload, requirements, context)
        if isinstance(execution, VerifyResponse):
            reason = execution.invalid_reason or ERR_INVALID_PAYLOAD_TYPE
            return SettleResponse(
                success=False,
                error_reason=reason,
                error_message=execution.invalid_message or reason,
                transaction="",
                network=network,
                payer=execution.payer,
            )

        if execution.kind == "erc20Approval":
            assert execution.extension_signer is not None
            assert execution.signed_transaction is not None
            deposit_call = _build_deposit_write_call(payload, execution)
            results = execution.extension_signer.send_transactions(
                [execution.signed_transaction, deposit_call]
            )
            tx = results[1]
        else:
            tx = signer.write_contract(
                to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
                BATCH_SETTLEMENT_ABI,
                "deposit",
                to_contract_channel_config(config),
                int(deposit.amount),
                execution.collector,
                execution.collector_data,
            )

        receipt = signer.wait_for_transaction_receipt(tx)
        if receipt.status != TX_STATUS_SUCCESS:
            return SettleResponse(
                success=False,
                error_reason=ERR_DEPOSIT_TRANSACTION_FAILED,
                error_message=f"transaction reverted (receipt status {receipt.status})",
                transaction=tx,
                network=network,
                payer=payer,
            )

        verified_extra = verified.extra or {}
        optimistic = {
            "channelState": {
                "channelId": voucher.channel_id,
                "balance": str(int(str(verified_extra.get("balance", "0"))) + int(deposit.amount)),
                "totalClaimed": str(verified_extra.get("totalClaimed", "0")),
                "withdrawRequestedAt": int(verified_extra.get("withdrawRequestedAt", 0)),
                "refundNonce": str(verified_extra.get("refundNonce", "0")),
            }
        }

        expected_min_balance = int(optimistic["channelState"]["balance"])
        deadline = time.time() + 2.0
        post_state = read_channel_state(signer, voucher.channel_id)
        while post_state.balance < expected_min_balance and time.time() < deadline:
            time.sleep(0.15)
            post_state = read_channel_state(signer, voucher.channel_id)

        if post_state.balance >= expected_min_balance:
            extra = {
                "channelState": {
                    "channelId": voucher.channel_id,
                    "balance": str(post_state.balance),
                    "totalClaimed": str(post_state.total_claimed),
                    "withdrawRequestedAt": post_state.withdraw_requested_at,
                    "refundNonce": str(post_state.refund_nonce),
                }
            }
        else:
            extra = optimistic

        return SettleResponse(
            success=True,
            transaction=tx,
            network=network,
            payer=payer,
            amount=deposit.amount,
            extra=extra,
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_DEPOSIT_TRANSACTION_FAILED,
            error_message=str(e)[:500],
            transaction="",
            network=network,
            payer=payer,
        )


def _verify_shared_deposit_state(
    signer: FacilitatorEvmSigner,
    payload: DepositPayload,
    requirements: PaymentRequirements,
) -> _SharedDepositState | VerifyResponse:
    assert payload.channel_config is not None and payload.voucher is not None
    assert payload.deposit is not None
    deposit = payload.deposit
    voucher = payload.voucher
    config = payload.channel_config
    payer = config.payer
    chain_id = get_evm_chain_id(str(requirements.network))

    config_err = validate_channel_config(config, voucher.channel_id, requirements)
    if config_err:
        return VerifyResponse(is_valid=False, invalid_reason=config_err, payer=payer)

    voucher_ok = verify_batch_settlement_voucher_typed_data(
        signer,
        channel_id=voucher.channel_id,
        max_claimable_amount=voucher.max_claimable_amount,
        payer_authorizer=config.payer_authorizer,
        payer=config.payer,
        signature=voucher.signature,
        chain_id=chain_id,
    )
    if not voucher_ok:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_INVALID_VOUCHER_SIGNATURE, payer=payer
        )

    settlement_addr = to_checksum_address(BATCH_SETTLEMENT_ADDRESS)
    channel_id_bytes = coerce_bytes32(voucher.channel_id)

    results = multicall(
        signer,
        [
            MulticallCall(
                address=settlement_addr,
                abi=BATCH_SETTLEMENT_ABI,
                function_name="channels",
                args=(channel_id_bytes,),
            ),
            MulticallCall(
                address=to_checksum_address(requirements.asset),
                abi=ERC20_BALANCE_OF_ABI,
                function_name="balanceOf",
                args=(to_checksum_address(payer),),
            ),
            MulticallCall(
                address=settlement_addr,
                abi=BATCH_SETTLEMENT_ABI,
                function_name="pendingWithdrawals",
                args=(channel_id_bytes,),
            ),
            MulticallCall(
                address=settlement_addr,
                abi=BATCH_SETTLEMENT_ABI,
                function_name="refundNonce",
                args=(channel_id_bytes,),
            ),
        ],
    )
    if any(not r.success for r in results):
        return VerifyResponse(is_valid=False, invalid_reason=ERR_RPC_READ_FAILED, payer=payer)

    ch_balance, ch_total_claimed = _unpack_pair(results[0].result)
    payer_balance = int(results[1].result)
    _, wd_initiated_at = _unpack_pair(results[2].result)
    refund_nonce_val = int(results[3].result)
    deposit_amount = int(deposit.amount)

    if payer_balance < deposit_amount:
        return VerifyResponse(is_valid=False, invalid_reason=ERR_INSUFFICIENT_BALANCE, payer=payer)

    effective_balance = ch_balance + deposit_amount
    max_claimable = int(voucher.max_claimable_amount)
    if max_claimable > effective_balance:
        return VerifyResponse(
            is_valid=False, invalid_reason=ERR_CUMULATIVE_EXCEEDS_BALANCE, payer=payer
        )
    if max_claimable <= ch_total_claimed:
        return VerifyResponse(
            is_valid=False,
            invalid_reason=ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
            payer=payer,
        )

    return _SharedDepositState(
        chain_id=chain_id,
        deposit_amount=deposit_amount,
        payer=payer,
        ch_balance=ch_balance,
        ch_total_claimed=ch_total_claimed,
        wd_initiated_at=wd_initiated_at,
        refund_nonce_val=refund_nonce_val,
    )


def _resolve_deposit_execution(
    signer: FacilitatorEvmSigner,
    payment: PaymentPayload,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    context: FacilitatorContext | None = None,
) -> _DepositExecution | VerifyResponse:
    transfer_method = _resolve_deposit_transfer_method(payload, requirements)
    if transfer_method == "eip3009":
        return _DepositExecution(
            kind="direct",
            collector=get_eip3009_deposit_collector_address(),
            collector_data=build_eip3009_deposit_collector_data(payload),
        )

    branch = resolve_permit2_deposit_branch(signer, payment, payload, requirements, context)
    if isinstance(branch, VerifyResponse):
        return branch

    if branch.kind == "erc20Approval":
        return _DepositExecution(
            kind="erc20Approval",
            collector=get_permit2_deposit_collector_address(),
            collector_data=branch.collector_data,
            signed_transaction=branch.signed_transaction,
            extension_signer=branch.extension_signer,
            skip_direct_simulation=True,
        )

    return _DepositExecution(
        kind="direct",
        collector=get_permit2_deposit_collector_address(),
        collector_data=branch.collector_data,
    )


def _resolve_deposit_transfer_method(
    payload: DepositPayload, requirements: PaymentRequirements
) -> str:
    extra = requirements.extra or {}
    hinted = extra.get("assetTransferMethod")
    if hinted:
        return hinted
    assert payload.deposit is not None
    return (
        "permit2" if payload.deposit.authorization.permit2_authorization is not None else "eip3009"
    )


def _build_deposit_write_call(payload: DepositPayload, execution: _DepositExecution):
    """Build a WriteContractCall for the erc20Approval branch's extension signer."""
    from .....extensions.erc20_approval_gas_sponsoring.types import WriteContractCall

    assert payload.channel_config is not None and payload.deposit is not None
    return WriteContractCall(
        address=to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
        abi=BATCH_SETTLEMENT_ABI,
        function="deposit",
        args=[
            to_contract_channel_config(payload.channel_config),
            int(payload.deposit.amount),
            execution.collector,
            execution.collector_data,
        ],
    )


def _unpack_pair(value: Any) -> tuple[int, int]:
    if isinstance(value, list | tuple) and len(value) >= 2:
        return int(value[0]), int(value[1])
    raise ValueError(f"expected (uint, uint) pair, got {value!r}")


__all__ = ["verify_deposit", "settle_deposit"]
