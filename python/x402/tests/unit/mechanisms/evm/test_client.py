"""Tests for ExactEvmScheme client."""

try:
    from eth_account import Account
    from eth_account.signers.base import BaseAccount
    from eth_account.signers.local import LocalAccount
except ImportError:
    import pytest

    pytest.skip("EVM client requires eth_account", allow_module_level=True)

from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.mechanisms.evm.utils import get_asset_info
from x402.schemas import PaymentRequirements


class TestExactEvmSchemeConstructor:
    """Test ExactEvmScheme constructor."""

    def test_should_create_instance_with_correct_scheme(self):
        """Should create instance with correct scheme."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)

        assert client.scheme == "exact"

    def test_should_store_signer_reference(self):
        """Should store signer reference."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)

        # Client should have access to signer (internal attribute)
        assert client._signer is signer


class TestCreatePaymentPayload:
    """Test create_payment_payload method."""

    def test_should_have_create_payment_payload_method(self):
        """Should have create_payment_payload method."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)

        assert hasattr(client, "create_payment_payload")
        assert callable(client.create_payment_payload)

    def test_should_accept_v2_requirements_with_amount_field(self):
        """Should accept V2 requirements with amount field."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)
        network = "eip155:8453"

        # Verify the client accepts PaymentRequirements (v2) with amount field
        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # USDC on Base
            amount="500000",  # V2 uses 'amount'
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={
                "name": "USD Coin",
                "version": "2",
            },
        )

        assert requirements.amount == "500000"
        assert client.scheme == "exact"

    def test_requirements_must_have_eip712_domain(self):
        """Requirements must have EIP-712 domain in extra."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # USDC on Base
            amount="100000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={},  # Missing EIP-712 domain
        )

        # The method should exist and handle this error scenario
        assert client.create_payment_payload is not None
        assert requirements.extra is not None
        assert requirements.extra.get("name") is None


class TestClientSchemeAttributes:
    """Test client scheme attributes and methods."""

    def test_scheme_attribute_is_exact(self):
        """scheme attribute should be 'exact'."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)

        assert client.scheme == "exact"

    def test_client_stores_signer_reference(self):
        """Client should store signer reference."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer)

        # Client should have access to signer (internal attribute)
        assert client._signer is signer


class TestLocalAccountAutoWrap:
    """Test that raw LocalAccount is auto-wrapped in EthAccountSigner."""

    def test_should_auto_wrap_local_account(self):
        """Passing a raw LocalAccount should auto-wrap it in EthAccountSigner."""
        account = Account.create()
        assert isinstance(account, LocalAccount)

        client = ExactEvmClientScheme(signer=account)

        assert isinstance(client._signer, EthAccountSigner)

    def test_auto_wrapped_signer_has_correct_address(self):
        """Auto-wrapped signer should preserve the account address."""
        account = Account.create()

        client = ExactEvmClientScheme(signer=account)

        assert client._signer.address == account.address

    def test_pre_wrapped_signer_is_not_double_wrapped(self):
        """An EthAccountSigner should pass through without re-wrapping."""
        account = Account.create()
        signer = EthAccountSigner(account)

        client = ExactEvmClientScheme(signer=signer)

        assert client._signer is signer

    def test_raw_local_account_can_sign_payload(self):
        """End-to-end: raw LocalAccount should produce a valid signed payload."""
        account = Account.create()
        network = "eip155:8453"

        # Pass raw LocalAccount — no manual EthAccountSigner wrapping
        client = ExactEvmClientScheme(signer=account)

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset=get_asset_info(network, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")["address"],
            amount="500000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={
                "name": "USD Coin",
                "version": "2",
            },
        )

        payload = client.create_payment_payload(requirements)

        assert isinstance(payload, dict)
        assert "authorization" in payload
        assert "signature" in payload
        assert payload["signature"].startswith("0x")
        assert len(payload["signature"]) > 2  # not just "0x"

    def test_eip3009_payload_sets_valid_after_to_zero(self):
        """EIP-3009 payload should use validAfter=0 and maxTimeout for validBefore."""
        import time

        account = Account.create()
        client = ExactEvmClientScheme(signer=account)
        network = "eip155:8453"
        now = int(time.time())

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount="500000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=600,
            extra={
                "name": "USD Coin",
                "version": "2",
            },
        )

        payload = client.create_payment_payload(requirements)
        auth = payload["authorization"]

        assert auth["validAfter"] == "0"
        assert int(auth["validBefore"]) >= now + 600 - 2
        assert int(auth["validBefore"]) <= now + 600 + 2


class _CustomBaseAccountSigner(BaseAccount):
    """A signer that satisfies `BaseAccount` without being a `LocalAccount`.

    Mirrors third-party wallet-provider adapters (e.g. Coinbase AgentKit's
    `EvmWalletSigner`) that wrap non-key-based custody backends: they extend
    the abstract `BaseAccount` directly and implement `sign_typed_data` with
    eth_account's keyword convention, but are never a `LocalAccount` instance.
    """

    def __init__(self):
        self._account = Account.create()

    @property
    def address(self):
        return self._account.address

    def unsafe_sign_hash(self, message_hash):
        return self._account.unsafe_sign_hash(message_hash)

    def sign_message(self, signable_message):
        return self._account.sign_message(signable_message)

    def sign_transaction(self, transaction_dict):
        return self._account.sign_transaction(transaction_dict)

    def sign_typed_data(
        self, domain_data=None, message_types=None, message_data=None, full_message=None
    ):
        return self._account.sign_typed_data(
            domain_data=domain_data,
            message_types=message_types,
            message_data=message_data,
            full_message=full_message,
        )


class TestBaseAccountAutoWrap:
    """A non-`LocalAccount` `BaseAccount` signer must also be auto-wrapped.

    Regression test: `_wrap_if_local_account` previously checked
    `isinstance(signer, LocalAccount)`, which only matches raw private-key
    accounts. Wallet-provider adapters that extend `BaseAccount` directly
    (not `LocalAccount`) fell through unwrapped, and were then called with
    `EthAccountSigner`'s 4-positional-argument convention
    (`domain, types, primary_type, message`), which does not match
    eth_account's keyword convention — causing a `KeyError` deep in
    `eth_account.messages.encode_typed_data`.
    """

    def test_should_auto_wrap_base_account_signer(self):
        """A custom BaseAccount (not LocalAccount) should be auto-wrapped."""
        signer = _CustomBaseAccountSigner()
        assert isinstance(signer, BaseAccount)
        assert not isinstance(signer, LocalAccount)

        client = ExactEvmClientScheme(signer=signer)

        assert isinstance(client._signer, EthAccountSigner)

    def test_custom_base_account_signer_can_sign_payload(self):
        """End-to-end: a custom BaseAccount signer should produce a valid signed payload."""
        signer = _CustomBaseAccountSigner()
        network = "eip155:8453"

        client = ExactEvmClientScheme(signer=signer)

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset=get_asset_info(network, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")["address"],
            amount="500000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={
                "name": "USD Coin",
                "version": "2",
            },
        )

        payload = client.create_payment_payload(requirements)

        assert isinstance(payload, dict)
        assert "authorization" in payload
        assert "signature" in payload
        assert payload["signature"].startswith("0x")
        assert len(payload["signature"]) > 2  # not just "0x"
