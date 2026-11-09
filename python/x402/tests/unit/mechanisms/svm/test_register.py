"""Tests for SVM exact registration helpers."""

from unittest.mock import patch

import pytest
from solders.keypair import Keypair

from x402 import NoMatchingRequirementsError, x402ClientSync
from x402.mechanisms.svm import SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.exact import register_exact_svm_client
from x402.mechanisms.svm.exact.v1.client import ExactSvmSchemeV1
from x402.mechanisms.svm.signers import KeypairSigner
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
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=300,
                asset="11111111111111111111111111111111",
            )
        ],
    )


class TestRegisterExactSvmClientV1Networks:
    """V1 registration should respect the networks filter."""

    @pytest.fixture
    def client(self) -> x402ClientSync:
        client = x402ClientSync().set_spend_controls(False)
        register_exact_svm_client(client, KeypairSigner(Keypair()), networks=SOLANA_DEVNET_CAIP2)
        return client

    def test_should_refuse_v1_network_outside_networks_filter(self, client: x402ClientSync):
        with pytest.raises(NoMatchingRequirementsError):
            client.create_payment_payload(_payment_required_v1("solana"))

    def test_should_accept_v1_network_matching_networks_filter(self, client: x402ClientSync):
        with patch.object(ExactSvmSchemeV1, "create_payment_payload", return_value={"ok": True}):
            payload = client.create_payment_payload(_payment_required_v1("solana-devnet"))

        assert payload.network == "solana-devnet"

    def test_should_register_all_v1_networks_without_networks_filter(self):
        client = x402ClientSync().set_spend_controls(False)
        register_exact_svm_client(client, KeypairSigner(Keypair()))

        with patch.object(ExactSvmSchemeV1, "create_payment_payload", return_value={"ok": True}):
            payload = client.create_payment_payload(_payment_required_v1("solana"))

        assert payload.network == "solana"
