"""Sync roundtrip tests for the BIP-122 Lightning mechanism."""

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.bip122 import (
    BTC_ASSET,
    BTC_MAINNET_CAIP2,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
    decode_invoice,
)
from x402.mechanisms.bip122.exact import (
    register_exact_bip122_client,
    register_exact_bip122_facilitator,
    register_exact_bip122_server,
)
from x402.schemas import ResourceConfig, ResourceInfo

from .helpers import InMemoryLightningPayer, InMemoryLightningReceiver


class TestBip122Roundtrip:
    """Exercise the full sync x402 flow for Lightning."""

    def test_should_build_verify_and_settle_payment_end_to_end(self) -> None:
        receiver = InMemoryLightningReceiver()
        payer = InMemoryLightningPayer(receiver, payer="alice", final_status="paid")

        client = register_exact_bip122_client(x402ClientSync(), payer)
        facilitator = register_exact_bip122_facilitator(
            x402FacilitatorSync(),
            receiver,
            networks=[BTC_MAINNET_CAIP2],
        )
        server = register_exact_bip122_server(
            x402ResourceServerSync(facilitator),
            receiver,
        )
        server.initialize()

        requirements = server.build_payment_requirements(
            ResourceConfig(
                scheme="exact",
                network=BTC_MAINNET_CAIP2,
                pay_to="merchant-node-id",
                price="21 sat",
                extra={"description": "premium endpoint"},
            )
        )
        requirement = requirements[0]

        assert requirement.asset == BTC_ASSET
        assert requirement.pay_to == PAY_TO_ANONYMOUS
        assert requirement.extra["paymentMethod"] == PAYMENT_METHOD_LIGHTNING

        payment_required = server.create_payment_required_response(
            requirements,
            resource=ResourceInfo(
                url="https://api.example.com/premium",
                description="Premium endpoint",
                mime_type="application/json",
            ),
        )
        payload = client.create_payment_payload(payment_required)
        accepted = server.find_matching_requirements(requirements, payload)

        assert accepted is not None
        assert payload.payload["invoice"] == requirement.extra["invoice"]

        verify_result = server.verify_payment(payload, accepted)
        settle_result = server.settle_payment(payload, accepted)

        assert verify_result.is_valid is True
        assert verify_result.payer == "alice"
        assert settle_result.success is True
        assert settle_result.payer == "alice"
        assert settle_result.network == BTC_MAINNET_CAIP2
        assert (
            settle_result.transaction == decode_invoice(requirement.extra["invoice"]).payment_hash
        )

        duplicate = server.settle_payment(payload, accepted)
        assert duplicate.success is False
        assert duplicate.error_reason == "duplicate_settlement"
