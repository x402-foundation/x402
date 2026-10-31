"""Tests for EVM signer implementations."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

try:
    from eth_account import Account
except ImportError:
    pytest.skip("EVM signers require eth_account", allow_module_level=True)

from x402.mechanisms.evm.constants import ERC20_ALLOWANCE_ABI, PERMIT2_ADDRESS
from x402.mechanisms.evm.signer import (
    RPCChainConfig,
    RPCConfig,
    has_sufficient_permit2_allowance,
    resolve_rpc_url,
)
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer

ALLOWANCE_TEST_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
ALLOWANCE_TEST_OWNER = "0x1234567890123456789012345678901234567890"


class _RecordingEth:
    """Stands in for web3's `eth` namespace, capturing the receipt-wait timeout."""

    def __init__(self) -> None:
        self.timeout: float | None = None

    def wait_for_transaction_receipt(self, tx_hash, timeout):
        self.timeout = timeout
        return {"status": 1, "blockNumber": 1, "logs": []}


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

    @pytest.mark.parametrize(
        ("signer_kwargs", "expected_gas_limit"),
        [
            pytest.param({}, 500_000, id="default"),
            pytest.param({"gas_limit": 750_000}, 750_000, id="configured"),
        ],
    )
    def test_transactions_use_gas_limit(self, signer_kwargs, expected_gas_limit):
        """Transactions should use the default or configured gas limit."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
            **signer_kwargs,
        )
        builder = Mock()
        builder.build_transaction.side_effect = lambda tx: tx
        signer._w3 = Mock()
        signer._w3.eth.contract.return_value.functions.transfer = Mock(return_value=builder)
        signer._w3.eth.get_transaction_count.return_value = 0
        signer._w3.eth.gas_price = 1
        signer._w3.eth.send_raw_transaction.return_value = bytes.fromhex("12" * 32)
        signer._account.sign_transaction = Mock(
            return_value=SimpleNamespace(raw_transaction=b"signed")
        )

        signer.write_contract("0x1111111111111111111111111111111111111111", [], "transfer")
        signer.send_transaction("0x2222222222222222222222222222222222222222", b"")

        assert [
            call.args[0]["gas"] for call in signer._account.sign_transaction.call_args_list
        ] == [
            expected_gas_limit,
            expected_gas_limit,
        ]

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

    def test_receipt_wait_defaults_to_120_seconds(self):
        """Receipt wait should keep its historical 120s bound when unconfigured."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
        )
        signer._w3 = SimpleNamespace(eth=_RecordingEth())

        signer.wait_for_transaction_receipt("0x" + "ab" * 32)

        assert signer._w3.eth.timeout == 120

    def test_receipt_wait_honors_configured_timeout(self):
        """A configured timeout should bound the receipt wait."""
        account = Account.create()
        signer = FacilitatorWeb3Signer(
            private_key=account.key.hex(),
            rpc_url="https://sepolia.base.org",
            confirmation_timeout_seconds=25,
        )
        signer._w3 = SimpleNamespace(eth=_RecordingEth())

        signer.wait_for_transaction_receipt("0x" + "ab" * 32)

        assert signer._w3.eth.timeout == 25


class TestHasSufficientPermit2Allowance:
    """Test has_sufficient_permit2_allowance."""

    @pytest.mark.parametrize(
        ("result", "error", "required", "want"),
        [
            pytest.param(100, None, "100", True, id="allowance equals required"),
            pytest.param(101, None, "100", True, id="allowance exceeds required"),
            pytest.param(99, None, "100", False, id="allowance below required"),
            pytest.param(None, RuntimeError("rpc down"), "100", False, id="read error"),
            pytest.param("100", None, "100", False, id="unexpected result type"),
            pytest.param(100, None, "", False, id="empty required amount"),
            pytest.param(100, None, "abc", False, id="non-numeric required amount"),
        ],
    )
    def test_has_sufficient_permit2_allowance(self, result, error, required, want):
        signer = Mock()
        signer.read_contract.return_value = result
        signer.read_contract.side_effect = error

        got = has_sufficient_permit2_allowance(
            signer, ALLOWANCE_TEST_TOKEN, ALLOWANCE_TEST_OWNER, required
        )

        assert got is want
        signer.read_contract.assert_called_once_with(
            ALLOWANCE_TEST_TOKEN,
            ERC20_ALLOWANCE_ABI,
            "allowance",
            ALLOWANCE_TEST_OWNER,
            PERMIT2_ADDRESS,
        )


class TestResolveRPCURL:
    """Test resolve_rpc_url."""

    def test_chain_specific_rpc_wins_over_default(self):
        config = RPCConfig(
            rpc_url="https://default.example",
            rpc_by_chain_id={8453: RPCChainConfig(rpc_url="https://base.example")},
        )

        assert resolve_rpc_url(config, "eip155:8453") == "https://base.example"
        assert resolve_rpc_url(config, "eip155:137") == "https://default.example"

    def test_returns_empty_string_without_config(self):
        assert resolve_rpc_url(None, "eip155:8453") == ""
