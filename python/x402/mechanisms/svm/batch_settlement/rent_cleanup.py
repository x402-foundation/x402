"""Bounded, explicitly driven discovery and sponsored-rent recovery."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from threading import Lock
from typing import Any

from ....schemas import PaymentRequirements
from ..payment_channels import (
    OPEN_SLOT_WINDOW,
    ChannelSplit,
    ChannelStatus,
    build_distribute_instruction,
    build_reclaim_instruction,
    build_seal_instruction,
    build_settle_and_seal_instructions,
    distribution_hash,
)
from .constants import BATCH_SETTLEMENT_SCHEME
from .facilitator_storage import PaymentChannelRecord


class BatchSvmRentCleanupManager:
    """Call discovery at startup/periodically, and cleanup well within close windows.

    Unknown recipients cannot be reconstructed from a distribution hash. Such
    rediscovered channels remain indexed until an operator restores their metadata;
    already-distributed channels can still be reclaimed without recipient metadata.
    """

    def __init__(
        self, facilitator: Any, network: str, *, on_error: Callable[[Exception], None] | None = None
    ):
        self.facilitator = facilitator
        self.network = network
        self.on_error = on_error
        self._lock = Lock()

    def _error(self, error: Exception) -> None:
        if self.on_error:
            self.on_error(error)
        else:
            logging.getLogger(__name__).error("Batch rent cleanup failed: %s", error)

    def discover(self) -> list[str]:
        with self._lock:
            discovered = self.facilitator.discover_channels(self.network)
            result = []
            for channel_id, _channel in discovered:
                if self.facilitator.channel_storage.get(self.network, channel_id) is None:
                    self.facilitator.channel_storage.record(
                        PaymentChannelRecord(
                            network=self.network,
                            channel_id=channel_id,
                            pay_to="",
                            token_program="",
                            last_activity_at=time.time(),
                        )
                    )
                result.append(channel_id)
            return result

    def cleanup(self, *, max_transactions: int = 10) -> dict[str, list[str]]:
        if type(max_transactions) is not int or max_transactions <= 0:
            raise ValueError("max_transactions must be a positive integer")
        with self._lock:
            result: dict[str, list[str]] = {"distributed": [], "reclaimed": [], "pending": []}
            sent = 0
            for record in self.facilitator.channel_storage.list(self.network):
                if sent >= max_transactions:
                    break
                try:
                    pending = self.facilitator.pending_store.find_pending(
                        self.network, [record.channel_id]
                    )
                    if pending:
                        outcome = self.facilitator.recover_pending(pending)
                        if outcome.success and pending.kind == "maintenance":
                            result[pending.metadata["expected_status"]].append(record.channel_id)
                        elif outcome.error_reason == "settlement_pending":
                            result["pending"].append(record.channel_id)
                        continue
                    # Revalidate immediately before choosing the transition.
                    channel = self.facilitator.read_channel(self.network, record.channel_id)
                    if channel is None:
                        continue
                    if (
                        channel.payee != channel.rent_payer
                        or channel.rent_payer not in self.facilitator.signer.get_addresses()
                    ):
                        continue
                    instructions = []
                    if channel.status == ChannelStatus.DISTRIBUTED:
                        slot = self.facilitator.signer.get_slot(self.network)
                        if slot <= channel.open_slot + OPEN_SLOT_WINDOW:
                            continue
                        action = "reclaimed"
                        instructions = [
                            build_reclaim_instruction(record.channel_id, channel.rent_payer)
                        ]
                    else:
                        action = "distributed"
                        if channel.status == ChannelStatus.OPEN:
                            idle = self.facilitator.config.max_idle_secs
                            if idle <= 0 or time.time() < record.last_activity_at + idle:
                                continue
                            instructions = build_settle_and_seal_instructions(
                                record.channel_id, channel.payee
                            )
                        elif channel.status == ChannelStatus.CLOSING:
                            if time.time() < channel.closure_started_at + channel.grace_period:
                                continue
                            instructions = [build_seal_instruction(record.channel_id)]
                        elif channel.status != ChannelStatus.SEALED:
                            continue
                        if not record.pay_to or not record.token_program:
                            raise ValueError(
                                f"Channel {record.channel_id} needs restored recipient metadata"
                            )
                        splits = [ChannelSplit(record.pay_to, 10_000)]
                        if distribution_hash(splits) != channel.distribution_hash:
                            raise ValueError(
                                "Stored recipient differs from the onchain distribution"
                            )
                        mint = self.facilitator.signer.get_account_info(channel.mint, self.network)
                        if not mint or mint["owner"] != record.token_program:
                            raise ValueError("Stored token program differs from the mint owner")
                        instructions.append(
                            build_distribute_instruction(
                                channel_id=record.channel_id,
                                payee=channel.payee,
                                payer=channel.payer,
                                rent_payer=channel.rent_payer,
                                mint=channel.mint,
                                token_program=record.token_program,
                                splits=splits,
                                network=self.network,
                            )
                        )
                    requirements = PaymentRequirements(
                        scheme=BATCH_SETTLEMENT_SCHEME,
                        network=self.network,
                        amount="0",
                        asset=channel.mint,
                        pay_to=record.pay_to or channel.payer,
                        max_timeout_seconds=60,
                        extra={"feePayer": channel.payee, "tokenProgram": record.token_program},
                    )
                    outcome = self.facilitator.submit_operation(
                        key=f"maintenance:{self.network}:{record.channel_id}:{action}:{channel.settled}",
                        network=self.network,
                        channel_ids=(record.channel_id,),
                        kind="maintenance",
                        payer=channel.payer,
                        fee_payer=channel.payee,
                        metadata={"expected_status": action, "configs": []},
                        requirements=requirements,
                        instructions=instructions,
                    )
                    sent += 1
                    if outcome.success:
                        result[action].append(record.channel_id)
                    elif outcome.error_reason == "settlement_pending":
                        result["pending"].append(record.channel_id)
                    else:
                        raise ValueError(f"Cleanup failed: {outcome.error_reason}")
                except Exception as error:
                    self._error(error)
            return result
