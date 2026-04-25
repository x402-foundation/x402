"""EVM integration tests for x402ClientSync, x402ResourceServerSync, and x402FacilitatorSync.

These tests perform REAL blockchain transactions on Base Sepolia using sync classes.

Required environment variables:
- EVM_CLIENT_PRIVATE_KEY: Private key for the client (payer)
- EVM_FACILITATOR_PRIVATE_KEY: Private key for the facilitator

These must be funded accounts on Base Sepolia with USDC.
"""

import os

import pytest
from eth_account import Account
from web3 import Web3

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.evm import (
    SCHEME_EXACT,
    SCHEME_UPTO,
    TypedDataDomain,
    TypedDataField,
)
from x402.mechanisms.evm.exact import (
    ExactEvmClientScheme,
    ExactEvmFacilitatorScheme,
    ExactEvmSchemeConfig,
    ExactEvmServerScheme,
)
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer
from x402.mechanisms.evm.upto import (
    UptoEvmClientScheme,
    UptoEvmFacilitatorScheme,
    UptoEvmServerScheme,
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

CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_PRIVATE_KEY")
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")

# Base Sepolia RPC URL
RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")

# Base Sepolia USDC contract
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

# Skip all tests if environment variables aren't set
pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY,
    reason="EVM_CLIENT_PRIVATE_KEY and EVM_FACILITATOR_PRIVATE_KEY environment variables required for EVM integration tests",
)


# =============================================================================
# ERC20 ABI (minimal for transfer authorization)
# =============================================================================

ERC20_ABI = [
    {
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "authorizer", "type": "address"},
            {"name": "nonce", "type": "bytes32"},
        ],
        "name": "authorizationState",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
            {"name": "v", "type": "uint8"},
            {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"},
        ],
        "name": "transferWithAuthorization",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]


# =============================================================================
# Facilitator Client Wrapper
# =============================================================================


class EvmFacilitatorClientSync:
    """Facilitator client wrapper for the x402ResourceServerSync."""

    scheme = SCHEME_EXACT
    network = "eip155:84532"
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


def build_evm_payment_requirements(
    pay_to: str,
    amount: str,
    network: str = "eip155:84532",
) -> PaymentRequirements:
    """Build EVM payment requirements for testing.

    Args:
        pay_to: Recipient address.
        amount: Amount in smallest units.
        network: Network identifier.

    Returns:
        Payment requirements.
    """
    return PaymentRequirements(
        scheme=SCHEME_EXACT,
        network=network,
        asset=USDC_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={
            "name": "USDC",
            "version": "2",
        },
    )


# =============================================================================
# Test Classes
# =============================================================================


class TestEvmIntegrationV2:
    """Integration tests for EVM V2 payment flow with REAL blockchain transactions."""

    def setup_method(self) -> None:
        """Set up test fixtures with real blockchain clients using library signers."""
        # Create signers using the library implementations
        client_account = Account.from_key(CLIENT_PRIVATE_KEY)
        self.client_signer = EthAccountSigner(client_account)
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )

        # Store addresses for assertions
        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.address

        # Create client with EVM scheme using EthAccountSigner
        self.client = x402ClientSync().register(
            "eip155:84532",
            ExactEvmClientScheme(self.client_signer),
        )

        # Create facilitator with EVM scheme using FacilitatorWeb3Signer
        self.facilitator = x402FacilitatorSync().register(
            ["eip155:84532"],
            ExactEvmFacilitatorScheme(
                self.facilitator_signer,
                ExactEvmSchemeConfig(deploy_erc4337_with_eip6492=True),
            ),
        )

        # Create facilitator client wrapper
        facilitator_client = EvmFacilitatorClientSync(self.facilitator)

        # Create resource server with EVM scheme
        self.server = x402ResourceServerSync(facilitator_client)
        self.server.register("eip155:84532", ExactEvmServerScheme())
        self.server.initialize()

    def test_server_should_successfully_verify_and_settle_evm_payment_from_client(
        self,
    ) -> None:
        """Test the complete EVM V2 payment flow with REAL blockchain transactions.

        This test:
        1. Creates payment requirements
        2. Client signs an EIP-3009 authorization
        3. Server verifies the signature on-chain
        4. Server settles by submitting transferWithAuthorization to Base Sepolia

        WARNING: This will spend real testnet USDC!
        """
        # Use facilitator address as recipient for testing
        recipient = self.facilitator_address

        # Server - builds PaymentRequired response
        accepts = [
            build_evm_payment_requirements(
                recipient,
                "1000",  # 0.001 USDC (1000 units with 6 decimals)
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

        # Client - creates payment payload (signs EIP-3009 authorization)
        payment_payload = self.client.create_payment_payload(payment_required)

        # Verify payload structure
        assert payment_payload.x402_version == 2
        assert payment_payload.accepted.scheme == SCHEME_EXACT
        assert payment_payload.accepted.network == "eip155:84532"
        assert "authorization" in payment_payload.payload
        assert "signature" in payment_payload.payload

        auth = payment_payload.payload["authorization"]
        assert auth["from"].lower() == self.client_address.lower()
        assert auth["to"].lower() == recipient.lower()
        assert auth["value"] == "1000"

        # Server - finds matching requirements
        accepted = self.server.find_matching_requirements(accepts, payment_payload)
        assert accepted is not None

        # Server - verifies payment (real signature verification)
        verify_response = self.server.verify_payment(payment_payload, accepted)

        if not verify_response.is_valid:
            print(f"❌ Verification failed: {verify_response.invalid_reason}")
            print(f"Payer: {verify_response.payer}")
            print(f"Client address: {self.client_address}")

        assert verify_response.is_valid is True
        assert verify_response.payer.lower() == self.client_address.lower()

        # Server does work here...

        # Server - settles payment (REAL on-chain transaction!)
        settle_response = self.server.settle_payment(payment_payload, accepted)

        if not settle_response.success:
            print(f"❌ Settlement failed: {settle_response.error_reason}")

        assert settle_response.success is True
        assert settle_response.network == "eip155:84532"
        assert settle_response.transaction != ""
        assert settle_response.payer.lower() == self.client_address.lower()

        print(f"✅ Transaction settled: {settle_response.transaction}")

    def test_client_creates_valid_evm_payment_payload(self) -> None:
        """Test that client creates properly structured EVM payload."""
        accepts = [
            build_evm_payment_requirements(
                "0x1234567890123456789012345678901234567890",
                "5000000",  # 5 USDC
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)

        payload = self.client.create_payment_payload(payment_required)

        assert payload.x402_version == 2
        assert payload.accepted.scheme == SCHEME_EXACT
        assert payload.accepted.amount == "5000000"

        # Check EVM payload structure
        assert "authorization" in payload.payload
        assert "signature" in payload.payload

        auth = payload.payload["authorization"]
        assert auth["from"].lower() == self.client_address.lower()
        assert auth["value"] == "5000000"
        assert auth["nonce"].startswith("0x")
        assert len(auth["nonce"]) == 66  # 0x + 64 hex chars

    def test_invalid_recipient_fails_verification(self) -> None:
        """Test that mismatched recipient fails verification."""
        accepts = [
            build_evm_payment_requirements(
                "0x1111111111111111111111111111111111111111",
                "1000",
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        # Change recipient in requirements
        different_accepts = [
            build_evm_payment_requirements(
                "0x2222222222222222222222222222222222222222",
                "1000",
            )
        ]

        # Manually verify with different requirements
        verify_response = self.server.verify_payment(payload, different_accepts[0])
        assert verify_response.is_valid is False
        assert "recipient" in verify_response.invalid_reason.lower()

    def test_insufficient_amount_fails_verification(self) -> None:
        """Test that insufficient amount fails verification."""
        accepts = [
            build_evm_payment_requirements(
                self.facilitator_address,
                "1000",  # Client pays 1000
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        # Try to verify against higher amount
        higher_accepts = [
            build_evm_payment_requirements(
                self.facilitator_address,
                "2000",  # Require 2000
            )
        ]

        verify_response = self.server.verify_payment(payload, higher_accepts[0])
        assert verify_response.is_valid is False
        assert (
            "amount" in verify_response.invalid_reason.lower()
            or "value" in verify_response.invalid_reason.lower()
        )

    def test_facilitator_get_supported(self) -> None:
        """Test that facilitator returns supported kinds."""
        supported = self.facilitator.get_supported()

        assert len(supported.kinds) >= 1

        # Find eip155:84532 support
        evm_support = None
        for kind in supported.kinds:
            if kind.network == "eip155:84532" and kind.scheme == SCHEME_EXACT:
                evm_support = kind
                break

        assert evm_support is not None
        assert evm_support.x402_version == 2


class TestEvmPriceParsing:
    """Tests for EVM server price parsing (no blockchain transactions needed)."""

    def setup_method(self) -> None:
        """Set up test fixtures."""
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )
        self.facilitator = x402FacilitatorSync().register(
            ["eip155:84532"],
            ExactEvmFacilitatorScheme(self.facilitator_signer),
        )

        facilitator_client = EvmFacilitatorClientSync(self.facilitator)
        self.server = x402ResourceServerSync(facilitator_client)
        self.evm_server = ExactEvmServerScheme()
        self.server.register("eip155:84532", self.evm_server)
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
                pay_to="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
                price=input_price,
                network="eip155:84532",
            )
            requirements = self.server.build_payment_requirements(config)

            assert len(requirements) == 1
            assert requirements[0].amount == expected_amount
            assert requirements[0].asset == USDC_ADDRESS

    def test_asset_amount_passthrough(self) -> None:
        """Test that AssetAmount is passed through directly."""
        from x402.schemas import AssetAmount

        custom_asset = AssetAmount(
            amount="5000000",
            asset="0xCustomToken1234567890123456789012345678",
            extra={"foo": "bar"},
        )

        config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
            price=custom_asset,
            network="eip155:84532",
        )
        requirements = self.server.build_payment_requirements(config)

        assert len(requirements) == 1
        assert requirements[0].amount == "5000000"
        assert requirements[0].asset == "0xCustomToken1234567890123456789012345678"

    def test_custom_money_parser(self) -> None:
        """Test registering custom money parser."""

        # Register custom parser for large amounts
        def large_amount_parser(amount: float, network: str):
            if amount > 100:
                from x402.schemas import AssetAmount

                return AssetAmount(
                    amount=str(int(amount * 1e18)),  # DAI has 18 decimals
                    asset="0x6B175474E89094C44Da98b954EedeAC495271d0F",
                    extra={"token": "DAI", "tier": "large"},
                )
            return None

        self.evm_server.register_money_parser(large_amount_parser)

        # Large amount - should use custom parser
        config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
            price=150,
            network="eip155:84532",
        )
        large_req = self.server.build_payment_requirements(config)

        assert large_req[0].extra.get("token") == "DAI"
        assert large_req[0].extra.get("tier") == "large"

        # Small amount - should use default USDC
        config2 = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
            price=50,
            network="eip155:84532",
        )
        small_req = self.server.build_payment_requirements(config2)

        assert small_req[0].asset == USDC_ADDRESS


class TestEvmSignersIntegration:
    """Integration tests for specific EthAccountSigner and FacilitatorWeb3Signer methods.

    These tests verify the signer interface methods work correctly.
    The full payment flow is already tested in TestEvmIntegrationV2.
    """

    def setup_method(self) -> None:
        """Set up test fixtures with library signers."""
        # Create signers using the library implementations
        client_account = Account.from_key(CLIENT_PRIVATE_KEY)
        self.client_signer = EthAccountSigner(client_account)
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )

        # Store addresses for assertions
        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.address

    def test_eth_account_signer_address(self) -> None:
        """Test that EthAccountSigner returns correct address."""
        account = Account.from_key(CLIENT_PRIVATE_KEY)
        expected_address = account.address

        assert self.client_signer.address == expected_address
        assert self.client_signer.address.startswith("0x")

    def test_facilitator_web3_signer_address(self) -> None:
        """Test that FacilitatorWeb3Signer returns correct address."""
        account = Account.from_key(FACILITATOR_PRIVATE_KEY)
        expected_address = account.address

        assert self.facilitator_signer.address == expected_address
        assert self.facilitator_address.startswith("0x")

    def test_facilitator_web3_signer_get_addresses(self) -> None:
        """Test that FacilitatorWeb3Signer.get_addresses returns correct list."""
        addresses = self.facilitator_signer.get_addresses()

        assert len(addresses) == 1
        assert addresses[0] == self.facilitator_address

    def test_facilitator_web3_signer_get_chain_id(self) -> None:
        """Test that FacilitatorWeb3Signer.get_chain_id returns correct chain."""
        chain_id = self.facilitator_signer.get_chain_id()

        # Base Sepolia chain ID
        assert chain_id == 84532

    def test_facilitator_web3_signer_get_balance(self) -> None:
        """Test that FacilitatorWeb3Signer.get_balance works for ERC20 tokens."""
        balance = self.facilitator_signer.get_balance(
            self.facilitator_address,
            USDC_ADDRESS,
        )

        # Should return an integer (balance might be 0 or more)
        assert isinstance(balance, int)
        assert balance >= 0

    def test_facilitator_web3_signer_get_native_balance(self) -> None:
        """Test that FacilitatorWeb3Signer.get_balance works for native token."""
        balance = self.facilitator_signer.get_balance(
            self.facilitator_address,
            "0x0000000000000000000000000000000000000000",
        )

        # Should return an integer
        assert isinstance(balance, int)
        assert balance >= 0

    def test_facilitator_web3_signer_get_code_eoa(self) -> None:
        """Test that FacilitatorWeb3Signer.get_code returns empty for EOA."""
        code = self.facilitator_signer.get_code(self.facilitator_address)

        # EOA should have no code
        assert code == b""

    def test_facilitator_web3_signer_get_code_contract(self) -> None:
        """Test that FacilitatorWeb3Signer.get_code returns bytecode for contract."""
        code = self.facilitator_signer.get_code(USDC_ADDRESS)

        # USDC contract should have code
        assert len(code) > 0

    def test_facilitator_web3_signer_read_contract(self) -> None:
        """Test that FacilitatorWeb3Signer.read_contract works."""
        balance = self.facilitator_signer.read_contract(
            USDC_ADDRESS,
            ERC20_ABI,
            "balanceOf",
            Web3.to_checksum_address(self.facilitator_address),
        )

        assert isinstance(balance, int)
        assert balance >= 0

    def test_eth_account_signer_sign_typed_data(self) -> None:
        """Test that EthAccountSigner.sign_typed_data produces valid signatures."""

        # Create a simple typed data message
        domain = TypedDataDomain(
            name="Test",
            version="1",
            chain_id=84532,
            verifying_contract="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        )
        types = {
            "Message": [
                TypedDataField(name="content", type="string"),
            ]
        }
        message = {"content": "Hello, world!"}

        # Sign the message
        signature = self.client_signer.sign_typed_data(
            domain=domain,
            types=types,
            primary_type="Message",
            message=message,
        )

        # Verify signature format
        assert isinstance(signature, bytes)
        assert len(signature) == 65  # r (32) + s (32) + v (1)

        # Verify with FacilitatorWeb3Signer
        is_valid = self.facilitator_signer.verify_typed_data(
            address=self.client_address,
            domain=domain,
            types=types,
            primary_type="Message",
            message=message,
            signature=signature,
        )
        assert is_valid is True

    def test_facilitator_web3_signer_verify_typed_data_invalid_signer(self) -> None:
        """Test that verify_typed_data returns False for wrong signer."""

        domain = TypedDataDomain(
            name="Test",
            version="1",
            chain_id=84532,
            verifying_contract="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        )
        types = {
            "Message": [
                TypedDataField(name="content", type="string"),
            ]
        }
        message = {"content": "Hello, world!"}

        # Sign with client
        signature = self.client_signer.sign_typed_data(
            domain=domain,
            types=types,
            primary_type="Message",
            message=message,
        )

        # Verify against wrong address should fail
        is_valid = self.facilitator_signer.verify_typed_data(
            address=self.facilitator_address,  # Wrong address!
            domain=domain,
            types=types,
            primary_type="Message",
            message=message,
            signature=signature,
        )
        assert is_valid is False


# =============================================================================
# Upto Integration Tests
# =============================================================================


def build_upto_payment_requirements(
    pay_to: str,
    amount: str,
    facilitator_address: str,
    network: str = "eip155:84532",
) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_UPTO,
        network=network,
        asset=USDC_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={
            "assetTransferMethod": "permit2",
            "facilitatorAddress": facilitator_address,
        },
    )


class UptoEvmFacilitatorClientSync:
    """Facilitator client wrapper for upto scheme."""

    scheme = SCHEME_UPTO
    network = "eip155:84532"
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync):
        self._facilitator = facilitator

    def verify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        return self._facilitator.verify(payload, requirements)

    def settle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        return self._facilitator.settle(payload, requirements)

    def get_supported(self) -> SupportedResponse:
        return self._facilitator.get_supported()


class TestEvmUptoIntegrationV2:
    """Integration tests for EVM Upto (V2) payment flow with REAL blockchain transactions."""

    def setup_method(self) -> None:
        client_account = Account.from_key(CLIENT_PRIVATE_KEY)
        self.client_signer = EthAccountSigner(client_account)
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )

        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.address

        # Register both exact and upto
        self.client = x402ClientSync()
        self.client.register("eip155:84532", UptoEvmClientScheme(self.client_signer))

        self.facilitator = x402FacilitatorSync()
        self.facilitator.register(
            ["eip155:84532"],
            UptoEvmFacilitatorScheme(self.facilitator_signer),
        )

        facilitator_client = UptoEvmFacilitatorClientSync(self.facilitator)

        self.server = x402ResourceServerSync(facilitator_client)
        self.server.register("eip155:84532", UptoEvmServerScheme())
        self.server.initialize()

    def test_server_should_verify_and_settle_upto_payment(self) -> None:
        """Full upto flow: client authorizes max, server settles actual amount."""
        recipient = self.facilitator_address

        accepts = [
            build_upto_payment_requirements(
                recipient,
                "1000",
                self.facilitator_address,
            )
        ]
        resource = ResourceInfo(
            url="https://api.example.com/llm/generate",
            description="LLM text generation",
            mime_type="application/json",
        )
        payment_required = self.server.create_payment_required_response(accepts, resource)

        assert payment_required.x402_version == 2

        payment_payload = self.client.create_payment_payload(payment_required)

        assert payment_payload.x402_version == 2
        assert payment_payload.accepted.scheme == SCHEME_UPTO
        assert "permit2Authorization" in payment_payload.payload
        assert "signature" in payment_payload.payload

        auth = payment_payload.payload["permit2Authorization"]
        assert auth["from"].lower() == self.client_address.lower()
        assert "facilitator" in auth["witness"]

        accepted = self.server.find_matching_requirements(accepts, payment_payload)
        assert accepted is not None

        verify_response = self.server.verify_payment(payment_payload, accepted)
        assert verify_response.is_valid is True
        assert verify_response.payer.lower() == self.client_address.lower()

        # Settle for a partial amount (500 of 1000 authorized)
        partial_requirements = build_upto_payment_requirements(
            recipient,
            "500",
            self.facilitator_address,
        )

        settle_response = self.server.settle_payment(payment_payload, partial_requirements)
        assert settle_response.success is True
        assert settle_response.network == "eip155:84532"
        assert settle_response.transaction != ""
        assert settle_response.payer.lower() == self.client_address.lower()

    def test_facilitator_get_supported_includes_upto(self) -> None:
        supported = self.facilitator.get_supported()

        upto_support = None
        for kind in supported.kinds:
            if kind.network == "eip155:84532" and kind.scheme == SCHEME_UPTO:
                upto_support = kind
                break

        assert upto_support is not None
        assert upto_support.x402_version == 2
        assert upto_support.extra is not None
        assert "facilitatorAddress" in upto_support.extra

    def test_client_creates_valid_upto_payload(self) -> None:
        accepts = [
            build_upto_payment_requirements(
                "0x1234567890123456789012345678901234567890",
                "5000000",
                self.facilitator_address,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        assert payload.x402_version == 2
        assert payload.accepted.scheme == SCHEME_UPTO
        p2 = payload.payload["permit2Authorization"]
        assert p2["permitted"]["amount"] == "5000000"
        assert "facilitator" in p2["witness"]
