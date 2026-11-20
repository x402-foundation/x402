"""TVM facilitator implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

import time
from typing import Any

from pytoniq_core import begin_cell

from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..codecs.common import decode_base64_boc, is_native_asset, normalize_address, normalize_asset
from ..codecs.native import has_jetton_only_extra, native_transfer_body
from ..codecs.w5 import (
    address_from_state_init,
    parse_active_w5_account_state,
    parse_w5_init_data,
    verify_w5_signature,
)
from ..constants import (
    ALLOWED_CLIENT_CODES,
    DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
    DEFAULT_SETTLEMENT_BATCH_FLUSH_INTERVAL_SECONDS,
    DEFAULT_SETTLEMENT_BATCH_FLUSH_SIZE,
    DEFAULT_SETTLEMENT_CONFIRMATION_WORKERS,
    DEFAULT_TRACE_CONFIRMATION_TIMEOUT_SECONDS,
    DEFAULT_TVM_OUTER_GAS_BUFFER,
    ERR_EXACT_TVM_ACCOUNT_FROZEN,
    ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
    ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
    ERR_EXACT_TVM_INSUFFICIENT_BALANCE,
    ERR_EXACT_TVM_INVALID_AMOUNT,
    ERR_EXACT_TVM_INVALID_ASSET,
    ERR_EXACT_TVM_INVALID_CODE_HASH,
    ERR_EXACT_TVM_INVALID_EXTENSIONS_DICT,
    ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER,
    ERR_EXACT_TVM_INVALID_PAYLOAD,
    ERR_EXACT_TVM_INVALID_RECIPIENT,
    ERR_EXACT_TVM_INVALID_SEQNO,
    ERR_EXACT_TVM_INVALID_SIGNATURE,
    ERR_EXACT_TVM_INVALID_SIGNATURE_MODE,
    ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED,
    ERR_EXACT_TVM_INVALID_W5_MESSAGE,
    ERR_EXACT_TVM_INVALID_WALLET_ID,
    ERR_EXACT_TVM_NETWORK_MISMATCH,
    ERR_EXACT_TVM_SIMULATION_FAILED,
    ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH,
    ERR_EXACT_TVM_TRANSACTION_FAILED,
    ERR_EXACT_TVM_UNSUPPORTED_NETWORK,
    ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
    ERR_EXACT_TVM_UNSUPPORTED_VERSION,
    ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR,
    MIN_FACILITATOR_TON_BALANCE,
    SCHEME_EXACT,
    SUPPORTED_NETWORKS,
)
from ..settlement_cache import SettlementCache
from ..signer import FacilitatorTvmSigner
from ..trace_utils import (
    message_body_hash_matches,
    parse_trace_transactions,
    trace_transaction_compute_fees,
    trace_transaction_fwd_fees,
    trace_transaction_hash_to_hex,
    trace_transaction_storage_fees,
    transaction_succeeded,
)
from ..types import (
    ExactTvmPayload,
    ParsedNativeTransfer,
    ParsedTvmSettlement,
    TvmAccountState,
    TvmRelayRequest,
    W5InitData,
)
from .codec import parse_exact_tvm_native_payload, parse_exact_tvm_payload
from .settlement_batcher import _BatchResult, _QueuedSettlement, _SettlementBatcher


def _parse_settlement(
    settlement_boc: str, requirements: PaymentRequirements
) -> ParsedTvmSettlement:
    if is_native_asset(requirements.asset):
        return parse_exact_tvm_native_payload(settlement_boc)
    return parse_exact_tvm_payload(settlement_boc)


def _effective_response_destination(extra: dict[str, Any]) -> str | None:
    response_destination = extra.get("responseDestination")
    if response_destination is None:
        return None
    return normalize_address(response_destination)


def _effective_forward_ton_amount(extra: dict[str, Any]) -> int:
    return int(extra.get("forwardTonAmount", 0))


def _effective_forward_payload(extra: dict[str, Any]):
    encoded_payload = extra.get("forwardPayload")
    if encoded_payload is None:
        return begin_cell().store_bit(0).end_cell()
    return decode_base64_boc(encoded_payload)


class ExactTvmScheme:
    """TVM facilitator implementation for the Exact payment scheme (V2)."""

    scheme = SCHEME_EXACT
    caip_family = "tvm:*"

    def __init__(
        self,
        signer: FacilitatorTvmSigner,
        settlement_cache: SettlementCache | None = None,
        *,
        batch_flush_interval_seconds: float = DEFAULT_SETTLEMENT_BATCH_FLUSH_INTERVAL_SECONDS,
        batch_flush_size: int = DEFAULT_SETTLEMENT_BATCH_FLUSH_SIZE,
        confirmation_workers: int = DEFAULT_SETTLEMENT_CONFIRMATION_WORKERS,
        confirmation_timeout_seconds: float = DEFAULT_TRACE_CONFIRMATION_TIMEOUT_SECONDS,
    ) -> None:
        self._signer = signer
        self._settlement_cache = settlement_cache or SettlementCache()
        self._batcher = _SettlementBatcher(
            signer,
            self._settlement_cache,
            flush_interval_seconds=batch_flush_interval_seconds,
            batch_flush_size=batch_flush_size,
            confirmation_workers=confirmation_workers,
            confirmation_timeout_seconds=confirmation_timeout_seconds,
            settlement_verifier=lambda trace_data, settlement: (
                self._verify_finalized_trace_settlement(
                    trace_data,
                    settlement=settlement,
                )
            ),
        )

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get mechanism-specific extra data."""
        if str(network) not in SUPPORTED_NETWORKS:
            return None
        return {"areFeesSponsored": True}

    def get_signers(self, network: Network) -> list[str]:
        """Get facilitator wallet addresses."""
        return self._signer.get_addresses_for_network(str(network))

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        """Verify a TON exact payment payload."""
        try:
            tvm_payload = ExactTvmPayload.from_dict(payload.payload)
        except ValueError as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_EXACT_TVM_INVALID_PAYLOAD,
                invalid_message=str(e),
                payer="",
            )

        try:
            settlement = _parse_settlement(tvm_payload.settlement_boc, requirements)
            verification, _ = self._verify(payload, requirements, tvm_payload, settlement)
            return verification
        except ValueError as e:
            return VerifyResponse(is_valid=False, invalid_reason=str(e), payer="")
        except Exception as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_EXACT_TVM_SIMULATION_FAILED,
                invalid_message=str(e),
                payer="",
            )

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        """Settle a TON exact payment payload."""
        try:
            tvm_payload = ExactTvmPayload.from_dict(payload.payload)
        except ValueError as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_EXACT_TVM_INVALID_PAYLOAD,
                error_message=str(e),
                payer="",
                transaction="",
                network=requirements.network,
            )

        try:
            settlement = _parse_settlement(tvm_payload.settlement_boc, requirements)
            verification, relay_request = self._verify(
                payload, requirements, tvm_payload, settlement
            )
        except ValueError as e:
            return SettleResponse(
                success=False,
                error_reason=str(e),
                payer="",
                transaction="",
                network=requirements.network,
            )
        except Exception as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_EXACT_TVM_SIMULATION_FAILED,
                error_message=str(e),
                payer="",
                transaction="",
                network=requirements.network,
            )
        if not verification.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verification.invalid_reason,
                error_message=verification.invalid_message,
                payer=verification.payer,
                transaction="",
                network=requirements.network,
            )

        if self._settlement_cache.is_duplicate(
            settlement.settlement_hash, requirements.max_timeout_seconds
        ):
            return SettleResponse(
                success=False,
                error_reason=ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
                payer=settlement.payer,
                transaction="",
                network=requirements.network,
            )

        try:
            batch_result = self._batcher.enqueue(
                _QueuedSettlement(
                    network=str(requirements.network),
                    settlement_hash=settlement.settlement_hash,
                    settlement=settlement,
                    relay_request=relay_request,
                )
            )
        except Exception as e:
            self._settlement_cache.release(settlement.settlement_hash)
            batch_result = _BatchResult(
                success=False,
                error_reason=ERR_EXACT_TVM_TRANSACTION_FAILED,
                error_message=str(e),
            )

        return SettleResponse(
            success=batch_result.success,
            error_reason=batch_result.error_reason,
            error_message=batch_result.error_message,
            payer=settlement.payer,
            transaction=batch_result.transaction,
            network=requirements.network,
        )

    def _verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        tvm_payload: ExactTvmPayload,
        settlement: ParsedTvmSettlement,
    ) -> tuple[VerifyResponse, TvmRelayRequest | None]:
        payer = settlement.payer

        def invalid_response(reason: str) -> tuple[VerifyResponse, TvmRelayRequest | None]:
            return (VerifyResponse(is_valid=False, invalid_reason=reason, payer=payer), None)

        if payload.x402_version != 2:
            return invalid_response(ERR_EXACT_TVM_UNSUPPORTED_VERSION)

        if payload.accepted.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return invalid_response(ERR_EXACT_TVM_UNSUPPORTED_SCHEME)

        if str(requirements.network) not in SUPPORTED_NETWORKS:
            return invalid_response(ERR_EXACT_TVM_UNSUPPORTED_NETWORK)

        if str(payload.accepted.network) != str(requirements.network):
            return invalid_response(ERR_EXACT_TVM_NETWORK_MISMATCH)

        facilitator_addresses = self._signer.get_addresses_for_network(str(requirements.network))
        for facilitator_address in facilitator_addresses:
            facilitator_state = self._signer.get_account_state(
                facilitator_address, str(requirements.network)
            )
            if facilitator_state.balance < MIN_FACILITATOR_TON_BALANCE:
                return (
                    VerifyResponse(
                        is_valid=False,
                        invalid_reason=ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
                        invalid_message=(
                            f"Facilitator wallet {facilitator_address} balance "
                            f"{facilitator_state.balance} nanotons is below required "
                            f"{MIN_FACILITATOR_TON_BALANCE} nanotons (1.1 TON)"
                        ),
                        payer=payer,
                    ),
                    None,
                )

        if int(payload.accepted.amount) != int(requirements.amount):
            return invalid_response(ERR_EXACT_TVM_INVALID_AMOUNT)

        if normalize_asset(payload.accepted.asset) != normalize_asset(requirements.asset):
            return invalid_response(ERR_EXACT_TVM_INVALID_ASSET)

        if normalize_address(payload.accepted.pay_to) != normalize_address(requirements.pay_to):
            return invalid_response(ERR_EXACT_TVM_INVALID_RECIPIENT)

        if (
            payload.accepted.extra.get("areFeesSponsored") is not True
            or requirements.extra.get("areFeesSponsored") is not True
        ):
            return invalid_response(ERR_EXACT_TVM_UNSUPPORTED_SCHEME)

        if normalize_asset(tvm_payload.asset) != normalize_asset(requirements.asset):
            return invalid_response(ERR_EXACT_TVM_INVALID_ASSET)

        if is_native_asset(requirements.asset):
            return self._verify_native(payload, requirements, settlement)

        if settlement.is_native:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

        expected_response_destination = _effective_response_destination(requirements.extra)
        if _effective_response_destination(payload.accepted.extra) != expected_response_destination:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

        expected_forward_ton_amount = _effective_forward_ton_amount(requirements.extra)
        if _effective_forward_ton_amount(payload.accepted.extra) != expected_forward_ton_amount:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

        expected_forward_payload = _effective_forward_payload(requirements.extra)
        if _effective_forward_payload(payload.accepted.extra).hash != expected_forward_payload.hash:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

        # Up to this point, we've checked all fields in PaymentRequirements and PaymentPayload except for settlementBoc

        if settlement.transfer.destination != normalize_address(requirements.pay_to):
            return invalid_response(ERR_EXACT_TVM_INVALID_RECIPIENT)

        if settlement.transfer.jetton_amount != int(requirements.amount):
            return invalid_response(ERR_EXACT_TVM_INVALID_AMOUNT)

        if settlement.transfer.forward_ton_amount != expected_forward_ton_amount:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)
        if settlement.transfer.response_destination != expected_response_destination:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)
        if settlement.transfer.forward_payload.hash != expected_forward_payload.hash:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)
        max_attached_ton_amount = (
            settlement.transfer.forward_ton_amount + DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT
        )
        if settlement.transfer.attached_ton_amount > max_attached_ton_amount:
            return invalid_response(ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH)

        account_or_error = self._verify_payer_wallet(requirements, settlement)
        if isinstance(account_or_error, str):
            return invalid_response(account_or_error)

        canonical_source_wallet = normalize_address(
            self._signer.get_jetton_wallet(
                requirements.asset,
                payer,
                str(requirements.network),
            )
        )
        if normalize_address(settlement.transfer.source_wallet) != canonical_source_wallet:
            return invalid_response(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

        jetton_wallet_data = self._signer.get_jetton_wallet_data(
            settlement.transfer.source_wallet,
            str(requirements.network),
        )
        if normalize_address(jetton_wallet_data.owner) != payer:
            return invalid_response(ERR_EXACT_TVM_INVALID_RECIPIENT)
        if normalize_address(jetton_wallet_data.jetton_minter) != normalize_address(
            requirements.asset
        ):
            return invalid_response(ERR_EXACT_TVM_INVALID_ASSET)
        if jetton_wallet_data.balance < settlement.transfer.jetton_amount:
            return invalid_response(ERR_EXACT_TVM_INSUFFICIENT_BALANCE)

        try:
            provisional_relay_request = TvmRelayRequest(
                destination=settlement.payer,
                body=settlement.body,
                state_init=settlement.state_init,
                forward_ton_amount=settlement.transfer.forward_ton_amount,
            )
            external_boc = self._signer.build_relay_external_boc(
                requirements.network,
                provisional_relay_request,
                for_emulation=True,
            )
            emulation = self._signer.emulate_external_message(requirements.network, external_boc)
            payer_transaction = self._verify_finalized_trace_settlement(
                emulation,
                settlement=settlement,
                return_transaction=True,
            )
            actual_inner = settlement.transfer.attached_ton_amount
            required_outer = (
                actual_inner
                + trace_transaction_storage_fees(payer_transaction)
                + trace_transaction_compute_fees(payer_transaction)
                + trace_transaction_fwd_fees(payer_transaction)
                + DEFAULT_TVM_OUTER_GAS_BUFFER
            )
            relay_request = TvmRelayRequest(
                destination=settlement.payer,
                body=settlement.body,
                state_init=settlement.state_init,
                forward_ton_amount=settlement.transfer.forward_ton_amount,
                relay_amount=required_outer,
            )
        except Exception as e:
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=ERR_EXACT_TVM_SIMULATION_FAILED,
                    invalid_message=str(e),
                    payer=payer,
                ),
                None,
            )

        return (VerifyResponse(is_valid=True, payer=payer), relay_request)

    def _verify_native(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        settlement: ParsedTvmSettlement,
    ) -> tuple[VerifyResponse, TvmRelayRequest | None]:
        """Verify the native TON part of a payment (spec: "Native TON")."""
        payer = settlement.payer

        def invalid_response(reason: str) -> tuple[VerifyResponse, TvmRelayRequest | None]:
            return (VerifyResponse(is_valid=False, invalid_reason=reason, payer=payer), None)

        if has_jetton_only_extra(requirements.extra) or has_jetton_only_extra(
            payload.accepted.extra
        ):
            return invalid_response(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER)

        expected_body = native_transfer_body(requirements.extra)
        if native_transfer_body(payload.accepted.extra).hash != expected_body.hash:
            return invalid_response(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER)

        transfer = settlement.transfer
        if not isinstance(transfer, ParsedNativeTransfer):
            return invalid_response(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER)
        if transfer.destination != normalize_address(requirements.pay_to):
            return invalid_response(ERR_EXACT_TVM_INVALID_RECIPIENT)
        if transfer.amount != int(requirements.amount):
            return invalid_response(ERR_EXACT_TVM_INVALID_AMOUNT)
        if transfer.has_extra_currencies or transfer.has_state_init:
            return invalid_response(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER)
        if transfer.body.hash != expected_body.hash:
            return invalid_response(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER)

        account_or_error = self._verify_payer_wallet(requirements, settlement)
        if isinstance(account_or_error, str):
            return invalid_response(account_or_error)
        account = account_or_error

        # Cheap pre-check before emulation; the exact rule (amount plus forward fee) follows.
        if account.balance < transfer.amount:
            return invalid_response(ERR_EXACT_TVM_INSUFFICIENT_BALANCE)

        try:
            provisional_relay_request = TvmRelayRequest(
                destination=settlement.payer,
                body=settlement.body,
                state_init=settlement.state_init,
            )
            external_boc = self._signer.build_relay_external_boc(
                requirements.network,
                provisional_relay_request,
                for_emulation=True,
            )
            emulation = self._signer.emulate_external_message(requirements.network, external_boc)
            payer_transaction = self._verify_finalized_trace_settlement(
                emulation,
                settlement=settlement,
                return_transaction=True,
            )
        except Exception as e:
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=ERR_EXACT_TVM_SIMULATION_FAILED,
                    invalid_message=str(e),
                    payer=payer,
                ),
                None,
            )

        # The relay message credits the payer wallet before its actions run. The payment
        # value and its forward fee must come from the payer's own pre-relay balance, or the
        # facilitator would be paying the merchant out of its gas budget.
        forward_fee = trace_transaction_fwd_fees(payer_transaction)
        if account.balance < transfer.amount + forward_fee:
            return invalid_response(ERR_EXACT_TVM_INSUFFICIENT_BALANCE)

        # The relay attaches only what the payer wallet needs to execute, never the value.
        required_outer = (
            trace_transaction_storage_fees(payer_transaction)
            + trace_transaction_compute_fees(payer_transaction)
            + DEFAULT_TVM_OUTER_GAS_BUFFER
        )
        relay_request = TvmRelayRequest(
            destination=settlement.payer,
            body=settlement.body,
            state_init=settlement.state_init,
            relay_amount=required_outer,
        )
        return (VerifyResponse(is_valid=True, payer=payer), relay_request)

    def _verify_payer_wallet(
        self,
        requirements: PaymentRequirements,
        settlement: ParsedTvmSettlement,
    ) -> TvmAccountState | str:
        """Check expiry, W5 wallet state and signature shared by all assets.

        Returns the payer account state, or an error reason.
        """
        payer = settlement.payer
        now = int(time.time())
        if settlement.valid_until <= now:
            return ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED
        if settlement.valid_until > now + requirements.max_timeout_seconds:
            return ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR

        account = self._signer.get_account_state(payer, str(requirements.network))
        init_data_parsed: W5InitData

        if account.is_frozen:
            return ERR_EXACT_TVM_ACCOUNT_FROZEN

        if settlement.state_init is not None and account.is_uninitialized:
            if (
                settlement.state_init.code is None
                or settlement.state_init.code.hash.hex() not in ALLOWED_CLIENT_CODES
            ):
                return ERR_EXACT_TVM_INVALID_CODE_HASH
            payer_workchain = int(payer.split(":", 1)[0])
            if address_from_state_init(settlement.state_init, payer_workchain) != payer:
                return ERR_EXACT_TVM_INVALID_W5_MESSAGE
            init_data_parsed = parse_w5_init_data(settlement.state_init)
            if init_data_parsed.seqno != 0:
                return ERR_EXACT_TVM_INVALID_SEQNO
            if init_data_parsed.extensions_dict:
                return ERR_EXACT_TVM_INVALID_EXTENSIONS_DICT
        else:
            try:
                init_data_parsed = parse_active_w5_account_state(account)
            except RuntimeError:
                return ERR_EXACT_TVM_INVALID_CODE_HASH

        if not init_data_parsed.signature_allowed:
            return ERR_EXACT_TVM_INVALID_SIGNATURE_MODE
        if init_data_parsed.seqno != settlement.seqno:
            return ERR_EXACT_TVM_INVALID_SEQNO
        if init_data_parsed.wallet_id != settlement.wallet_id:
            return ERR_EXACT_TVM_INVALID_WALLET_ID

        if not verify_w5_signature(
            init_data_parsed.public_key,
            settlement.signed_slice_hash,
            settlement.signature,
        ):
            return ERR_EXACT_TVM_INVALID_SIGNATURE

        return account

    @staticmethod
    def _verify_finalized_trace_settlement(
        trace_data: dict[str, object],
        *,
        settlement: ParsedTvmSettlement,
        return_transaction: bool = False,
    ) -> str | dict[str, object]:
        transactions = parse_trace_transactions(trace_data)
        if settlement.is_native:
            payer_transaction = _find_native_payment_transaction(transactions, settlement)
            return _payer_transaction_result(payer_transaction, return_transaction)

        expected_source_wallet = normalize_address(settlement.transfer.source_wallet)

        payer_transaction = None
        for transaction in transactions:
            if normalize_address(transaction["account"]) != settlement.payer:
                continue
            if not transaction_succeeded(transaction):
                continue
            in_msg: dict = transaction.get("in_msg")
            if not message_body_hash_matches(in_msg, settlement.body.hash):
                continue
            payer_transaction = transaction
            break
        if payer_transaction is None:
            raise ValueError("Trace does not contain the expected payer wallet transaction")

        out_msgs: list[dict] = payer_transaction.get("out_msgs")
        payer_out_hash = None
        for out_msg in out_msgs:
            if normalize_address(out_msg["destination"]) != expected_source_wallet:
                continue
            if not message_body_hash_matches(out_msg, settlement.transfer.body_hash):
                continue
            payer_out_hash = out_msg["hash"]
            break
        if payer_out_hash is None:
            raise ValueError("Trace payer wallet transaction is missing out message hash")

        # According to TEP-74, it is sufficient to check the success of the transaction on the payer's jetton wallet
        source_wallet_transaction = None
        for transaction in transactions:
            if normalize_address(transaction["account"]) != expected_source_wallet:
                continue
            if not transaction_succeeded(transaction):
                continue
            in_msg: dict = transaction.get("in_msg")
            if not in_msg:
                continue
            if in_msg.get("hash") == payer_out_hash:
                source_wallet_transaction = transaction
                break
        if source_wallet_transaction is None:
            raise ValueError("Trace does not contain the expected source jetton wallet transaction")

        return _payer_transaction_result(payer_transaction, return_transaction)


def _payer_transaction_result(
    payer_transaction: dict[str, object], return_transaction: bool
) -> str | dict[str, object]:
    transaction_hash = payer_transaction.get("hash_norm") or payer_transaction.get("hash")
    if not transaction_hash:
        raise ValueError("Trace payer wallet transaction is missing transaction hash")
    return (
        payer_transaction if return_transaction else trace_transaction_hash_to_hex(transaction_hash)
    )


def _find_native_payment_transaction(
    transactions: list[dict[str, object]],
    settlement: ParsedTvmSettlement,
) -> dict[str, object]:
    """Find the payer transaction that delivered ``amount`` TON to ``payTo``.

    Fails when the payer skipped the action (mode 3), when no message with the exact
    value and body reached the merchant, or when the merchant bounced it.
    """
    transfer = settlement.transfer
    assert isinstance(transfer, ParsedNativeTransfer)

    payer_transaction = None
    for transaction in transactions:
        if normalize_address(transaction["account"]) != settlement.payer:
            continue
        if not transaction_succeeded(transaction):
            continue
        in_msg: dict = transaction.get("in_msg")
        if not message_body_hash_matches(in_msg, settlement.body.hash):
            continue
        payer_transaction = transaction
        break
    if payer_transaction is None:
        raise ValueError("Trace does not contain the expected payer wallet transaction")

    payment_hash = None
    for out_msg in payer_transaction.get("out_msgs") or []:
        if normalize_address(out_msg["destination"]) != transfer.destination:
            continue
        if _parse_message_value(out_msg) != transfer.amount:
            continue
        if not message_body_hash_matches(out_msg, transfer.body.hash):
            continue
        payment_hash = out_msg["hash"]
        break
    if payment_hash is None:
        raise ValueError("Trace payer wallet transaction did not send the payment to payTo")

    for transaction in transactions:
        if normalize_address(transaction["account"]) != transfer.destination:
            continue
        in_msg = transaction.get("in_msg") or {}
        if in_msg.get("hash") != payment_hash:
            continue
        description = transaction.get("description", transaction)
        if description.get("bounce") is not None:
            raise ValueError("Trace shows the payment bounced from payTo")
        return payer_transaction
    raise ValueError("Trace does not contain the payTo transaction receiving the payment")


def _parse_message_value(message: dict[str, object]) -> int | None:
    value = message.get("value")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None
