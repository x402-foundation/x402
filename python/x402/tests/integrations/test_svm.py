"""SVM integration tests for x402ClientSync, x402ResourceServerSync, and x402FacilitatorSync.

These tests perform REAL blockchain transactions on Solana Devnet using sync classes.

Required environment variables:
- SVM_CLIENT_PRIVATE_KEY: Base58 encoded private key for the client (payer)
- SVM_FACILITATOR_PRIVATE_KEY: Base58 encoded private key for the facilitator (fee payer)

These must be funded accounts on Solana Devnet with SOL and USDC
"""

import os

import pytest
from solders.keypair import Keypair

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.svm import (
    SCHEME_EXACT,
    SOLANA_DEVNET_CAIP2,
    USDC_DEVNET_ADDRESS,
    FacilitatorKeypairSigner,
    KeypairSigner,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmServerScheme,
)
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceConfig,
    ResourceInfo,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)

# =============================================================================
# Environment Variable Loading
# =============================================================================

CLIENT_PRIVATE_KEY = os.environ.get("SVM_CLIENT_PRIVATE_KEY")
FACILITATOR_PRIVATE_KEY = os.environ.get("SVM_FACILITATOR_PRIVATE_KEY")

# Custom RPC URL (optional)
RPC_URL = os.environ.get("SVM_RPC_URL")

# Skip all tests if environment variables aren't set
pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY,
    reason="SVM_CLIENT_PRIVATE_KEY and SVM_FACILITATOR_PRIVATE_KEY environment variables required for SVM integration tests",
)


# =============================================================================
# Facilitator Client Wrapper
# =============================================================================


class SvmFacilitatorClientSync:
    """Facilitator client wrapper for the x402ResourceServerSync."""

    scheme = SCHEME_EXACT
    network = SOLANA_DEVNET_CAIP2
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync):
        """Create wrapper.

        Args:
            facilitator: The x402FacilitatorSync to wrap.
        """
        self._facilitator = facilitator

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify payment."""
        return self._facilitator.verify(payload, requirements)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle payment."""
        return self._facilitator.settle(payload, requirements)

    def get_supported(self) -> SupportedResponse:
        """Get supported kinds."""
        return self._facilitator.get_supported()


# =============================================================================
# Helper Functions
# =============================================================================


def build_svm_payment_requirements(
    pay_to: str,
    amount: str,
    network: str = SOLANA_DEVNET_CAIP2,
    fee_payer: str | None = None,
) -> PaymentRequirements:
    """Build SVM payment requirements for testing.

    Args:
        pay_to: Recipient address (base58).
        amount: Amount in smallest units (e.g., "1000" for 0.001 USDC).
        network: Network identifier.
        fee_payer: Optional fee payer address.

    Returns:
        Payment requirements.
    """
    extra = {}
    if fee_payer:
        extra["feePayer"] = fee_payer

    return PaymentRequirements(
        scheme=SCHEME_EXACT,
        network=network,
        asset=USDC_DEVNET_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra=extra,
    )


# =============================================================================
# Test Classes
# =============================================================================


class TestSvmIntegrationV2:
    """Integration tests for SVM V2 payment flow with REAL blockchain transactions."""

    def setup_method(self) -> None:
        """Set up test fixtures with real blockchain clients."""
        # Create real signers using the provided implementations
        client_keypair = Keypair.from_base58_string(CLIENT_PRIVATE_KEY)
        self.client_signer = KeypairSigner(client_keypair)

        # For facilitator, use custom RPC URL if provided
        self.facilitator_signer = FacilitatorKeypairSigner.from_base58(
            FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )

        # Store addresses for assertions
        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.get_addresses()[0]

        # Create client with SVM scheme
        self.client = x402ClientSync().register(
            SOLANA_DEVNET_CAIP2,
            ExactSvmClientScheme(self.client_signer, rpc_url=RPC_URL),
        )

        # Create facilitator with SVM scheme
        self.facilitator = x402FacilitatorSync().register(
            [SOLANA_DEVNET_CAIP2],
            ExactSvmFacilitatorScheme(self.facilitator_signer),
        )

        # Create facilitator client wrapper
        facilitator_client = SvmFacilitatorClientSync(self.facilitator)

        # Create resource server with SVM scheme
        self.server = x402ResourceServerSync(facilitator_client)
        self.server.register(SOLANA_DEVNET_CAIP2, ExactSvmServerScheme())
        self.server.initialize()

    def test_server_should_successfully_verify_and_settle_svm_payment_from_client(
        self,
    ) -> None:
        """Test the complete SVM V2 payment flow with REAL blockchain transactions.

        This test:
        1. Creates payment requirements
        2. Client signs an SPL TransferChecked transaction
        3. Server verifies the transaction structure
        4. Server settles by submitting the transaction to Solana Devnet

        WARNING: This will spend real testnet USDC!
        """
        # Use facilitator address as recipient for testing
        recipient = self.facilitator_address

        # Server - builds PaymentRequired response
        accepts = [
            build_svm_payment_requirements(
                recipient,
                "1000",  # 0.001 USDC (1000 units with 6 decimals)
                fee_payer=self.facilitator_address,
            )
        ]
        resource = ResourceInfo(
            url="https://api.example.com/premium",
            description="Premium API Access",
            mime_type="application/json",
        )
        payment_required = self.server.create_payment_required_response(accepts, resource)

        # Verify V2
        assert payment_required.x402_version == 2

        # Client - creates payment payload (signs SPL TransferChecked transaction)
        payment_payload = self.client.create_payment_payload(payment_required)

        # Verify payload structure
        assert payment_payload.x402_version == 2
        assert payment_payload.accepted.scheme == SCHEME_EXACT
        assert payment_payload.accepted.network == SOLANA_DEVNET_CAIP2
        assert "transaction" in payment_payload.payload

        # Server - finds matching requirements
        accepted = self.server.find_matching_requirements(accepts, payment_payload)
        assert accepted is not None

        # Server - verifies payment (real transaction verification)
        verify_response = self.server.verify_payment(payment_payload, accepted)

        if not verify_response.is_valid:
            print(f"❌ Verification failed: {verify_response.invalid_reason}")
            print(f"Payer: {verify_response.payer}")
            print(f"Client address: {self.client_address}")

        assert verify_response.is_valid is True
        assert verify_response.payer == self.client_address

        # Server does work here...

        # Server - settles payment (REAL on-chain transaction!)
        settle_response = self.server.settle_payment(payment_payload, accepted)

        if not settle_response.success:
            print(f"❌ Settlement failed: {settle_response.error_reason}")
            if settle_response.transaction:
                print(f"📋 Transaction signature: {settle_response.transaction}")
                print(
                    f"🔍 View on explorer: https://explorer.solana.com/tx/{settle_response.transaction}?cluster=devnet"
                )

        assert settle_response.success is True
        assert settle_response.network == SOLANA_DEVNET_CAIP2
        assert settle_response.transaction != ""
        assert settle_response.payer == self.client_address

        print(f"✅ Transaction settled: {settle_response.transaction}")

    def test_client_creates_valid_svm_payment_payload(self) -> None:
        """Test that client creates properly structured SVM payload."""
        # Use a random recipient for this test (no actual settlement)
        recipient = "11111111111111111111111111111112"  # System program (valid address)

        accepts = [
            build_svm_payment_requirements(
                recipient,
                "5000000",  # 5 USDC
                fee_payer=self.facilitator_address,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)

        payload = self.client.create_payment_payload(payment_required)

        assert payload.x402_version == 2
        assert payload.accepted.scheme == SCHEME_EXACT
        assert payload.accepted.amount == "5000000"
        assert payload.accepted.network == SOLANA_DEVNET_CAIP2

        # Check SVM payload structure
        assert "transaction" in payload.payload
        # Transaction should be base64 encoded
        tx_base64 = payload.payload["transaction"]
        assert isinstance(tx_base64, str)
        assert len(tx_base64) > 0

    def test_invalid_recipient_fails_verification(self) -> None:
        """Test that mismatched recipient fails verification."""
        recipient1 = "11111111111111111111111111111112"
        recipient2 = "11111111111111111111111111111113"

        accepts = [
            build_svm_payment_requirements(
                recipient1,
                "1000",
                fee_payer=self.facilitator_address,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        # Change recipient in requirements
        different_accepts = [
            build_svm_payment_requirements(
                recipient2,
                "1000",
                fee_payer=self.facilitator_address,
            )
        ]

        # Manually verify with different requirements
        verify_response = self.server.verify_payment(payload, different_accepts[0])
        assert verify_response.is_valid is False
        assert "recipient" in verify_response.invalid_reason.lower()

    def test_insufficient_amount_fails_verification(self) -> None:
        """Test that insufficient amount fails verification."""
        recipient = self.facilitator_address

        accepts = [
            build_svm_payment_requirements(
                recipient,
                "1000",  # Client pays 1000
                fee_payer=self.facilitator_address,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        # Try to verify against higher amount
        higher_accepts = [
            build_svm_payment_requirements(
                recipient,
                "2000",  # Require 2000
                fee_payer=self.facilitator_address,
            )
        ]

        verify_response = self.server.verify_payment(payload, higher_accepts[0])
        assert verify_response.is_valid is False
        assert "amount" in verify_response.invalid_reason.lower()

    def test_facilitator_get_supported(self) -> None:
        """Test that facilitator returns supported kinds."""
        supported = self.facilitator.get_supported()

        assert len(supported.kinds) >= 1

        # Find solana devnet support
        svm_support = None
        for kind in supported.kinds:
            if kind.network == SOLANA_DEVNET_CAIP2 and kind.scheme == SCHEME_EXACT:
                svm_support = kind
                break

        assert svm_support is not None
        assert svm_support.x402_version == 2

        # SVM should have feePayer in extra
        assert svm_support.extra is not None
        assert "feePayer" in svm_support.extra

    def test_fee_payer_not_managed_fails_verification(self) -> None:
        """Test that using an unmanaged fee payer fails verification."""
        recipient = self.facilitator_address
        unknown_fee_payer = "UnknownFeePayer111111111111111111111111111"

        accepts = [
            build_svm_payment_requirements(
                recipient,
                "1000",
                fee_payer=unknown_fee_payer,
            )
        ]

        # Create payment requirements with unknown fee payer
        requirements = accepts[0]

        # Verify should fail because the fee payer is not managed
        # We need to create a payload first with a valid fee payer
        valid_accepts = [
            build_svm_payment_requirements(
                recipient,
                "1000",
                fee_payer=self.facilitator_address,
            )
        ]
        payment_required = self.server.create_payment_required_response(valid_accepts)
        payload = self.client.create_payment_payload(payment_required)

        # Now verify with unknown fee payer
        verify_response = self.server.verify_payment(payload, requirements)
        assert verify_response.is_valid is False
        assert "fee_payer" in verify_response.invalid_reason.lower()


class TestSvmPriceParsing:
    """Tests for SVM server price parsing (no blockchain transactions needed)."""

    def setup_method(self) -> None:
        """Set up test fixtures."""
        # Create a mock facilitator for the server
        facilitator_keypair = Keypair.from_base58_string(FACILITATOR_PRIVATE_KEY)
        self.facilitator_signer = FacilitatorKeypairSigner(
            facilitator_keypair,
            rpc_url=RPC_URL,
        )
        self.facilitator_address = self.facilitator_signer.get_addresses()[0]

        self.facilitator = x402FacilitatorSync().register(
            [SOLANA_DEVNET_CAIP2],
            ExactSvmFacilitatorScheme(self.facilitator_signer),
        )

        facilitator_client = SvmFacilitatorClientSync(self.facilitator)
        self.server = x402ResourceServerSync(facilitator_client)
        self.svm_server = ExactSvmServerScheme()
        self.server.register(SOLANA_DEVNET_CAIP2, self.svm_server)
        self.server.initialize()

    def test_parse_money_formats(self) -> None:
        """Test parsing different Money formats."""
        test_cases = [
            ("$1.00", "1000000"),
            ("1.50", "1500000"),
            (2.5, "2500000"),
            ("$0.001", "1000"),
        ]

        for input_price, expected_amount in test_cases:
            config = ResourceConfig(
                scheme=SCHEME_EXACT,
                pay_to=self.facilitator_address,
                price=input_price,
                network=SOLANA_DEVNET_CAIP2,
            )
            requirements = self.server.build_payment_requirements(config)

            assert len(requirements) == 1
            assert requirements[0].amount == expected_amount
            assert requirements[0].asset == USDC_DEVNET_ADDRESS

    def test_asset_amount_passthrough(self) -> None:
        """Test that AssetAmount is passed through directly."""
        from x402.schemas import AssetAmount

        custom_asset = AssetAmount(
            amount="5000000",
            asset="CustomMint1111111111111111111111111111111111",
            extra={"foo": "bar"},
        )

        config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to=self.facilitator_address,
            price=custom_asset,
            network=SOLANA_DEVNET_CAIP2,
        )
        requirements = self.server.build_payment_requirements(config)

        assert len(requirements) == 1
        assert requirements[0].amount == "5000000"
        assert requirements[0].asset == "CustomMint1111111111111111111111111111111111"

    def test_custom_money_parser(self) -> None:
        """Test registering custom money parser."""
        from x402.schemas import AssetAmount

        # Register custom parser for large amounts
        def large_amount_parser(amount: float, network: str):
            if amount > 100:
                return AssetAmount(
                    amount=str(int(amount * 1_000_000)),  # USDC has 6 decimals
                    asset="LargeTokenMint11111111111111111111111111111",
                    extra={"token": "LARGE", "tier": "large"},
                )
            return None

        self.svm_server.register_money_parser(large_amount_parser)

        # Large amount - should use custom parser
        config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to=self.facilitator_address,
            price=150,
            network=SOLANA_DEVNET_CAIP2,
        )
        large_req = self.server.build_payment_requirements(config)

        assert large_req[0].extra.get("token") == "LARGE"
        assert large_req[0].extra.get("tier") == "large"

        # Small amount - should use default USDC
        config2 = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to=self.facilitator_address,
            price=50,
            network=SOLANA_DEVNET_CAIP2,
        )
        small_req = self.server.build_payment_requirements(config2)

        assert small_req[0].asset == USDC_DEVNET_ADDRESS


class TestSvmNetworkNormalization:
    """Tests for SVM network identifier normalization."""

    def setup_method(self) -> None:
        """Set up test fixtures."""
        facilitator_keypair = Keypair.from_base58_string(FACILITATOR_PRIVATE_KEY)
        self.facilitator_signer = FacilitatorKeypairSigner(
            facilitator_keypair,
            rpc_url=RPC_URL,
        )
        self.facilitator_address = self.facilitator_signer.get_addresses()[0]

        # Register for devnet with CAIP-2 identifier
        self.facilitator = x402FacilitatorSync().register(
            [SOLANA_DEVNET_CAIP2],
            ExactSvmFacilitatorScheme(self.facilitator_signer),
        )

    def test_facilitator_supports_caip2_network(self) -> None:
        """Test that facilitator correctly supports CAIP-2 network identifier."""
        supported = self.facilitator.get_supported()

        # Find devnet support
        devnet_support = None
        for kind in supported.kinds:
            if kind.network == SOLANA_DEVNET_CAIP2:
                devnet_support = kind
                break

        assert devnet_support is not None
        assert devnet_support.scheme == SCHEME_EXACT

    def test_facilitator_extra_contains_fee_payer(self) -> None:
        """Test that facilitator's extra data contains feePayer for SVM."""
        supported = self.facilitator.get_supported()

        for kind in supported.kinds:
            if kind.network == SOLANA_DEVNET_CAIP2:
                assert kind.extra is not None
                assert "feePayer" in kind.extra
                assert kind.extra["feePayer"] in self.facilitator_signer.get_addresses()
