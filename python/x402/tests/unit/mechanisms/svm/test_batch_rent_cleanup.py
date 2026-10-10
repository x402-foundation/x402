"""Recovery never closes early or invents missing recipient metadata."""

import time
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

from x402.mechanisms.svm.batch_settlement.facilitator_storage import (
    MemoryBatchPendingSettlementStore,
    MemoryPaymentChannelStorage,
    PaymentChannelRecord,
)
from x402.mechanisms.svm.batch_settlement.rent_cleanup import BatchSvmRentCleanupManager
from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS
from x402.mechanisms.svm.payment_channels import (
    Channel,
    ChannelSplit,
    ChannelStatus,
    distribution_hash,
)
from x402.schemas import SettleResponse

from .test_batch_server import FEE, MINT, PAYER, RECEIVER


def fixture(status=ChannelStatus.OPEN):
    fee = str(FEE.pubkey())
    channel = Channel(
        payer=str(PAYER.pubkey()),
        payee=fee,
        rent_payer=fee,
        authorized_signer=str(PAYER.pubkey()),
        mint=str(MINT.pubkey()),
        salt=0,
        open_slot=100,
        deposit=100,
        settled=10,
        payout_watermark=0,
        grace_period=900,
        distribution_hash=distribution_hash([ChannelSplit(str(RECEIVER.pubkey()), 10_000)]),
        status=status,
    )
    cid = str(MINT.pubkey())
    storage = MemoryPaymentChannelStorage()
    storage.record(
        PaymentChannelRecord(
            SOLANA_DEVNET_CAIP2,
            cid,
            str(RECEIVER.pubkey()),
            TOKEN_PROGRAM_ADDRESS,
            last_activity_at=time.time() - 1000,
        )
    )
    fac = SimpleNamespace(
        channel_storage=storage,
        pending_store=MemoryBatchPendingSettlementStore(),
        read_channel=Mock(return_value=channel),
        discover_channels=Mock(return_value=[(cid, channel)]),
        signer=SimpleNamespace(
            get_addresses=lambda: [fee],
            get_slot=lambda _: 1601,
            get_account_info=lambda *_: {"owner": TOKEN_PROGRAM_ADDRESS},
        ),
        config=SimpleNamespace(max_idle_secs=100),
        submit_operation=Mock(
            return_value=SettleResponse(
                success=True, transaction="confirmed", network=SOLANA_DEVNET_CAIP2
            )
        ),
    )
    return fac, channel, cid


def test_idle_policy_never_closes_when_not_advertised_or_before_deadline():
    fac, channel, cid = fixture()
    manager = BatchSvmRentCleanupManager(fac, SOLANA_DEVNET_CAIP2)
    fac.config.max_idle_secs = 0
    assert not manager.cleanup()["distributed"]
    fac.config.max_idle_secs = 2000
    assert not manager.cleanup()["distributed"]
    fac.config.max_idle_secs = 100
    assert manager.cleanup()["distributed"] == [cid]
    assert len(fac.submit_operation.call_args.kwargs["instructions"]) == 2


def test_closing_waits_for_grace_and_reclaim_waits_strict_slot_boundary():
    fac, channel, cid = fixture(ChannelStatus.CLOSING)
    manager = BatchSvmRentCleanupManager(fac, SOLANA_DEVNET_CAIP2)
    fac.read_channel.return_value = replace(channel, closure_started_at=int(time.time()))
    assert not manager.cleanup()["distributed"]
    fac.read_channel.return_value = replace(channel, closure_started_at=int(time.time()) - 901)
    assert manager.cleanup()["distributed"] == [cid]
    fac.read_channel.return_value = replace(channel, status=ChannelStatus.DISTRIBUTED)
    fac.signer.get_slot = lambda _: 1600
    assert not manager.cleanup()["reclaimed"]
    fac.signer.get_slot = lambda _: 1601
    assert manager.cleanup()["reclaimed"] == [cid]


def test_discovery_starts_new_idle_clock_and_cannot_guess_receiver():
    fac, channel, cid = fixture()
    fac.channel_storage = MemoryPaymentChannelStorage()
    errors = []
    manager = BatchSvmRentCleanupManager(fac, SOLANA_DEVNET_CAIP2, on_error=errors.append)
    assert manager.discover() == [cid]
    assert fac.channel_storage.get(SOLANA_DEVNET_CAIP2, cid).last_activity_at >= time.time() - 1
    assert not manager.cleanup()["distributed"]
    fac.read_channel.return_value = replace(channel, status=ChannelStatus.SEALED)
    assert not manager.cleanup()["distributed"]
    assert "recipient metadata" in str(errors[-1])
    assert not fac.submit_operation.called


def test_unknown_close_outcome_recovers_even_after_account_disappears():
    fac, _, cid = fixture()
    pending = SimpleNamespace(kind="maintenance", metadata={"expected_status": "reclaimed"})
    fac.pending_store = SimpleNamespace(find_pending=lambda *_: pending)
    fac.read_channel.return_value = None
    fac.recover_pending = Mock(
        return_value=SettleResponse(
            success=True, transaction="known-signature", network=SOLANA_DEVNET_CAIP2
        )
    )
    assert BatchSvmRentCleanupManager(fac, SOLANA_DEVNET_CAIP2).cleanup()["reclaimed"] == [cid]
    fac.recover_pending.assert_called_once_with(pending)
    assert not fac.read_channel.called
    assert not fac.submit_operation.called
