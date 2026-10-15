"""Redemption reconciles per-channel onchain watermarks before recording payouts."""

from copy import deepcopy

import pytest

from x402.mechanisms.svm.batch_settlement.channel_manager import BatchChannelManager
from x402.mechanisms.svm.batch_settlement.errors import BatchError
from x402.mechanisms.svm.batch_settlement.types import ChannelState
from x402.mechanisms.svm.payment_channels import find_payment_channel_pda, sign_voucher
from x402.schemas import SettleResponse

from .test_batch_server import PAYER, setup


def make_channels(count=1):
    scheme, req, cfg, original = setup()
    # Use one store with channels sharing terms but different salts.
    states = []
    for salt in range(7, 7 + count):
        config = {**cfg, "salt": str(salt)}
        cid = find_payment_channel_pda(
            payer=cfg["payer"],
            payee=req.extra["feePayer"],
            mint=req.asset,
            authorized_signer=cfg["payerAuthorizer"],
            salt=salt,
            open_slot=cfg["openSlot"],
        )
        state = ChannelState(
            channel_id=cid,
            network=req.network,
            channel_config=config,
            fee_payer=req.extra["feePayer"],
            token_program=req.extra["tokenProgram"],
            deposit=100,
            charged_cumulative_amount=10,
            signed_max_claimable=10,
            highest_voucher={
                "channelId": cid,
                "maxClaimableAmount": "10",
                "expiresAt": 0,
                "signature": sign_voucher(PAYER, cid, 10),
            },
        )
        scheme.store.put(state)
        states.append(state)
    return scheme.store, req, states


class Settler:
    def __init__(self, req):
        self.req = req
        self.calls = []
        self.claim_extra = True
        self.closing = False

    def settle(self, payload, requirements):
        self.calls.append(deepcopy(payload.payload))
        kind = payload.payload["type"]
        extra = {}
        if kind == "claim":
            if self.closing:
                return SettleResponse(
                    success=False,
                    transaction="",
                    network=self.req.network,
                    error_reason=BatchError.CHANNEL_CLOSING,
                )
            if self.claim_extra:
                extra["accepts"] = [
                    {
                        "channelId": c["channelId"],
                        "totalClaimed": c["voucher"]["maxClaimableAmount"],
                    }
                    for c in payload.payload["claims"]
                ]
        elif kind == "settle":
            extra["channels"] = [c["channelId"] for c in payload.payload["channels"]]
        return SettleResponse(
            success=True,
            transaction="confirmed",
            amount="999999",
            network=self.req.network,
            extra=extra,
        )


def test_claim_batches_four_and_never_infers_payout_from_response_amount():
    store, req, states = make_channels(5)
    facilitator = Settler(req)
    manager = BatchChannelManager(store, facilitator, req, read_payout_watermark=lambda _: 7)
    result = manager.redeem()
    assert len(result["claimed"]) == 5
    assert result["distributed"] == []
    assert [len(c["claims"]) for c in facilitator.calls if c["type"] == "claim"] == [4, 1]
    assert [len(c["channels"]) for c in facilitator.calls if c["type"] == "settle"] == [4, 1]
    assert all(store.get(s.channel_id).payout_watermark == 7 for s in states)
    assert all(store.get(s.channel_id).settled == 10 for s in states)


def test_async_facilitator_is_rejected_before_starting_worker():
    store, req, _ = make_channels()

    class AsyncFacilitator:
        async def settle(self, *_):
            raise AssertionError("Must be rejected at construction")

    with pytest.raises(TypeError, match="synchronous facilitator"):
        BatchChannelManager(store, AsyncFacilitator(), req)


def test_each_voucher_mode_has_its_own_worker_over_shared_store():
    from .test_batch_server import OPERATOR

    store, client_req, states = make_channels()
    _, server_req, _, server_id = setup(True, store=store)
    state = store.get(server_id)
    state.charged_cumulative_amount = state.signed_max_claimable = 10
    state.highest_voucher = {
        "channelId": server_id,
        "maxClaimableAmount": "10",
        "expiresAt": 0,
        "signature": sign_voucher(OPERATOR, server_id, 10),
    }
    store.put(state)
    for req, expected in ((client_req, states[0].channel_id), (server_req, server_id)):
        manager = BatchChannelManager(store, Settler(req), req, read_payout_watermark=lambda _: 10)
        assert manager.redeem()["claimed"] == [expected]


def test_spec_minimal_claim_response_uses_confirmed_chain_reader():
    store, req, states = make_channels()
    facilitator = Settler(req)
    facilitator.claim_extra = False
    errors = []
    manager = BatchChannelManager(
        store,
        facilitator,
        req,
        read_settled_watermark=lambda _: 9,
        read_payout_watermark=lambda _: 10,
        on_error=errors.append,
    )
    assert manager.redeem()["claimed"] == []
    assert errors
    assert store.get(states[0].channel_id).settled == 0
    manager._read_settled = lambda _: 10
    result = manager.redeem()
    assert result["claimed"] == [states[0].channel_id]
    assert result["distributed"] == [states[0].channel_id]


def test_claim_detects_closing_channel_and_seals_final_voucher():
    store, req, states = make_channels()
    facilitator = Settler(req)
    facilitator.closing = True
    result = BatchChannelManager(store, facilitator, req).redeem()
    assert result["sealed"] == [states[0].channel_id]
    assert [c["type"] for c in facilitator.calls] == ["claim", "seal"]
    assert store.get(states[0].channel_id).status == "distributed"


@pytest.mark.parametrize("charged", [0, 10])
def test_closing_channel_is_sealed_even_when_all_charges_are_already_claimed(charged):
    store, req, states = make_channels()
    state = states[0]
    state.status = "closing"
    state.charged_cumulative_amount = state.signed_max_claimable = state.settled = charged
    state.highest_voucher = {
        "channelId": state.channel_id,
        "maxClaimableAmount": str(charged),
        "expiresAt": 0,
        "signature": sign_voucher(PAYER, state.channel_id, charged),
    }
    store.put(state)
    facilitator = Settler(req)
    result = BatchChannelManager(store, facilitator, req).redeem()
    assert result["sealed"] == [state.channel_id]
    assert [call["type"] for call in facilitator.calls] == ["seal"]
    assert store.get(state.channel_id).status == "distributed"
    assert store.get(state.channel_id).payout_watermark == charged


def test_redemption_ignores_channels_from_other_networks_or_receivers():
    store, req, states = make_channels(3)
    states[1].network = "solana:other-network"
    states[2].channel_config["receiver"] = str(PAYER.pubkey())
    store.put(states[1])
    store.put(states[2])
    facilitator = Settler(req)
    result = BatchChannelManager(
        store, facilitator, req, read_payout_watermark=lambda _: 10
    ).redeem()
    assert result["claimed"] == [states[0].channel_id]


def test_invalid_payout_does_not_erase_unpaid_balance():
    store, req, states = make_channels()
    errors = []
    manager = BatchChannelManager(
        store, Settler(req), req, read_payout_watermark=lambda _: 101, on_error=errors.append
    )
    assert manager.redeem()["distributed"] == []
    assert errors
    assert store.get(states[0].channel_id).payout_watermark == 0


def test_already_claimed_and_paid_channels_reconcile_after_cache_loss():
    store, req, states = make_channels()

    class AlreadySettled(Settler):
        def settle(self, payload, requirements):
            return SettleResponse(
                success=False,
                transaction="",
                network=req.network,
                error_reason=BatchError.CUMULATIVE_AMOUNT_MISMATCH,
            )

    manager = BatchChannelManager(
        store,
        AlreadySettled(req),
        req,
        read_settled_watermark=lambda _: 10,
        read_payout_watermark=lambda _: 10,
    )
    result = manager.redeem()
    assert result["claimed"] == [states[0].channel_id]
    assert result["distributed"] == [states[0].channel_id]
    assert store.get(states[0].channel_id).payout_watermark == 10


def test_mixed_distribution_response_reconciles_omitted_already_paid_channels():
    store, req, states = make_channels(2)

    class PartialSweep(Settler):
        def settle(self, payload, requirements):
            result = super().settle(payload, requirements)
            if payload.payload["type"] == "settle":
                result.extra["channels"] = [states[1].channel_id]
            return result

    result = BatchChannelManager(
        store, PartialSweep(req), req, read_payout_watermark=lambda _: 10
    ).redeem()
    assert set(result["distributed"]) == {s.channel_id for s in states}
    assert all(store.get(s.channel_id).payout_watermark == 10 for s in states)
