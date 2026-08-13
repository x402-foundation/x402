"""Unit tests for x402HTTPClient on_payment_required hooks."""

from __future__ import annotations

import pytest

from x402 import x402Client, x402ClientSync
from x402.http.x402_http_client import x402HTTPClient, x402HTTPClientSync
from x402.schemas import PaymentRequired, PaymentRequirements
from x402.schemas.hooks import PaymentRequiredContext, PaymentRequiredHeadersResult


def make_payment_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def make_payment_required() -> PaymentRequired:
    return PaymentRequired(x402_version=2, accepts=[make_payment_requirements()])


class TestOnPaymentRequiredRegistration:
    def test_async_chaining(self):
        client = x402Client()
        http_client = x402HTTPClient(client)
        result = http_client.on_payment_required(lambda ctx: None).on_payment_required(
            lambda ctx: None
        )
        assert result is http_client
        assert len(http_client._payment_required_hooks) == 2

    def test_sync_chaining(self):
        client = x402ClientSync()
        http_client = x402HTTPClientSync(client)
        http_client.on_payment_required(lambda ctx: None)
        assert len(http_client._payment_required_hooks) == 1


class TestHandlePaymentRequired:
    @pytest.mark.asyncio
    async def test_returns_none_without_hooks(self):
        http_client = x402HTTPClient(x402Client())
        assert await http_client.handle_payment_required(make_payment_required()) is None

    @pytest.mark.asyncio
    async def test_returns_headers_from_hook(self):
        http_client = x402HTTPClient(x402Client())
        http_client.on_payment_required(
            lambda ctx: PaymentRequiredHeadersResult(headers={"Authorization": "Bearer t"})
        )
        result = await http_client.handle_payment_required(make_payment_required())
        assert result == {"Authorization": "Bearer t"}

    @pytest.mark.asyncio
    async def test_first_headers_win(self):
        http_client = x402HTTPClient(x402Client())
        order: list[int] = []

        http_client.on_payment_required(
            lambda ctx: order.append(1) or PaymentRequiredHeadersResult(headers={"X-Hook": "first"})
        )
        http_client.on_payment_required(
            lambda ctx: (
                order.append(2) or PaymentRequiredHeadersResult(headers={"X-Hook": "second"})
            )
        )

        result = await http_client.handle_payment_required(make_payment_required())

        assert result == {"X-Hook": "first"}
        assert order == [1]

    @pytest.mark.asyncio
    async def test_skips_void_and_continues(self):
        http_client = x402HTTPClient(x402Client())
        order: list[int] = []

        http_client.on_payment_required(lambda ctx: order.append(1))
        http_client.on_payment_required(
            lambda ctx: (
                order.append(2) or PaymentRequiredHeadersResult(headers={"X-Hook": "second"})
            )
        )

        result = await http_client.handle_payment_required(make_payment_required())

        assert result == {"X-Hook": "second"}
        assert order == [1, 2]

    @pytest.mark.asyncio
    async def test_passes_context(self):
        http_client = x402HTTPClient(x402Client())
        payment_required = make_payment_required()
        received: list[PaymentRequiredContext] = []

        http_client.on_payment_required(lambda ctx: received.append(ctx))

        await http_client.handle_payment_required(payment_required)

        assert len(received) == 1
        assert received[0].payment_required == payment_required

    def test_sync_first_headers_win(self):
        http_client = x402HTTPClientSync(x402ClientSync())
        http_client.on_payment_required(
            lambda ctx: PaymentRequiredHeadersResult(headers={"X-Hook": "first"})
        )
        http_client.on_payment_required(
            lambda ctx: PaymentRequiredHeadersResult(headers={"X-Hook": "second"})
        )
        result = http_client.handle_payment_required(make_payment_required())
        assert result == {"X-Hook": "first"}
