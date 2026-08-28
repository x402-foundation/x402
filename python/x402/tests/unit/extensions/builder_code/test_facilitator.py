"""Tests for the builder-code facilitator extension."""

import pytest

from x402.extensions.builder_code import (
    BUILDER_CODE,
    MAX_CLIENT_SERVICE_CODES,
    MAX_SERVER_SERVICE_CODES,
    BuilderCodeExtensionData,
    BuilderCodeFacilitatorExtension,
    parse_builder_code_suffix_from_calldata,
)
from x402.schemas import PaymentPayload, PaymentRequirements

APP = "bc_my_app"
SERVICE = "bc_my_client"
WALLET = "bc_my_facilitator"

_REQUIREMENTS = PaymentRequirements(
    scheme="exact",
    network="eip155:8453",
    asset="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amount="1000",
    pay_to="0x0000000000000000000000000000000000000001",
    max_timeout_seconds=300,
)


def _payload(extensions: dict | None = None) -> PaymentPayload:
    return PaymentPayload(payload={}, accepted=_REQUIREMENTS, extensions=extensions)


def _parse(ext: BuilderCodeFacilitatorExtension, payload: PaymentPayload):
    suffix = ext.build_data_suffix(payload, _REQUIREMENTS)
    assert suffix is not None
    return parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")


class TestConstructorValidation:
    def test_rejects_invalid_wallet_code(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            BuilderCodeFacilitatorExtension(builder_code="X-bad")

    def test_rejects_invalid_service_code(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            BuilderCodeFacilitatorExtension(service_code="Bad-Code")

    def test_default_key(self) -> None:
        assert BuilderCodeFacilitatorExtension().key == BUILDER_CODE


class TestBuildDataSuffix:
    def test_encodes_wallet_code_only(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        assert _parse(ext, _payload()) == BuilderCodeExtensionData(w=WALLET)

    def test_wallet_code_optional(self) -> None:
        ext = BuilderCodeFacilitatorExtension()
        payload = _payload({BUILDER_CODE: {"info": {"a": APP, "s": SERVICE}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(a=APP, s=[SERVICE])

    def test_none_when_no_attribution(self) -> None:
        ext = BuilderCodeFacilitatorExtension()
        assert ext.build_data_suffix(_payload(), _REQUIREMENTS) is None

    def test_reads_client_app_and_service(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        payload = _payload({BUILDER_CODE: {"info": {"a": APP, "s": SERVICE}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(a=APP, w=WALLET, s=[SERVICE])

    def test_keeps_valid_service_entries_drops_invalid(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        payload = _payload(
            {BUILDER_CODE: {"info": {"s": ["INVALID", SERVICE, "bc_other"]}, "schema": {}}}
        )
        assert _parse(ext, payload) == BuilderCodeExtensionData(w=WALLET, s=[SERVICE, "bc_other"])

    def test_truncates_echoed_service_codes_to_client_plus_server_budget(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        codes = [f"bc_{i}" for i in range(1, 12)]
        payload = _payload({BUILDER_CODE: {"info": {"s": codes}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(
            w=WALLET, s=[f"bc_{i}" for i in range(1, 11)]
        )

    def test_filters_invalid_before_truncating_to_echoed_budget(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        payload = _payload(
            {
                BUILDER_CODE: {
                    "info": {"s": ["INVALID", *[f"bc_{i}" for i in range(1, 13)]]},
                    "schema": {},
                }
            }
        )
        assert _parse(ext, payload) == BuilderCodeExtensionData(
            w=WALLET, s=[f"bc_{i}" for i in range(1, 11)]
        )

    def test_does_not_drop_entries_when_client_and_server_each_use_full_reservation(
        self,
    ) -> None:
        # Regression test: client provides MAX_CLIENT_SERVICE_CODES codes and server
        # provides MAX_SERVER_SERVICE_CODES codes; neither side should crowd out the
        # other. This simulates what the core merge would have already concatenated.
        client_codes = ["bc_c1", "bc_c2", "bc_c3", "bc_c4", "bc_c5"]
        server_codes = ["bc_s1", "bc_s2", "bc_s3", "bc_s4", "bc_s5"]
        assert len(client_codes) == MAX_CLIENT_SERVICE_CODES
        assert len(server_codes) == MAX_SERVER_SERVICE_CODES
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        payload = _payload(
            {BUILDER_CODE: {"info": {"s": client_codes + server_codes}, "schema": {}}}
        )
        assert _parse(ext, payload) == BuilderCodeExtensionData(
            w=WALLET, s=client_codes + server_codes
        )

    def test_ignores_invalid_client_service_string(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        payload = _payload({BUILDER_CODE: {"info": {"s": "Also_Invalid"}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(w=WALLET)

    def test_ignores_invalid_client_app_code(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET)
        payload = _payload({BUILDER_CODE: {"info": {"a": "Bad-App"}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(w=WALLET)


class TestFacilitatorServiceCode:
    def test_appends_facilitator_service_code_after_echoed_codes(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET, service_code="bc_fac")
        payload = _payload({BUILDER_CODE: {"info": {"s": [SERVICE]}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(w=WALLET, s=[SERVICE, "bc_fac"])

    def test_does_not_duplicate_facilitator_service_code_when_already_echoed(self) -> None:
        ext = BuilderCodeFacilitatorExtension(builder_code=WALLET, service_code=SERVICE)
        payload = _payload({BUILDER_CODE: {"info": {"s": [SERVICE]}, "schema": {}}})
        assert _parse(ext, payload) == BuilderCodeExtensionData(w=WALLET, s=[SERVICE])
