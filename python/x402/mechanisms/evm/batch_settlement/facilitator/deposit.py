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
from ...constants import ERR_SETTLEMENT_PENDING, TX_STATUS_SUCCESS
from ...erc6492 import has_deployment_info, parse_erc6492_signature
from ...multicall import MulticallCall, multicall
from ...settle_receipt import wait_for_receipt_and_build_response
from ...signer import FacilitatorEvmSigner
from ...types import ERC6492SignatureData, TransactionReceipt
from ...utils import (
    bytes_to_hex,
    final_hash_from_two_request_send,
    get_evm_chain_id,
    truncate_error_message,
)
from ..abi import BATCH_SETTLEMENT_ABI, ERC20_BALANCE_OF_ABI
from ..constants import (
    BATCH_SETTLEMENT_ADDRESS,
    CHANNEL_STATE_POLL_INTERVAL_S,
    CHANNEL_STATE_POLL_S,
)
from ..errors import (
    ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
    ERR_CUMULATIVE_EXCEEDS_BALANCE,
    ERR_DEPOSIT_SIMULATION_FAILED,
    ERR_DEPOSIT_TRANSACTION_FAILED,
    ERR_FACTORY_NOT_ALLOWED,
    ERR_INSUFFICIENT_BALANCE,
    ERR_INVALID_PAYLOAD_TYPE,
    ERR_INVALID_VOUCHER_SIGNATURE,
    ERR_RPC_READ_FAILED,
    ERR_SMART_WALLET_DEPLOYMENT_FAILED,
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
    allowed_factories: list[str] | None = None,
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

    # erc3009_counterfactual is non-None when the ERC-3009 deposit is from an undeployed
    # ERC-6492 wallet with an allowlisted factory; its inner signature is validated by the
    # deploy+deposit simulation below rather than a direct (no-code) signature check.
    erc3009_counterfactual: ERC6492SignatureData | None = None
    if transfer_method == "permit2":
        method_err = verify_permit2_deposit_authorization(
            signer, payment, payload, requirements, chain_id, context
        )
        if method_err is not None:
            return method_err
    else:
        erc3009_counterfactual, method_err = verify_eip3009_deposit_authorization(
            signer, payload, requirements, chain_id, allowed_factories
        )
        if method_err is not None:
            return method_err

    shared = _verify_shared_deposit_state(signer, payload, requirements)
    if isinstance(shared, VerifyResponse):
        return shared

    execution = _resolve_deposit_execution(signer, payment, payload, requirements, context)
    if isinstance(execution, VerifyResponse):
        return execution

    if erc3009_counterfactual is not None:
        # Counterfactual: the payer has no code yet, so a plain deposit() eth_call would
        # revert. Simulate factory-deploy + deposit atomically via one Multicall3 eth_call so
        # the inner signature is validated against the just-deployed wallet.
        if not _simulate_counterfactual_deposit(
            signer, erc3009_counterfactual, payload, shared.deposit_amount, execution
        ):
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_DEPOSIT_SIMULATION_FAILED,
                payer=payer,
            )
    elif not execution.skip_direct_simulation:
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
                invalid_message=truncate_error_message(str(e)),
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
    allowed_factories: list[str] | None = None,
    data_suffix: str | None = None,
) -> SettleResponse:
    """Verify then execute a deposit onchain via the appropriate collector."""
    assert payload.channel_config is not None and payload.voucher is not None
    assert payload.deposit is not None
    network = str(requirements.network)
    config = payload.channel_config
    payer = config.payer
    deposit = payload.deposit
    voucher = payload.voucher

    verified = verify_deposit(signer, payment, payload, requirements, context, allowed_factories)
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

    receipt_waiter = signer
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

        # ERC-6492 counterfactual deposit: deploy the undeployed wallet (gated by the factory
        # allowlist) before the deposit. The inner signature is validated by the verify-side
        # deploy+deposit Multicall3 simulation and, definitively, by the on-chain deposit().
        transfer_method = _resolve_deposit_transfer_method(payload, requirements)
        if transfer_method == "eip3009":
            deploy_err = _deploy_erc3009_counterfactual_if_needed(
                signer, payload, requirements, allowed_factories
            )
            if deploy_err is not None:
                return deploy_err

        # A single hash from the two-request (approve + deposit) send means the signer
        # bundled them atomically, but a non-conforming signer could return one hash
        # after broadcasting only the approve. Its receipt then proves some transaction
        # didn't revert, not that the deposit ran, so success requires the balance check
        # in _build_deposit_success.
        unconfirmed_bundle_hash = False
        if execution.kind == "erc20Approval":
            assert execution.extension_signer is not None
            assert execution.signed_transaction is not None
            deposit_call = _build_deposit_write_call(payload, execution, data_suffix=data_suffix)
            results = execution.extension_signer.send_transactions(
                [execution.signed_transaction, deposit_call]
            )
            tx = final_hash_from_two_request_send(results)
            if tx is None:
                raise RuntimeError(
                    "expected 1 (atomic bundle) or 2 (sequential) tx hashes from "
                    f"extension signer, got {len(results)}"
                )
            unconfirmed_bundle_hash = len(results) == 1
            receipt_waiter = execution.extension_signer
        else:
            tx = signer.write_contract(
                to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
                BATCH_SETTLEMENT_ABI,
                "deposit",
                to_contract_channel_config(config),
                int(deposit.amount),
                execution.collector,
                execution.collector_data,
                data_suffix=data_suffix,
            )

        def _build_deposit_success(_receipt: TransactionReceipt) -> SettleResponse:
            verified_extra = verified.extra or {}
            optimistic = {
                "channelState": {
                    "channelId": voucher.channel_id,
                    "balance": str(
                        int(str(verified_extra.get("balance", "0"))) + int(deposit.amount)
                    ),
                    "totalClaimed": str(verified_extra.get("totalClaimed", "0")),
                    "withdrawRequestedAt": int(verified_extra.get("withdrawRequestedAt", 0)),
                    "refundNonce": str(verified_extra.get("refundNonce", "0")),
                }
            }

            expected_min_balance = int(optimistic["channelState"]["balance"])
            deadline = time.time() + CHANNEL_STATE_POLL_S
            balance_confirmed = False
            # Set only when a read succeeds and shows the deposit missing, as opposed
            # to a read that failed outright and leaves the balance unknown.
            balance_read_without_confirmation = False
            try:
                post_state = read_channel_state(signer, voucher.channel_id)
                while post_state.balance < expected_min_balance and time.time() < deadline:
                    time.sleep(CHANNEL_STATE_POLL_INTERVAL_S)
                    post_state = read_channel_state(signer, voucher.channel_id)

                if post_state.balance >= expected_min_balance:
                    balance_confirmed = True
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
                    balance_read_without_confirmation = True
                    extra = optimistic
            except Exception:
                extra = optimistic

            if unconfirmed_bundle_hash and not balance_confirmed:
                # A read showing the deposit missing is terminal; a failed read leaves it
                # unconfirmed, so report settlement_pending for the caller to reconcile.
                if balance_read_without_confirmation:
                    return SettleResponse(
                        success=False,
                        error_reason=ERR_DEPOSIT_TRANSACTION_FAILED,
                        error_message=(
                            "extension signer returned a single transaction hash for the "
                            "erc20 approval + deposit bundle, but the resulting channel "
                            "balance does not reflect the deposit"
                        ),
                        transaction=tx,
                        network=network,
                        payer=payer,
                    )
                return SettleResponse(
                    success=False,
                    error_reason=ERR_SETTLEMENT_PENDING,
                    error_message=(
                        "extension signer returned a single transaction hash for the "
                        "erc20 approval + deposit bundle and the post-deposit balance read "
                        "failed, so the deposit could not be confirmed"
                    ),
                    transaction=tx,
                    network=network,
                    payer=payer,
                )

            return SettleResponse(
                success=True,
                transaction=tx,
                network=network,
                payer=payer,
                amount=deposit.amount,
                extra=extra,
            )

        return wait_for_receipt_and_build_response(
            receipt_waiter,
            tx,
            network,
            payer,
            failed_reason=ERR_DEPOSIT_TRANSACTION_FAILED,
            on_success=_build_deposit_success,
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_DEPOSIT_TRANSACTION_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
            payer=payer,
        )


def _simulate_counterfactual_deposit(
    signer: FacilitatorEvmSigner,
    sig_data: ERC6492SignatureData,
    payload: DepositPayload,
    deposit_amount: int,
    execution: _DepositExecution,
) -> bool:
    """Simulate factory-deploy + deposit atomically via Multicall3.

    The deposit succeeds only if, after the wallet is deployed in the first sub-call, its
    isValidSignature accepts the inner ERC-3009 signature carried by the (already-stripped)
    collector data. Returns the success of the deposit sub-call.
    """
    assert payload.channel_config is not None
    results = multicall(
        signer,
        [
            MulticallCall(
                address=bytes_to_hex(sig_data.factory),
                call_data=sig_data.factory_calldata,
            ),
            MulticallCall(
                address=to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
                abi=BATCH_SETTLEMENT_ABI,
                function_name="deposit",
                args=(
                    to_contract_channel_config(payload.channel_config),
                    deposit_amount,
                    execution.collector,
                    execution.collector_data,
                ),
            ),
        ],
    )
    return len(results) >= 2 and results[1].success


def _deploy_erc3009_counterfactual_if_needed(
    signer: FacilitatorEvmSigner,
    payload: DepositPayload,
    requirements: PaymentRequirements,
    allowed_factories: list[str] | None,
) -> SettleResponse | None:
    """Deploy an undeployed ERC-6492 wallet before an ERC-3009 deposit.

    Returns None when no deployment is needed or the wallet deployed successfully (the caller
    proceeds to the real deposit), or a terminal SettleResponse when the factory is disallowed
    or the deploy reverts. The inner signature is validated by the verify-side deploy+deposit
    Multicall3 simulation and, definitively, by the on-chain deposit() that follows — so no
    post-deploy re-simulation is performed here.
    """
    assert payload.deposit is not None and payload.channel_config is not None
    network = str(requirements.network)
    payer = payload.channel_config.payer
    auth = payload.deposit.authorization.erc3009_authorization
    if auth is None:
        return None

    try:
        sig_data = parse_erc6492_signature(bytes.fromhex(auth.signature.removeprefix("0x")))
    except Exception:
        return None
    if not has_deployment_info(sig_data):
        return None

    code = signer.get_code(to_checksum_address(payer))
    if len(code) != 0:
        # Already deployed — nothing to do; proceed with the standard deposit.
        return None

    allowed = [f.strip().lower() for f in (allowed_factories or [])]
    if bytes_to_hex(sig_data.factory).lower() not in allowed:
        return SettleResponse(
            success=False,
            error_reason=ERR_FACTORY_NOT_ALLOWED,
            error_message="factory not in eip6492_allowed_factories allowlist",
            transaction="",
            network=network,
            payer=payer,
        )

    try:
        tx_hash = signer.send_transaction(bytes_to_hex(sig_data.factory), sig_data.factory_calldata)
        receipt = signer.wait_for_transaction_receipt(tx_hash)
        if receipt.status != TX_STATUS_SUCCESS:
            raise RuntimeError("deployment transaction reverted")
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_SMART_WALLET_DEPLOYMENT_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
            payer=payer,
        )

    # Do NOT re-simulate the deposit here. The single authoritative pre-check is the
    # atomic Multicall3 deploy+isValidSignature simulation that runs in verify_deposit
    # (one eth_call, state shared across both sub-calls). A second standalone eth_call
    # after the real deploy tx is unreliable — the read can race the deploy's state
    # propagation across load-balanced RPC nodes — and was producing false
    # inner-signature-unsupported rejections for valid wallets
    # (e.g. Coinbase Smart Wallet v1.1). The on-chain deposit() transaction that
    # follows is itself the definitive signature check; a genuinely unsupported inner
    # signature will revert there and the outer try/except in settle_deposit will
    # surface it as ERR_DEPOSIT_TRANSACTION_FAILED.
    return None


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


def _build_deposit_write_call(
    payload: DepositPayload,
    execution: _DepositExecution,
    data_suffix: str | None = None,
):
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
        data_suffix=data_suffix,
    )


def _unpack_pair(value: Any) -> tuple[int, int]:
    if isinstance(value, list | tuple) and len(value) >= 2:
        return int(value[0]), int(value[1])
    raise ValueError(f"expected (uint, uint) pair, got {value!r}")


__all__ = ["verify_deposit", "settle_deposit"]
