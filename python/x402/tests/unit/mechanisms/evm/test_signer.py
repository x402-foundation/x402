"""Tests for EVM signer implementations."""

import pytest

try:
    from eth_account import Account
except ImportError:
    pytest.skip("EVM signers require eth_account", allow_module_level=True)

from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer


class TestEthAccountSigner:
    """Test EthAccountSigner client-side signer."""

    def test_should_create_signer_from_account(self):
        """Should create signer from LocalAccount."""
        account = Account.create()
        signer = EthAccountSigner(account)

        assert signer.address is not None
        assert signer.address.startswith("0x")
        assert len(signer.address) == 42  # 0x + 40 hex chars

    def test_address_should_return_checksummed_address(self):
        """address property should return checksummed address."""
        account = Account.create()
        signer = EthAccountSigner(account)

        assert signer.address == account.address

    def test_should_sign_typed_data(self):
        """Should sign EIP-712 typed data."""
        account = Account.create()
        signer = EthAccountSigner(account)

        from x402.mechanisms.evm.types import TypedDataDomain, TypedDataField

        domain = TypedDataDomain(
            name="USD Coin",
            version="2",
            chain_id=8453,
            verifying_contract="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        )

        types = {
            "TransferWithAuthorization": [
                TypedDataField(name="from", type="address"),
                TypedDataField(name="to", type="address"),
                TypedDataField(name="value", type="uint256"),
                TypedDataField(name="validAfter", type="uint256"),
                TypedDataField(name="validBefore", type="uint256"),
                TypedDataField(name="nonce", type="bytes32"),
            ]
        }

        message = {
            "from": account.address,
            "to": "0x1234567890123456789012345678901234567890",
            "value": "1000000",
            "validAfter": "1000000000",
            "validBefore": "1000003600",
            "nonce": "0x" + "00" * 32,
        }

        signature = signer.sign_typed_data(domain, types, "TransferWithAuthorization", message)

        assert signature is not None
        assert isinstance(signature, bytes)
        assert len(signature) >= 65  # ECDSA signature is 65 bytes


class TestFacilitatorWeb3Signer:
    """Test FacilitatorWeb3Signer facilitator-side signer."""

    def test_should_create_signer_with_private_key(self):
        """Should create signer with private key."""
        account = Account.create()
        private_key = account.key.hex()

        signer = FacilitatorWeb3Signer(
            private_key=private_key,
            rpc_url="https://sepolia.base.org",
        )

        assert signer.address is not None
        assert signer.address.startswith("0x")

    def test_should_create_signer_with_private_key_without_0x_prefix(self):
        """Should create signer with private key without 0x prefix."""
        account = Account.create()
        private_key = account.key.hex().removeprefix("0x")

        signer = FacilitatorWeb3Signer(
            private_key=private_key,
            rpc_url="https://sepolia.base.org",
        )

        assert signer.address == account.address

    def test_get_addresses_should_return_list_with_signer_address(self):
        """get_addresses should return list containing signer address."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
        )

        addresses = signer.get_addresses()

        assert isinstance(addresses, list)
        assert len(addresses) == 1
        assert addresses[0] == account.address
        assert all(isinstance(addr, str) for addr in addresses)

    def test_address_property_should_return_checksummed_address(self):
        """address property should return checksummed address."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
        )

        assert signer.address == account.address

    def test_should_have_required_methods(self):
        """Should have all required facilitator signer methods."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
        )

        # Verify all required methods exist
        assert hasattr(signer, "get_addresses")
        assert hasattr(signer, "read_contract")
        assert hasattr(signer, "verify_typed_data")
        assert hasattr(signer, "write_contract")
        assert hasattr(signer, "send_transaction")
        assert hasattr(signer, "wait_for_transaction_receipt")
        assert hasattr(signer, "get_balance")
        assert hasattr(signer, "get_chain_id")
        assert hasattr(signer, "get_code")

        # Verify they are callable
        assert callable(signer.get_addresses)
        assert callable(signer.read_contract)
        assert callable(signer.verify_typed_data)
        assert callable(signer.write_contract)
        assert callable(signer.send_transaction)
        assert callable(signer.wait_for_transaction_receipt)
        assert callable(signer.get_balance)
        assert callable(signer.get_chain_id)
        assert callable(signer.get_code)


class TestSignerProtocols:
    """Test that signers implement expected protocols."""

    def test_eth_account_signer_implements_client_protocol(self):
        """EthAccountSigner should implement ClientEvmSigner protocol."""
        account = Account.create()
        signer = EthAccountSigner(account)

        # ClientEvmSigner protocol requires:
        assert hasattr(signer, "address")
        assert hasattr(signer, "sign_typed_data")

    def test_facilitator_signer_implements_facilitator_protocol(self):
        """FacilitatorWeb3Signer should implement FacilitatorEvmSigner protocol."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
        )

        # FacilitatorEvmSigner protocol requires:
        assert hasattr(signer, "get_addresses")
        assert hasattr(signer, "read_contract")
        assert hasattr(signer, "verify_typed_data")
        assert hasattr(signer, "write_contract")
        assert hasattr(signer, "send_transaction")
        assert hasattr(signer, "wait_for_transaction_receipt")
        assert hasattr(signer, "get_balance")
        assert hasattr(signer, "get_chain_id")
        assert hasattr(signer, "get_code")
