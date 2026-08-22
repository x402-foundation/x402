"""Unit tests for resource server extension echo validation.

Covers ``x402ResourceServerBase.validate_extensions``: the generic capability that
ensures a client's echoed extension ``info`` preserves every server-advertised
(non-dynamic) field before the payment reaches the facilitator.
"""

from x402 import x402ResourceServer
from x402.schemas import (
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
)
from x402.server_base import ERR_EXTENSION_ECHO_MISMATCH

BUILDER_CODE = "builder-code"
GAS_SPONSORING = "eip2612-gas-sponsoring"


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        asset="0xabc",
        amount="1000",
        pay_to="0xrecipient",
        max_timeout_seconds=300,
    )


def _payment_required(extensions: dict | None) -> PaymentRequired:
    return PaymentRequired(
        resource=ResourceInfo(url="https://example.com/resource"),
        accepts=[_requirements()],
        extensions=extensions,
    )


def _payment_payload(extensions: dict | None) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"authorization": {}, "signature": "0x"},
        accepted=_requirements(),
        extensions=extensions,
    )


class _DummyExtension:
    """Minimal registered extension exposing optional dynamic info fields."""

    def __init__(self, key: str, dynamic_info_fields: list[str] | None = None) -> None:
        self.key = key
        self.dynamic_info_fields = dynamic_info_fields
        self.hooks = None
        self.transport_hooks = None


def test_passes_when_client_omits_extensions() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    payload = _payment_payload(None)

    assert server.validate_extensions(required, payload).valid


def test_passes_when_no_server_extensions() -> None:
    server = x402ResourceServer()
    required = _payment_required(None)
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": ["svc"]}}})

    assert server.validate_extensions(required, payload).valid


def test_fails_when_client_forges_builder_code_app_code_without_server_declaration() -> None:
    server = x402ResourceServer()
    required = _payment_required(None)
    payload = _payment_payload({BUILDER_CODE: {"info": {"a": "forged_app"}}})

    result = server.validate_extensions(required, payload)
    assert result.valid is False
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_fails_when_client_forges_builder_code_app_code_while_server_declares_other_extensions() -> (
    None
):
    server = x402ResourceServer()
    required = _payment_required(
        {
            "bazaar": {"info": {"tool": "search", "version": 1}},
            "builder": {"info": {"code": "abc"}},
        }
    )
    payload = _payment_payload({BUILDER_CODE: {"info": {"a": "forged_app"}}})

    result = server.validate_extensions(required, payload)
    assert result.valid is False
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_passes_when_client_sends_only_builder_code_service_codes_without_server_declaration() -> (
    None
):
    server = x402ResourceServer()
    required = _payment_required(None)
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": ["bc_client"]}}})

    assert server.validate_extensions(required, payload).valid


def test_fails_when_client_forges_builder_code_app_code_that_mismatches_server_declaration() -> (
    None
):
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_app"}}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"a": "forged_app"}}})

    result = server.validate_extensions(required, payload)
    assert result.valid is False
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_passes_when_builder_code_echo_is_additive() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    # Client re-merge restores server `info.a` + `schema` and adds `info.s`.
    payload = _payment_payload(
        {BUILDER_CODE: {"info": {"a": "bc_myapp", "s": ["svc"]}, "schema": 2}}
    )

    assert server.validate_extensions(required, payload).valid


def test_passes_when_echoed_s_array_is_superset_of_advertised() -> None:
    server = x402ResourceServer()
    required = _payment_required(
        {BUILDER_CODE: {"info": {"a": "bc_myapp", "s": ["bc_server"]}, "schema": 2}}
    )
    payload = _payment_payload(
        {
            BUILDER_CODE: {
                "info": {"a": "bc_myapp", "s": ["bc_server", "bc_client"]},
                "schema": 2,
            }
        }
    )

    assert server.validate_extensions(required, payload).valid


def test_rejects_when_echoed_s_array_drops_advertised_element() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"s": ["bc_server"]}, "schema": 2}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": ["bc_client"]}, "schema": 2}})

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_rejects_when_echoed_s_array_exceeds_the_combined_budget_even_as_a_superset() -> None:
    # Regression test: a hand-crafted echo padding `s` past the combined
    # client+server budget must be rejected outright rather than accepted and
    # left to be silently truncated downstream (e.g. by a facilitator
    # extension), which could crowd out the legitimately advertised entry.
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"s": ["bc_server"]}, "schema": 2}})
    padded = ["bc_server"] + [f"bc_fake_{i}" for i in range(10)]
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": padded}, "schema": 2}})

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_passes_when_echoed_s_array_is_exactly_at_the_combined_budget() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"s": ["bc_server"]}, "schema": 2}})
    at_budget = ["bc_server"] + [f"bc_client_{i}" for i in range(9)]
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": at_budget}, "schema": 2}})

    assert server.validate_extensions(required, payload).valid


def test_passes_when_advertised_s_is_a_scalar_and_echo_is_an_array_containing_it() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"s": "bc_server"}, "schema": 2}})
    payload = _payment_payload(
        {BUILDER_CODE: {"info": {"s": ["bc_server", "bc_client"]}, "schema": 2}}
    )

    assert server.validate_extensions(required, payload).valid


def test_passes_when_advertised_s_is_an_array_and_echo_is_a_matching_scalar() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"s": ["bc_server"]}, "schema": 2}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": "bc_server"}, "schema": 2}})

    assert server.validate_extensions(required, payload).valid


def test_rejects_when_non_builder_code_extension_array_field_gains_an_echoed_element() -> None:
    # Additive-array echo matching is scoped to builder-code's `s`; other
    # extensions' array fields (e.g. sign-in-with-x's `resources`) must still
    # match exactly so clients cannot smuggle extra values into the echo.
    server = x402ResourceServer()
    required = _payment_required(
        {"sign-in-with-x": {"info": {"resources": ["https://api.example.com/data"]}, "schema": 2}}
    )
    payload = _payment_payload(
        {
            "sign-in-with-x": {
                "info": {"resources": ["https://api.example.com/data", "https://evil.example.com"]},
                "schema": 2,
            }
        }
    )

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == "sign-in-with-x"


def test_rejects_when_advertised_field_missing() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": ["svc"]}}})

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_rejects_when_advertised_field_changed() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"a": "bc_attacker"}, "schema": 2}})

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH


def test_passes_when_gas_sponsoring_echo_preserves_server_fields() -> None:
    server = x402ResourceServer()
    required = _payment_required(
        {
            GAS_SPONSORING: {
                "info": {"description": "Gas sponsoring", "version": "1"},
                "schema": {"type": "object"},
            }
        }
    )
    payload = _payment_payload(
        {
            GAS_SPONSORING: {
                "info": {
                    "description": "Gas sponsoring",
                    "version": "1",
                    "from": "0xpayer",
                    "signature": "0xsig",
                },
                "schema": {"type": "object"},
            }
        }
    )

    assert server.validate_extensions(required, payload).valid


def test_passes_when_dynamic_fields_differ() -> None:
    server = x402ResourceServer()
    server.register_extension(
        _DummyExtension("siwx-like", dynamic_info_fields=["nonce", "issuedAt"])
    )
    required = _payment_required(
        {
            "siwx-like": {
                "info": {"domain": "example.com", "nonce": "abc", "issuedAt": "t1"},
            }
        }
    )
    payload = _payment_payload(
        {
            "siwx-like": {
                "info": {"domain": "example.com", "nonce": "xyz", "issuedAt": "t2"},
            }
        }
    )

    assert server.validate_extensions(required, payload).valid


def test_rejects_when_non_dynamic_field_changed_on_dynamic_extension() -> None:
    server = x402ResourceServer()
    server.register_extension(
        _DummyExtension("siwx-like", dynamic_info_fields=["nonce", "issuedAt"])
    )
    required = _payment_required(
        {
            "siwx-like": {
                "info": {"domain": "example.com", "nonce": "abc"},
            }
        }
    )
    payload = _payment_payload(
        {
            "siwx-like": {
                "info": {"domain": "evil.com", "nonce": "xyz"},
            }
        }
    )

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH


def test_skips_v1_payloads() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}}})
    payload = PaymentPayloadV1(
        x402_version=1,
        scheme="exact",
        network="eip155:84532",
        payload={},
    )

    assert server.validate_extensions(required, payload).valid


def test_passes_for_v1_payloads_with_forged_builder_code_app_code() -> None:
    server = x402ResourceServer()
    required = _payment_required(None)
    payload = PaymentPayload(
        x402_version=1,
        payload={"authorization": {}, "signature": "0x"},
        accepted=_requirements(),
        extensions={BUILDER_CODE: {"info": {"a": "forged_app"}}},
    )

    assert server.validate_extensions(required, payload).valid
