"""Unit tests for payment-flow resolution, wire extra, and HTTP orchestration."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from x402 import (
    PAYMENT_FLOWS,
    SDK_DEFAULT_ASSET_TRANSFER_METHOD,
    PaymentFlowPhases,
    ResolvedPaymentFlow,
    apply_payment_flow_wire_extra,
    resolve_failure_path_settlement,
    resolve_payment_flow,
    x402ResourceServer,
)
from x402.http.types import (
    HTTPRequestContext,
    PaymentOption,
    RouteConfig,
)
from x402.http.utils import decode_payment_response_header, encode_payment_signature_header
from x402.http.x402_http_server import x402HTTPResourceServer
from x402.schemas import (
    AbortResult,
    PaymentPayload,
    PaymentRequirements,
    ResourceConfig,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)
from x402.schemas.hooks import CompletedSettlement, VerifiedPaymentCancelOptions

NETWORK = "eip155:8453"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


class MockFacilitatorClient:
    def __init__(
        self,
        *,
        settle_response: SettleResponse | None = None,
        verify_response: VerifyResponse | None = None,
    ) -> None:
        self.verify_calls: list = []
        self.settle_calls: list = []
        self._settle_response = settle_response
        self._verify_response = verify_response or VerifyResponse(is_valid=True)

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[SupportedKind(x402_version=2, scheme="exact", network=NETWORK)],
            extensions=[],
            signers={},
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        return self._verify_response

    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        if self._settle_response is not None:
            return self._settle_response
        return SettleResponse(success=True, transaction="0xtx", network=requirements.network)

    def set_settle_response(self, response: SettleResponse) -> None:
        self._settle_response = response


class FlowScheme:
    scheme = "exact"
    default_asset_transfer_method = "default"
    payment_flows = {
        "default": {"supported": ("authorization",), "default": "authorization"},
    }

    def __init__(self, flow: str = "authorization") -> None:
        self.payment_flows = {"default": {"supported": (flow,), "default": flow}}

    def parse_price(self, price, network):
        @dataclass
        class AssetAmount:
            asset: str
            amount: str
            extra: dict | None = None

        return AssetAmount(asset=USDC, amount="1000000", extra={})

    def enhance_payment_requirements(self, requirements, supported_kind, extensions):
        return requirements


class ExactEvmLikeScheme(FlowScheme):
    default_asset_transfer_method = "eip3009"
    payment_flows = {
        "eip3009": {"supported": ("authorization", "upfront"), "default": "authorization"},
        "permit2": {"supported": ("authorization", "upfront"), "default": "authorization"},
    }

    def __init__(self) -> None:
        pass


exact_evm_like_scheme = ExactEvmLikeScheme()


class MockHTTPAdapter:
    def __init__(self, headers: dict[str, str] | None = None) -> None:
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}

    def get_header(self, name: str) -> str | None:
        return self._headers.get(name.lower())

    def get_method(self) -> str:
        return "GET"

    def get_path(self) -> str:
        return "/api/test"

    def get_url(self) -> str:
        return "https://example.com/api/test"

    def get_accept_header(self) -> str:
        return "application/json"

    def get_user_agent(self) -> str:
        return "TestClient/1.0"

    def get_query_params(self) -> dict[str, str]:
        return {}

    def get_query_param(self, name: str) -> str | None:
        return None

    def get_body(self):
        return None


def build_requirements(**overrides) -> PaymentRequirements:
    base = {
        "scheme": "exact",
        "network": NETWORK,
        "asset": USDC,
        "amount": "1000000",
        "pay_to": "0xabc",
        "max_timeout_seconds": 300,
        "extra": {},
    }
    extra = overrides.pop("extra", None)
    base.update(overrides)
    if extra is not None:
        base["extra"] = extra
    return PaymentRequirements(**base)


def build_payload(*, accepted: PaymentRequirements | None = None, payload: dict | None = None):
    requirements = accepted or build_requirements()
    return PaymentPayload(payload=payload or {}, accepted=requirements)


def build_settle_response(**overrides) -> SettleResponse:
    base = {
        "success": True,
        "transaction": "0xtx",
        "network": NETWORK,
    }
    base.update(overrides)
    return SettleResponse(**base)


class TestResolvePaymentFlow:
    def test_omits_atm_and_payment_flow_to_scheme_defaults(self) -> None:
        resolved = resolve_payment_flow(exact_evm_like_scheme, build_requirements(extra={}))
        assert resolved == ResolvedPaymentFlow(
            asset_transfer_method="eip3009",
            payment_flow="authorization",
        )

    def test_resolves_explicit_defaults_the_same_as_omitted(self) -> None:
        resolved = resolve_payment_flow(
            exact_evm_like_scheme,
            build_requirements(
                extra={"assetTransferMethod": "eip3009", "paymentFlow": "authorization"}
            ),
        )
        assert resolved == ResolvedPaymentFlow(
            asset_transfer_method="eip3009",
            payment_flow="authorization",
        )

    def test_resolves_upfront_and_permit2_atm(self) -> None:
        resolved = resolve_payment_flow(
            exact_evm_like_scheme,
            build_requirements(extra={"assetTransferMethod": "permit2", "paymentFlow": "upfront"}),
        )
        assert resolved == ResolvedPaymentFlow(
            asset_transfer_method="permit2",
            payment_flow="upfront",
        )

    def test_throws_on_unknown_atm(self) -> None:
        with pytest.raises(ValueError, match='does not support assetTransferMethod "unknown"'):
            resolve_payment_flow(
                exact_evm_like_scheme,
                build_requirements(extra={"assetTransferMethod": "unknown"}),
            )

    def test_throws_on_unsupported_flow(self) -> None:
        with pytest.raises(ValueError, match='does not support paymentFlow "escrow"'):
            resolve_payment_flow(
                exact_evm_like_scheme,
                build_requirements(extra={"paymentFlow": "escrow"}),
            )


class TestResolveFailurePathSettlement:
    def test_prefers_successful_cancel_receipt_over_before_handler_deposit(self) -> None:
        cancel = build_settle_response(success=True, amount="0", transaction="0xrefund")
        before = CompletedSettlement(
            phase="before-handler",
            flow="escrow",
            result=build_settle_response(success=True, amount="100000", transaction="0xdeposit"),
            requirements=build_requirements(),
        )
        assert resolve_failure_path_settlement(cancel, before, build_payload()) == cancel

    def test_builds_failed_cancel_receipt_with_deposit_recovery_extra(self) -> None:
        cancel = build_settle_response(
            success=False,
            error_reason="refund_failed",
            transaction="should-not-appear",
        )
        before = CompletedSettlement(
            phase="before-handler",
            flow="escrow",
            result=build_settle_response(success=True, amount="100000", transaction="0xdeposit"),
            requirements=build_requirements(),
        )
        receipt = resolve_failure_path_settlement(
            cancel,
            before,
            build_payload(payload={"channelId": "channel-123"}),
        )
        assert receipt is not None
        assert receipt.success is False
        assert receipt.error_reason == "refund_failed"
        assert receipt.transaction == ""
        assert receipt.extra == {
            "depositTransaction": "0xdeposit",
            "depositAmount": "100000",
            "channelId": "channel-123",
        }

    def test_echoes_before_handler_deposit_when_cancel_is_none(self) -> None:
        before = CompletedSettlement(
            phase="before-handler",
            flow="upfront",
            result=build_settle_response(success=True, amount="100000", transaction="0xdeposit"),
            requirements=build_requirements(),
        )
        assert resolve_failure_path_settlement(None, before) == before.result

    def test_returns_none_when_neither_receipt_applies(self) -> None:
        assert resolve_failure_path_settlement(None) is None
        assert resolve_failure_path_settlement(None, None, build_payload()) is None


class TestApplyPaymentFlowWireExtra:
    def test_leaves_authorization_alone(self) -> None:
        assert apply_payment_flow_wire_extra(
            {"name": "USDC"},
            ResolvedPaymentFlow(asset_transfer_method="eip3009", payment_flow="authorization"),
        ) == {"name": "USDC"}

    def test_forces_non_authorization_payment_flow_onto_extra(self) -> None:
        assert apply_payment_flow_wire_extra(
            {},
            ResolvedPaymentFlow(asset_transfer_method="eip3009", payment_flow="upfront"),
        ) == {"paymentFlow": "upfront"}
        assert apply_payment_flow_wire_extra(
            {},
            ResolvedPaymentFlow(asset_transfer_method="default", payment_flow="escrow"),
        ) == {"paymentFlow": "escrow"}

    def test_strips_sdk_atm_sentinel(self) -> None:
        assert apply_payment_flow_wire_extra(
            {"assetTransferMethod": SDK_DEFAULT_ASSET_TRANSFER_METHOD, "name": "USDC"},
            ResolvedPaymentFlow(
                asset_transfer_method=SDK_DEFAULT_ASSET_TRANSFER_METHOD,
                payment_flow="authorization",
            ),
        ) == {"name": "USDC"}


class TestVocabulary:
    def test_authorization_phase_table(self) -> None:
        assert PAYMENT_FLOWS["authorization"] == PaymentFlowPhases(
            verify_before_handler=True,
            settle_before_handler=False,
            settle_after_handler=True,
        )

    @pytest.mark.asyncio
    async def test_get_payment_flow_returns_table_default(self) -> None:
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.register(NETWORK, FlowScheme("authorization"))
        server.initialize()
        assert (
            server.get_payment_flow(build_payload(), build_requirements(scheme="exact"))
            == "authorization"
        )

    @pytest.mark.asyncio
    async def test_build_payment_requirements_rejects_unsupported_escrow(self) -> None:
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.register(NETWORK, ExactEvmLikeScheme())
        server.initialize()
        with pytest.raises(ValueError, match='does not support paymentFlow "escrow"'):
            server.build_payment_requirements(
                ResourceConfig(
                    scheme="exact",
                    pay_to="0xabc",
                    price="$1.00",
                    network=NETWORK,
                    extra={"paymentFlow": "escrow"},
                )
            )

    @pytest.mark.asyncio
    async def test_build_payment_requirements_emits_payment_flow_for_escrow_default(self) -> None:
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.register(NETWORK, FlowScheme("escrow"))
        server.initialize()
        requirements = server.build_payment_requirements(
            ResourceConfig(scheme="exact", pay_to="0xabc", price="$1.00", network=NETWORK)
        )
        assert requirements[0].extra.get("paymentFlow") == "escrow"
        assert "assetTransferMethod" not in requirements[0].extra


class TestSettlePaymentPhase:
    @pytest.mark.asyncio
    async def test_passes_phase_on_settle_context_to_before_settle_hooks(self) -> None:
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.register(NETWORK, FlowScheme("authorization"))
        server.initialize()
        phases: list[str] = []
        server.on_before_settle(lambda ctx: phases.append(ctx.phase))
        requirements = build_requirements()
        await server.settle_payment(
            build_payload(accepted=requirements),
            requirements,
            phase="before-handler",
        )
        assert phases == ["before-handler"]

    @pytest.mark.asyncio
    async def test_settle_local_payload_copy_allows_second_enrichment(self) -> None:
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        scheme = FlowScheme("escrow")
        enrich_calls = {"n": 0}

        def enrich(ctx):
            enrich_calls["n"] += 1
            return {"settlePhase": "deposit" if ctx.phase == "before-handler" else "charge"}

        scheme.enrich_settlement_payload = enrich  # type: ignore[attr-defined]
        server.register(NETWORK, scheme)
        server.initialize()

        payload = build_payload(payload={"signature": "sig"})
        requirements = build_requirements()
        await server.settle_payment(payload, requirements, phase="before-handler")
        await server.settle_payment(payload, requirements, phase="after-handler")

        assert enrich_calls["n"] == 2
        assert len(client.settle_calls) == 2
        assert client.settle_calls[0][0].payload == {"signature": "sig", "settlePhase": "deposit"}
        assert client.settle_calls[1][0].payload == {"signature": "sig", "settlePhase": "charge"}
        assert payload.payload == {"signature": "sig"}


class TestCancellationDispatcherSettledPhases:
    @pytest.mark.asyncio
    async def test_exposes_completed_settle_phases_on_cancel(self) -> None:
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.register(NETWORK, FlowScheme("escrow"))
        server.initialize()
        requirements = build_requirements()
        payload = build_payload(accepted=requirements)
        handle = server.create_payment_cancellation_dispatcher(
            payload,
            requirements,
            settled_phases=["before-handler"],
        )
        settled: list[str] | None = None

        def on_cancel(ctx):
            nonlocal settled
            settled = list(ctx.settled_phases)
            assert ctx.phase == "cancel"

        server.on_verified_payment_canceled(on_cancel)
        await handle.cancel(
            VerifiedPaymentCancelOptions(reason="handler_failed", response_status=500)
        )
        assert settled == ["before-handler"]


async def _setup_http(
    flow: str,
) -> tuple[x402HTTPResourceServer, x402ResourceServer, MockFacilitatorClient]:
    facilitator = MockFacilitatorClient(
        settle_response=build_settle_response(success=True, transaction="0xtx"),
    )
    resource_server = x402ResourceServer(facilitator)
    resource_server.register(NETWORK, FlowScheme(flow))
    resource_server.initialize()
    http_server = x402HTTPResourceServer(
        resource_server,
        {
            "/api/test": RouteConfig(
                accepts=PaymentOption(
                    scheme="exact",
                    pay_to="0xabc",
                    price="$1.00",
                    network=NETWORK,
                )
            )
        },
    )
    return http_server, resource_server, facilitator


async def _verified_request(http_server: x402HTTPResourceServer, flow: str):
    extra = {} if flow == "authorization" else {"paymentFlow": flow}
    requirements = build_requirements(pay_to="0xabc", extra=extra)
    payload = build_payload(accepted=requirements)
    adapter = MockHTTPAdapter(
        {"payment-signature": encode_payment_signature_header(payload)},
    )
    return await http_server.process_http_request(
        HTTPRequestContext(adapter=adapter, path="/api/test", method="GET")
    )


class TestHttpOrchestration:
    @pytest.mark.asyncio
    async def test_authorization_verifies_before_handler_and_settles_after(self) -> None:
        http_server, resource_server, facilitator = await _setup_http("authorization")
        phases: list[str] = []
        resource_server.on_before_settle(lambda ctx: phases.append(ctx.phase))
        result = await _verified_request(http_server, "authorization")
        assert result.type == "payment-verified"
        assert len(facilitator.verify_calls) == 1
        assert len(facilitator.settle_calls) == 0
        settle = await http_server.process_settlement(
            result.payment_payload,
            result.payment_requirements,
            declared_extensions=result.declared_extensions,
            before_handler_settlement=result.before_handler_settlement,
        )
        assert settle.success is True
        assert len(facilitator.settle_calls) == 1
        assert phases == ["after-handler"]

    @pytest.mark.asyncio
    async def test_upfront_skips_facilitator_verify_and_settles_before_handler(self) -> None:
        http_server, resource_server, facilitator = await _setup_http("upfront")
        phases: list[str] = []
        before_verify_ran = {"v": False}
        after_verify_ran = {"v": False}
        resource_server.on_before_verify(lambda _ctx: before_verify_ran.__setitem__("v", True))
        resource_server.on_after_verify(lambda _ctx: after_verify_ran.__setitem__("v", True))
        resource_server.on_before_settle(lambda ctx: phases.append(ctx.phase))

        result = await _verified_request(http_server, "upfront")
        assert result.type == "payment-verified"
        assert before_verify_ran["v"] is True
        assert after_verify_ran["v"] is False
        assert len(facilitator.verify_calls) == 0
        assert len(facilitator.settle_calls) == 1
        assert phases == ["before-handler"]
        assert result.before_handler_settlement is not None
        assert result.before_handler_settlement.phase == "before-handler"
        assert result.before_handler_settlement.result.success is True
        assert result.before_handler_settlement.result.transaction == "0xtx"
        dumped = result.before_handler_settlement.result.model_dump()
        assert "headers" not in dumped
        assert "requirements" not in dumped

        headers = http_server.create_completed_settlement_headers(result.before_handler_settlement)
        assert headers["Cache-Control"] == "private"
        decoded = decode_payment_response_header(headers["PAYMENT-RESPONSE"])
        assert decoded.success is True
        assert decoded.transaction == "0xtx"

        settle = await http_server.process_settlement(
            result.payment_payload,
            result.payment_requirements,
            declared_extensions=result.declared_extensions,
            before_handler_settlement=result.before_handler_settlement,
        )
        assert settle.success is True
        assert settle.headers.get("PAYMENT-RESPONSE")
        assert settle.transaction == "0xtx"
        assert len(facilitator.settle_calls) == 1
        assert phases == ["before-handler"]

    @pytest.mark.asyncio
    async def test_upfront_before_verify_abort_never_settles(self) -> None:
        http_server, resource_server, facilitator = await _setup_http("upfront")
        resource_server.on_before_verify(lambda _ctx: AbortResult(reason="extension_gate"))
        result = await _verified_request(http_server, "upfront")
        assert result.type == "payment-error"
        assert len(facilitator.verify_calls) == 0
        assert len(facilitator.settle_calls) == 0

    @pytest.mark.asyncio
    async def test_escrow_settles_before_and_after_with_distinct_phases(self) -> None:
        http_server, resource_server, facilitator = await _setup_http("escrow")
        phases: list[str] = []
        resource_server.on_before_settle(lambda ctx: phases.append(ctx.phase))
        result = await _verified_request(http_server, "escrow")
        assert result.type == "payment-verified"
        assert len(facilitator.verify_calls) == 0
        assert len(facilitator.settle_calls) == 1
        settle = await http_server.process_settlement(
            result.payment_payload,
            result.payment_requirements,
            declared_extensions=result.declared_extensions,
            before_handler_settlement=result.before_handler_settlement,
        )
        assert settle.success is True
        assert len(facilitator.settle_calls) == 2
        assert phases == ["before-handler", "after-handler"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("flow", ["upfront", "escrow"])
    async def test_before_handler_settle_failure_returns_payment_error(self, flow: str) -> None:
        http_server, _resource_server, facilitator = await _setup_http(flow)
        facilitator.set_settle_response(
            build_settle_response(success=False, error_reason="insufficient_funds", transaction="")
        )
        result = await _verified_request(http_server, flow)
        assert result.type == "payment-error"
        assert len(facilitator.verify_calls) == 0
        assert len(facilitator.settle_calls) == 1
        assert result.response is not None
        assert result.response.status == 402

    @pytest.mark.asyncio
    async def test_escrow_cancel_after_before_handler_returns_refund_receipt(self) -> None:
        facilitator = MockFacilitatorClient(
            settle_response=build_settle_response(success=True, transaction="0xdeposit"),
        )
        resource_server = x402ResourceServer(facilitator)
        scheme = FlowScheme("escrow")
        scheme.settle_on_cancel = (  # type: ignore[attr-defined]
            lambda ctx: ctx.requirements.model_copy(update={"amount": "0"})
        )
        resource_server.register(NETWORK, scheme)
        resource_server.initialize()
        http_server = x402HTTPResourceServer(
            resource_server,
            {
                "/api/test": RouteConfig(
                    accepts=PaymentOption(
                        scheme="exact", pay_to="0xabc", price="$1.00", network=NETWORK
                    )
                )
            },
        )
        settled: list[str] | None = None

        def on_cancel(ctx):
            nonlocal settled
            settled = list(ctx.settled_phases)
            assert ctx.phase == "cancel"
            assert ctx.reason == "handler_failed"

        resource_server.on_verified_payment_canceled(on_cancel)
        result = await _verified_request(http_server, "escrow")
        assert result.type == "payment-verified"
        assert result.before_handler_settlement is not None
        assert result.before_handler_settlement.result.transaction == "0xdeposit"
        assert len(facilitator.settle_calls) == 1

        facilitator.set_settle_response(
            build_settle_response(success=True, amount="0", transaction="0xrefund")
        )
        assert result.cancellation_dispatcher is not None
        cancel_result = await result.cancellation_dispatcher.cancel(
            VerifiedPaymentCancelOptions(reason="handler_failed", response_status=500)
        )
        assert settled == ["before-handler"]
        assert len(facilitator.settle_calls) == 2
        assert cancel_result is not None
        assert cancel_result.success is True
        assert cancel_result.amount == "0"
        assert cancel_result.transaction == "0xrefund"

        receipt_headers = http_server.create_failure_path_settlement_headers(
            cancel_result,
            result.before_handler_settlement,
            result.payment_payload,
        )
        assert receipt_headers is not None
        decoded = decode_payment_response_header(receipt_headers["PAYMENT-RESPONSE"])
        assert decoded.success is True
        assert decoded.amount == "0"
        assert decoded.transaction == "0xrefund"

    @pytest.mark.asyncio
    async def test_failed_cancel_receipt_headers_include_deposit_recovery(self) -> None:
        http_server, _, _facilitator = await _setup_http("escrow")
        cancel = build_settle_response(
            success=False, error_reason="refund_failed", transaction="should-not-appear"
        )
        before = CompletedSettlement(
            phase="before-handler",
            flow="escrow",
            result=build_settle_response(success=True, amount="100000", transaction="0xdeposit"),
            requirements=build_requirements(),
        )
        receipt_headers = http_server.create_failure_path_settlement_headers(
            cancel,
            before,
            build_payload(payload={"channelId": "channel-123"}),
        )
        assert receipt_headers is not None
        decoded = decode_payment_response_header(receipt_headers["PAYMENT-RESPONSE"])
        assert decoded.success is False
        assert decoded.transaction == ""
        assert decoded.amount is None
        assert decoded.extra == {
            "depositTransaction": "0xdeposit",
            "depositAmount": "100000",
            "channelId": "channel-123",
        }

    @pytest.mark.asyncio
    async def test_warns_once_when_missing_before_handler_settlement(self, caplog) -> None:
        http_server, _resource_server, _facilitator = await _setup_http("upfront")
        result = await _verified_request(http_server, "upfront")
        assert result.type == "payment-verified"
        with caplog.at_level("WARNING", logger="x402"):
            settle1 = await http_server.process_settlement(
                result.payment_payload, result.payment_requirements
            )
            settle2 = await http_server.process_settlement(
                result.payment_payload, result.payment_requirements
            )
        assert settle1.success is True
        assert settle2.success is True
        assert settle1.headers == {}
        matches = [r for r in caplog.records if "without beforeHandlerSettlement" in r.message]
        assert len(matches) == 1
