"""Server accounting invariants exercised with real Ed25519 proofs."""

import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest
from solders.keypair import Keypair

from x402.interfaces import SchemePaymentRequiredContext
from x402.mechanisms.svm.batch_settlement.authorization import sign_batch_authorization
from x402.mechanisms.svm.batch_settlement.errors import BatchError
from x402.mechanisms.svm.batch_settlement.server import BatchSvmScheme, BatchSvmServerConfig
from x402.mechanisms.svm.batch_settlement.storage import MemoryChannelStore
from x402.mechanisms.svm.batch_settlement.types import ChannelState
from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS
from x402.mechanisms.svm.payment_channels import (
    find_payment_channel_pda,
    sign_voucher,
    verify_voucher,
)
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
    SupportedKind,
    VerifyResponse,
)
from x402.schemas.hooks import (
    AbortResult,
    SettleContext,
    SettleResultContext,
    SkipSettleResult,
    SkipVerifyResult,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyResultContext,
)

KEYS = [Keypair.from_seed(bytes([n]) * 32) for n in range(1, 7)]
PAYER, FEE, RECEIVER, AUTH, OPERATOR, MINT = KEYS


def setup(server_mode=False, amount="10", *, balance=100, fresh=True, store=None):
    requirements = PaymentRequirements(
        scheme="batch-settlement",
        network=SOLANA_DEVNET_CAIP2,
        amount=amount,
        asset=str(MINT.pubkey()),
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
        extra={
            "feePayer": str(FEE.pubkey()),
            "receiverAuthorizer": str(AUTH.pubkey()),
            "tokenProgram": TOKEN_PROGRAM_ADDRESS,
            "withdrawDelay": 900,
            **(
                {"voucherSigner": "server", "operator": str(OPERATOR.pubkey())}
                if server_mode
                else {}
            ),
        },
    )
    cfg = {
        "payer": str(PAYER.pubkey()),
        "payerAuthorizer": str((OPERATOR if server_mode else PAYER).pubkey()),
        "receiver": requirements.pay_to,
        "receiverAuthorizer": str(AUTH.pubkey()),
        "token": requirements.asset,
        "withdrawDelay": 900,
        "salt": "7",
        "openSlot": 123,
        **({"voucherSigner": "server"} if server_mode else {}),
    }
    channel_id = find_payment_channel_pda(
        payer=cfg["payer"],
        payee=str(FEE.pubkey()),
        mint=cfg["token"],
        authorized_signer=cfg["payerAuthorizer"],
        salt=7,
        open_slot=123,
    )
    server = BatchSvmScheme(
        BatchSvmServerConfig(
            receiver_authorizer=AUTH, operator=OPERATOR if server_mode else None, store=store
        )
    )
    server.store.put(
        ChannelState(
            channel_id=channel_id,
            network=requirements.network,
            channel_config=cfg,
            fee_payer=str(FEE.pubkey()),
            token_program=TOKEN_PROGRAM_ADDRESS,
            deposit=balance,
            onchain_synced_at=time.time() if fresh else 0,
        )
    )
    return server, requirements, cfg, channel_id


def payment(requirements, cfg, channel_id, amount=None, request_id="request-1"):
    raw = {
        "type": "authorization" if cfg.get("voucherSigner") == "server" else "voucher",
        "channelConfig": deepcopy(cfg),
    }
    if raw["type"] == "authorization":
        raw["authorization"] = sign_batch_authorization(
            PAYER,
            channel_id,
            cfg["payerAuthorizer"],
            request_id,
            int(requirements.amount),
            int(time.time()) + 60,
        )
    else:
        amount = int(requirements.amount) if amount is None else amount
        raw["voucher"] = {
            "channelId": channel_id,
            "expiresAt": 0,
            "maxClaimableAmount": str(amount),
            "signature": sign_voucher(PAYER, channel_id, amount),
        }
    return PaymentPayload(x402_version=2, accepted=requirements, payload=raw)


def reserve(server, payload, requirements, extra=None):
    before = server.before_verify(VerifyContext(payload, requirements))
    if isinstance(before, AbortResult):
        return before
    return server.after_verify(
        VerifyResultContext(
            payload, requirements, result=VerifyResponse(is_valid=True, extra=extra)
        )
    )


def test_client_vouchers_commit_once_and_keep_highest_signature():
    server, req, cfg, cid = setup()
    p = payment(req, cfg, cid)
    assert isinstance(server.before_verify(VerifyContext(p, req)), SkipVerifyResult)
    assert (
        server.after_verify(VerifyResultContext(p, req, result=VerifyResponse(is_valid=True)))
        is None
    )
    result = server.before_settle(SettleContext(p, req))
    assert isinstance(result, SkipSettleResult)
    assert result.result.extra["chargedAmount"] == "10"
    assert result.result.extra["commitmentId"] == f"{cid}:10"
    assert result.result.transaction == ""
    assert server.store.get(cid).highest_voucher == p.payload["voucher"]
    assert reserve(server, payment(req, cfg, cid), req).reason == "duplicate_settlement"
    p2 = payment(req, cfg, cid, amount=20)
    assert reserve(server, p2, req) is None
    assert isinstance(server.before_settle(SettleContext(p2, req)), SkipSettleResult)
    assert server.store.get(cid).charged_cumulative_amount == 20


def test_parallel_client_voucher_only_one_handler_reserved():
    server, req, cfg, cid = setup()
    payloads = [payment(req, cfg, cid) for _ in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda p: reserve(server, p, req), payloads))
    assert results.count(None) == 1
    assert (
        sum(isinstance(r, AbortResult) and r.reason == "duplicate_settlement" for r in results) == 7
    )


def test_server_requests_reserve_ceilings_but_charge_actual_and_sign_receipts():
    server, req, cfg, cid = setup(True, amount="60")
    p1 = payment(req, cfg, cid, request_id="1")
    p2 = payment(req, cfg, cid, request_id="2")
    assert reserve(server, p1, req) is None
    assert reserve(server, p2, req).reason == BatchError.CUMULATIVE_EXCEEDS_DEPOSIT
    result = server.before_settle(SettleContext(p1, req.model_copy(update={"amount": "20"})))
    assert isinstance(result, SkipSettleResult)
    receipt = result.result.extra["voucher"]
    assert verify_voucher(receipt["signature"], cfg["payerAuthorizer"], cid, 20)
    assert result.result.extra["chargedAmount"] == "20"
    assert server.operation_store.get(cid, "1").actual == 20
    assert (
        reserve(server, payment(req, cfg, cid, request_id="1"), req).reason
        == "duplicate_settlement"
    )
    assert (
        reserve(server, payment(req, cfg, cid, request_id="2"), req).reason
        == "duplicate_settlement"
    )


def test_concurrent_server_actual_commits_are_monotonic():
    server, req, cfg, cid = setup(True, amount="10")
    payloads = [payment(req, cfg, cid, request_id=str(i)) for i in range(8)]
    assert all(reserve(server, p, req) is None for p in payloads)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda p: server.before_settle(
                    SettleContext(p, req.model_copy(update={"amount": "3"}))
                ),
                payloads,
            )
        )
    assert all(isinstance(r, SkipSettleResult) for r in results)
    cumulative = sorted(int(r.result.extra["voucher"]["maxClaimableAmount"]) for r in results)
    assert cumulative == list(range(3, 25, 3))
    assert server.store.get(cid).charged_cumulative_amount == 24


def test_cancel_releases_capacity_but_request_id_stays_consumed():
    server, req, cfg, cid = setup(True, amount="100")
    p = payment(req, cfg, cid)
    assert reserve(server, p, req) is None
    server.on_verified_payment_canceled(VerifiedPaymentCanceledContext(p, req))
    assert not server.store.get(cid).reservations
    assert server.store.get(cid).charged_cumulative_amount == 0
    assert reserve(server, payment(req, cfg, cid), req).reason == "duplicate_settlement"
    assert reserve(server, payment(req, cfg, cid, request_id="fresh"), req) is None


@pytest.mark.parametrize("stage", ["get", "update"])
def test_storage_failure_aborts_before_handler(stage):
    class FailingStore(MemoryChannelStore):
        fail = False

        def get(self, cid):
            if self.fail and stage == "get":
                raise OSError("database unavailable")
            return super().get(cid)

        def update(self, cid, updater):
            if self.fail and stage == "update":
                raise OSError("database unavailable")
            return super().update(cid, updater)

    store = FailingStore()
    server, req, cfg, cid = setup(store=store, fresh=False)
    p = payment(req, cfg, cid)
    assert server.before_verify(VerifyContext(p, req)) is None
    store.fail = True
    if stage == "get":
        result = server.before_verify(VerifyContext(p, req))
    else:
        result = server.after_verify(
            VerifyResultContext(
                p,
                req,
                result=VerifyResponse(
                    is_valid=True,
                    extra={
                        "channelId": cid,
                        "balance": "100",
                        "totalClaimed": "0",
                        "withdrawRequestedAt": 0,
                    },
                ),
            )
        )
    assert isinstance(result, AbortResult)
    assert result.reason == BatchError.CHANNEL_STATE


def test_stale_snapshot_cannot_regress_watermark_and_requires_corrective_voucher():
    server, req, cfg, cid = setup(fresh=False)
    p = payment(req, cfg, cid, amount=10)
    result = reserve(
        server,
        p,
        req,
        {"channelId": cid, "balance": "100", "totalClaimed": "30", "withdrawRequestedAt": 0},
    )
    assert result.reason == BatchError.CUMULATIVE_AMOUNT_MISMATCH
    assert server.store.get(cid).charged_cumulative_amount == 30
    assert not server.store.get(cid).reservations


def test_corrective_response_omits_voucher_below_refreshed_chain_watermark():
    server, req, cfg, cid = setup(fresh=False)
    p = payment(req, cfg, cid, amount=10)
    state = server.store.get(cid)
    state.highest_voucher = deepcopy(p.payload["voucher"])
    server.store.put(state)
    result = reserve(
        server,
        p,
        req,
        {"channelId": cid, "balance": "100", "totalClaimed": "30", "withdrawRequestedAt": 0},
    )
    assert result.reason == BatchError.CUMULATIVE_AMOUNT_MISMATCH
    corrected = server.enrich_payment_required_response(
        SchemePaymentRequiredContext(
            requirements=[req],
            resource_info=None,
            error=result.reason,
            payment_required_response=PaymentRequired(x402_version=2, accepts=[req]),
            payment_payload=p,
        )
    )
    assert corrected[0].extra["channelState"]["chargedCumulativeAmount"] == "30"
    assert "voucherState" not in corrected[0].extra


def test_metered_charge_cannot_exceed_reserved_ceiling():
    server, req, cfg, cid = setup(True)
    p = payment(req, cfg, cid)
    assert reserve(server, p, req) is None
    result = server.before_settle(SettleContext(p, req.model_copy(update={"amount": "11"})))
    assert result.reason == BatchError.CUMULATIVE_AMOUNT_MISMATCH
    assert server.store.get(cid).charged_cumulative_amount == 0


@pytest.mark.parametrize("snapshot_kind", ["complete", "missing", "malformed", "closing"])
def test_topup_confirmed_balance_becomes_available_once(snapshot_kind):
    server, req, cfg, cid = setup(balance=5)
    p = payment(req, cfg, cid)
    p.payload.update(
        type="deposit", deposit={"amount": "100", "transaction": "validated-by-facilitator"}
    )
    assert (
        reserve(
            server,
            p,
            req,
            {"channelId": cid, "balance": "5", "totalClaimed": "0", "withdrawRequestedAt": 0},
        )
        is None
    )
    assert server.before_settle(SettleContext(p, req)) is None
    response = SettleResponse(
        success=True,
        transaction="confirmed",
        network=req.network,
        extra={
            "channelState": {
                "channelId": cid,
                "balance": "105",
                "totalClaimed": "0",
                "withdrawRequestedAt": 0,
            }
        },
    )
    ctx = SettleResultContext(p, req, result=response)
    if snapshot_kind == "missing":
        response.extra = {"channelId": cid}
    elif snapshot_kind == "malformed":
        response.extra["channelState"]["balance"] = "invalid"
    elif snapshot_kind == "closing":
        response.extra["channelState"]["withdrawRequestedAt"] = int(time.time())
    # Confirmation may arrive after the handler's reservation deadline.
    state = server.store.get(cid)
    next(iter(state.reservations.values())).expires_at = time.time() - 1
    server.store.put(state)
    server.after_settle(ctx)
    server.after_settle(ctx)
    assert server.store.get(cid).deposit == 105
    assert server.store.get(cid).charged_cumulative_amount == 10
    assert server.enrich_settlement_response(ctx)["chargedAmount"] == "10"
    assert not server.store.get(cid).reservations
    assert server.store.get(cid).status == ("closing" if snapshot_kind == "closing" else "open")
    if snapshot_kind in ("missing", "malformed"):
        assert server.store.get(cid).onchain_synced_at == 0


@pytest.mark.parametrize("snapshot", [None, {"balance": "bad", "totalClaimed": "0"}])
@pytest.mark.parametrize("with_operator", [False, True])
def test_confirmed_refund_without_usable_snapshot_stops_accepting_payments(snapshot, with_operator):
    server, req, cfg, cid = setup()
    if with_operator:
        server.config.operator = OPERATOR
        req.extra["voucherSigner"] = "client"
    p = payment(req, cfg, cid, amount=0)
    p.payload["type"] = "refund"
    assert not isinstance(reserve(server, p, req), AbortResult)
    result = SettleResponse(
        success=True,
        transaction="closed",
        network=req.network,
        extra={"channelId": cid, "channelState": snapshot},
    )
    server.after_settle(SettleResultContext(p, req, result=result))
    state = server.store.get(cid)
    assert state.status == "closing"
    assert state.onchain_synced_at == 0
    assert not state.reservations
    assert state.highest_voucher == p.payload["voucher"]
    assert not server._requests
    assert reserve(server, payment(req, cfg, cid), req).reason == BatchError.CHANNEL_CLOSING


@pytest.mark.parametrize("next_deposit", [20, 200])
def test_consecutive_topups_without_snapshots_preserve_confirmed_escrow(next_deposit):
    server, req, cfg, cid = setup(balance=5)
    for index, amount in enumerate((100, next_deposit), start=1):
        p = payment(req, cfg, cid, amount=index * 10)
        p.payload.update(
            type="deposit", deposit={"amount": str(amount), "transaction": f"validated-{index}"}
        )
        assert reserve(server, p, req) is None
        response = SettleResponse(
            success=True, transaction=f"confirmed-{index}", network=req.network
        )
        server.after_settle(SettleResultContext(p, req, result=response))
        assert server.store.get(cid).onchain_synced_at == 0
    state = server.store.get(cid)
    assert state.deposit == 105 + next_deposit
    assert state.charged_cumulative_amount == 20
    assert state.signed_max_claimable == 20
    assert not state.reservations


def test_inflight_deposit_reservation_survives_deadline_and_another_server_worker():
    server, req, cfg, cid = setup(True, balance=5)
    p = payment(req, cfg, cid)
    p.payload.update(type="deposit", deposit={"amount": "100", "transaction": "validated"})
    assert reserve(server, p, req) is None
    state = server.store.get(cid)
    next(iter(state.reservations.values())).expires_at = time.time() - 1
    server.store.put(state)
    other = BatchSvmScheme(
        BatchSvmServerConfig(receiver_authorizer=AUTH, operator=OPERATOR, store=server.store)
    )
    for index, worker in enumerate((server, other)):
        next_payment = payment(req, cfg, cid, request_id=f"later-{index}")
        assert reserve(worker, next_payment, req).reason == BatchError.CHANNEL_BUSY
    response = SettleResponse(success=True, transaction="confirmed", network=req.network)
    server.after_settle(SettleResultContext(p, req, result=response))
    state = server.store.get(cid)
    assert state.deposit == 105
    assert state.charged_cumulative_amount == 10
    assert not state.reservations
    assert cid not in server._bookkeeping_failures


def test_confirmed_settlement_storage_failure_is_logged_and_blocks_new_charges(monkeypatch, caplog):
    server, req, cfg, cid = setup()
    p = payment(req, cfg, cid)
    p.payload.update(type="deposit", deposit={"amount": "100", "transaction": "validated"})
    assert reserve(server, p, req) is None

    def unavailable(*_):
        raise OSError("storage unavailable")

    monkeypatch.setattr(server.store, "update", unavailable)
    result = SettleResponse(success=True, transaction="confirmed", network=req.network)
    server.after_settle(SettleResultContext(p, req, result=result))
    assert result.success
    assert not server._requests
    assert "Accounting recovery required for confirmed transaction confirmed" in caplog.text
    rejected = server.before_verify(VerifyContext(payment(req, cfg, cid), req))
    assert rejected.reason == BatchError.CHANNEL_STATE
    assert "accounting recovery" in rejected.message
    monkeypatch.undo()
    state = server.store.get(cid)
    next(iter(state.reservations.values())).expires_at = time.time() - 1
    server.store.put(state)
    restarted = BatchSvmScheme(BatchSvmServerConfig(receiver_authorizer=AUTH, store=server.store))
    assert reserve(restarted, payment(req, cfg, cid), req).reason == BatchError.CHANNEL_BUSY


@pytest.mark.parametrize("minimum", [5_000_000, 5.0, True])
def test_min_deposit_rejects_ambiguous_numeric_amounts(minimum):
    from x402.mechanisms.svm.default_assets import DEFAULT_ASSETS

    server, req, _, _ = setup()
    req = req.model_copy(
        update={"asset": DEFAULT_ASSETS[req.network][0]["asset"], "extra": {"minDeposit": minimum}}
    )
    with pytest.raises(ValueError, match="atomic amount string or a money string"):
        server.resolve_min_deposit_hint(req)


def test_min_deposit_strings_distinguish_atomic_units_and_money():
    from x402.mechanisms.svm.default_assets import DEFAULT_ASSETS

    server, req, _, _ = setup()
    req = req.model_copy(update={"asset": DEFAULT_ASSETS[req.network][0]["asset"]})
    for minimum in ("5000000", "$5"):
        req.extra["minDeposit"] = minimum
        assert server.resolve_min_deposit_hint(req) == "5000000"


def test_delegated_server_requires_advertised_receiver_authorizer():
    server = BatchSvmScheme()
    _, req, _, _ = setup()
    supported = SupportedKind(
        x402_version=2,
        scheme=server.scheme,
        network=req.network,
        extra={"feePayer": str(FEE.pubkey())},
    )
    assert "receiver_authorizer" in server.validate_facilitator_support(req.network, supported, [])
    supported.extra["receiverAuthorizer"] = str(AUTH.pubkey())
    enhanced = server.enhance_payment_requirements(req, supported, [])
    assert enhanced.extra["receiverAuthorizer"] == str(AUTH.pubkey())
    assert enhanced.extra["minDeposit"] == "100"
    assert "assetTransferMethod" not in enhanced.extra


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.payload["channelConfig"].update(receiver=str(PAYER.pubkey())),
        lambda p: p.payload["voucher"].update(expiresAt=1),
        lambda p: p.payload["voucher"].update(maxClaimableAmount="11"),
        lambda p: p.payload["channelConfig"].update(openSlot=True),
    ],
)
def test_binding_or_signature_tampering_aborts(mutate):
    server, req, cfg, cid = setup()
    p = payment(req, cfg, cid)
    mutate(p)
    assert isinstance(reserve(server, p, req), AbortResult)
    assert not server.store.get(cid).reservations


@pytest.mark.parametrize("asynchronous", [False, True])
def test_core_dispatches_batch_hooks_and_metered_settlement(asynchronous):
    import asyncio

    from x402 import x402ResourceServer, x402ResourceServerSync
    from x402.schemas import SupportedResponse

    scheme, req, cfg, cid = setup(True)

    class Facilitator:
        def get_supported(self):
            return SupportedResponse(
                kinds=[
                    SupportedKind(
                        x402_version=2, scheme=req.scheme, network=req.network, extra=req.extra
                    )
                ]
            )

        def verify(self, *_):
            raise AssertionError("Fresh offchain authorization should verify locally")

        def settle(self, *_):
            raise AssertionError("Offchain acceptance must not settle onchain")

    core = (x402ResourceServer if asynchronous else x402ResourceServerSync)(Facilitator())
    core.register(req.network, scheme)
    core.initialize()
    p = payment(req, cfg, cid)
    verified = core.verify_payment(p, req)
    if asynchronous:
        verified = asyncio.run(verified)
    assert verified.is_valid
    settled = core.settle_payment(p, req.model_copy(update={"amount": "4"}))
    if asynchronous:
        settled = asyncio.run(settled)
    assert settled.success
    assert settled.extra["chargedAmount"] == "4"
    assert settled.extra["voucher"]["maxClaimableAmount"] == "4"
    assert scheme.store.get(cid).charged_cumulative_amount == 4


@pytest.mark.parametrize("with_snapshot", [False, True])
def test_initial_deposit_full_core_flow_keeps_request_identity_and_enriches_receipt(with_snapshot):
    from solders.hash import Hash

    from x402 import x402ResourceServerSync
    from x402.mechanisms.svm.payment_channels import ChannelSplit, build_open_transaction
    from x402.schemas import SupportedResponse

    _, req, cfg, cid = setup(True)
    scheme = BatchSvmScheme(BatchSvmServerConfig(operator=OPERATOR, receiver_authorizer=AUTH))
    p = payment(req, cfg, cid)
    p.payload.update(
        type="deposit",
        deposit={
            "amount": "100",
            "transaction": build_open_transaction(
                payer=PAYER,
                fee_payer=str(FEE.pubkey()),
                payee=str(FEE.pubkey()),
                mint=req.asset,
                authorized_signer=cfg["payerAuthorizer"],
                token_program=TOKEN_PROGRAM_ADDRESS,
                deposit=100,
                salt=7,
                open_slot=123,
                grace_period=900,
                blockhash=str(Hash.default()),
                recipients=[ChannelSplit(req.pay_to, 10_000)],
                binding_memo=f"x402:batch-settlement:svm:rcvauth:v1:{cfg['receiverAuthorizer']}",
            ),
        },
    )

    class Facilitator:
        def get_supported(self):
            return SupportedResponse(
                kinds=[
                    SupportedKind(
                        x402_version=2, scheme=req.scheme, network=req.network, extra=req.extra
                    )
                ]
            )

        def verify(self, payload, requirements):
            return VerifyResponse(is_valid=True, extra={"channelId": cid})

        def settle(self, payload, requirements):
            return SettleResponse(
                success=True,
                transaction="confirmed",
                network=req.network,
                extra={
                    "channelState": {
                        "channelId": cid,
                        "balance": "100",
                        "totalClaimed": "0",
                        "withdrawRequestedAt": 0,
                    }
                }
                if with_snapshot
                else {"channelId": cid},
            )

    core = x402ResourceServerSync(Facilitator()).register(req.network, scheme)
    core.initialize()
    assert core.verify_payment(p, req).is_valid
    result = core.settle_payment(p, req.model_copy(update={"amount": "4"}))
    assert result.success
    assert result.extra["chargedAmount"] == "4"
    assert result.extra["voucher"]["maxClaimableAmount"] == "4"
    assert scheme.store.get(cid).deposit == 100


def test_known_token_2022_asset_uses_registry_program():
    from x402.mechanisms.svm.constants import SOLANA_MAINNET_CAIP2, TOKEN_2022_PROGRAM_ADDRESS
    from x402.mechanisms.svm.default_assets import DEFAULT_ASSETS

    server, req, _, _ = setup()
    asset = next(
        a
        for a in DEFAULT_ASSETS[SOLANA_MAINNET_CAIP2]
        if a["token_program"] == TOKEN_2022_PROGRAM_ADDRESS
    )
    req = req.model_copy(
        update={"network": SOLANA_MAINNET_CAIP2, "asset": asset["asset"], "extra": {}}
    )
    supported = SupportedKind(
        x402_version=2,
        scheme=req.scheme,
        network=req.network,
        extra={"feePayer": str(FEE.pubkey())},
    )
    assert (
        server.enhance_payment_requirements(req, supported, []).extra["tokenProgram"]
        == TOKEN_2022_PROGRAM_ADDRESS
    )


@pytest.mark.parametrize("asynchronous", [False, True])
def test_http_corrective_402_after_refresh_contains_signed_voucher_state(asynchronous):
    import asyncio
    from unittest.mock import MagicMock

    from x402 import x402ResourceServer, x402ResourceServerSync
    from x402.http.types import HTTPRequestContext, PaymentOption, RouteConfig
    from x402.http.utils import decode_payment_required_header, encode_payment_signature_header
    from x402.http.x402_http_server import x402HTTPResourceServer, x402HTTPResourceServerSync
    from x402.schemas import SupportedResponse

    scheme, req, cfg, cid = setup(fresh=False)
    state = scheme.store.get(cid)
    state.charged_cumulative_amount = state.signed_max_claimable = 30
    state.highest_voucher = payment(req, cfg, cid, amount=30).payload["voucher"]
    scheme.store.put(state)

    class Facilitator:
        verify_calls = 0

        def get_supported(self):
            return SupportedResponse(
                kinds=[
                    SupportedKind(
                        x402_version=2, scheme=req.scheme, network=req.network, extra=req.extra
                    )
                ]
            )

        def verify(self, *_):
            self.verify_calls += 1
            return VerifyResponse(
                is_valid=True,
                extra={"channelId": cid, "balance": "100", "totalClaimed": "0"},
            )

    class AsyncFacilitator(Facilitator):
        async def verify(self, *args):
            return super().verify(*args)

    facilitator = AsyncFacilitator() if asynchronous else Facilitator()
    core = (x402ResourceServer if asynchronous else x402ResourceServerSync)(facilitator)
    core.register(req.network, scheme).initialize()
    http = (x402HTTPResourceServer if asynchronous else x402HTTPResourceServerSync)(
        core,
        {
            "GET /paid": RouteConfig(
                accepts=PaymentOption(
                    scheme=req.scheme,
                    network=req.network,
                    pay_to=req.pay_to,
                    price={"asset": req.asset, "amount": req.amount},
                    extra=req.extra,
                    max_timeout_seconds=60,
                )
            )
        },
    )
    adapter = MagicMock()
    adapter.get_header.return_value = None
    adapter.get_url.return_value = "https://merchant.example/paid"
    adapter.get_accept_header.return_value = "application/json"
    adapter.get_user_agent.return_value = "batch-test"
    context = HTTPRequestContext(adapter=adapter, path="/paid", method="GET")

    def process():
        result = http.process_http_request(context)
        return asyncio.run(result) if asynchronous else result

    offered = process()
    offered_req = decode_payment_required_header(offered.response.headers["PAYMENT-REQUIRED"])
    payload = payment(offered_req.accepts[0], cfg, cid, amount=20)
    adapter.get_header.side_effect = lambda name: (
        encode_payment_signature_header(payload) if name.lower() == "payment-signature" else None
    )
    result = process()
    assert facilitator.verify_calls == 1  # Mismatch arises in after_verify, after the refresh.
    assert result.type == "payment-error"
    assert result.response.status == 402
    corrected = decode_payment_required_header(result.response.headers["PAYMENT-REQUIRED"])
    assert corrected.error == BatchError.CUMULATIVE_AMOUNT_MISMATCH
    assert corrected.accepts[0].extra["channelState"]["chargedCumulativeAmount"] == "30"
    assert corrected.accepts[0].extra["voucherState"] == {
        "signedMaxClaimable": "30",
        "expiresAt": 0,
        "signature": state.highest_voucher["signature"],
    }
    assert not scheme.store.get(cid).reservations
