"""Exercise registered hooks, real SDK routing and HTTP upfront settlement."""

import asyncio
from unittest.mock import Mock

import pytest
from flask import Flask, request

from x402 import (
    x402Client,
    x402ClientSync,
    x402Facilitator,
    x402FacilitatorSync,
    x402ResourceServer,
    x402ResourceServerSync,
)
from x402.http import decode_payment_required_header, encode_payment_signature_header
from x402.http.middleware.flask import PaymentMiddleware
from x402.mechanisms.lnbtc import (
    MAINNET,
    TESTNET,
    SQLiteReplayStore,
    http_request_binding,
    mcp_request_binding,
)
from x402.mechanisms.lnbtc.exact.client import ExactLnbtcScheme as Client
from x402.mechanisms.lnbtc.exact.facilitator import ExactLnbtcScheme as Facilitator
from x402.mechanisms.lnbtc.exact.server import ExactLnbtcScheme as Server
from x402.schemas import (
    AssetAmount,
    PaymentRequirements,
    ResourceConfig,
    ResourceInfo,
    SupportedKind,
)
from x402.schemas.errors import PaymentAbortedError

from .helpers import NOW, PAYEE, Payer, Receiver, invoice

URL = "https://api.example.com/article/A"


def binding():
    return http_request_binding("GET", URL, public_origin="https://api.example.com")


def sdk_client():
    return x402ClientSync().set_spend_controls(
        {
            "allowed_assets": [
                {"network": network, "asset": "BTC", "max_amount_per_payment": "25000"}
                for network in (MAINNET, TESTNET)
            ]
        }
    )


def requirement():
    return PaymentRequirements(
        scheme="exact",
        network=MAINNET,
        asset="BTC",
        amount="21000",
        pay_to=PAYEE,
        max_timeout_seconds=300,
        extra={**binding().extra(), "paymentFlow": "upfront", "invoice": invoice(binding().digest)},
    )


@pytest.mark.parametrize(
    "overrides,reason",
    [
        ({"invoice": "other"}, "payer_invoice_mismatch"),
        ({"payment_hash": "00" * 32}, "payer_payment_hash_mismatch"),
        ({"amount_msat": 21001}, "payer_amount_mismatch"),
        ({"preimage": None}, "payer_preimage_required"),
        ({"preimage": "FF" * 32}, "payer_preimage_malformed"),
        ({"preimage": "00" * 32}, "payer_preimage_hash_mismatch"),
        ({"status": "unpaid"}, "payment_not_paid"),
        ({"status": "in_flight"}, "payment_in_flight"),
    ],
)
def test_payer_cannot_report_unproven_or_different_payment(overrides, reason):
    payer = Payer(**overrides)
    with pytest.raises(ValueError, match=reason):
        Client(payer, binding, clock=lambda: NOW).create_payment_payload(requirement())
    assert payer.calls == 1


@pytest.mark.parametrize("change", ["digest", "resource", "profile", "expired"])
def test_client_checks_challenge_before_paying(change):
    payer = Payer()
    client = sdk_client().register(MAINNET, Client(payer, binding, clock=lambda: NOW))
    server = x402ResourceServerSync()
    requirements = requirement()
    url = URL
    if change == "digest":
        requirements.extra["requestHash"] = "00" * 32
    elif change == "resource":
        url += "/wrong"
    elif change == "profile":
        requirements.extra.update(
            mcp_request_binding(
                "https://api.example.com/mcp", {"name": "get_article"}, resource_url=URL
            ).extra()
        )
    else:
        requirements.extra["invoice"] = invoice(binding().digest, date=NOW - 301)
    challenge = server.create_payment_required_response(
        [requirements], resource=ResourceInfo(url=url)
    )
    with pytest.raises(Exception, match="(request_mismatch|invoice_expired)"):
        client.create_payment_payload(challenge)
    assert payer.calls == 0


@pytest.mark.parametrize(
    "price,expected",
    [("21 sat", "21000"), ("0.001 sats", "1"), (AssetAmount(asset="BTC", amount="25000"), "25000")],
)
def test_explicit_millisatoshi_prices(price, expected):
    assert Server(Receiver(), binding).parse_price(price, MAINNET).amount == expected


@pytest.mark.parametrize("price", [21, "21", "$1.00", "0 sats", "0.0001 sat", "-1 sat"])
def test_ambiguous_or_fractional_millisatoshi_prices_rejected(price):
    with pytest.raises(ValueError):
        Server(Receiver(), binding).parse_price(price, MAINNET)


def test_invoice_issuance_denied_before_calling_receiver():
    receiver = Receiver()
    server = Server(receiver, binding, allow_invoice=lambda: False)
    with pytest.raises(ValueError, match="invoice_issuance_denied"):
        server.enhance_payment_requirements(
            requirement(), SupportedKind(x402_version=2, scheme="exact", network=MAINNET), []
        )
    assert not receiver.invoices


@pytest.mark.parametrize("network", [MAINNET, TESTNET])
@pytest.mark.parametrize("profile", ["http", "mcp"])
def test_sdk_roundtrip_new_challenge_and_two_distinct_payments(tmp_path, network, profile):
    current = (
        binding()
        if profile == "http"
        else mcp_request_binding(
            "https://api.example.com/mcp",
            {"name": "get_article", "arguments": {"article": "A"}},
            resource_url=URL,
        )
    )
    receiver = Receiver()
    facilitator = x402FacilitatorSync().register(
        [network], Facilitator(SQLiteReplayStore(tmp_path / "payments.db"), clock=lambda: NOW)
    )
    server = x402ResourceServerSync(facilitator).register(
        network, Server(receiver, lambda: current, clock=lambda: NOW)
    )
    server.initialize()
    client = sdk_client().register(
        network, Client(Payer(receiver), lambda: current, clock=lambda: NOW)
    )
    config = ResourceConfig(
        scheme="exact", network=network, pay_to=PAYEE, price="21 sats", max_timeout_seconds=300
    )
    first = server.build_payment_requirements(config)
    second = server.build_payment_requirements(config)
    assert first[0].extra["invoice"] != second[0].extra["invoice"]
    payloads = [
        client.create_payment_payload(
            server.create_payment_required_response(requirements, resource=ResourceInfo(url=URL))
        )
        for requirements in (first, second)
    ]
    for payload in payloads:
        matched = server.find_matching_requirements(second, payload)
        assert matched is not None
        assert server.settle_payment(payload, matched).success
        assert server.settle_payment(payload, matched).error_reason == "duplicate_settlement"


def test_registered_server_hook_rejects_stale_actual_request(tmp_path):
    current = binding()
    receiver = Receiver()
    facilitator = x402FacilitatorSync().register(
        [MAINNET], Facilitator(SQLiteReplayStore(tmp_path / "payments.db"), clock=lambda: NOW)
    )
    server = x402ResourceServerSync(facilitator).register(
        MAINNET, Server(receiver, lambda: current, clock=lambda: NOW)
    )
    server.initialize()
    reqs = server.build_payment_requirements(
        ResourceConfig(scheme="exact", network=MAINNET, pay_to=PAYEE, price="21 sats")
    )
    client = sdk_client().register(
        MAINNET, Client(Payer(receiver), lambda: current, clock=lambda: NOW)
    )
    payload = client.create_payment_payload(
        server.create_payment_required_response(reqs, resource=ResourceInfo(url=URL))
    )
    current = http_request_binding("GET", URL[:-1] + "B", public_origin="https://api.example.com")
    with pytest.raises(PaymentAbortedError, match="request_mismatch"):
        server.settle_payment(payload, reqs[0])
    current = binding()
    assert server.settle_payment(payload, reqs[0]).success


def test_flask_handler_runs_only_after_single_successful_settlement(tmp_path):
    app = Flask(__name__)
    handled = []
    receiver = Receiver()
    mechanism = Facilitator(SQLiteReplayStore(tmp_path / "http.db"), clock=lambda: NOW)
    mechanism.verify = Mock(side_effect=AssertionError("upfront must never verify"))
    facilitator = x402FacilitatorSync().register([MAINNET], mechanism)

    def actual_request():
        return http_request_binding(
            request.method,
            request.url,
            public_origin="https://api.example.com",
            body=request.get_data(),
            headers=list(request.headers),
        )

    server = x402ResourceServerSync(facilitator).register(
        MAINNET, Server(receiver, actual_request, clock=lambda: NOW)
    )
    server.initialize()
    PaymentMiddleware(
        app,
        {
            "GET /article/A": {
                "accepts": {
                    "scheme": "exact",
                    "network": MAINNET,
                    "payTo": PAYEE,
                    "price": "21 sats",
                    "maxTimeoutSeconds": 300,
                }
            }
        },
        server,
        sync_facilitator_on_start=False,
    )

    @app.get("/article/A")
    def article():
        handled.append(True)
        return {"article": "A"}

    browser = app.test_client()
    unpaid = browser.get(URL)
    assert unpaid.status_code == 402
    assert handled == []
    challenge = decode_payment_required_header(unpaid.headers["PAYMENT-REQUIRED"])
    client = sdk_client().register(MAINNET, Client(Payer(receiver), binding, clock=lambda: NOW))
    payload = client.create_payment_payload(challenge)
    header = encode_payment_signature_header(payload)
    paid = browser.get(URL, headers={"PAYMENT-SIGNATURE": header})
    assert paid.status_code == 200, paid.data
    assert len(handled) == 1
    replayed = browser.get(URL, headers={"PAYMENT-SIGNATURE": header})
    assert replayed.status_code == 402
    assert len(handled) == 1
    mechanism.verify.assert_not_called()


def test_async_sdk_roundtrip(tmp_path):
    async def run():
        receiver = Receiver()
        facilitator = x402Facilitator().register(
            [MAINNET], Facilitator(SQLiteReplayStore(tmp_path / "async.db"), clock=lambda: NOW)
        )
        server = x402ResourceServer(facilitator).register(
            MAINNET, Server(receiver, binding, clock=lambda: NOW)
        )
        server.initialize()
        requirements = server.build_payment_requirements(
            ResourceConfig(scheme="exact", network=MAINNET, pay_to=PAYEE, price="21 sats")
        )
        challenge = await server.create_payment_required_response(
            requirements, resource=ResourceInfo(url=URL)
        )
        client = x402Client().register(MAINNET, Client(Payer(receiver), binding, clock=lambda: NOW))
        client.set_spend_controls(
            {
                "allowed_assets": [
                    {"network": MAINNET, "asset": "BTC", "max_amount_per_payment": "21000"}
                ]
            }
        )
        payload = await client.create_payment_payload(challenge)
        assert (await server.settle_payment(payload, requirements[0])).success
        assert (
            await server.settle_payment(payload, requirements[0])
        ).error_reason == "duplicate_settlement"

    asyncio.run(run())
