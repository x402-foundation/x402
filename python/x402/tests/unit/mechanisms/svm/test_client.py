"""Tests for ExactSvmScheme client."""

from unittest.mock import MagicMock, patch

from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from x402.mechanisms.svm import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS, USDC_DEVNET_ADDRESS
from x402.mechanisms.svm.exact import ExactSvmClientScheme
from x402.mechanisms.svm.exact.v1 import ExactSvmSchemeV1
from x402.mechanisms.svm.signers import KeypairSigner
from x402.schemas import PaymentRequirements
from x402.schemas.v1 import PaymentRequirementsV1

FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"
FIXED_BLOCKHASH_ALT = "7ZCxc2SDhzV2bYgEQqdxTpweYJkpwshVSDtXuY7uPtjf"


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


class TestMintMetadataCache:
    """Test mint metadata caching during payload creation."""

    def _mock_rpc_client(self):
        mock_client = MagicMock()

        blockhashes = [
            Hash.from_string(FIXED_BLOCKHASH),
            Hash.from_string(FIXED_BLOCKHASH_ALT),
        ]

        def get_latest_blockhash():
            mock_resp = MagicMock()
            mock_resp.value.blockhash = blockhashes.pop(0)
            return mock_resp

        mock_client.get_latest_blockhash.side_effect = get_latest_blockhash

        mock_account_info = MagicMock()
        mock_account_info.value = MagicMock()
        mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
        mock_client.get_account_info.return_value = mock_account_info

        return mock_client

    def test_v2_reuses_cached_mint_metadata(self):
        """V2 should fetch mint metadata once for repeated same-network same-mint payments."""
        signer = KeypairSigner(Keypair.from_seed(bytes([1] * 32)))
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        client = ExactSvmClientScheme(signer)
        rpc_client = self._mock_rpc_client()

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey())},
        )

        with patch.object(client, "_get_client", return_value=rpc_client):
            client.create_payment_payload(requirements)
            client.create_payment_payload(requirements)

        assert rpc_client.get_account_info.call_count == 1
        assert rpc_client.get_latest_blockhash.call_count == 2

    def test_v1_reuses_cached_mint_metadata(self):
        """V1 should fetch mint metadata once for repeated same-network same-mint payments."""
        signer = KeypairSigner(Keypair.from_seed(bytes([1] * 32)))
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        client = ExactSvmSchemeV1(signer)
        rpc_client = self._mock_rpc_client()

        requirements = PaymentRequirementsV1(
            scheme="exact",
            network="solana-devnet",
            resource="https://example.com",
            asset=USDC_DEVNET_ADDRESS,
            max_amount_required="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey())},
        )

        with patch.object(client, "_get_client", return_value=rpc_client):
            client.create_payment_payload(requirements)
            client.create_payment_payload(requirements)

        assert rpc_client.get_account_info.call_count == 1
        assert rpc_client.get_latest_blockhash.call_count == 2


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
