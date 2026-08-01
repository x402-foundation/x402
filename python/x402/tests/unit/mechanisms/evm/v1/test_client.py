"""Tests for ExactEvmSchemeV1 client verifying-contract trust gating.

Mirrors tests/unit/mechanisms/evm/test_client.py's
TestSigningDomainVerifyingContract, against the V1 (legacy) client.
"""

try:
    from eth_account import Account
except ImportError:
    import pytest

    pytest.skip("EVM client requires eth_account", allow_module_level=True)

from x402.mechanisms.evm.exact.v1 import ExactEvmSchemeV1
from x402.schemas.v1 import PaymentRequirementsV1

USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
GATEWAY_CONTRACT = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
RECIPIENT = "0x0987654321098765432109876543210987654321"


class TestSigningDomainVerifyingContractV1:
    """extra.verifyingContract must only be trusted for EIP-712 signing when
    an explicit validator approves it (V1 legacy client)."""

    def _signed_domain_matches(self, payload, requirements, verifying_contract):
        """True if `payload`'s signature recovers against the given verifying_contract."""
        from eth_account.messages import _hash_eip191_message, encode_typed_data
        from eth_keys import KeyAPI
        from eth_utils import to_checksum_address

        from x402.mechanisms.evm.v1.utils import get_evm_chain_id

        auth = payload["authorization"]
        domain = {
            "name": requirements.extra["name"],
            "version": requirements.extra.get("version", "1"),
            "chainId": get_evm_chain_id(requirements.network),
            "verifyingContract": verifying_contract,
        }
        types = {
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ]
        }
        message = {
            "from": auth["from"],
            "to": auth["to"],
            "value": int(auth["value"]),
            "validAfter": int(auth["validAfter"]),
            "validBefore": int(auth["validBefore"]),
            "nonce": bytes.fromhex(auth["nonce"].removeprefix("0x")),
        }
        signable = encode_typed_data(domain_data=domain, message_types=types, message_data=message)
        digest = _hash_eip191_message(signable)
        signature = bytes.fromhex(payload["signature"].removeprefix("0x"))
        r, s, v = signature[:32], signature[32:64], signature[64]
        rec_id = v - 27 if v >= 27 else v
        pubkey = (
            KeyAPI()
            .Signature(vrs=(rec_id, int.from_bytes(r, "big"), int.from_bytes(s, "big")))
            .recover_public_key_from_msg_hash(digest)
        )
        return to_checksum_address(pubkey.to_address()) == to_checksum_address(auth["from"])

    def _gateway_requirements(self) -> PaymentRequirementsV1:
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

    def test_signs_against_custom_verifying_contract_when_validator_approves(self):
        account = Account.create()
        client = ExactEvmSchemeV1(
            signer=account,
            verifying_contract_validator=lambda addr, reqs: addr == GATEWAY_CONTRACT,
        )
        requirements = self._gateway_requirements()

        payload = client.create_payment_payload(requirements)

        assert self._signed_domain_matches(payload, requirements, GATEWAY_CONTRACT)
        assert not self._signed_domain_matches(payload, requirements, USDC_ASSET)

    def test_falls_back_to_asset_when_no_verifying_contract_given(self):
        account = Account.create()
        client = ExactEvmSchemeV1(signer=account)
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

        payload = client.create_payment_payload(requirements)

        assert self._signed_domain_matches(payload, requirements, USDC_ASSET)

    def test_falls_back_to_asset_when_no_validator_supplied(self):
        account = Account.create()
        client = ExactEvmSchemeV1(signer=account)
        requirements = self._gateway_requirements()

        payload = client.create_payment_payload(requirements)

        assert self._signed_domain_matches(payload, requirements, USDC_ASSET)
        assert not self._signed_domain_matches(payload, requirements, GATEWAY_CONTRACT)

    def test_falls_back_to_asset_when_validator_rejects(self):
        account = Account.create()
        client = ExactEvmSchemeV1(
            signer=account,
            verifying_contract_validator=lambda addr, reqs: False,
        )
        requirements = self._gateway_requirements()

        payload = client.create_payment_payload(requirements)

        assert self._signed_domain_matches(payload, requirements, USDC_ASSET)

    def test_validator_receives_candidate_and_requirements(self):
        from unittest.mock import Mock

        account = Account.create()
        validator = Mock(return_value=True)
        client = ExactEvmSchemeV1(signer=account, verifying_contract_validator=validator)
        requirements = self._gateway_requirements()

        client.create_payment_payload(requirements)

        validator.assert_called_once_with(GATEWAY_CONTRACT, requirements)

    def test_validator_not_invoked_when_no_verifying_contract_present(self):
        from unittest.mock import Mock

        account = Account.create()
        validator = Mock(return_value=True)
        client = ExactEvmSchemeV1(signer=account, verifying_contract_validator=validator)
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

        client.create_payment_payload(requirements)

        validator.assert_not_called()
