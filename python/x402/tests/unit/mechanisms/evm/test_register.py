"""Tests for EVM exact registration helpers."""

from unittest.mock import patch

import pytest
from eth_account import Account

from x402 import NoMatchingRequirementsError, x402ClientSync
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.exact.v1.client import ExactEvmSchemeV1
from x402.schemas.v1 import PaymentRequiredV1, PaymentRequirementsV1


def _payment_required_v1(network: str) -> PaymentRequiredV1:
    return PaymentRequiredV1(
        x402_version=1,
        accepts=[
            PaymentRequirementsV1(
                scheme="exact",
                network=network,
                max_amount_required="1000",
                resource="https://example.com/paid",
                pay_to="0x1234567890123456789012345678901234567890",
                max_timeout_seconds=300,
                asset="0x0000000000000000000000000000000000000000",
            )
        ],
    )


class TestRegisterExactEvmClientV1Networks:
    """V1 registration should respect the networks filter."""

    @pytest.fixture
    def client(self) -> x402ClientSync:
        client = x402ClientSync().set_spend_controls(False)
        register_exact_evm_client(client, Account.create(), networks="eip155:84532")
        return client

    def test_should_refuse_v1_network_outside_networks_filter(self, client: x402ClientSync):
        with pytest.raises(NoMatchingRequirementsError):
            client.create_payment_payload(_payment_required_v1("base"))

    def test_should_accept_v1_network_matching_networks_filter(self, client: x402ClientSync):
        with patch.object(ExactEvmSchemeV1, "create_payment_payload", return_value={"ok": True}):
            payload = client.create_payment_payload(_payment_required_v1("base-sepolia"))

        assert payload.network == "base-sepolia"

    def test_should_register_all_v1_networks_without_networks_filter(self):
        client = x402ClientSync().set_spend_controls(False)
        register_exact_evm_client(client, Account.create())

        with patch.object(ExactEvmSchemeV1, "create_payment_payload", return_value={"ok": True}):
            payload = client.create_payment_payload(_payment_required_v1("base"))

        assert payload.network == "base"
