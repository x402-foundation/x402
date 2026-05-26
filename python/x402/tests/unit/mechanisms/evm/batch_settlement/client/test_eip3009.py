"""Unit tests for `create_batch_settlement_eip3009_deposit_payload`."""

from __future__ import annotations

import time

import pytest

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_utils import to_checksum_address

    from x402.mechanisms.evm.batch_settlement.client.eip3009 import (
        create_batch_settlement_eip3009_deposit_payload,
    )
    from x402.mechanisms.evm.batch_settlement.constants import (
        ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
        RECEIVE_AUTHORIZATION_TYPES,
        SCHEME_BATCH_SETTLEMENT,
    )
    from x402.mechanisms.evm.batch_settlement.encoding import (
        build_erc3009_deposit_nonce,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import (
        coerce_bytes32,
        compute_channel_id,
    )
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import PaymentRequirements
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:84532"
CHAIN_ID = 84532
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
RECEIVER = "0x3333333333333333333333333333333333333333"
RECEIVER_AUTHORIZER = "0x4444444444444444444444444444444444444444"
TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _signer() -> EthAccountSigner:
    return EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY))


def _requirements(extra: dict | None = None) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=TOKEN,
        amount="100",
        pay_to=RECEIVER,
        max_timeout_seconds=60,
        extra=extra
        if extra is not None
        else {
            "receiverAuthorizer": RECEIVER_AUTHORIZER,
            "name": "USDC",
            "version": "2",
        },
    )


def _channel_config(signer: EthAccountSigner) -> ChannelConfig:
    return ChannelConfig(
        payer=signer.address,
        payer_authorizer=signer.address,
        receiver=RECEIVER,
        receiver_authorizer=RECEIVER_AUTHORIZER,
        token=TOKEN,
        withdraw_delay=900,
        salt="0x" + "00" * 32,
    )


class TestCreateEip3009DepositPayload:
    def test_missing_name_raises(self):
        signer = _signer()
        req = _requirements(extra={"receiverAuthorizer": RECEIVER_AUTHORIZER, "version": "2"})
        with pytest.raises(ValueError, match="EIP-712 domain"):
            create_batch_settlement_eip3009_deposit_payload(
                signer=signer,
                requirements=req,
                channel_config=_channel_config(signer),
                deposit_amount="1000",
                max_claimable_amount="100",
            )

    def test_missing_version_raises(self):
        signer = _signer()
        req = _requirements(extra={"receiverAuthorizer": RECEIVER_AUTHORIZER, "name": "USDC"})
        with pytest.raises(ValueError, match="EIP-712 domain"):
            create_batch_settlement_eip3009_deposit_payload(
                signer=signer,
                requirements=req,
                channel_config=_channel_config(signer),
                deposit_amount="1000",
                max_claimable_amount="100",
            )

    def test_payload_shape_and_voucher(self):
        signer = _signer()
        cc = _channel_config(signer)
        payload = create_batch_settlement_eip3009_deposit_payload(
            signer=signer,
            requirements=_requirements(),
            channel_config=cc,
            deposit_amount="1000",
            max_claimable_amount="100",
        )
        assert payload.deposit.amount == "1000"
        assert payload.deposit.authorization.erc3009_authorization is not None
        assert payload.voucher is not None
        assert payload.voucher.max_claimable_amount == "100"

        cid = compute_channel_id(cc, NETWORK)
        assert payload.voucher.channel_id.lower() == cid.lower()

    def test_erc3009_signature_recovers_to_signer(self):
        signer = _signer()
        cc = _channel_config(signer)
        before = int(time.time())
        payload = create_batch_settlement_eip3009_deposit_payload(
            signer=signer,
            requirements=_requirements(),
            channel_config=cc,
            deposit_amount="1000",
            max_claimable_amount="100",
        )
        auth = payload.deposit.authorization.erc3009_authorization
        # valid_after ~= now - 600, valid_before ~= now + timeout
        assert int(auth.valid_after) <= before
        assert int(auth.valid_before) >= before

        cid = compute_channel_id(cc, NETWORK)
        nonce = build_erc3009_deposit_nonce(cid, auth.salt)

        domain = {
            "name": "USDC",
            "version": "2",
            "chainId": CHAIN_ID,
            "verifyingContract": to_checksum_address(TOKEN),
        }
        message = {
            "from": to_checksum_address(signer.address),
            "to": to_checksum_address(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
            "value": 1000,
            "validAfter": int(auth.valid_after),
            "validBefore": int(auth.valid_before),
            "nonce": coerce_bytes32(nonce),
        }
        signable = encode_typed_data(
            domain_data=domain,
            message_types=RECEIVE_AUTHORIZATION_TYPES,
            message_data=message,
        )
        recovered = Account.recover_message(signable, signature=auth.signature)
        assert recovered.lower() == signer.address.lower()

    def test_voucher_signer_override_used_for_voucher_only(self):
        signer = _signer()
        other = EthAccountSigner(Account.from_key("0x" + "22" * 32))
        cc = ChannelConfig(
            payer=signer.address,
            payer_authorizer=other.address,
            receiver=RECEIVER,
            receiver_authorizer=RECEIVER_AUTHORIZER,
            token=TOKEN,
            withdraw_delay=900,
            salt="0x" + "00" * 32,
        )
        payload = create_batch_settlement_eip3009_deposit_payload(
            signer=signer,
            requirements=_requirements(),
            channel_config=cc,
            deposit_amount="1000",
            max_claimable_amount="100",
            voucher_signer=other,
        )
        # The deposit (ERC-3009) is still signed by `signer` (token holder);
        # the voucher is signed by the voucher_signer override.
        assert payload.deposit.authorization.erc3009_authorization is not None
        assert payload.voucher is not None
