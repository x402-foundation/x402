"""Tests for the BIP-122 Lightning client scheme."""

import pytest

from x402.mechanisms.bip122 import (
    BTC_ASSET,
    BTC_MAINNET_CAIP2,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
)
from x402.mechanisms.bip122.exact import ExactBip122ClientScheme
from x402.schemas import PaymentRequirements

from .helpers import InMemoryLightningPayer, InMemoryLightningReceiver


def build_requirements(invoice: str, amount_msat: int = 1_000) -> PaymentRequirements:
    """Build valid Lightning requirements for client tests."""
    return PaymentRequirements(
        scheme="exact",
        network=BTC_MAINNET_CAIP2,
        asset=BTC_ASSET,
        amount=str(amount_msat),
        pay_to=PAY_TO_ANONYMOUS,
        max_timeout_seconds=3600,
        extra={
            "paymentMethod": PAYMENT_METHOD_LIGHTNING,
            "invoice": invoice,
        },
    )


class TestExactBip122ClientScheme:
    """Test client-side invoice payment behavior."""

    def test_should_create_instance_with_correct_scheme(self) -> None:
        client = ExactBip122ClientScheme(InMemoryLightningPayer(InMemoryLightningReceiver()))

        assert client.scheme == "exact"

    def test_should_return_invoice_payload_after_successful_payment(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice = receiver.create_invoice(
            amount_msat=1_000,
            memo="client happy path",
            expiry_seconds=3600,
            network=BTC_MAINNET_CAIP2,
        )
        client = ExactBip122ClientScheme(
            InMemoryLightningPayer(receiver, payer="alice", final_status="paid")
        )

        payload = client.create_payment_payload(build_requirements(invoice))

        assert payload == {"invoice": invoice}

    def test_should_reject_missing_invoice(self) -> None:
        client = ExactBip122ClientScheme(InMemoryLightningPayer(InMemoryLightningReceiver()))
        requirements = PaymentRequirements(
            scheme="exact",
            network=BTC_MAINNET_CAIP2,
            asset=BTC_ASSET,
            amount="1000",
            pay_to=PAY_TO_ANONYMOUS,
            max_timeout_seconds=3600,
            extra={"paymentMethod": PAYMENT_METHOD_LIGHTNING},
        )

        with pytest.raises(
            ValueError,
            match="invalid_exact_bip122_payload_missing_invoice",
        ):
            client.create_payment_payload(requirements)

    def test_should_reject_amount_mismatch(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice = receiver.create_invoice(
            amount_msat=2_000,
            memo="client mismatch",
            expiry_seconds=3600,
            network=BTC_MAINNET_CAIP2,
        )
        client = ExactBip122ClientScheme(InMemoryLightningPayer(receiver))

        with pytest.raises(
            ValueError,
            match="invalid_exact_bip122_payload_invoice_mismatch",
        ):
            client.create_payment_payload(build_requirements(invoice, amount_msat=1_000))

    def test_should_reject_in_flight_payments(self) -> None:
        receiver = InMemoryLightningReceiver()
        invoice = receiver.create_invoice(
            amount_msat=1_000,
            memo="client in flight",
            expiry_seconds=3600,
            network=BTC_MAINNET_CAIP2,
        )
        client = ExactBip122ClientScheme(
            InMemoryLightningPayer(receiver, payer="alice", final_status="in_flight")
        )

        with pytest.raises(ValueError, match="Invoice payment did not complete: in_flight"):
            client.create_payment_payload(build_requirements(invoice))
