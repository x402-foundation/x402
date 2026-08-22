"""Tests for the builder-code client extension."""

import pytest

from x402 import x402Client, x402ResourceServer
from x402.extensions.builder_code import (
    BUILDER_CODE,
    MAX_CLIENT_SERVICE_CODES,
    BuilderCodeClientExtension,
    declare_builder_code_extension,
)
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo
from x402.server_base import ERR_EXTENSION_ECHO_MISMATCH

APP = "bc_my_app"
SERVICE = "bc_my_client"


def _base_payload(extensions: dict | None = None) -> PaymentPayload:
    return PaymentPayload(
        payload={},
        accepted=PaymentRequirements(
            scheme="exact",
            network="eip155:8453",
            asset="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            amount="1000",
            pay_to="0x0000000000000000000000000000000000000001",
            max_timeout_seconds=300,
        ),
        extensions=extensions,
    )


def _payment_required(app_code: str | None = None) -> PaymentRequired:
    extensions = {BUILDER_CODE: declare_builder_code_extension(app_code)} if app_code else None
    return PaymentRequired(
        resource=ResourceInfo(url="https://example.com/resource"), accepts=[], extensions=extensions
    )


class TestConstructorValidation:
    def test_rejects_invalid_single_code(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            BuilderCodeClientExtension("Bad-Code")

    def test_rejects_when_any_array_entry_invalid(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            BuilderCodeClientExtension([SERVICE, "Bad-Code"])

    def test_rejects_too_many_service_codes(self) -> None:
        too_many = [f"bc_{i}" for i in range(MAX_CLIENT_SERVICE_CODES + 1)]
        with pytest.raises(ValueError, match="Too many service codes"):
            BuilderCodeClientExtension(too_many)

    def test_accepts_exactly_max_client_service_codes(self) -> None:
        at_max = [f"bc_{i}" for i in range(MAX_CLIENT_SERVICE_CODES)]
        BuilderCodeClientExtension(at_max)


class TestEnrichPaymentPayload:
    def test_attaches_single_service_code(self) -> None:
        client = BuilderCodeClientExtension(SERVICE)
        enriched = client.enrich_payment_payload(_base_payload(), _payment_required(APP))
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE]}}

    def test_attaches_multiple_service_codes(self) -> None:
        client = BuilderCodeClientExtension([SERVICE, "bc_other"])
        enriched = client.enrich_payment_payload(_base_payload(), _payment_required(APP))
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE, "bc_other"]}}

    def test_preserves_unrelated_extensions(self) -> None:
        client = BuilderCodeClientExtension(SERVICE)
        payload = _base_payload({"other": {"kept": True}})
        enriched = client.enrich_payment_payload(payload, _payment_required(APP))
        assert enriched.extensions["other"] == {"kept": True}
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE]}}

    def test_attaches_service_codes_without_server_declaration(self) -> None:
        client = BuilderCodeClientExtension(SERVICE)
        enriched = client.enrich_payment_payload(_base_payload(), _payment_required(None))
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE]}}


class _MockSchemeClient:
    scheme = "exact"

    def find_default_asset(self, asset, _network=None):
        return {"asset": asset, "decimals": 6, "symbol": "MOCK"}

    def create_payment_payload(self, requirements):
        return {"mock": "payload", "network": requirements.network}


class TestBuilderCodeClientIntegration:
    @pytest.mark.asyncio
    async def test_attaches_service_codes_when_server_omits_builder_code(self) -> None:
        client = x402Client()
        client.register("eip155:8453", _MockSchemeClient())
        client.register_extension(BuilderCodeClientExtension(SERVICE))

        payment_required = PaymentRequired(
            resource=ResourceInfo(url="https://example.com/resource"),
            x402_version=2,
            accepts=[
                PaymentRequirements(
                    scheme="exact",
                    network="eip155:8453",
                    asset="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                    amount="1000",
                    pay_to="0x0000000000000000000000000000000000000001",
                    max_timeout_seconds=300,
                )
            ],
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE]}}

    @pytest.mark.asyncio
    async def test_merges_server_and_client_service_codes_when_both_declare_s(self) -> None:
        client = x402Client()
        client.register("eip155:8453", _MockSchemeClient())
        client.register_extension(BuilderCodeClientExtension(SERVICE))

        payment_required = PaymentRequired(
            resource=ResourceInfo(url="https://example.com/resource"),
            x402_version=2,
            accepts=[
                PaymentRequirements(
                    scheme="exact",
                    network="eip155:8453",
                    asset="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                    amount="1000",
                    pay_to="0x0000000000000000000000000000000000000001",
                    max_timeout_seconds=300,
                )
            ],
            extensions={BUILDER_CODE: declare_builder_code_extension(APP, "bc_server_sdk")},
        )
        payload = await client.create_payment_payload(payment_required)
        assert payload.extensions is not None
        assert payload.extensions[BUILDER_CODE] == {
            "info": {"a": APP, "s": [SERVICE, "bc_server_sdk"]},
            "schema": payment_required.extensions[BUILDER_CODE]["schema"],
        }

    @pytest.mark.asyncio
    async def test_rejects_forged_builder_code_app_code_when_server_did_not_declare_builder_code(
        self,
    ) -> None:
        client = x402Client()
        client.register("eip155:8453", _MockSchemeClient())
        client.register_extension(BuilderCodeClientExtension(SERVICE))
        server = x402ResourceServer()

        payment_required = PaymentRequired(
            resource=ResourceInfo(url="https://example.com/resource"),
            x402_version=2,
            accepts=[
                PaymentRequirements(
                    scheme="exact",
                    network="eip155:8453",
                    asset="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                    amount="1000",
                    pay_to="0x0000000000000000000000000000000000000001",
                    max_timeout_seconds=300,
                )
            ],
        )
        payment_payload = await client.create_payment_payload(payment_required)
        payment_payload.extensions = {
            **(payment_payload.extensions or {}),
            BUILDER_CODE: {
                "info": {"a": "forged_app", "s": [SERVICE]},
            },
        }

        result = server.validate_extensions(payment_required, payment_payload)
        assert result.valid is False
        assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
        assert result.extension_key == BUILDER_CODE
