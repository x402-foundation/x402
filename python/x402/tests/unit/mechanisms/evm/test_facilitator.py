"""Tests for the exact EVM facilitator's simulation-based verification flow."""

from __future__ import annotations

import time

import pytest

try:
    from eth_abi import encode as abi_encode
except ImportError:
    pytest.skip("eth-abi not available", allow_module_level=True)

from x402.mechanisms.evm import ERC6492_MAGIC_VALUE, get_network_config
from x402.mechanisms.evm.constants import (
    ERR_AUTHORIZATION_VALUE_MISMATCH,
    ERR_INSUFFICIENT_BALANCE,
    ERR_INVALID_SIGNATURE,
    ERR_NONCE_ALREADY_USED,
    ERR_TOKEN_NAME_MISMATCH,
    ERR_TOKEN_VERSION_MISMATCH,
    ERR_TRANSACTION_SIMULATION_FAILED,
    ERR_UNDEPLOYED_SMART_WALLET,
)
from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme, ExactEvmSchemeConfig
from x402.mechanisms.evm.exact.v1.facilitator import ExactEvmSchemeV1
from x402.mechanisms.evm.types import TransactionReceipt
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

NETWORK = "eip155:8453"
TOKEN_ADDRESS = get_network_config(NETWORK)["default_asset"]["address"]
PAYER = "0x1234567890123456789012345678901234567890"
RECIPIENT = "0x0987654321098765432109876543210987654321"
FACILITATOR = "0x1111111111111111111111111111111111111111"
FACTORY = "0x2222222222222222222222222222222222222222"
NONCE = "0x" + "11" * 32


def make_payment_payload(
    *,
    signature: str = "0x" + "00" * 65,
    accepted_scheme: str = "exact",
    accepted_network: str = NETWORK,
    pay_to: str = RECIPIENT,
    amount: str = "100000",
    extra: dict | None = None,
    authorization_overrides: dict | None = None,
) -> PaymentPayload:
    now = int(time.time())
    authorization = {
        "from": PAYER,
        "to": RECIPIENT,
        "value": amount,
        "validAfter": str(now - 60),
        "validBefore": str(now + 600),
        "nonce": NONCE,
    }
    if authorization_overrides:
        authorization.update(authorization_overrides)

    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/protected",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=PaymentRequirements(
            scheme=accepted_scheme,
            network=accepted_network,
            asset=TOKEN_ADDRESS,
            amount=amount,
            pay_to=pay_to,
            max_timeout_seconds=3600,
            extra=extra if extra is not None else {"name": "USD Coin", "version": "2"},
        ),
        payload={"authorization": authorization, "signature": signature},
    )


def make_requirements(
    *,
    scheme: str = "exact",
    network: str = NETWORK,
    amount: str = "100000",
    pay_to: str = RECIPIENT,
    extra: dict | None = None,
) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=scheme,
        network=network,
        asset=TOKEN_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra=extra if extra is not None else {"name": "USD Coin", "version": "2"},
    )


def make_payment_payload_v1(
    *,
    signature: str = "0x" + "00" * 65,
    scheme: str = "exact",
    network: str = "base",
    pay_to: str = RECIPIENT,
    amount: str = "100000",
    extra: dict | None = None,
    authorization_overrides: dict | None = None,
) -> PaymentPayloadV1:
    now = int(time.time())
    authorization = {
        "from": PAYER,
        "to": RECIPIENT,
        "value": amount,
        "validAfter": str(now - 60),
        "validBefore": str(now + 600),
        "nonce": NONCE,
    }
    if authorization_overrides:
        authorization.update(authorization_overrides)

    return PaymentPayloadV1(
        x402_version=1,
        scheme=scheme,
        network=network,
        payload={"authorization": authorization, "signature": signature},
    )


def make_requirements_v1(
    *,
    scheme: str = "exact",
    network: str = "base",
    amount: str = "100000",
    pay_to: str = RECIPIENT,
    extra: dict | None = None,
) -> PaymentRequirementsV1:
    return PaymentRequirementsV1(
        scheme=scheme,
        network=network,
        asset=TOKEN_ADDRESS,
        max_amount_required=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        resource="http://example.com/protected",
        extra=extra if extra is not None else {"name": "USD Coin", "version": "2"},
    )


def encode_result(abi_type: str, value):
    return abi_encode([abi_type], [value])


def make_diagnostic_results(
    *,
    balance: int = 100000,
    name: str = "USD Coin",
    version: str = "2",
    nonce_used: bool = False,
    authorization_state_supported: bool = True,
) -> list[tuple[bool, bytes]]:
    return [
        (True, encode_result("uint256", balance)),
        (True, encode_result("string", name)),
        (True, encode_result("string", version)),
        (
            authorization_state_supported,
            encode_result("bool", nonce_used) if authorization_state_supported else b"",
        ),
    ]


def make_erc6492_signature(inner_signature: bytes) -> str:
    payload = abi_encode(
        ["address", "bytes", "bytes"], [FACTORY, b"\xde\xad\xbe\xef", inner_signature]
    )
    return "0x" + (payload + ERC6492_MAGIC_VALUE).hex()


class MockFacilitatorSigner:
    """Mock signer that exposes just enough behavior for facilitator tests."""

    def __init__(
        self,
        *,
        addresses: list[str] | None = None,
        typed_data_valid: bool = True,
        code: bytes = b"",
        transfer_simulation_should_revert: bool = False,
        multicall_results: list[tuple[bool, bytes]] | None = None,
        deploy_tx_hash: str = "0x" + "12" * 32,
    ):
        self._addresses = addresses or [FACILITATOR]
        self.typed_data_valid = typed_data_valid
        self.code = code
        self.transfer_simulation_should_revert = transfer_simulation_should_revert
        self.multicall_results = multicall_results or []
        self.deploy_tx_hash = deploy_tx_hash
        self.transfer_simulation_calls = 0
        self.write_calls = 0
        self.send_calls = 0

    def get_addresses(self) -> list[str]:
        return self._addresses

    def read_contract(self, address: str, abi: list[dict], function_name: str, *args):
        if function_name == "tryAggregate":
            return self.multicall_results

        if function_name == "transferWithAuthorization":
            self.transfer_simulation_calls += 1
            if self.transfer_simulation_should_revert:
                raise RuntimeError("simulation reverted")
            return None

        raise AssertionError(f"unexpected read_contract call: {function_name}")

    def verify_typed_data(
        self,
        address: str,
        domain,
        types,
        primary_type: str,
        message: dict,
        signature: bytes,
    ) -> bool:
        return self.typed_data_valid

    def write_contract(self, address: str, abi: list[dict], function_name: str, *args) -> str:
        self.write_calls += 1
        return "0x" + "34" * 32

    def send_transaction(self, to: str, data: bytes) -> str:
        self.send_calls += 1
        return self.deploy_tx_hash

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        return TransactionReceipt(status=1, block_number=1, tx_hash=tx_hash)

    def get_balance(self, address: str, token_address: str) -> int:
        return 1_000_000_000

    def get_chain_id(self) -> int:
        return 8453

    def get_code(self, address: str) -> bytes:
        return self.code


class TestExactEvmSchemeConstructor:
    def test_creates_instance_with_config(self):
        signer = MockFacilitatorSigner()
        config = ExactEvmSchemeConfig(
            deploy_erc4337_with_eip6492=True,
            simulate_in_settle=True,
        )

        facilitator = ExactEvmFacilitatorScheme(signer, config)

        assert facilitator.scheme == "exact"
        assert facilitator._config.deploy_erc4337_with_eip6492 is True
        assert facilitator._config.simulate_in_settle is True


class TestVerify:
    def test_rejects_wrong_scheme(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(accepted_scheme="wrong"),
            make_requirements(),
        )

        assert result.is_valid is False
        assert "unsupported_scheme" in result.invalid_reason

    def test_rejects_wrong_network(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(accepted_network="eip155:1"),
            make_requirements(),
        )

        assert result.is_valid is False
        assert "network_mismatch" in result.invalid_reason

    def test_rejects_missing_eip712_domain(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(extra={}),
            make_requirements(extra={}),
        )

        assert result.is_valid is False
        assert "missing_eip712_domain" in result.invalid_reason

    def test_rejects_recipient_mismatch(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(
                authorization_overrides={"to": FACILITATOR},
                pay_to=RECIPIENT,
            ),
            make_requirements(),
        )

        assert result.is_valid is False
        assert "recipient_mismatch" in result.invalid_reason

    def test_rejects_amount_mismatch(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(amount="50000"),
            make_requirements(amount="100000"),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_AUTHORIZATION_VALUE_MISMATCH

    def test_rejects_overpayment_amount_mismatch(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(amount="150000"),
            make_requirements(amount="100000"),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_AUTHORIZATION_VALUE_MISMATCH

    def test_reports_name_mismatch_from_simulation_diagnostic(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"\x01",
            transfer_simulation_should_revert=True,
            multicall_results=make_diagnostic_results(name="Wrong Coin"),
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "22" * 66),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_TOKEN_NAME_MISMATCH

    def test_reports_version_mismatch_from_simulation_diagnostic(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"\x01",
            transfer_simulation_should_revert=True,
            multicall_results=make_diagnostic_results(version="3"),
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "22" * 66),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_TOKEN_VERSION_MISMATCH

    def test_deployed_erc1271_falls_back_to_simulation(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"\x01",
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "22" * 66),
            make_requirements(),
        )

        assert result.is_valid is True
        assert result.payer == PAYER
        assert signer.transfer_simulation_calls == 1

    def test_undeployed_erc6492_passes_when_deploy_and_transfer_simulate(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"",
            multicall_results=[(True, b""), (True, b"")],
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature=make_erc6492_signature(b"\x33" * 66)),
            make_requirements(),
        )

        assert result.is_valid is True
        assert result.payer == PAYER

    def test_undeployed_erc6492_rejects_when_simulation_fails(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"",
            multicall_results=[(True, b""), (False, b"")],
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature=make_erc6492_signature(b"\x33" * 66)),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_TRANSACTION_SIMULATION_FAILED

    def test_undeployed_smart_wallet_without_deployment_info_is_rejected(self):
        signer = MockFacilitatorSigner(typed_data_valid=False, code=b"")
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "22" * 66),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNDEPLOYED_SMART_WALLET

    def test_reports_nonce_used_from_simulation_diagnostic(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"\x01",
            transfer_simulation_should_revert=True,
            multicall_results=make_diagnostic_results(nonce_used=True),
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "22" * 66),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_NONCE_ALREADY_USED

    def test_reports_insufficient_balance_from_simulation_diagnostic(self):
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"\x01",
            transfer_simulation_should_revert=True,
            multicall_results=make_diagnostic_results(balance=1),
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "22" * 66),
            make_requirements(amount="100000"),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_INSUFFICIENT_BALANCE

    def test_eoa_invalid_signature_is_rejected_immediately(self):
        signer = MockFacilitatorSigner(typed_data_valid=False, code=b"")
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(
            make_payment_payload(signature="0x" + "00" * 65),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_INVALID_SIGNATURE


class TestSettle:
    def test_fails_settlement_if_verification_fails(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.settle(
            make_payment_payload(accepted_scheme="wrong"),
            make_requirements(),
        )

        assert result.success is False
        assert "unsupported_scheme" in result.error_reason
        assert result.network == NETWORK

    def test_can_rerun_simulation_during_settle(self):
        signer = MockFacilitatorSigner(typed_data_valid=True)
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(simulate_in_settle=True),
        )

        result = facilitator.settle(
            make_payment_payload(signature="0x" + "00" * 65),
            make_requirements(),
        )

        assert result.success is True
        assert signer.transfer_simulation_calls == 1
        assert signer.write_calls == 1


class TestVerifyV1:
    def test_rejects_overpayment_amount_mismatch(self):
        signer = MockFacilitatorSigner()
        facilitator = ExactEvmSchemeV1(signer)

        result = facilitator.verify(
            make_payment_payload_v1(amount="150000"),
            make_requirements_v1(amount="100000"),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_AUTHORIZATION_VALUE_MISMATCH


class TestFacilitatorSchemeAttributes:
    def test_scheme_attribute_is_exact(self):
        facilitator = ExactEvmFacilitatorScheme(MockFacilitatorSigner())
        assert facilitator.scheme == "exact"

    def test_caip_family_attribute(self):
        facilitator = ExactEvmFacilitatorScheme(MockFacilitatorSigner())
        assert facilitator.caip_family == "eip155:*"

    def test_get_extra_returns_none(self):
        facilitator = ExactEvmFacilitatorScheme(MockFacilitatorSigner())
        assert facilitator.get_extra(NETWORK) is None

    def test_get_signers_returns_signer_addresses(self):
        addresses = [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
        ]
        facilitator = ExactEvmFacilitatorScheme(MockFacilitatorSigner(addresses=addresses))
        assert facilitator.get_signers(NETWORK) == addresses
