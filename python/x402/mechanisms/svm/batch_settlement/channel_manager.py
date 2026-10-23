"""Out-of-band voucher redemption and confirmed payout reconciliation."""

from __future__ import annotations

import inspect
import logging
import time
from collections.abc import Callable
from threading import Event, Lock, Thread
from typing import Any

from solana.rpc.api import Client
from solders.pubkey import Pubkey

from ....schemas import PaymentPayload, PaymentRequirements, SettleResponse
from ..payment_channels import PAYMENT_CHANNELS_PROGRAM_ID, decode_channel_account
from ..utils import get_network_config
from .errors import BatchError
from .storage import ChannelStore
from .types import ChannelState


class BatchChannelManager:
    """Drive ``redeem()`` from a worker, or schedule passes with ``start()``.

    The facilitator must be synchronous (e.g. HTTPFacilitatorClientSync).
    Never infer a channel's payout watermark from a transaction-wide amount.
    """

    def __init__(
        self,
        store: ChannelStore,
        facilitator: Any,
        requirements: PaymentRequirements,
        *,
        receiver_authorizer: Any = None,
        rpc_url: str | None = None,
        max_channels_per_batch: int = 4,
        read_settled_watermark: Callable[[str], int | None] | None = None,
        read_payout_watermark: Callable[[str], int | None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ):
        if inspect.iscoroutinefunction(getattr(facilitator, "settle", None)):
            raise TypeError("BatchChannelManager requires a synchronous facilitator client")
        if type(max_channels_per_batch) is not int or not 1 <= max_channels_per_batch <= 4:
            raise ValueError("max_channels_per_batch must be between 1 and 4")
        if not (requirements.extra or {}).get("feePayer"):
            raise ValueError("Use enhanced requirements containing feePayer")
        self.store = store
        self.facilitator = facilitator
        self.requirements = requirements
        self.receiver_authorizer = receiver_authorizer
        self.batch_size = max_channels_per_batch
        self._rpc_url = rpc_url
        self._rpc: Client | None = None
        self._read_settled = read_settled_watermark
        self._read_payout = read_payout_watermark
        self._on_error = on_error
        self._lock = Lock()
        self._stop = Event()
        self._thread: Thread | None = None

    def _error(self, error: Exception) -> None:
        if self._on_error:
            self._on_error(error)
        else:
            logging.getLogger(__name__).error("Batch redemption failed: %s", error)

    def _read(self, channel_id: str, field: str) -> int | None:
        reader = self._read_settled if field == "settled" else self._read_payout
        if reader:
            return reader(channel_id)
        if self._rpc is None:
            self._rpc = Client(
                self._rpc_url or get_network_config(self.requirements.network)["rpc_url"]
            )
        account = self._rpc.get_account_info(
            Pubkey.from_string(channel_id), commitment="confirmed"
        ).value
        if account is None:
            return None
        if str(account.owner) != str(PAYMENT_CHANNELS_PROGRAM_ID) or account.executable:
            raise ValueError("Unexpected channel account owner")
        return getattr(decode_channel_account(bytes(account.data)), field)

    def _eligible(self) -> list[ChannelState]:
        extra = self.requirements.extra or {}
        return [
            s
            for s in self.store.list()
            if (
                s.network == self.requirements.network
                and s.channel_config["token"] == self.requirements.asset
                and s.channel_config["receiver"] == self.requirements.pay_to
                and s.fee_payer == extra.get("feePayer")
                and s.token_program == extra.get("tokenProgram")
                and s.channel_config["receiverAuthorizer"] == extra.get("receiverAuthorizer")
                and s.channel_config.get("voucherSigner", "client")
                == extra.get("voucherSigner", "client")
                and (
                    extra.get("voucherSigner") != "server"
                    or s.channel_config["payerAuthorizer"] == extra.get("operator")
                )
            )
        ]

    def _submit(self, raw: dict[str, Any]) -> SettleResponse:
        result = self.facilitator.settle(
            PaymentPayload(x402_version=2, accepted=self.requirements, payload=raw),
            self.requirements,
        )
        if result.network != self.requirements.network:
            raise ValueError("Redemption response belongs to another network")
        return result

    def _record(self, channel_id: str, **fields: Any) -> None:
        def update(current: ChannelState | None) -> ChannelState:
            if current is None:
                raise ValueError("Channel disappeared during redemption")
            for name, value in fields.items():
                if name in ("settled", "payout_watermark"):
                    value = max(value, getattr(current, name))
                setattr(current, name, value)
            current.onchain_synced_at = time.time()
            return current

        self.store.update(channel_id, update)

    def _seal(self, channel: ChannelState) -> bool:
        if (
            channel.close_requested_at
            and time.time() >= channel.close_requested_at + channel.channel_config["withdrawDelay"]
        ):
            raise ValueError("Channel grace period elapsed before final voucher redemption")
        self._record(channel.channel_id, status="closing")
        payload: dict[str, Any] = {
            "type": "seal",
            "channelId": channel.channel_id,
            "channelConfig": channel.channel_config,
            "voucher": channel.highest_voucher,
        }
        if self.receiver_authorizer:
            from .close_authorization import sign_close_authorization

            payload["closeAuthorization"] = sign_close_authorization(
                self.receiver_authorizer,
                network=self.requirements.network,
                fee_payer=channel.fee_payer,
                channel_id=channel.channel_id,
                max_claimable_amount=channel.signed_max_claimable,
                voucher_expires_at=0,
                valid_before=int(time.time()) + self.requirements.max_timeout_seconds,
            )
        response = self._submit(payload)
        if not response.success:
            raise ValueError(f"Seal failed: {response.error_reason}")
        self._record(
            channel.channel_id,
            status="distributed",
            settled=channel.signed_max_claimable,
            payout_watermark=channel.signed_max_claimable,
        )
        return True

    def _claim(self, batch: list[ChannelState], outcome: dict[str, list[str]]) -> None:
        response = self._submit(
            {
                "type": "claim",
                "claims": [
                    {
                        "channelId": s.channel_id,
                        "channelConfig": s.channel_config,
                        "voucher": s.highest_voucher,
                    }
                    for s in batch
                ],
            }
        )
        if not response.success:
            if response.error_reason == BatchError.CHANNEL_CLOSING:
                if len(batch) > 1:
                    for channel in batch:
                        self._claim([channel], outcome)
                elif self._seal(batch[0]):
                    outcome["sealed"].append(batch[0].channel_id)
                return
            if response.error_reason == BatchError.CUMULATIVE_AMOUNT_MISMATCH:
                # Another worker may already have claimed this voucher, including
                # before our durable response cache was restored.
                for channel in batch:
                    settled = self._read(channel.channel_id, "settled")
                    if (
                        type(settled) is not int
                        or not channel.signed_max_claimable <= settled <= channel.deposit
                    ):
                        raise ValueError("Claim failed without a confirmed matching watermark")
                    self._record(channel.channel_id, settled=settled)
                    outcome["claimed"].append(channel.channel_id)
                return
            raise ValueError(f"Claim failed: {response.error_reason}")
        accepts = (response.extra or {}).get("accepts")
        if accepts is not None:
            if not isinstance(accepts, list) or len(accepts) != len(batch):
                raise ValueError("Claim response omits confirmed channels")
            for channel in batch:
                matches = [
                    a
                    for a in accepts
                    if isinstance(a, dict) and a.get("channelId") == channel.channel_id
                ]
                if len(matches) != 1 or matches[0].get("totalClaimed") != str(
                    channel.signed_max_claimable
                ):
                    raise ValueError("Claim response omits confirmed watermark")
        for channel in batch:
            settled = (
                channel.signed_max_claimable
                if accepts is not None
                else self._read(channel.channel_id, "settled")
            )
            if settled is None or not channel.signed_max_claimable <= settled <= channel.deposit:
                raise ValueError("Confirmed settled watermark unavailable or invalid")
            self._record(channel.channel_id, settled=settled)
            outcome["claimed"].append(channel.channel_id)

    def redeem(self) -> dict[str, list[str]]:
        with self._lock:
            outcome: dict[str, list[str]] = {"claimed": [], "distributed": [], "sealed": []}
            channels = [
                s
                for s in self._eligible()
                if s.highest_voucher
                and (s.status == "closing" or s.signed_max_claimable > s.settled)
            ]
            open_channels = [s for s in channels if s.status == "open"]
            for index in range(0, len(open_channels), self.batch_size):
                try:
                    self._claim(open_channels[index : index + self.batch_size], outcome)
                except Exception as error:
                    self._error(error)
            for channel in channels:
                if channel.status == "closing":
                    try:
                        if self._seal(channel):
                            outcome["sealed"].append(channel.channel_id)
                    except Exception as error:
                        self._error(error)
            payable = [
                s for s in self._eligible() if s.status == "open" and s.settled > s.payout_watermark
            ]
            for index in range(0, len(payable), self.batch_size):
                batch = payable[index : index + self.batch_size]
                try:
                    response = self._submit(
                        {
                            "type": "settle",
                            "channels": [
                                {"channelId": s.channel_id, "channelConfig": s.channel_config}
                                for s in batch
                            ],
                        }
                    )
                    if (
                        not response.success
                        and response.error_reason != BatchError.CUMULATIVE_AMOUNT_MISMATCH
                    ):
                        raise ValueError(f"Distribution failed: {response.error_reason}")
                    ids = (response.extra or {}).get("channels")
                    if ids is not None and (
                        not isinstance(ids, list)
                        or any(not isinstance(channel_id, str) for channel_id in ids)
                        or len(set(ids)) != len(ids)
                        or not set(ids).issubset({s.channel_id for s in batch})
                    ):
                        raise ValueError("Distribution response channel mismatch")
                    for channel in batch:
                        paid = self._read(channel.channel_id, "payout_watermark")
                        if type(paid) is not int or not 0 <= paid <= channel.deposit:
                            raise ValueError("Confirmed payout watermark unavailable or invalid")
                        self._record(channel.channel_id, payout_watermark=paid)
                        if paid >= channel.settled:
                            outcome["distributed"].append(channel.channel_id)
                except Exception as error:
                    self._error(error)
            return outcome

    def start(self, interval_seconds: float) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()

        def run() -> None:
            while not self._stop.wait(interval_seconds):
                try:
                    self.redeem()
                except Exception as error:
                    self._error(error)

        self._thread = Thread(target=run, name="x402-svm-batch-redemption", daemon=True)
        self._thread.start()

    def stop(self, *, flush: bool = False) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join()
            self._thread = None
        if flush:
            self.redeem()
