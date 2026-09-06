"""Tests for UptoEvmScheme client."""

try:
    from eth_account import Account
    from eth_account.signers.local import LocalAccount
except ImportError:
    import pytest

    pytest.skip("EVM client requires eth_account", allow_module_level=True)

from x402.mechanisms.evm.constants import X402_UPTO_PERMIT2_PROXY_ADDRESS
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.mechanisms.evm.upto import UptoEvmClientScheme
from x402.schemas import PaymentRequirements

FACILITATOR = "0x1111111111111111111111111111111111111111"


def make_upto_requirements(
    *,
    network: str = "eip155:8453",
    amount: str = "500000",
    facilitator_address: str = FACILITATOR,
) -> PaymentRequirements:
    return PaymentRequirements(
        scheme="upto",
        network=network,
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount=amount,
        pay_to="0x0987654321098765432109876543210987654321",
        max_timeout_seconds=3600,
        extra={
            "assetTransferMethod": "permit2",
            "facilitatorAddress": facilitator_address,
        },
    )


class TestUptoEvmSchemeConstructor:
    def test_should_create_instance_with_correct_scheme(self):
        account = Account.create()
        signer = EthAccountSigner(account)
        client = UptoEvmClientScheme(signer)
        assert client.scheme == "upto"

    def test_should_store_signer_reference(self):
        account = Account.create()
        signer = EthAccountSigner(account)
        client = UptoEvmClientScheme(signer)
        assert client._signer is signer


class TestCreatePaymentPayload:
    def test_should_create_permit2_payload_with_facilitator(self):
        account = Account.create()
        signer = EthAccountSigner(account)
        client = UptoEvmClientScheme(signer)

        requirements = make_upto_requirements()
        payload = client.create_payment_payload(requirements)

        assert isinstance(payload, dict)
        assert "permit2Authorization" in payload
        assert "signature" in payload
        assert payload["signature"].startswith("0x")

        p2 = payload["permit2Authorization"]
        assert p2["from"] == account.address
        assert p2["spender"] == X402_UPTO_PERMIT2_PROXY_ADDRESS
        assert "facilitator" in p2["witness"]
        assert p2["witness"]["facilitator"].lower() == FACILITATOR.lower()

    def test_should_reject_missing_facilitator_address(self):
        account = Account.create()
        client = UptoEvmClientScheme(signer=account)

        requirements = PaymentRequirements(
            scheme="upto",
            network="eip155:8453",
            asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount="500000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2"},
        )

        import pytest

        with pytest.raises(ValueError, match="facilitatorAddress"):
            client.create_payment_payload(requirements)

    def test_permit2_payload_has_correct_witness_structure(self):
        account = Account.create()
        client = UptoEvmClientScheme(signer=account)

        requirements = make_upto_requirements()
        payload = client.create_payment_payload(requirements)

        witness = payload["permit2Authorization"]["witness"]
        assert "to" in witness
        assert "facilitator" in witness
        assert "validAfter" in witness

    def test_rejects_non_positive_timeout_window(self):
        import pytest

        account = Account.create()
        signer = EthAccountSigner(account)
        client = UptoEvmClientScheme(signer)

        requirements = make_upto_requirements()
        requirements.max_timeout_seconds = -1000

        with pytest.raises(ValueError, match="Invalid time window"):
            client.create_payment_payload(requirements)


class TestLocalAccountAutoWrap:
    def test_should_auto_wrap_local_account(self):
        account = Account.create()
        assert isinstance(account, LocalAccount)
        client = UptoEvmClientScheme(signer=account)
        assert isinstance(client._signer, EthAccountSigner)

    def test_auto_wrapped_signer_has_correct_address(self):
        account = Account.create()
        client = UptoEvmClientScheme(signer=account)
        assert client._signer.address == account.address

    def test_pre_wrapped_signer_is_not_double_wrapped(self):
        account = Account.create()
        signer = EthAccountSigner(account)
        client = UptoEvmClientScheme(signer=signer)
        assert client._signer is signer

    def test_raw_local_account_can_sign_payload(self):
        account = Account.create()
        client = UptoEvmClientScheme(signer=account)
        requirements = make_upto_requirements()

        payload = client.create_payment_payload(requirements)

        assert isinstance(payload, dict)
        assert "permit2Authorization" in payload
        assert "signature" in payload
        assert payload["signature"].startswith("0x")
        assert len(payload["signature"]) > 2
