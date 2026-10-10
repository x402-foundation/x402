"""Resource-server accounting and lifecycle hooks for SVM batch settlement."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from threading import RLock
from typing import Any
from uuid import uuid4

from ....interfaces import SchemePaymentRequiredContext
from ....schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedKind,
    VerifyResponse,
)
from ....schemas.helpers import convert_to_token_amount, parse_money
from ....schemas.hooks import (
    AbortResult,
    SettleContext,
    SettleFailureContext,
    SettleResultContext,
    SkipHandlerDirective,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)
from ..constants import TOKEN_PROGRAM_ADDRESS
from ..default_assets import find_default_asset
from ..exact.server import ExactSvmScheme
from ..payment_channels import sign_voucher
from .constants import BATCH_SETTLEMENT_SCHEME, MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY
from .errors import BatchError
from .storage import (
    BatchOperationStore,
    ChannelStore,
    MemoryBatchOperationStore,
    MemoryChannelStore,
)
from .types import BatchOperation, ChannelReservation, ChannelState
from .validation import address, atomic, integer, validate_client_payload


def _signer_address(signer: Any) -> str:
    return str(signer.pubkey()) if hasattr(signer, "pubkey") else str(signer.address)


@dataclass
class BatchSvmServerConfig:
    withdraw_delay: int | None = None
    receiver_authorizer: Any = None
    operator: Any = None
    store: ChannelStore | None = None
    operation_store: BatchOperationStore | None = None
    onchain_state_ttl_ms: int | None = None
    enforce_min_deposit: bool = False
    on_channel_closing: Callable[[str], None] | None = None


@dataclass
class _Request:
    payload: PaymentPayload
    channel_id: str
    ceiling: int
    refresh: bool = False
    top_up: bool = False
    request_id: str | None = None
    pending_id: str | None = None


class BatchSvmScheme(ExactSvmScheme):
    """Reserve capacity before serving; commit actual charges after the handler.

    Use persistent stores in production and a channel manager to redeem vouchers.
    The inherited price parser is shared with the exact Solana mechanism.
    """

    scheme = BATCH_SETTLEMENT_SCHEME
    default_asset_transfer_method = "default"
    payment_flows = {"default": {"default": "authorization", "supported": ("authorization",)}}
    dynamic_extra_fields = ("recentBlockhash", "recentSlot")

    def __init__(self, config: BatchSvmServerConfig | None = None):
        super().__init__()
        self.config = config or BatchSvmServerConfig()
        self.store = self.config.store or MemoryChannelStore()
        self.operation_store = self.config.operation_store or MemoryBatchOperationStore()
        self._requests: dict[int, _Request] = {}
        self._extras: dict[int, tuple[PaymentPayload, dict[str, Any]]] = {}
        self._bookkeeping_failures: set[str] = set()
        self._lock = RLock()

    def get_channel_store(self) -> ChannelStore:
        return self.store

    def is_server_signed(self, requirements: PaymentRequirements) -> bool:
        mode = (requirements.extra or {}).get("voucherSigner")
        if mode not in (None, "client", "server"):
            raise ValueError("voucherSigner must be client or server")
        if mode == "server" and self.config.operator is None:
            raise ValueError("Server voucher mode requires an operator signer")
        return self.config.operator is not None and mode != "client"

    def validate_facilitator_support(
        self, network: str, supported_kind: SupportedKind, facilitator_extensions: list[str]
    ) -> str | None:
        extra = supported_kind.extra or {}
        try:
            address(extra.get("feePayer"))
        except (ValueError, TypeError):
            return f"Facilitator must advertise a valid feePayer for {network}"
        if self.config.receiver_authorizer is None:
            try:
                address(extra.get("receiverAuthorizer"))
            except (ValueError, TypeError):
                return f"Configure receiver_authorizer or use a facilitator advertising one for {network}"
        return None

    def resolve_min_deposit_hint(self, requirements: PaymentRequirements) -> str:
        amount = atomic(requirements.amount)
        override = (requirements.extra or {}).get("minDeposit")
        if override is None:
            minimum = amount * (3 if self.is_server_signed(requirements) else 10)
        elif not isinstance(override, str):
            raise ValueError("minDeposit must be an atomic amount string or a money string")
        elif override.isascii() and override.isdecimal():
            minimum = atomic(override, "minDeposit")
        else:
            asset = find_default_asset(requirements.asset, requirements.network)
            if not asset:
                raise ValueError("Use atomic minDeposit for non-default assets")
            parsed = parse_money(override)
            if parsed.get("symbol") not in (None, asset["symbol"]):
                raise ValueError("minDeposit currency must match the asset")
            minimum = atomic(convert_to_token_amount(parsed["amount"], asset["decimals"]))
        return str(max(amount, minimum))

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extension_keys: list[str],
    ) -> PaymentRequirements:
        problem = self.validate_facilitator_support(
            requirements.network, supported_kind, extension_keys
        )
        if problem:
            raise ValueError(problem)
        delay = self.config.withdraw_delay
        if delay is None:
            delay = max(MIN_WITHDRAW_DELAY, requirements.max_timeout_seconds)
        if (
            type(delay) is not int
            or not MIN_WITHDRAW_DELAY <= delay <= MAX_WITHDRAW_DELAY
            or delay < requirements.max_timeout_seconds
        ):
            raise BatchError(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE)
        server_signed = self.is_server_signed(requirements)
        extra = {**(requirements.extra or {}), **(supported_kind.extra or {})}
        extra.pop("operator", None)
        extra.pop("assetTransferMethod", None)
        # Default assets are SPL. Custom Token-2022 routes must supply their program;
        # both client and facilitator independently check the mint's actual owner.
        extra.update(
            tokenProgram=(requirements.extra or {}).get(
                "tokenProgram",
                (find_default_asset(requirements.asset, requirements.network) or {}).get(
                    "token_program", TOKEN_PROGRAM_ADDRESS
                ),
            ),
            withdrawDelay=delay,
            minDeposit=self.resolve_min_deposit_hint(requirements),
            receiverAuthorizer=(
                _signer_address(self.config.receiver_authorizer)
                if self.config.receiver_authorizer
                else extra.get("receiverAuthorizer")
            ),
        )
        if server_signed:
            extra.update(voucherSigner="server", operator=_signer_address(self.config.operator))
        else:
            extra.pop("voucherSigner", None)
        return requirements.model_copy(update={"extra": extra})

    def _validate(self, payload: PaymentPayload, requirements: PaymentRequirements) -> str:
        raw = payload.payload
        channel_id = validate_client_payload(raw, requirements)
        cfg = raw["channelConfig"]
        if self.config.receiver_authorizer and cfg["receiverAuthorizer"] != _signer_address(
            self.config.receiver_authorizer
        ):
            raise BatchError(BatchError.RECEIVER_AUTHORIZER_MISMATCH)
        if cfg.get("voucherSigner") == "server" and (
            not self.config.operator
            or cfg["payerAuthorizer"] != _signer_address(self.config.operator)
        ):
            raise BatchError(BatchError.CHANNEL_STATE)
        if raw["type"] == "deposit" and self.config.enforce_min_deposit:
            if atomic(raw["deposit"]["amount"]) < atomic(
                self.resolve_min_deposit_hint(requirements)
            ):
                raise BatchError(BatchError.DEPOSIT_BELOW_MIN_DEPOSIT)
        return channel_id

    @staticmethod
    def _abort(error: Exception) -> AbortResult:
        return AbortResult(
            reason=error.reason if isinstance(error, BatchError) else BatchError.CHANNEL_STATE,
            message=str(error),
        )

    @staticmethod
    def _assert_state(
        state: ChannelState, raw: dict[str, Any], requirements: PaymentRequirements
    ) -> None:
        extra = requirements.extra or {}
        if (
            state.channel_config != raw["channelConfig"]
            or state.network != requirements.network
            or state.fee_payer != extra.get("feePayer")
            or state.token_program != extra.get("tokenProgram")
        ):
            raise BatchError(BatchError.CHANNEL_STATE)
        if state.status != "open":
            raise BatchError(BatchError.CHANNEL_CLOSING)

    def _fresh(self, state: ChannelState) -> bool:
        ttl_ms = self.config.onchain_state_ttl_ms
        if ttl_ms is None:
            ttl_ms = min(300_000, max(30_000, state.channel_config["withdrawDelay"] * 1000 // 3))
        return state.onchain_synced_at > 0 and time.time() - state.onchain_synced_at < ttl_ms / 1000

    def before_verify(self, ctx: VerifyContext) -> AbortResult | SkipVerifyResult | None:
        try:
            raw = ctx.payment_payload.payload
            channel_id = self._validate(ctx.payment_payload, ctx.requirements)
            if channel_id in self._bookkeeping_failures:
                raise BatchError(
                    BatchError.CHANNEL_STATE, "Confirmed settlement requires accounting recovery"
                )
            state = self.store.get(channel_id)
            if raw["type"] == "deposit" and state is None:
                from ..payment_channels.verification import verify_open_transaction

                extra = ctx.requirements.extra or {}
                verify_open_transaction(
                    raw["deposit"]["transaction"],
                    channel_config=raw["channelConfig"],
                    fee_payer=extra["feePayer"],
                    token_program=extra["tokenProgram"],
                    deposit=atomic(raw["deposit"]["amount"]),
                    memo=extra.get("memo"),
                )
            if state:
                self._assert_state(state, raw, ctx.requirements)
            request = _Request(
                payload=ctx.payment_payload,
                channel_id=channel_id,
                ceiling=0 if raw["type"] == "refund" else atomic(ctx.requirements.amount),
                refresh=raw["type"] in ("voucher", "authorization")
                and (state is None or not self._fresh(state)),
                top_up=raw["type"] == "deposit"
                and state is not None
                and (state.onchain_synced_at > 0 or bool(state.open_signature)),
                request_id=(raw.get("authorization") or {}).get("requestId"),
            )
            if raw["type"] == "refund" and state is None:
                raise BatchError(BatchError.CHANNEL_STATE)
            if not request.refresh and "voucher" in raw:
                current = state.charged_cumulative_amount if state else 0
                amount = atomic(raw["voucher"]["maxClaimableAmount"])
                expected = current + request.ceiling
                if (
                    raw["type"] != "refund"
                    and state
                    and amount == current
                    and raw["voucher"] == state.highest_voucher
                ):
                    raise BatchError(BatchError.CHANNEL_BUSY)
                if amount != expected:
                    raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
            with self._lock:
                self._requests[id(ctx.payment_payload)] = request
            if raw["type"] in ("voucher", "authorization") and not request.refresh:
                return SkipVerifyResult(
                    VerifyResponse(
                        is_valid=True,
                        payer=raw["channelConfig"]["payer"],
                        extra={"channelId": channel_id},
                    )
                )
        except Exception as error:
            return self._abort(error)
        return None

    @staticmethod
    def _snapshot(extra: dict[str, Any] | None, channel_id: str) -> dict[str, int] | None:
        if not extra or "totalClaimed" not in extra:
            return None
        if extra.get("channelId", channel_id) != channel_id:
            raise BatchError(BatchError.CHANNEL_ID_MISMATCH)
        balance = atomic(extra.get("balance"), "balance")
        settled = atomic(extra.get("totalClaimed"), "totalClaimed")
        closing = integer(extra.get("withdrawRequestedAt", 0), "withdrawRequestedAt")
        if settled > balance:
            raise BatchError(BatchError.CHANNEL_STATE)
        return {"balance": balance, "settled": settled, "closing": closing}

    @staticmethod
    def _new_state(
        request: _Request, requirements: PaymentRequirements, deposit: int = 0
    ) -> ChannelState:
        extra = requirements.extra or {}
        return ChannelState(
            channel_id=request.channel_id,
            network=requirements.network,
            channel_config=deepcopy(request.payload.payload["channelConfig"]),
            fee_payer=extra["feePayer"],
            token_program=extra["tokenProgram"],
            deposit=deposit,
        )

    def after_verify(self, ctx: VerifyResultContext) -> AbortResult | SkipHandlerResult | None:
        if not ctx.result.is_valid:
            return None
        request = self._requests.get(id(ctx.payment_payload))
        try:
            if request is None:
                raise BatchError(BatchError.CHANNEL_STATE, "Missing request context")
            raw = ctx.payment_payload.payload
            snapshot = self._snapshot(ctx.result.extra, request.channel_id)
            if request.refresh and snapshot is None:
                raise BatchError(
                    BatchError.CHANNEL_STATE, "Facilitator omitted verified channel state"
                )
            if snapshot:
                # Persist confirmed state even when the following reservation is rejected;
                # corrective 402 responses must carry the refreshed baseline.
                def persist(current: ChannelState | None) -> ChannelState:
                    current = current or self._new_state(request, ctx.requirements)
                    self._assert_state(current, raw, ctx.requirements)
                    current.deposit = (
                        max(current.deposit, snapshot["balance"])
                        if current.onchain_synced_at
                        else snapshot["balance"]
                    )
                    current.settled = max(current.settled, snapshot["settled"])
                    current.charged_cumulative_amount = max(
                        current.charged_cumulative_amount, snapshot["settled"]
                    )
                    current.signed_max_claimable = max(
                        current.signed_max_claimable, snapshot["settled"]
                    )
                    current.onchain_synced_at = time.time()
                    if snapshot["closing"]:
                        current.status = "closing"
                        current.close_requested_at = snapshot["closing"]
                    return current

                self.store.update(request.channel_id, persist)
                request.top_up = raw["type"] == "deposit"
                if snapshot["closing"]:
                    raise BatchError(BatchError.CHANNEL_CLOSING)
            if request.request_id and not self.operation_store.reserve(
                request.channel_id, request.request_id, request.ceiling
            ):
                raise BatchError(BatchError.CHANNEL_BUSY)
            pending_id = uuid4().hex

            def reserve(current: ChannelState | None) -> ChannelState:
                if current is None:
                    if snapshot:
                        current = self._new_state(request, ctx.requirements, snapshot["balance"])
                    elif raw["type"] == "deposit":
                        current = self._new_state(
                            request, ctx.requirements, atomic(raw["deposit"]["amount"])
                        )
                    else:
                        raise BatchError(BatchError.CHANNEL_STATE)
                self._assert_state(current, raw, ctx.requirements)
                if raw["type"] == "deposit" and not request.top_up:
                    current.deposit = atomic(raw["deposit"]["amount"])
                now = time.time()
                current.reservations = {
                    k: v
                    for k, v in current.reservations.items()
                    if v.kind in ("deposit", "close") or v.expires_at > now
                }
                # Deposit/close operations are exclusive; only offchain server requests run concurrently.
                kind = (
                    "close"
                    if raw["type"] == "refund"
                    else "deposit"
                    if raw["type"] == "deposit"
                    else "server"
                    if raw["type"] == "authorization"
                    else "client"
                )
                active = list(current.reservations.values())
                if active and (kind != "server" or any(r.kind != "server" for r in active)):
                    raise BatchError(BatchError.CHANNEL_BUSY)
                if (
                    "voucher" in raw
                    and atomic(raw["voucher"]["maxClaimableAmount"])
                    != current.charged_cumulative_amount + request.ceiling
                ):
                    raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
                available = current.deposit + (
                    atomic(raw["deposit"]["amount"]) if request.top_up else 0
                )
                if (
                    current.charged_cumulative_amount
                    + sum(r.ceiling for r in active)
                    + request.ceiling
                    > available
                ):
                    raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
                current.reservations[pending_id] = ChannelReservation(
                    ceiling=request.ceiling,
                    expires_at=now + max(5, ctx.requirements.max_timeout_seconds),
                    kind=kind,
                    request_id=request.request_id,
                )
                return current

            self.store.update(request.channel_id, reserve)
            request.pending_id = pending_id
            if raw["type"] == "refund":
                return SkipHandlerResult(
                    SkipHandlerDirective(
                        body={"channelId": request.channel_id, "message": "Refund initiated"}
                    )
                )
        except Exception as error:
            # Storage errors must abort before the handler, including snapshot writes.
            with self._lock:
                self._requests.pop(id(ctx.payment_payload), None)
            return self._abort(error)
        return None

    def _commit(
        self, request: _Request, actual: int, result: SettleResponse | None = None
    ) -> ChannelState:
        raw = request.payload.payload
        if actual > request.ceiling or ("voucher" in raw and actual != request.ceiling):
            raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)

        def commit(current: ChannelState | None) -> ChannelState:
            if current is None or request.pending_id not in current.reservations:
                raise BatchError(BatchError.CHANNEL_BUSY)
            reservation = current.reservations[request.pending_id]
            if actual > reservation.ceiling or (
                result is None and reservation.expires_at <= time.time()
            ):
                raise BatchError(BatchError.CHANNEL_BUSY)
            cumulative = current.charged_cumulative_amount + actual
            if "voucher" in raw:
                voucher = deepcopy(raw["voucher"])
                if atomic(voucher["maxClaimableAmount"]) != cumulative:
                    raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
            else:
                voucher = {
                    "channelId": request.channel_id,
                    "maxClaimableAmount": str(cumulative),
                    "expiresAt": 0,
                    "signature": sign_voucher(
                        self.config.operator, request.channel_id, cumulative, 0
                    ),
                }
            if result is not None:
                snapshot = self._settled_snapshot(result, request.channel_id)
                if snapshot is None:
                    # The successful settlement confirms this exact deposit. A
                    # missing optional snapshot must not undo its accepted charge.
                    deposit = atomic(raw["deposit"]["amount"])
                    current.deposit = (
                        current.deposit + deposit
                        if request.top_up
                        else max(current.deposit, deposit)
                    )
                    current.onchain_synced_at = 0
                else:
                    current.deposit = max(current.deposit, snapshot["balance"])
                    current.settled = max(current.settled, snapshot["settled"])
                    current.onchain_synced_at = time.time()
                    if snapshot["closing"]:
                        current.status = "closing"
                        current.close_requested_at = snapshot["closing"]
                current.open_signature = result.transaction
            if cumulative > current.deposit:
                raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
            if request.request_id:
                self.operation_store.complete(
                    BatchOperation(
                        channel_id=request.channel_id,
                        request_id=request.request_id,
                        ceiling=request.ceiling,
                        status="completed",
                        actual=actual,
                        cumulative=cumulative,
                    )
                )
            current.charged_cumulative_amount = cumulative
            current.signed_max_claimable = cumulative
            current.highest_voucher = voucher
            del current.reservations[request.pending_id]
            return current

        return self.store.update(request.channel_id, commit)

    def _settled_snapshot(self, result: SettleResponse, channel_id: str) -> dict[str, int] | None:
        try:
            return self._snapshot((result.extra or {}).get("channelState"), channel_id)
        except (ValueError, TypeError, AttributeError):
            logging.getLogger(__name__).warning(
                "Ignoring invalid optional settlement snapshot for channel %s", channel_id
            )
            return None

    @staticmethod
    def _settlement_extra(state: ChannelState, amount: str) -> dict[str, Any]:
        result = {
            "channelState": state.snapshot(),
            "chargedAmount": amount,
            "commitmentId": f"{state.channel_id}:{state.signed_max_claimable}",
        }
        if state.channel_config.get("voucherSigner") == "server":
            result["voucher"] = deepcopy(state.highest_voucher)
        return result

    def before_settle(self, ctx: SettleContext) -> AbortResult | SkipSettleResult | None:
        try:
            request = self._requests.get(id(ctx.payment_payload))
            if request is None or request.pending_id is None:
                raise BatchError(BatchError.CHANNEL_BUSY)
            raw = ctx.payment_payload.payload
            actual = atomic(ctx.requirements.amount)
            if raw["type"] == "refund":
                return None
            if actual > request.ceiling or ("voucher" in raw and actual != request.ceiling):
                raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
            state = self.store.get(request.channel_id)
            if state is None or request.pending_id not in state.reservations:
                raise BatchError(BatchError.CHANNEL_BUSY)
            if raw["type"] == "deposit":
                return None
            committed = self._commit(request, actual)
            with self._lock:
                self._requests.pop(id(ctx.payment_payload), None)
            return SkipSettleResult(
                SettleResponse(
                    success=True,
                    transaction="",
                    amount="",
                    network=ctx.requirements.network,
                    payer=raw["channelConfig"]["payer"],
                    extra=self._settlement_extra(committed, str(actual)),
                )
            )
        except Exception as error:
            return self._abort(error)

    def after_settle(self, ctx: SettleResultContext) -> None:
        request = self._requests.get(id(ctx.payment_payload))
        if not ctx.result.success or request is None:
            return
        try:
            raw = ctx.payment_payload.payload
            if raw["type"] == "deposit":
                state = self._commit(request, atomic(ctx.requirements.amount), ctx.result)
                with self._lock:
                    self._extras[id(ctx.payment_payload)] = (
                        ctx.payment_payload,
                        self._settlement_extra(state, ctx.requirements.amount),
                    )
            elif raw["type"] == "refund":
                snapshot = self._settled_snapshot(ctx.result, request.channel_id)

                def close(current: ChannelState | None) -> ChannelState:
                    if current is None:
                        raise BatchError(BatchError.CHANNEL_STATE)
                    current.reservations.pop(request.pending_id, None)
                    current.close_signature = ctx.result.transaction
                    if current.highest_voucher is None:
                        current.highest_voucher = deepcopy(raw.get("voucher"))
                        if (
                            current.highest_voucher is None
                            and self.config.operator
                            and current.channel_config.get("voucherSigner") == "server"
                            and current.signed_max_claimable == 0
                        ):
                            current.highest_voucher = {
                                "channelId": request.channel_id,
                                "maxClaimableAmount": "0",
                                "expiresAt": 0,
                                "signature": sign_voucher(
                                    self.config.operator, request.channel_id, 0, 0
                                ),
                            }
                    # Minimal receipts confirm the close but not its watermark.
                    # Stop accepting payments and let the manager reconcile it.
                    current.status = "closing"
                    current.onchain_synced_at = 0
                    if snapshot is not None:
                        current.close_requested_at = snapshot["closing"]
                        current.onchain_synced_at = time.time()
                        current.settled = max(current.settled, snapshot["settled"])
                        current.status = "closing" if snapshot["closing"] else "distributed"
                        if current.status == "distributed":
                            current.payout_watermark = current.settled
                    return current

                self.store.update(request.channel_id, close)
        except Exception:
            # A confirmed transfer cannot be reversed by a bookkeeping failure.
            # Preserve its success response, but block further charges until an
            # operator restores the durable accounting state.
            with self._lock:
                self._bookkeeping_failures.add(request.channel_id)
            logging.getLogger(__name__).exception(
                "Accounting recovery required for confirmed transaction %s on channel %s",
                ctx.result.transaction,
                request.channel_id,
            )
        finally:
            with self._lock:
                self._requests.pop(id(ctx.payment_payload), None)

    def enrich_settlement_response(self, ctx: SettleResultContext) -> dict[str, Any] | None:
        with self._lock:
            item = self._extras.pop(id(ctx.payment_payload), None)
        if not item:
            return None

        def additions(new: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in new.items():
                if key not in existing:
                    result[key] = value
                elif isinstance(value, dict) and isinstance(existing[key], dict):
                    nested = additions(value, existing[key])
                    if nested:
                        result[key] = nested
            return result

        return additions(item[1], ctx.result.extra or {})

    def enrich_settlement_payload(self, ctx: SettleContext) -> dict[str, Any] | None:
        raw = ctx.payment_payload.payload
        if raw.get("type") != "refund":
            return None
        request = self._requests.get(id(ctx.payment_payload))
        if request is None or request.pending_id is None:
            raise BatchError(BatchError.CHANNEL_BUSY)
        state = self.store.get(request.channel_id)
        if state is None or request.pending_id not in state.reservations:
            raise BatchError(BatchError.CHANNEL_BUSY)
        cumulative = state.charged_cumulative_amount
        voucher = raw.get("voucher")
        if voucher is None:
            voucher = state.highest_voucher
            if voucher is None and cumulative == 0:
                voucher = {
                    "channelId": request.channel_id,
                    "maxClaimableAmount": "0",
                    "expiresAt": 0,
                    "signature": sign_voucher(self.config.operator, request.channel_id, 0, 0),
                }
        if voucher is None or atomic(voucher["maxClaimableAmount"]) != cumulative:
            raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
        fields = {"voucher": deepcopy(voucher)} if "voucher" not in raw else {}
        if self.config.receiver_authorizer:
            from .close_authorization import sign_close_authorization

            fields["closeAuthorization"] = sign_close_authorization(
                self.config.receiver_authorizer,
                network=ctx.requirements.network,
                fee_payer=state.fee_payer,
                channel_id=state.channel_id,
                max_claimable_amount=cumulative,
                voucher_expires_at=0,
                valid_before=int(time.time()) + ctx.requirements.max_timeout_seconds,
            )
        return fields

    def enrich_payment_required_response(
        self, ctx: SchemePaymentRequiredContext
    ) -> list[PaymentRequirements] | None:
        if ctx.error != BatchError.CUMULATIVE_AMOUNT_MISMATCH or ctx.payment_payload is None:
            return None
        try:
            channel_id = self._validate(ctx.payment_payload, ctx.payment_payload.accepted)
            state = self.store.get(channel_id)
            if state is None:
                return None
            result = []
            for requirement in ctx.requirements:
                if requirement.scheme == self.scheme and requirement.network == state.network:
                    extra = {**(requirement.extra or {}), "channelState": state.snapshot()}
                    extra.pop("voucherState", None)
                    if (
                        state.highest_voucher
                        and int(state.highest_voucher["maxClaimableAmount"])
                        >= state.charged_cumulative_amount
                    ):
                        extra["voucherState"] = {
                            "signedMaxClaimable": state.highest_voucher["maxClaimableAmount"],
                            "expiresAt": state.highest_voucher["expiresAt"],
                            "signature": state.highest_voucher["signature"],
                        }
                    requirement = requirement.model_copy(update={"extra": extra})
                result.append(requirement)
            return result
        except Exception:
            return None

    def _clear(self, payload: PaymentPayload) -> None:
        with self._lock:
            request = self._requests.pop(id(payload), None)
        if request is None or request.pending_id is None:
            return

        def clear(current: ChannelState | None) -> ChannelState:
            if current is None:
                raise BatchError(BatchError.CHANNEL_STATE)
            current.reservations.pop(request.pending_id, None)
            return current

        self.store.update(request.channel_id, clear)
        if request.request_id:
            self.operation_store.release(request.channel_id, request.request_id)

    def on_verified_payment_canceled(self, ctx: VerifiedPaymentCanceledContext) -> None:
        self._clear(ctx.payment_payload)

    def on_settle_failure(self, ctx: SettleFailureContext) -> None:
        self._clear(ctx.payment_payload)

    def on_verify_failure(self, ctx: VerifyFailureContext) -> None:
        request = self._requests.get(id(ctx.payment_payload))
        if request and BatchError.CHANNEL_CLOSING in str(ctx.error):

            def mark(current: ChannelState | None) -> ChannelState:
                if current is None:
                    raise BatchError(BatchError.CHANNEL_STATE)
                current.status = "closing"
                return current

            if self.store.get(request.channel_id):
                self.store.update(request.channel_id, mark)
                if self.config.on_channel_closing:
                    self.config.on_channel_closing(request.channel_id)
        self._clear(ctx.payment_payload)

    def create_channel_manager(
        self, facilitator: Any, requirements: PaymentRequirements, **options: Any
    ) -> Any:
        from .channel_manager import BatchChannelManager

        return BatchChannelManager(
            self.store,
            facilitator,
            requirements,
            receiver_authorizer=self.config.receiver_authorizer,
            **options,
        )
