"""Cardano HTTP hosting keeps unrelated requests live during provider work."""

import asyncio
import importlib.util
import os
from pathlib import Path
from threading import Event

import dotenv
import httpx
import pytest

from x402 import x402Facilitator
from x402.mechanisms import cardano
from x402.mechanisms.cardano.exact.facilitator import ExactCardanoScheme
from x402.mechanisms.cardano.types import CardanoSettlementEvidence

from .test_facilitator import payment as payment


@pytest.fixture(
    params=[
        "e2e/facilitators/python/main.py",
        "examples/python/facilitator/advanced/all_networks.py",
    ]
)
def hosted_app(request, monkeypatch, payment):
    root = Path(__file__).resolve().parents[6]
    path = root / request.param
    for key in os.environ:
        if key.endswith(("PRIVATE_KEY", "MNEMONIC")):
            monkeypatch.setenv(key, "")
    monkeypatch.setenv("BLOCKFROST_PROJECT_ID", "preprod-test-only")
    monkeypatch.setenv("CARDANO_NETWORK", "cardano:preprod")
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setattr(cardano, "to_facilitator_cardano_signer", lambda config: payment[2])
    monkeypatch.syspath_prepend(str(root / "e2e/facilitators/python"))
    spec = importlib.util.spec_from_file_location("cardano_host_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["verify", "settle"])
async def test_health_remains_responsive_during_cardano_work(hosted_app, payment, operation):
    payload, requirements, chain = payment
    entered, release = Event(), Event()
    hooks = []

    async def before(context):
        hooks.append("before")
        await asyncio.sleep(0)

    async def after(context):
        hooks.append("after")

    if operation == "verify":
        get_utxo = chain.get_utxo

        def delayed_utxo(*args):
            entered.set()
            release.wait(0.5)
            return get_utxo(*args)

        chain.get_utxo = delayed_utxo
    else:

        def evidence(*args):
            if chain.submissions:
                entered.set()
            return (
                CardanoSettlementEvidence("confirmed", 1)
                if release.is_set()
                else CardanoSettlementEvidence("unknown", -2)
            )

        chain.get_transaction_evidence = evidence

    facilitator = x402Facilitator().register(
        [requirements.network],
        ExactCardanoScheme(chain, confirmation_timeout_ms=500, confirmation_poll_ms=25),
    )
    getattr(facilitator, f"on_before_{operation}")(before)
    getattr(facilitator, f"on_after_{operation}")(after)
    hosted_app.facilitator = facilitator
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=hosted_app.app), base_url="http://test"
    ) as client:
        pending = asyncio.create_task(
            client.post(
                f"/{operation}",
                json={
                    "paymentPayload": payload.model_dump(by_alias=True),
                    "paymentRequirements": requirements.model_dump(by_alias=True),
                },
            )
        )
        try:

            async def wait_for_provider():
                while not entered.is_set():
                    await asyncio.sleep(0.001)

            await asyncio.wait_for(wait_for_provider(), 2)
            health = await client.get("/health")
            progressed_while_pending = not pending.done()
        finally:
            release.set()
            response = await pending
        assert health.status_code == 200
        assert progressed_while_pending, "Cardano provider work blocked the request event loop"
        assert response.status_code == 200
        assert response.json()["isValid" if operation == "verify" else "success"] is True
        assert hooks == ["before", "after"]
