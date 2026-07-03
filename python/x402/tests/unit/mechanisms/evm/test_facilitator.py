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
    ERR_ASSET_NOT_DEPLOYED_CONTRACT,
    ERR_AUTHORIZATION_VALUE_MISMATCH,
    ERR_FACTORY_NOT_ALLOWED,
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
        code_by_address: dict[str, bytes] | None = None,
        transfer_simulation_should_revert: bool = False,
        write_should_revert: bool = False,
        multicall_results: list[tuple[bool, bytes]] | None = None,
        deploy_tx_hash: str = "0x" + "12" * 32,
    ):
        self._addresses = addresses or [FACILITATOR]
        self.typed_data_valid = typed_data_valid
        self.code = code
        # Default: token contract is always a deployed contract so the asset check passes.
        self._code_by_address: dict[str, bytes] = {
            TOKEN_ADDRESS.lower(): b"\x60",
        }
        if code_by_address:
            self._code_by_address.update({k.lower(): v for k, v in code_by_address.items()})
        self.transfer_simulation_should_revert = transfer_simulation_should_revert
        self.write_should_revert = write_should_revert
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

        if function_name == "isValidSignature":
            # EIP-1271 support: honour typed_data_valid for contract-path verification.
            return bytes.fromhex("1626ba7e") if self.typed_data_valid else b"\x00\x00\x00\x00"

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
        if self.write_should_revert:
            raise RuntimeError("execution reverted: invalid signature")
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
        explicit = self._code_by_address.get(address.lower())
        if explicit is not None:
            return explicit
        # After a factory deployment (send_transaction called), simulate that the
        # deployed wallet's bytecode is now visible on the node.
        if self.send_calls > 0 and self.code == b"":
            return b"\x60"
        return self.code


class TestExactEvmSchemeConstructor:
    def test_creates_instance_with_config(self):
        signer = MockFacilitatorSigner()
        config = ExactEvmSchemeConfig(
            eip6492_allowed_factories=["0x1111111111111111111111111111111111111111"],
            simulate_in_settle=True,
        )

        facilitator = ExactEvmFacilitatorScheme(signer, config)

        assert facilitator.scheme == "exact"
        assert facilitator._config.eip6492_allowed_factories == [
            "0x1111111111111111111111111111111111111111"
        ]
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
        # Verify now mirrors settle's allowlist gate, so the factory must be allowlisted.
        facilitator = ExactEvmFacilitatorScheme(
            signer, ExactEvmSchemeConfig(eip6492_allowed_factories=[FACTORY])
        )

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
        facilitator = ExactEvmFacilitatorScheme(
            signer, ExactEvmSchemeConfig(eip6492_allowed_factories=[FACTORY])
        )

        result = facilitator.verify(
            make_payment_payload(signature=make_erc6492_signature(b"\x33" * 66)),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_TRANSACTION_SIMULATION_FAILED

    def test_undeployed_erc6492_rejects_when_factory_not_allowlisted(self):
        # Verify must mirror settle: a counterfactual payment whose factory is not in the
        # allowlist is rejected before simulation, just as settle would refuse to deploy it.
        signer = MockFacilitatorSigner(
            typed_data_valid=False,
            code=b"",
            multicall_results=[(True, b""), (True, b"")],
        )
        facilitator = ExactEvmFacilitatorScheme(signer)  # empty allowlist

        result = facilitator.verify(
            make_payment_payload(signature=make_erc6492_signature(b"\x33" * 66)),
            make_requirements(),
        )

        assert result.is_valid is False
        assert result.invalid_reason == ERR_FACTORY_NOT_ALLOWED

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

    def test_rejects_eoa_asset(self):
        # When the asset address has no bytecode (EOA), verify must reject before signature checks.
        signer = MockFacilitatorSigner(
            code_by_address={
                TOKEN_ADDRESS.lower(): b"",  # token = EOA
                PAYER.lower(): b"\x01",  # payer = contract so strict EIP-1271 path is taken
            },
        )
        facilitator = ExactEvmFacilitatorScheme(signer)

        result = facilitator.verify(make_payment_payload(), make_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == ERR_ASSET_NOT_DEPLOYED_CONTRACT

    def test_getcode_rpc_error_raises(self):
        # An RPC error on get_code must propagate as an exception (internal error), not a 400.
        # Payer returns code so verify_typed_data_strict can complete via EIP-1271;
        # the RPC error fires on the asset-contract check (outside the sig try/except).
        class _RPCErrorSigner(MockFacilitatorSigner):
            def get_code(self, address: str) -> bytes:
                if address.lower() == PAYER.lower():
                    return b"\x01"  # payer has code → EIP-1271 path inside verify_typed_data_strict
                raise RuntimeError("rpc: connection refused")

        facilitator = ExactEvmFacilitatorScheme(_RPCErrorSigner())

        with pytest.raises(RuntimeError, match="rpc: connection refused"):
            facilitator.verify(make_payment_payload(), make_requirements())


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
        # Payer has code so verify_typed_data_strict takes the EIP-1271 path, which
        # honours typed_data_valid=True via the isValidSignature mock above.
        signer = MockFacilitatorSigner(
            typed_data_valid=True,
            code_by_address={PAYER.lower(): b"\x01"},
        )
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


class TestSettleFactoryAllowlist:
    """ERC-6492 factory allowlist enforcement during settle."""

    def _erc6492_payload(self):
        return make_payment_payload(signature=make_erc6492_signature(b"\x33" * 66))

    def test_empty_allowlist_blocks_factory_deployment(self):
        signer = MockFacilitatorSigner(typed_data_valid=True, code=b"")
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=[],
            ),
        )

        result = facilitator.settle(self._erc6492_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_FACTORY_NOT_ALLOWED
        assert signer.send_calls == 0

    def test_matching_factory_in_allowlist_deploys_and_settles(self):
        signer = MockFacilitatorSigner(typed_data_valid=True, code=b"")
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=[FACTORY],
            ),
        )

        result = facilitator.settle(self._erc6492_payload(), make_requirements())

        assert result.success is True
        assert signer.send_calls == 1  # factory deployment
        assert signer.write_calls == 1  # transferWithAuthorization

    def test_deployed_wallet_rejecting_inner_sig_classifies_transfer_revert(self):
        # After deploying the wallet via the allowlisted factory, settle submits the
        # on-chain transferWithAuthorization (the authoritative signature check) — there
        # is no separate pre-transfer gate. A deployed wallet that rejects the inner
        # signature surfaces as a reverted transfer, classified via
        # parse_eip3009_transfer_error.
        signer = MockFacilitatorSigner(
            typed_data_valid=True,
            code=b"",
            write_should_revert=True,
        )
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=[FACTORY],
            ),
        )

        result = facilitator.settle(self._erc6492_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_INVALID_SIGNATURE
        assert signer.send_calls == 1  # wallet was deployed
        assert signer.write_calls == 1  # transfer was submitted (and reverted)

    def test_case_insensitive_factory_match(self):
        signer = MockFacilitatorSigner(typed_data_valid=True, code=b"")
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=[FACTORY.upper()],
            ),
        )

        result = facilitator.settle(self._erc6492_payload(), make_requirements())

        assert result.success is True
        assert signer.send_calls == 1

    def test_non_matching_factory_is_blocked(self):
        signer = MockFacilitatorSigner(typed_data_valid=True, code=b"")
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=["0x3333333333333333333333333333333333333333"],
            ),
        )

        result = facilitator.settle(self._erc6492_payload(), make_requirements())

        assert result.success is False
        assert result.error_reason == ERR_FACTORY_NOT_ALLOWED
        assert signer.send_calls == 0

    def test_already_deployed_wallet_skips_allowlist_check(self):
        # Wallet already has code: deployment path is skipped entirely.
        signer = MockFacilitatorSigner(typed_data_valid=True, code=b"\x60\x80")
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=[],  # empty — would block if deployment were attempted
            ),
        )

        result = facilitator.settle(self._erc6492_payload(), make_requirements())

        assert result.success is True
        assert signer.send_calls == 0  # no deployment needed
        assert signer.write_calls == 1

    def test_eoa_payer_unaffected_by_allowlist(self):
        # EOA-style signature (no ERC-6492 wrapper) — allowlist is irrelevant.
        # Payer has code so verify_typed_data_strict uses the EIP-1271 path and
        # typed_data_valid=True makes isValidSignature return the magic value.
        signer = MockFacilitatorSigner(
            typed_data_valid=True,
            code_by_address={PAYER.lower(): b"\x01"},
        )
        facilitator = ExactEvmFacilitatorScheme(
            signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=[],
            ),
        )

        result = facilitator.settle(
            make_payment_payload(signature="0x" + "00" * 65),
            make_requirements(),
        )

        assert result.success is True
        assert signer.send_calls == 0


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
