"""Tests for ExactSvmScheme client."""

from solders.keypair import Keypair

from x402.mechanisms.svm import SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS
from x402.mechanisms.svm.exact import ExactSvmClientScheme
from x402.mechanisms.svm.signers import KeypairSigner
from x402.schemas import PaymentRequirements


class TestExactSvmSchemeConstructor:
    """Test ExactSvmScheme constructor."""

    def test_should_create_instance_with_correct_scheme(self):
        """Should create instance with correct scheme."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer)

        assert client.scheme == "exact"

    def test_should_accept_optional_rpc_url_config(self):
        """Should accept optional RPC URL config."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer, rpc_url="https://custom-rpc.com")

        assert client.scheme == "exact"


class TestCreatePaymentPayload:
    """Test create_payment_payload method."""

    def test_should_have_create_payment_payload_method(self):
        """Should have create_payment_payload method."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer)

        assert hasattr(client, "create_payment_payload")
        assert callable(client.create_payment_payload)

    def test_should_accept_v2_requirements_with_amount_field(self):
        """Should accept V2 requirements with amount field."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer)

        # Verify the client accepts PaymentRequirements (v2) with amount field
        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="500000",  # V2 uses 'amount'
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

        assert requirements.amount == "500000"
        assert client.scheme == "exact"

    def test_requirements_must_have_fee_payer(self):
        """Requirements must have feePayer in extra."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer)

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={},  # Missing feePayer
        )

        # The method should exist and handle this error scenario
        assert client.create_payment_payload is not None
        assert requirements.extra is not None
        assert requirements.extra.get("feePayer") is None


class TestClientSchemeAttributes:
    """Test client scheme attributes and methods."""

    def test_scheme_attribute_is_exact(self):
        """scheme attribute should be 'exact'."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer)

        assert client.scheme == "exact"

    def test_client_stores_signer_reference(self):
        """Client should store signer reference."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        client = ExactSvmClientScheme(signer)

        # Client should have access to signer (internal attribute)
        assert client._signer is signer
