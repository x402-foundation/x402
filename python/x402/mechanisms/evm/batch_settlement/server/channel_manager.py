"""Async `BatchSettlementChannelManager` for periodic claim/settle/refund."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any

from ..authorizer_signer import sign_claim_batch, sign_refund
from ..types import VoucherClaim
from ..utils import compute_channel_id
from .channel_manager_common import (
    AUTO_JOB_PRIORITY,
    AutoJob,
    AutoSettlementConfig,
    AutoSettlementContext,
    ChannelManagerConfig,
    ClaimChannelSelector,
    ClaimOptions,
    ClaimResult,
    RefundChannelSelector,
    RefundResult,
    SettleResult,
    build_claim_payment_payload,
    build_payment_requirements,
    build_refund_claims,
    build_refund_payment_payload,
    build_settle_payment_payload,
    format_facilitator_failure,
    get_claimable_vouchers_from_channels,
    get_idle_channels_for_refund,
    has_live_pending_request,
    now_ms,
)
from .storage import Channel


class BatchSettlementChannelManager:
    """Async channel manager for claim / settle / refund lifecycle."""

    def __init__(self, config: ChannelManagerConfig) -> None:
        self._scheme = config.scheme
        self._facilitator = config.facilitator
        self._receiver = config.receiver
        self._token = config.token
        self._network = config.network

        self._timer_tasks: dict[AutoJob, asyncio.Task[None]] = {}
        self._drain_task: asyncio.Task[None] | None = None
        self._last_claim_time = 0
        self._last_settle_time = 0
        self._pending_settle = False
        self._running = False
        self._pending_jobs: set[AutoJob] = set()
        self._draining_jobs = False
        self._auto_settle_config = AutoSettlementConfig()

    async def claim(self, opts: ClaimOptions | None = None) -> list[ClaimResult]:
        targets = await self._select_claim_targets(opts)
        max_per_batch = (opts.max_claims_per_batch if opts else None) or 100
        idle_secs = opts.idle_secs if opts else None
        return await self._claim_from_channels(
            targets, max_claims_per_batch=max_per_batch, idle_secs=idle_secs
        )

    async def settle(self) -> SettleResult:
        requirements = build_payment_requirements(self._receiver, self._token, self._network)
        payload = build_settle_payment_payload(requirements, self._receiver, self._token)
        response = await self._facilitator.settle(payload, requirements)
        if not response.success:
            raise RuntimeError(format_facilitator_failure("Settle", response))
        self._pending_settle = False
        return SettleResult(transaction=response.transaction)

    async def claim_and_settle(self, opts: ClaimOptions | None = None) -> dict[str, Any]:
        claims = await self.claim(opts)
        settle: SettleResult | None = None
        if claims:
            settle = await self.settle()
        return {"claims": claims, "settle": settle}

    async def refund(self, channel_ids: list[str] | None = None) -> list[RefundResult]:
        storage = self._scheme.get_storage()
        channels = storage.list()

        now = now_ms()
        if channel_ids is not None:
            requested = {c.lower() for c in channel_ids}
            channels = [c for c in channels if c.channel_id.lower() in requested]
        targets = [c for c in channels if not has_live_pending_request(c, now)]

        if not targets:
            return []
        return await self._refund_channels(targets)

    async def refund_idle_channels(self, idle_secs: int) -> list[RefundResult]:
        targets = get_idle_channels_for_refund(self._scheme.get_storage().list(), idle_secs)
        return await self._refund_channels(targets)

    async def get_claimable_vouchers(
        self, opts: dict[str, Any] | None = None
    ) -> list[VoucherClaim]:
        idle_secs = opts.get("idleSecs") if opts else None
        channels = self._scheme.get_storage().list()
        return get_claimable_vouchers_from_channels(channels, idle_secs)

    async def get_withdrawal_pending_sessions(self) -> list[Channel]:
        return [c for c in self._scheme.get_storage().list() if c.withdraw_requested_at > 0]

    def start(self, config: AutoSettlementConfig | None = None) -> None:
        if self._running:
            return
        now = now_ms()
        self._last_claim_time = now
        self._last_settle_time = now
        self._running = True
        self._auto_settle_config = config or AutoSettlementConfig()

        self._start_auto_timer("claim", self._auto_settle_config.claim_interval_secs)
        self._start_auto_timer("settle", self._auto_settle_config.settle_interval_secs)
        self._start_auto_timer("refund", self._auto_settle_config.refund_interval_secs)

    async def stop(self, *, flush: bool = False) -> None:
        self._running = False
        for task in list(self._timer_tasks.values()):
            task.cancel()
        self._timer_tasks.clear()
        self._pending_jobs.clear()

        drain = self._drain_task
        if drain is not None and not drain.done():
            drain.cancel()
            try:
                await drain
            except asyncio.CancelledError:
                pass
        self._drain_task = None

        if flush:
            opts = ClaimOptions(
                max_claims_per_batch=self._auto_settle_config.max_claims_per_batch,
                select_claim_channels=self._auto_settle_config.select_claim_channels,
            )
            await self.claim_and_settle(opts)

    def _start_auto_timer(self, job: AutoJob, interval_secs: int | None) -> None:
        if interval_secs is None:
            return

        async def loop() -> None:
            while self._running:
                await asyncio.sleep(interval_secs)
                if not self._running:
                    return
                self._enqueue_job(job)

        try:
            asyncio.get_running_loop()
        except RuntimeError as err:
            raise RuntimeError(
                "BatchSettlementChannelManager.start() requires a running asyncio "
                "event loop (e.g. call it from FastAPI lifespan startup, not at "
                "module import time)."
            ) from err
        self._timer_tasks[job] = asyncio.create_task(loop(), name=f"bs-{job}")

    def _enqueue_job(self, job: AutoJob) -> None:
        if not self._running:
            return
        self._pending_jobs.add(job)
        if not self._draining_jobs:
            self._drain_task = asyncio.create_task(self._drain_jobs())

    async def _drain_jobs(self) -> None:
        if self._draining_jobs:
            return
        self._draining_jobs = True
        try:
            while self._running and self._pending_jobs:
                next_job: AutoJob | None = next(
                    (j for j in AUTO_JOB_PRIORITY if j in self._pending_jobs),
                    None,
                )
                if next_job is None:
                    return
                self._pending_jobs.discard(next_job)
                await self._run_auto_job(next_job)
        finally:
            self._draining_jobs = False

    async def _run_auto_job(self, job: AutoJob) -> None:
        try:
            if job == "claim":
                await self._run_claim_job()
            elif job == "settle":
                await self._run_settle_job()
            elif job == "refund":
                await self._run_refund_job()
        except BaseException as err:  # noqa: BLE001
            on_error = self._auto_settle_config.on_error
            if on_error is not None:
                on_error(err)

    async def _run_claim_job(self) -> None:
        cfg = self._auto_settle_config
        targets = await self._select_claim_targets(
            ClaimOptions(select_claim_channels=cfg.select_claim_channels)
        )
        results = await self._claim_from_channels(
            targets,
            max_claims_per_batch=cfg.max_claims_per_batch or 100,
            idle_secs=None,
        )
        self._last_claim_time = now_ms()
        if cfg.on_claim is not None:
            for r in results:
                cfg.on_claim(r)

    async def _run_settle_job(self) -> None:
        cfg = self._auto_settle_config
        ctx = self._build_auto_settlement_context(now_ms())
        if not ctx.pending_settle:
            return
        if cfg.should_settle is not None:
            should = await _await_value(cfg.should_settle(ctx))
            if not should:
                return
        result = await self.settle()
        self._last_settle_time = now_ms()
        if cfg.on_settle is not None:
            cfg.on_settle(result)

    async def _run_refund_job(self) -> None:
        cfg = self._auto_settle_config
        if cfg.select_refund_channels is None:
            return
        ctx = self._build_auto_settlement_context(now_ms())
        channels = self._scheme.get_storage().list()
        targets = await _await_value(cfg.select_refund_channels(channels, ctx))
        for r in await self._refund_channels(targets):
            if cfg.on_refund is not None:
                cfg.on_refund(r)

    async def _select_claim_targets(self, opts: ClaimOptions | None) -> list[Channel]:
        channels = self._scheme.get_storage().list()
        if opts is None or opts.select_claim_channels is None:
            return channels
        ctx = self._build_auto_settlement_context(now_ms())
        return await _await_value(opts.select_claim_channels(channels, ctx))

    async def _claim_from_channels(
        self,
        channels: list[Channel],
        *,
        max_claims_per_batch: int,
        idle_secs: int | None,
    ) -> list[ClaimResult]:
        all_claims = get_claimable_vouchers_from_channels(channels, idle_secs)
        if not all_claims:
            return []
        results: list[ClaimResult] = []
        for i in range(0, len(all_claims), max_claims_per_batch):
            batch = all_claims[i : i + max_claims_per_batch]
            result = await self._submit_claim(batch)
            results.append(result)
            self._update_claimed_sessions(batch)
        if results:
            self._pending_settle = True
        return results

    async def _refund_channels(self, channels: list[Channel]) -> list[RefundResult]:
        now = now_ms()
        results: list[RefundResult] = []
        for c in channels:
            if has_live_pending_request(c, now):
                continue
            results.append(await self._refund_channel(c))
        return results

    async def _refund_channel(self, target: Channel) -> RefundResult:
        signer = self._scheme.get_receiver_authorizer_signer()
        claims = build_refund_claims(target)
        refund_amount = str(int(target.balance) - int(target.charged_cumulative_amount))
        nonce = str(target.refund_nonce or 0)

        refund_authorizer_signature = (
            sign_refund(signer, target.channel_id, refund_amount, nonce, self._network)
            if signer is not None
            else None
        )
        claim_authorizer_signature = (
            sign_claim_batch(signer, claims, self._network)
            if signer is not None and claims
            else None
        )

        requirements = build_payment_requirements(self._receiver, self._token, self._network)
        payment_payload = build_refund_payment_payload(
            target,
            claims,
            requirements,
            refund_amount,
            nonce,
            refund_authorizer_signature,
            claim_authorizer_signature,
        )

        response = await self._facilitator.settle(payment_payload, requirements)
        if not response.success:
            raise RuntimeError(format_facilitator_failure("Refund", response))

        def update(current: Channel | None) -> Channel | None:
            if current is None:
                return current
            if has_live_pending_request(current, now_ms()):
                return current
            return None

        self._scheme.get_storage().update_channel(target.channel_id, update)

        return RefundResult(channel=target.channel_id, transaction=response.transaction)

    async def _submit_claim(self, claims: list[VoucherClaim]) -> ClaimResult:
        signer = self._scheme.get_receiver_authorizer_signer()
        claim_authorizer_signature = (
            sign_claim_batch(signer, claims, self._network) if signer is not None else None
        )
        requirements = build_payment_requirements(self._receiver, self._token, self._network)
        payment_payload = build_claim_payment_payload(
            claims, requirements, claim_authorizer_signature
        )
        response = await self._facilitator.settle(payment_payload, requirements)
        if not response.success:
            raise RuntimeError(format_facilitator_failure("Claim", response))
        return ClaimResult(vouchers=len(claims), transaction=response.transaction)

    def _update_claimed_sessions(self, claims: list[VoucherClaim]) -> None:
        storage = self._scheme.get_storage()
        for claim in claims:
            channel_id = compute_channel_id(claim.channel, self._network)
            channel = storage.get(channel_id)
            if channel is None:
                continue
            claimed_amount = int(claim.total_claimed)
            if claimed_amount <= int(channel.total_claimed):
                continue

            def update(current: Channel | None, _claimed: int = claimed_amount) -> Channel | None:
                if current is None or _claimed <= int(current.total_claimed):
                    return current
                next_ch = current.copy()
                next_ch.total_claimed = str(_claimed)
                return next_ch

            storage.update_channel(channel_id, update)

    def _build_auto_settlement_context(self, now_ms_val: int) -> AutoSettlementContext:
        return AutoSettlementContext(
            now=now_ms_val,
            last_claim_time=self._last_claim_time,
            last_settle_time=self._last_settle_time,
            pending_settle=self._pending_settle,
        )


async def _await_value(value: Any | Awaitable[Any]) -> Any:
    if asyncio.iscoroutine(value) or asyncio.isfuture(value):
        return await value
    return value


__all__ = [
    "AutoSettlementConfig",
    "AutoSettlementContext",
    "BatchSettlementChannelManager",
    "ChannelManagerConfig",
    "ClaimChannelSelector",
    "ClaimOptions",
    "ClaimResult",
    "RefundChannelSelector",
    "RefundResult",
    "SettleResult",
]
