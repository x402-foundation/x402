"""Unit tests for server 402 and settlement enrichment hooks."""

import asyncio

import pytest

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)


class MockFacilitatorClient:
    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=2,
                    scheme="exact",
                    network="eip155:8453",
                )
            ],
            extensions=[],
            signers={},
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        return VerifyResponse(is_valid=True)

    async def settle(self, payload, requirements) -> SettleResponse:
        return SettleResponse(
            success=True,
            transaction="0xsettled",
            network=requirements.network,
            amount="1000",
        )


class MockFacilitatorClientSync(MockFacilitatorClient):
    def verify(self, payload, requirements) -> VerifyResponse:
        return VerifyResponse(is_valid=True)

    def settle(self, payload, requirements) -> SettleResponse:
        return SettleResponse(
            success=True,
            transaction="0xsettled",
            network=requirements.network,
            amount="1000",
        )


class SchemeEnrichServer:
    scheme = "exact"

    def parse_price(self, price, network):
        from x402.schemas import AssetAmount

        return AssetAmount(amount="1000", asset="0xusdc")

    def enhance_payment_requirements(self, requirements, supported_kind, extensions):
        return requirements

    def enrich_payment_required_response(self, context):
        accepts = list(context.requirements)
        accepts[0] = accepts[0].model_copy(
            update={"extra": {**accepts[0].extra, "scheme_enriched": True}}
        )
        return accepts

    def enrich_settlement_response(self, context):
        return {"scheme_extra": "ok"}


class ExtensionEnrich402:
    key = "test-ext"

    def enrich_declaration(self, declaration, transport_context):
        return declaration

    def enrich_payment_required_response(self, declaration, context):
        context.requirements[0].pay_to = "0xfilled"
        return {"enriched": True, "declaration": declaration}


class ExtensionEnrichSettle:
    key = "settle-ext"

    def enrich_declaration(self, declaration, transport_context):
        return declaration

    def enrich_settlement_response(self, declaration, context):
        return {"settle_ext": declaration}


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0xasset",
        amount="1000",
        pay_to="",
        max_timeout_seconds=300,
        extra={},
    )


def _payload(requirements: PaymentRequirements) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"sig": "0x1"},
        accepted=requirements,
    )


@pytest.mark.asyncio
async def test_create_payment_required_response_scheme_and_extension_enrich() -> None:
    server = x402ResourceServer(MockFacilitatorClient())
    server.register("eip155:8453", SchemeEnrichServer())
    server.register_extension(ExtensionEnrich402())
    server.initialize()

    response = await server.create_payment_required_response(
        [_requirements()],
        ResourceInfo(url="https://example.com/resource"),
        extensions={"test-ext": {"route": "a"}},
    )

    assert response.accepts[0].extra.get("scheme_enriched") is True
    assert response.accepts[0].pay_to == "0xfilled"
    assert response.extensions == {"test-ext": {"enriched": True, "declaration": {"route": "a"}}}


def test_create_payment_required_response_sync() -> None:
    server = x402ResourceServerSync(MockFacilitatorClientSync())
    server.register("eip155:8453", SchemeEnrichServer())
    server.register_extension(ExtensionEnrich402())
    server.initialize()

    response = server.create_payment_required_response(
        [_requirements()],
        extensions={"test-ext": {"route": "a"}},
    )

    assert response.accepts[0].extra.get("scheme_enriched") is True
    assert response.extensions["test-ext"]["enriched"] is True


@pytest.mark.asyncio
async def test_settle_payment_extension_and_scheme_enrich() -> None:
    server = x402ResourceServer(MockFacilitatorClient())
    server.register("eip155:8453", SchemeEnrichServer())
    server.register_extension(ExtensionEnrichSettle())
    server.initialize()

    requirements = _requirements().model_copy(update={"pay_to": "0xpayto"})
    payload = _payload(requirements)

    result = await server.settle_payment(
        payload,
        requirements,
        declared_extensions={"settle-ext": {"note": "x"}},
    )

    assert result.success is True
    assert result.extensions == {"settle-ext": {"settle_ext": {"note": "x"}}}
    assert result.extra == {"scheme_extra": "ok"}


def test_extension_enrich_policy_violation_raises() -> None:
    class BadExtension:
        key = "bad"

        def enrich_declaration(self, declaration, transport_context):
            return declaration

        def enrich_payment_required_response(self, declaration, context):
            context.requirements[0].scheme = "hijacked"
            return declaration

    server = x402ResourceServerSync(MockFacilitatorClientSync())
    server.register_extension(BadExtension())
    server.initialize()

    with pytest.raises(ValueError, match="scheme/network"):
        server.create_payment_required_response(
            [_requirements()],
            extensions={"bad": {}},
        )


@pytest.mark.asyncio
async def test_async_extension_enrich_hook() -> None:
    class AsyncExtension:
        key = "async-ext"

        def enrich_declaration(self, declaration, transport_context):
            return declaration

        async def enrich_payment_required_response(self, declaration, context):
            await asyncio.sleep(0)
            return {"async": True}

    server = x402ResourceServer(MockFacilitatorClient())
    server.register_extension(AsyncExtension())
    server.initialize()

    response = await server.create_payment_required_response(
        [_requirements()],
        extensions={"async-ext": {}},
    )
    assert response.extensions == {"async-ext": {"async": True}}
