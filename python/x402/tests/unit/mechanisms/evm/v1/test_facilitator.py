"""Tests for ExactEvmSchemeV1 facilitator verifying-contract trust gating.

Mirrors tests/unit/mechanisms/evm/test_facilitator.py's
TestVerifyingContractValidator, against the V1 (legacy) facilitator. No
dedicated V1 facilitator test file existed before this change.
"""

try:
    from eth_account import Account
except ImportError:
    import pytest

    pytest.skip("EVM facilitator requires eth_account", allow_module_level=True)

from x402.mechanisms.evm.constants import ERR_INVALID_SIGNATURE
from x402.mechanisms.evm.exact.v1 import (
    ExactEvmSchemeV1Client,
    ExactEvmSchemeV1Facilitator,
)
from x402.mechanisms.evm.exact.v1.facilitator import ExactEvmSchemeV1Config
from x402.mechanisms.evm.types import TransactionReceipt
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
GATEWAY_CONTRACT = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
RECIPIENT = "0x0987654321098765432109876543210987654321"


class MockFacilitatorSignerV1:
    """Minimal signer covering only what V1 verify/settle exercise here."""

    def __init__(self, *, code_by_address: dict[str, bytes] | None = None):
        self._code_by_address = {k.lower(): v for k, v in (code_by_address or {}).items()}
        self.write_addresses: list[str] = []

    def get_addresses(self) -> list[str]:
        return ["0x1111111111111111111111111111111111111111"]

    def get_code(self, address: str) -> bytes:
        return self._code_by_address.get(address.lower(), b"")

    def read_contract(self, address: str, abi: list[dict], function_name: str, *args):
        if function_name == "transferWithAuthorization":
            return None
        raise AssertionError(f"unexpected read_contract call: {function_name}")

    def write_contract(
        self,
        address: str,
        abi: list[dict],
        function_name: str,
        *args,
        data_suffix: str | None = None,
    ) -> str:
        self.write_addresses.append(address)
        return "0x" + "34" * 32

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        return TransactionReceipt(status=1, block_number=1, tx_hash=tx_hash)


def _gateway_requirements() -> PaymentRequirementsV1:
    return PaymentRequirementsV1(
        scheme="exact",
        network="base",
        asset=USDC_ASSET,
        max_amount_required="8000",
        pay_to=RECIPIENT,
        max_timeout_seconds=3600,
        resource="http://example.com/protected",
        extra={
            "name": "GatewayWalletBatched",
            "version": "1",
            "verifyingContract": GATEWAY_CONTRACT,
        },
    )


def _sign_with_client(account, requirements, *, trust_gateway: bool) -> PaymentPayloadV1:
    client = ExactEvmSchemeV1Client(
        signer=account,
        verifying_contract_validator=(
            (lambda addr, reqs: addr == GATEWAY_CONTRACT) if trust_gateway else None
        ),
    )
    signed = client.create_payment_payload(requirements)
    return PaymentPayloadV1(
        x402_version=1,
        scheme="exact",
        network=requirements.network,
        payload=signed,
    )


class TestVerifyingContractValidatorV1:
    """The V1 facilitator must verify and settle against
    extra.verifyingContract when a configured validator trusts it, not
    unconditionally against requirements.asset. Same bug as the V2
    facilitator (see TestVerifyingContractValidator in test_facilitator.py),
    duplicated in the V1 legacy code path."""

    def test_verifies_against_verifying_contract_when_validator_approves(self):
        account = Account.create()
        requirements = _gateway_requirements()
        payload = _sign_with_client(account, requirements, trust_gateway=True)

        signer = MockFacilitatorSignerV1(code_by_address={GATEWAY_CONTRACT: b"\x60"})
        facilitator = ExactEvmSchemeV1Facilitator(
            signer,
            ExactEvmSchemeV1Config(
                verifying_contract_validator=lambda addr, reqs: addr == GATEWAY_CONTRACT
            ),
        )

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is True

    def test_rejects_verifying_contract_signature_when_no_validator_configured(self):
        account = Account.create()
        requirements = _gateway_requirements()
        payload = _sign_with_client(account, requirements, trust_gateway=True)

        signer = MockFacilitatorSignerV1()
        facilitator = ExactEvmSchemeV1Facilitator(signer)  # no validator configured

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == ERR_INVALID_SIGNATURE

    def test_falls_back_to_asset_when_no_verifying_contract_in_extra(self):
        account = Account.create()
        requirements = PaymentRequirementsV1(
            scheme="exact",
            network="base",
            asset=USDC_ASSET,
            max_amount_required="500000",
            pay_to=RECIPIENT,
            max_timeout_seconds=3600,
            resource="http://example.com/protected",
            extra={"name": "USD Coin", "version": "2"},
        )
        payload = _sign_with_client(account, requirements, trust_gateway=False)

        signer = MockFacilitatorSignerV1(code_by_address={USDC_ASSET: b"\x60"})
        facilitator = ExactEvmSchemeV1Facilitator(
            signer,
            ExactEvmSchemeV1Config(verifying_contract_validator=lambda addr, reqs: True),
        )

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is True

    def test_settles_transferwithauthorization_against_verifying_contract(self):
        """settle must call transferWithAuthorization on the trusted
        verifying contract, not on requirements.asset."""
        account = Account.create()
        requirements = _gateway_requirements()
        payload = _sign_with_client(account, requirements, trust_gateway=True)

        signer = MockFacilitatorSignerV1(code_by_address={GATEWAY_CONTRACT: b"\x60"})
        facilitator = ExactEvmSchemeV1Facilitator(
            signer,
            ExactEvmSchemeV1Config(
                verifying_contract_validator=lambda addr, reqs: addr == GATEWAY_CONTRACT
            ),
        )

        result = facilitator.settle(payload, requirements)

        assert result.success is True
        assert signer.write_addresses == [GATEWAY_CONTRACT]
