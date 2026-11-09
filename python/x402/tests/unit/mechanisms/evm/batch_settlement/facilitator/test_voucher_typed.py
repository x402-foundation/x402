"""Unit tests for `verify_batch_settlement_voucher_typed_data`."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    from x402.mechanisms.evm.batch_settlement.constants import VOUCHER_TYPES
    from x402.mechanisms.evm.batch_settlement.facilitator.utils import (
        verify_batch_settlement_voucher_typed_data,
    )
    from x402.mechanisms.evm.batch_settlement.utils import (
        coerce_bytes32,
        get_batch_settlement_eip712_domain,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


CHAIN_ID = 8453
TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _sign_voucher(channel_id: str, amount: int) -> tuple[str, str]:
    account = Account.from_key(TEST_PRIVATE_KEY)
    domain = get_batch_settlement_eip712_domain(CHAIN_ID)
    message = {
        "channelId": coerce_bytes32(channel_id),
        "maxClaimableAmount": amount,
    }
    signable = encode_typed_data(
        domain_data=domain, message_types=VOUCHER_TYPES, message_data=message
    )
    sig = account.sign_message(signable)
    return account.address, sig.signature.hex()


class TestVerifyVoucherTypedData:
    def test_valid_signature_recovers_to_authorizer(self):
        channel_id = "0x" + "ab" * 32
        amount = 1000
        addr, sig = _sign_voucher(channel_id, amount)
        ok = verify_batch_settlement_voucher_typed_data(
            signer=None,  # type: ignore[arg-type] - not used when authorizer is non-zero
            channel_id=channel_id,
            max_claimable_amount=str(amount),
            payer_authorizer=addr,
            payer="0x0000000000000000000000000000000000000001",
            signature=sig,
            chain_id=CHAIN_ID,
        )
        assert ok is True

    def test_wrong_authorizer_returns_false(self):
        channel_id = "0x" + "ab" * 32
        amount = 1000
        _, sig = _sign_voucher(channel_id, amount)
        bogus = "0x9999999999999999999999999999999999999999"
        assert (
            verify_batch_settlement_voucher_typed_data(
                signer=None,  # type: ignore[arg-type]
                channel_id=channel_id,
                max_claimable_amount=str(amount),
                payer_authorizer=bogus,
                payer="0x0000000000000000000000000000000000000001",
                signature=sig,
                chain_id=CHAIN_ID,
            )
            is False
        )

    def test_wrong_amount_returns_false(self):
        channel_id = "0x" + "ab" * 32
        addr, sig = _sign_voucher(channel_id, 1000)
        assert (
            verify_batch_settlement_voucher_typed_data(
                signer=None,  # type: ignore[arg-type]
                channel_id=channel_id,
                max_claimable_amount="1001",
                payer_authorizer=addr,
                payer="0x0000000000000000000000000000000000000001",
                signature=sig,
                chain_id=CHAIN_ID,
            )
            is False
        )

    def test_garbage_signature_returns_false(self):
        channel_id = "0x" + "ab" * 32
        addr = Account.from_key(TEST_PRIVATE_KEY).address
        assert (
            verify_batch_settlement_voucher_typed_data(
                signer=None,  # type: ignore[arg-type]
                channel_id=channel_id,
                max_claimable_amount="1000",
                payer_authorizer=addr,
                payer="0x0000000000000000000000000000000000000001",
                signature="0x" + "00" * 65,
                chain_id=CHAIN_ID,
            )
            is False
        )

    def test_zero_authorizer_falls_back_to_signer_path(self):
        """With payer_authorizer=0, verify_typed_data_strict is called on the payer.

        The fake signer returns code (contract path) so EIP-1271 isValidSignature
        is exercised rather than ECDSA, confirming the strict signer path is taken
        instead of the payer_authorizer ECDSA path.
        """
        calls: list[dict] = []

        class _FakeSigner:
            def get_code(self, address: str) -> bytes:
                return b"\x01"  # treat payer as contract → EIP-1271 path

            def read_contract(self, address, abi, function_name, *args):
                if function_name == "isValidSignature":
                    calls.append({"function": "isValidSignature", "address": address})
                    return bytes.fromhex("1626ba7e")  # EIP1271_MAGIC_VALUE → True
                raise AssertionError(f"unexpected read_contract call: {function_name}")

        ok = verify_batch_settlement_voucher_typed_data(
            signer=_FakeSigner(),  # type: ignore[arg-type]
            channel_id="0x" + "ab" * 32,
            max_claimable_amount="1000",
            payer_authorizer="0x" + "00" * 20,
            payer="0x0000000000000000000000000000000000000123",
            signature="0x" + "11" * 65,
            chain_id=CHAIN_ID,
        )
        assert ok is True
        assert len(calls) == 1  # strict signer path was used (not payer_authorizer ECDSA)

    def test_zero_authorizer_signer_exception_returns_false(self):
        class _RaisingSigner:
            def verify_typed_data(self, **kwargs):
                raise RuntimeError("boom")

        assert (
            verify_batch_settlement_voucher_typed_data(
                signer=_RaisingSigner(),  # type: ignore[arg-type]
                channel_id="0x" + "ab" * 32,
                max_claimable_amount="1000",
                payer_authorizer="0x" + "00" * 20,
                payer="0x0000000000000000000000000000000000000123",
                signature="0x" + "11" * 65,
                chain_id=CHAIN_ID,
            )
            is False
        )
