"""Managed custody keeps admission and charging at the remote facilitator."""

from __future__ import annotations

import asyncio
import gc
import weakref
from types import SimpleNamespace

import pytest

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.interfaces import SchemePaymentRequiredContext
from x402.mechanisms.evm.batch_settlement.client.channel import (
    BatchSettlementClientDeps,
    build_channel_config,
)
from x402.mechanisms.evm.batch_settlement.client.storage import InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.constants import MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY
from x402.mechanisms.evm.batch_settlement.errors import (
    ERR_CHANNEL_ID_MISMATCH,
    ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
    ERR_CUMULATIVE_AMOUNT_MISMATCH,
    ERR_DEPOSIT_BELOW_MIN_DEPOSIT,
    ERR_REFUND_AMOUNT_INVALID,
    ERR_REFUND_NO_BALANCE,
    ERR_UNEXPECTED_CANCEL,
    ERR_UNEXPECTED_PENDING_ID,
    ERR_VOUCHER_STORE_MODE_MISMATCH,
)
from x402.mechanisms.evm.batch_settlement.server.scheme import (
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeServerConfig,
)
from x402.mechanisms.evm.batch_settlement.server.storage import InMemoryChannelStorage
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
from x402.schemas import (
    AbortResult,
    AfterSettleAbortError,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)
from x402.schemas.hooks import (
    SettleContext,
    SettleFailureContext,
    SettleResultContext,
    VerifiedPaymentCanceledContext,
    VerifiedPaymentCancelOptions,
    VerifyContext,
    VerifyResultContext,
)

NETWORK = "eip155:8453"
RECEIVER = "0x3333333333333333333333333333333333333333"
AUTHORIZER = "0x4444444444444444444444444444444444444444"
REFUND_AUTHORIZER = "0x5555555555555555555555555555555555555555"
PAYER = "0x1111111111111111111111111111111111111111"
TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


class Signer:
    address = REFUND_AUTHORIZER

    def __init__(self):
        self.signed = []

    def sign_typed_data(self, **kwargs):
        self.signed.append(kwargs)
        return "0x" + "ab" * 65


def scheme(**kwargs):
    return BatchSettlementEvmScheme(
        RECEIVER,
        BatchSettlementEvmSchemeServerConfig(voucher_store_mode="facilitator", **kwargs),
    )


def supported(**overrides):
    return SupportedKind(
        x402_version=2,
        scheme="batch-settlement",
        network=NETWORK,
        extra={
            "voucherManager": ["server", "facilitator"],
            "receiverAuthorizer": AUTHORIZER,
            "withdrawDelay": 1800,
            "delegatedRefund": True,
            **overrides,
        },
    )


def requirements(**extra):
    return PaymentRequirements(
        scheme="batch-settlement",
        network=NETWORK,
        asset=TOKEN,
        amount="100",
        pay_to=RECEIVER,
        max_timeout_seconds=60,
        extra={
            "voucherManager": "facilitator",
            "receiverAuthorizer": AUTHORIZER,
            "withdrawDelay": 1800,
            **extra,
        },
    )


def payload(kind="voucher", amount=None):
    req = requirements()
    config = build_channel_config(
        BatchSettlementClientDeps(
            SimpleNamespace(address=PAYER), InMemoryClientChannelStorage(), "1"
        ),
        req,
    )
    raw = {
        "type": kind,
        "channelConfig": config.to_dict(),
        "voucher": {
            "channelId": compute_channel_id(config, NETWORK),
            "maxClaimableAmount": "100",
            "signature": "0x" + "11" * 65,
        },
    }
    if kind == "deposit":
        raw["deposit"] = {"amount": "1000", "authorization": {}}
    if amount is not None:
        raw["amount"] = amount
    return PaymentPayload(x402_version=2, accepted=req, payload=raw)


def channel_state(charged="100", balance="1000", **overrides):
    return {
        "chargedCumulativeAmount": charged,
        "balance": balance,
        "totalClaimed": "50",
        "refundNonce": "7",
        "withdrawRequestedAt": 0,
        **overrides,
    }


def admit(s, p, pending_id="reservation-1"):
    assert s.before_verify(VerifyContext(payment_payload=p, requirements=p.accepted)) is None
    return s.after_verify(
        VerifyResultContext(
            payment_payload=p,
            requirements=p.accepted,
            result=VerifyResponse(
                is_valid=True,
                payer=PAYER,
                extra={
                    "pendingId": pending_id,
                    "balance": "1000",
                    "chargedCumulativeAmount": "100",
                    "totalClaimed": "50",
                    "refundNonce": "7",
                    "withdrawRequestedAt": 0,
                },
            ),
        )
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("voucherManager", ["server"]),
        ("voucherManager", "facilitator"),
        ("receiverAuthorizer", "0x" + "00" * 20),
        ("receiverAuthorizer", "bad"),
        ("withdrawDelay", True),
        ("withdrawDelay", "1800"),
        ("withdrawDelay", MIN_WITHDRAW_DELAY - 1),
        ("withdrawDelay", MAX_WITHDRAW_DELAY + 1),
        ("delegatedRefund", False),
    ],
)
def test_invalid_capabilities_fail_startup(field, value):
    assert scheme().validate_facilitator_support(NETWORK, supported(**{field: value}), [])


def test_requirements_copy_remote_delay_and_separate_refund_key():
    signer = Signer()
    s = scheme(withdraw_delay=900, refund_authorizer_signer=signer)
    req = s.enhance_payment_requirements(requirements(), supported(delegatedRefund=False), [])
    assert req.extra["withdrawDelay"] == 1800
    assert req.extra["receiverAuthorizer"] == AUTHORIZER
    assert req.extra["refundAuthorizer"] == signer.address
    assert req.extra["voucherManager"] == "facilitator"
    assert s.validate_facilitator_support(NETWORK, supported(delegatedRefund=False), []) is None


def test_default_mode_preserves_existing_server_custody():
    s = BatchSettlementEvmScheme(RECEIVER)
    req = requirements()
    assert (
        s.before_verify(VerifyContext(payment_payload=payload(), requirements=req)).reason
        == ERR_VOUCHER_STORE_MODE_MISMATCH
    )
    assert (
        s.settle_on_cancel(
            VerifiedPaymentCanceledContext(
                payment_payload=payload(), requirements=req, reason="handler_failed"
            )
        )
        is None
    )


@pytest.mark.parametrize(
    "field,reason", [("pendingId", ERR_UNEXPECTED_PENDING_ID), ("cancel", ERR_UNEXPECTED_CANCEL)]
)
def test_client_cannot_supply_server_reservation_fields(field, reason):
    p = payload()
    p.payload[field] = False
    assert (
        scheme().before_verify(VerifyContext(payment_payload=p, requirements=p.accepted)).reason
        == reason
    )


def test_managed_server_checks_channel_binding_and_opt_in_deposit_policy():
    s, p = scheme(enforce_min_deposit=True), payload("deposit")
    p.payload["deposit"]["amount"] = "10"
    assert (
        s.before_verify(VerifyContext(payment_payload=p, requirements=p.accepted)).reason
        == ERR_DEPOSIT_BELOW_MIN_DEPOSIT
    )
    p.payload["deposit"]["amount"] = "1000"
    p.payload["voucher"]["channelId"] = "0x" + "12" * 32
    assert (
        s.before_verify(VerifyContext(payment_payload=p, requirements=p.accepted)).reason
        == ERR_CHANNEL_ID_MISMATCH
    )


def test_remote_reservation_forwarded_without_local_storage_reads():
    class UnavailableStore(InMemoryChannelStorage):
        def get(self, key):
            raise AssertionError("local store cannot authorize requests")

    s, p = scheme(storage=UnavailableStore()), payload()
    admit(s, p)
    ctx = SettleContext(payment_payload=p, requirements=p.accepted)
    assert s.before_settle(ctx) is None
    assert s.enrich_settlement_payload(ctx) == {"pendingId": "reservation-1"}


@pytest.mark.parametrize("kind", ["deposit", "voucher", "refund"])
@pytest.mark.parametrize("reason", ["handler_failed", "handler_threw", "after_verify_aborted"])
def test_cancel_only_releases_remote_admission(kind, reason):
    s, p = scheme(), payload(kind)
    admit(s, p)
    ctx = VerifiedPaymentCanceledContext(
        payment_payload=p, requirements=p.accepted, reason=reason, phase="cancel"
    )
    s.on_verified_payment_canceled(ctx)
    req = s.settle_on_cancel(ctx)
    assert req.amount == "0"
    assert p.accepted.amount == "100"
    assert s.enrich_settlement_payload(ctx) == {"pendingId": "reservation-1", "cancel": True}
    s.after_settle(
        SettleResultContext(
            payment_payload=p,
            requirements=req,
            phase="cancel",
            result=SettleResponse(success=True, transaction="", network=NETWORK),
        )
    )
    assert s.read_request_context(p) is None
    assert s.get_storage().get(p.payload["voucher"]["channelId"]) is None


def test_refund_uses_remote_snapshot_and_only_refund_signature():
    signer = Signer()
    s, p = scheme(refund_authorizer_signer=signer), payload("refund")
    directive = admit(s, p)
    assert directive.response.body["refunded"] is True
    fields = s.enrich_settlement_payload(SettleContext(payment_payload=p, requirements=p.accepted))
    assert fields["amount"] == "900"
    assert fields["refundNonce"] == "7"
    assert fields["claims"][0]["totalClaimed"] == "100"
    assert "claimAuthorizerSignature" not in fields
    assert fields["refundAuthorizerSignature"].startswith("0xab")
    assert signer.signed[0]["primary_type"] == "Refund"
    assert signer.signed[0]["message"]["amount"] == 900


@pytest.mark.parametrize(
    "amount,reason",
    [
        ("0", ERR_REFUND_AMOUNT_INVALID),
        ("1.5", ERR_REFUND_AMOUNT_INVALID),
        ("-1", ERR_REFUND_AMOUNT_INVALID),
        ("901", ERR_REFUND_NO_BALANCE),
    ],
)
def test_refund_validates_requested_amount(amount, reason):
    s, p = scheme(), payload("refund", amount)
    admit(s, p)
    with pytest.raises(ValueError, match=reason):
        s.enrich_settlement_payload(SettleContext(payment_payload=p, requirements=p.accepted))


def test_delegated_partial_refund_needs_no_local_signer():
    s, p = scheme(), payload("refund", "200")
    admit(s, p)
    fields = s.enrich_settlement_payload(SettleContext(payment_payload=p, requirements=p.accepted))
    assert fields["refundNonce"] == "7"
    assert "amount" not in fields  # Preserve the buyer's signed amount.
    assert "refundAuthorizerSignature" not in fields
    assert "claimAuthorizerSignature" not in fields


@pytest.mark.parametrize(
    "reason", [ERR_CUMULATIVE_AMOUNT_MISMATCH, ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED]
)
def test_corrective_402_preserves_both_facilitator_snapshots(reason):
    s, p = scheme(), payload()
    channel = {
        "channelId": p.payload["voucher"]["channelId"],
        "balance": "1000",
        "totalClaimed": "50",
        "withdrawRequestedAt": 0,
        "refundNonce": "7",
        "chargedCumulativeAmount": "400",
    }
    voucher = {"signedMaxClaimable": "400", "signature": "0x" + "22" * 65}
    s.after_verify(
        VerifyResultContext(
            payment_payload=p,
            requirements=p.accepted,
            result=VerifyResponse(
                is_valid=False,
                invalid_reason=reason,
                extra={"channelState": channel, "voucherState": voucher},
            ),
        )
    )
    ctx = SchemePaymentRequiredContext(
        requirements=[p.accepted],
        resource_info=None,
        error=reason,
        payment_required_response=PaymentRequired(x402_version=2, accepts=[p.accepted]),
        payment_payload=p,
    )
    assert s.enrich_payment_required_response(ctx)[0].extra["channelState"] == channel
    assert p.accepted.extra["voucherState"] == voucher
    assert s.read_request_context(p) is None


@pytest.mark.parametrize(
    "extra",
    [{}, {"channelState": {}, "voucherState": {}}, {"channelState": "invalid", "voucherState": {}}],
)
def test_incomplete_corrective_state_does_not_create_a_local_proof(extra):
    s, p = scheme(), payload()
    s.after_verify(
        VerifyResultContext(
            payment_payload=p,
            requirements=p.accepted,
            result=VerifyResponse(
                is_valid=False, invalid_reason=ERR_CUMULATIVE_AMOUNT_MISMATCH, extra=extra
            ),
        )
    )
    assert s.read_request_context(p) is None


def test_replica_failure_retains_success_and_cleans_context(caplog):
    class BrokenReplica(InMemoryChannelStorage):
        def update_channel(self, key, updater):
            raise OSError("replica offline")

    s, p = scheme(storage=BrokenReplica()), payload()
    admit(s, p)
    result = SettleResponse(
        success=True,
        transaction="",
        network=NETWORK,
        extra={"chargedAmount": "100", "chargeCount": 2, "channelState": channel_state("200")},
    )
    s.after_settle(SettleResultContext(payment_payload=p, requirements=p.accepted, result=result))
    assert result.success and result.extra["chargeCount"] == 2
    assert s.read_request_context(p) is None
    assert "replica offline" in caplog.text


def test_settlement_failure_retains_request_for_reconciliation():
    s, p = scheme(), payload()
    admit(s, p)
    s.on_settle_failure(
        SettleFailureContext(
            payment_payload=p, requirements=p.accepted, error=RuntimeError("offline")
        )
    )
    assert s.read_request_context(p).pending_id == "reservation-1"


def test_replica_watermark_never_regresses_on_older_voucher_receipt():
    s = scheme()
    for watermark in ("400", "200"):
        p = payload()
        admit(s, p)
        result = SettleResponse(
            success=True,
            transaction="",
            network=NETWORK,
            extra={"channelState": channel_state(watermark)},
        )
        s.after_settle(
            SettleResultContext(payment_payload=p, requirements=p.accepted, result=result)
        )
    assert s.get_storage().get(p.payload["voucher"]["channelId"]).charged_cumulative_amount == "400"


@pytest.mark.parametrize("balance,retained", [("800", True), ("100", False)])
def test_refund_replica_applies_remote_remainder(balance, retained):
    s, p = scheme(), payload("refund", "200")
    admit(s, p)
    result = SettleResponse(
        success=True,
        transaction="0xrefund",
        network=NETWORK,
        extra={
            "channelState": {
                "balance": balance,
                "chargedCumulativeAmount": "100",
                "refundNonce": "8",
                "totalClaimed": "100",
                "withdrawRequestedAt": 0,
            }
        },
    )
    s.after_settle(SettleResultContext(payment_payload=p, requirements=p.accepted, result=result))
    replica = s.get_storage().get(p.payload["voucher"]["channelId"])
    assert (replica is not None) is retained
    if retained:
        assert replica.balance == balance and replica.refund_nonce == 8
    assert s.read_request_context(p) is None


class Facilitator:
    """In-process Go wire-shape fixture; no RPC or funds."""

    def __init__(self):
        self.calls = []

    def get_supported(self):
        return SupportedResponse(kinds=[supported()], extensions=[], signers={})

    def verify(self, p, req):
        self.calls.append(("verify", p, req))
        return VerifyResponse(
            is_valid=True,
            payer=PAYER,
            extra={
                "pendingId": "remote-reservation",
                **channel_state("100" if p.payload["type"] == "refund" else "0"),
            },
        )

    def settle(self, p, req):
        self.calls.append(("settle", p, req))
        return SettleResponse(
            success=True,
            transaction="",
            network=NETWORK,
            extra={
                "chargedAmount": "0"
                if p.payload["type"] == "refund" or p.payload.get("cancel")
                else req.amount,
                "chargeCount": 1,
                "channelState": channel_state(),
            },
        )


class AsyncFacilitator(Facilitator):
    async def verify(self, p, req):
        return super().verify(p, req)

    async def settle(self, p, req):
        return super().settle(p, req)


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.parametrize("kind", ["deposit", "voucher"])
def test_core_routes_payment_to_facilitator_and_cancellation_once(async_mode, cancel, kind):
    remote = AsyncFacilitator() if async_mode else Facilitator()
    s, p = scheme(), payload(kind)
    server = x402ResourceServer(remote) if async_mode else x402ResourceServerSync(remote)
    server.register(NETWORK, s)
    server.initialize()

    async def run_async():
        assert (await server.verify_payment(p, p.accepted)).is_valid
        if cancel:
            dispatcher = server.create_payment_cancellation_dispatcher(p, p.accepted)
            result = await dispatcher.cancel(VerifiedPaymentCancelOptions(reason="handler_failed"))
            assert (
                await dispatcher.cancel(VerifiedPaymentCancelOptions(reason="handler_failed"))
                is result
            )
            return result
        return await server.settle_payment(p, p.accepted)

    if async_mode:
        result = asyncio.run(run_async())
    else:
        assert server.verify_payment(p, p.accepted).is_valid
        if cancel:
            dispatcher = server.create_payment_cancellation_dispatcher(p, p.accepted)
            result = dispatcher.cancel_sync(VerifiedPaymentCancelOptions(reason="handler_failed"))
            assert (
                dispatcher.cancel_sync(VerifiedPaymentCancelOptions(reason="handler_failed"))
                is result
            )
        else:
            result = server.settle_payment(p, p.accepted)
    assert result.success
    assert [call[0] for call in remote.calls] == ["verify", "settle"]
    assert remote.calls[1][1].payload["pendingId"] == "remote-reservation"
    assert remote.calls[1][2].amount == ("0" if cancel else "100")
    assert remote.calls[1][1].payload.get("cancel", False) is cancel
    assert result.extra["chargedAmount"] == ("0" if cancel else "100")
    assert result.extra["chargeCount"] == 1
    assert "pendingId" not in p.payload
    assert s.read_request_context(p) is None


@pytest.mark.parametrize("async_mode", [False, True])
def test_application_after_verify_abort_still_cancels_remote_reservation(async_mode):
    remote = AsyncFacilitator() if async_mode else Facilitator()
    s, p = scheme(), payload()
    server = (
        x402ResourceServer(remote) if async_mode else x402ResourceServerSync(remote)
    ).register(NETWORK, s)
    server.on_after_verify(lambda _: AbortResult(reason="application_declined"))
    server.initialize()
    if async_mode:
        result = asyncio.run(server.verify_payment(p, p.accepted))
    else:
        result = server.verify_payment(p, p.accepted)
    assert not result.is_valid and result.invalid_reason == "application_declined"
    assert [call[0] for call in remote.calls] == ["verify", "settle"]
    assert remote.calls[1][1].payload["pendingId"] == "remote-reservation"
    assert remote.calls[1][1].payload["cancel"] is True
    assert remote.calls[1][2].amount == "0"
    assert s.read_request_context(p) is None


@pytest.mark.parametrize("async_mode", [False, True])
def test_application_after_settle_abort_does_not_retain_a_dead_request(async_mode):
    remote = AsyncFacilitator() if async_mode else Facilitator()
    s, p = scheme(), payload()
    server = (
        x402ResourceServer(remote) if async_mode else x402ResourceServerSync(remote)
    ).register(NETWORK, s)

    def abort(_):
        raise AfterSettleAbortError("application_declined")

    server.on_after_settle(abort)
    server.initialize()

    async def run(request_payload):
        assert (await server.verify_payment(request_payload, request_payload.accepted)).is_valid
        return await server.settle_payment(request_payload, request_payload.accepted)

    if async_mode:
        result = asyncio.run(run(p))
    else:
        assert server.verify_payment(p, p.accepted).is_valid
        result = server.settle_payment(p, p.accepted)
    assert not result.success and result.error_reason == "application_declined"
    assert [call[0] for call in remote.calls] == ["verify", "settle"]
    reference = weakref.ref(p)
    remote.calls.clear()
    del p
    gc.collect()
    assert reference() is None
    assert s._request_contexts == {}
    assert s._request_payload_refs == {}


@pytest.mark.parametrize("kind,status", [("voucher", 200), ("voucher", 500), ("refund", 200)])
def test_flask_http_challenge_handler_and_settlement(kind, status):
    pytest.importorskip("flask")
    from flask import Flask

    from x402.http.middleware.flask import payment_middleware
    from x402.http.utils import (
        decode_payment_required_header,
        decode_payment_response_header,
        encode_payment_signature_header,
    )

    remote, s = Facilitator(), scheme()
    server = x402ResourceServerSync(remote).register(NETWORK, s)
    server.initialize()
    app = Flask(__name__)
    app.config["TESTING"] = True
    payment_middleware(
        app,
        {
            "GET /paid": {
                "accepts": {
                    "scheme": "batch-settlement",
                    "network": NETWORK,
                    "payTo": RECEIVER,
                    "price": {"amount": "100", "asset": TOKEN},
                }
            }
        },
        server,
        sync_facilitator_on_start=False,
    )
    invoked = []

    @app.get("/paid")
    def paid():
        invoked.append(True)
        return "paid", status

    client = app.test_client()
    challenge = client.get("/paid")
    assert challenge.status_code == 402
    req = decode_payment_required_header(challenge.headers["PAYMENT-REQUIRED"]).accepts[0]
    assert req.extra["voucherManager"] == "facilitator"
    p = payload(kind)
    p.accepted = req
    response = client.get(
        "/paid", headers={"PAYMENT-SIGNATURE": encode_payment_signature_header(p)}
    )
    assert response.status_code == status
    assert len(invoked) == (0 if kind == "refund" else 1)
    settles = [call for call in remote.calls if call[0] == "settle"]
    assert len(settles) == 1
    assert settles[0][1].payload["pendingId"] == "remote-reservation"
    if status == 500:
        assert settles[0][1].payload["cancel"] is True
        assert settles[0][2].amount == "0"
    else:
        receipt = decode_payment_response_header(response.headers["PAYMENT-RESPONSE"])
        assert receipt.success and receipt.extra["chargeCount"] == 1


@pytest.mark.parametrize(
    "kind,status,throws",
    [
        ("voucher", 200, False),
        ("voucher", 500, False),
        ("voucher", 500, True),
        ("refund", 200, False),
    ],
)
def test_fastapi_http_challenge_handler_and_settlement(kind, status, throws):
    pytest.importorskip("fastapi")
    import httpx
    from fastapi import FastAPI
    from starlette.responses import PlainTextResponse

    from x402.http.middleware.fastapi import payment_middleware
    from x402.http.utils import (
        decode_payment_required_header,
        decode_payment_response_header,
        encode_payment_signature_header,
    )

    remote, s = AsyncFacilitator(), scheme()
    server = x402ResourceServer(remote).register(NETWORK, s)
    server.initialize()
    app = FastAPI()
    app.middleware("http")(
        payment_middleware(
            {
                "GET /paid": {
                    "accepts": {
                        "scheme": "batch-settlement",
                        "network": NETWORK,
                        "payTo": RECEIVER,
                        "price": {"amount": "100", "asset": TOKEN},
                    }
                }
            },
            server,
            sync_facilitator_on_start=False,
        )
    )
    invoked = []

    @app.get("/paid")
    async def paid():
        invoked.append(True)
        if throws:
            raise RuntimeError("handler failed")
        return PlainTextResponse("paid", status_code=status)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://resource.test",
        ) as client:
            challenge = await client.get("/paid")
            assert challenge.status_code == 402
            req = decode_payment_required_header(challenge.headers["PAYMENT-REQUIRED"]).accepts[0]
            assert req.extra["voucherManager"] == "facilitator"
            p = payload(kind)
            p.accepted = req
            response = await client.get(
                "/paid", headers={"PAYMENT-SIGNATURE": encode_payment_signature_header(p)}
            )
            assert response.status_code == status
            assert len(invoked) == (0 if kind == "refund" else 1)
            settles = [call for call in remote.calls if call[0] == "settle"]
            assert len(settles) == 1
            assert settles[0][1].payload["pendingId"] == "remote-reservation"
            if status == 500:
                assert settles[0][1].payload["cancel"] is True
                assert settles[0][2].amount == "0"
            else:
                receipt = decode_payment_response_header(response.headers["PAYMENT-RESPONSE"])
                assert receipt.success and receipt.extra["chargeCount"] == 1

    asyncio.run(run())


@pytest.mark.parametrize("async_mode", [False, True])
def test_channel_manager_cannot_refund_managed_replica(async_mode):
    s = scheme()
    if async_mode:
        manager = s.create_channel_manager(AsyncFacilitator(), NETWORK)

        async def run():
            with pytest.raises(ValueError, match="client-initiated"):
                await manager.refund()
            with pytest.raises(ValueError, match="client-initiated"):
                await manager.refund_idle_channels(60)
            await manager._run_refund_job()

        asyncio.run(run())
    else:
        manager = s.create_channel_manager_sync(Facilitator(), NETWORK)
        with pytest.raises(ValueError, match="client-initiated"):
            manager.refund()
        with pytest.raises(ValueError, match="client-initiated"):
            manager.refund_idle_channels(60)
        manager._run_refund_job()


@pytest.mark.parametrize("async_mode", [False, True])
def test_two_servers_use_shared_facilitator_through_real_http_adapter(async_mode):
    import json

    import httpx

    from x402.http import FacilitatorConfig, HTTPFacilitatorClient, HTTPFacilitatorClientSync

    charged, charges, operations = 0, 0, []

    def handle(request):
        nonlocal charged, charges
        operations.append(request.url.path)
        if request.url.path == "/supported":
            return httpx.Response(
                200,
                json=SupportedResponse(kinds=[supported()], extensions=[], signers={}).model_dump(
                    by_alias=True
                ),
            )
        body = json.loads(request.content)
        raw, req = body["paymentPayload"]["payload"], body["paymentRequirements"]
        if request.url.path == "/verify":
            assert "pendingId" not in raw
            assert int(raw["voucher"]["maxClaimableAmount"]) == charged + int(req["amount"])
            return httpx.Response(
                200,
                json={
                    "isValid": True,
                    "payer": PAYER,
                    "extra": {
                        "pendingId": f"remote-{charges}",
                        "balance": "1000",
                        "chargedCumulativeAmount": str(charged),
                        "totalClaimed": "0",
                        "refundNonce": "0",
                        "withdrawRequestedAt": 0,
                    },
                },
            )
        assert request.url.path == "/settle"
        assert raw["pendingId"] == f"remote-{charges}"
        charged += int(req["amount"])
        charges += 1
        return httpx.Response(
            200,
            json={
                "success": True,
                "transaction": "",
                "network": NETWORK,
                "extra": {
                    "chargedAmount": req["amount"],
                    "chargeCount": charges,
                    "channelState": channel_state(str(charged), totalClaimed="0", refundNonce="0"),
                },
            },
        )

    transport = httpx.MockTransport(handle)
    if async_mode:
        http = httpx.AsyncClient(transport=transport)
        remote = HTTPFacilitatorClient(
            FacilitatorConfig(url="https://facilitator.test", http_client=http)
        )
        remote._get_sync_client = lambda: httpx.Client(transport=transport)
    else:
        http = httpx.Client(transport=transport)
        remote = HTTPFacilitatorClientSync(
            FacilitatorConfig(url="https://facilitator.test", http_client=http)
        )
    servers = []
    for _ in range(2):
        s = scheme()
        server = (
            x402ResourceServer(remote) if async_mode else x402ResourceServerSync(remote)
        ).register(NETWORK, s)
        server.initialize()
        servers.append((server, s))

    async def run():
        for i, (server, s) in enumerate(servers):
            p = payload()
            p.payload["voucher"]["maxClaimableAmount"] = str(100 * (i + 1))
            if async_mode:
                assert (await server.verify_payment(p, p.accepted)).is_valid
                result = await server.settle_payment(p, p.accepted)
            else:
                assert server.verify_payment(p, p.accepted).is_valid
                result = server.settle_payment(p, p.accepted)
            assert result.success and result.extra["chargeCount"] == i + 1
            assert s.read_request_context(p) is None
        if async_mode:
            await http.aclose()
        else:
            http.close()

    asyncio.run(run())
    assert charged == 200 and charges == 2
    assert operations.count("/verify") == operations.count("/settle") == 2
