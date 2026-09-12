"""Tests for the BIP-122 Lightning facilitator scheme."""

import time

from x402.mechanisms.bip122 import (
    BTC_ASSET,
    BTC_MAINNET_CAIP2,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
)
from x402.mechanisms.bip122.exact import ExactBip122FacilitatorScheme
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

from .helpers import InMemoryLightningReceiver, build_invoice


def build_requirements(invoice: str, amount_msat: int) -> PaymentRequirements:
    """Build valid Lightning payment requirements."""
    return PaymentRequirements(
        scheme="exact",
        network=BTC_MAINNET_CAIP2,
        asset=BTC_ASSET,
        amount=str(amount_msat),
        pay_to=PAY_TO_ANONYMOUS,
        max_timeout_seconds=300,
        extra={
            "paymentMethod": PAYMENT_METHOD_LIGHTNING,
            "invoice": invoice,
        },
    )


def build_payload(requirements: PaymentRequirements, invoice: str) -> PaymentPayload:
    """Build valid Lightning payment payload."""
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="https://api.example.com/premium",
            description="Premium endpoint",
            mime_type="application/json",
        ),
        accepted=requirements,
        payload={"invoice": invoice},
    )


class TestVerify:
    """Test invoice verification."""

    def test_should_accept_paid_invoice(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice = receiver.create_invoice(
            amount_msat=1000,
            memo="verify paid",
            expiry_seconds=300,
            network=BTC_MAINNET_CAIP2,
        )
        receiver.set_status(invoice, "paid", payer="alice", settled_at=int(time.time()))
        facilitator = ExactBip122FacilitatorScheme(receiver)
        requirements = build_requirements(invoice, amount_msat=1000)
        payload = build_payload(requirements, invoice)

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is True
        assert result.payer == "alice"

    def test_should_reject_unknown_invoice(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice, _ = build_invoice(amount_msat=1000, memo="unknown invoice")
        facilitator = ExactBip122FacilitatorScheme(receiver)
        requirements = build_requirements(invoice, amount_msat=1000)
        payload = build_payload(requirements, invoice)

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == "unknown_invoice"

    def test_should_reject_in_flight_invoice(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice = receiver.create_invoice(
            amount_msat=1000,
            memo="verify in flight",
            expiry_seconds=300,
            network=BTC_MAINNET_CAIP2,
        )
        receiver.set_status(invoice, "in_flight", payer="alice")
        facilitator = ExactBip122FacilitatorScheme(receiver)
        requirements = build_requirements(invoice, amount_msat=1000)
        payload = build_payload(requirements, invoice)

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == "invoice_in_flight"
        assert result.invalid_message == "Payment is still in flight; retry later."

    def test_should_reject_expired_invoice(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice, _ = build_invoice(
            amount_msat=1000,
            memo="expired invoice",
            expiry_seconds=1,
            issued_at=int(time.time()) - 600,
        )
        receiver.add_invoice(invoice, BTC_MAINNET_CAIP2, status="unpaid")
        facilitator = ExactBip122FacilitatorScheme(receiver)
        requirements = build_requirements(invoice, amount_msat=1000)
        payload = build_payload(requirements, invoice)

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == "invoice_expired"


class TestSettle:
    """Test settlement behavior."""

    def test_should_return_payment_hash_and_prevent_duplicate_settlement(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice = receiver.create_invoice(
            amount_msat=2500,
            memo="settle duplicate",
            expiry_seconds=300,
            network=BTC_MAINNET_CAIP2,
        )
        status = receiver.set_status(invoice, "paid", payer="alice", settled_at=int(time.time()))
        facilitator = ExactBip122FacilitatorScheme(receiver)
        requirements = build_requirements(invoice, amount_msat=2500)
        payload = build_payload(requirements, invoice)

        result = facilitator.settle(payload, requirements)
        duplicate = facilitator.settle(payload, requirements)

        assert result.success is True
        assert result.transaction == status.payment_hash
        assert result.network == BTC_MAINNET_CAIP2
        assert duplicate.success is False
        assert duplicate.error_reason == "duplicate_settlement"
