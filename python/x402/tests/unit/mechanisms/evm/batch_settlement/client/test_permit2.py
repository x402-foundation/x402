"""Unit tests for `create_batch_settlement_permit2_deposit_payload`."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_utils import to_checksum_address

    from x402.mechanisms.evm.batch_settlement.client.permit2 import (
        create_batch_settlement_permit2_deposit_payload,
    )
    from x402.mechanisms.evm.batch_settlement.constants import (
        BATCH_PERMIT2_WITNESS_TYPES,
        PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
        SCHEME_BATCH_SETTLEMENT,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import (
        coerce_bytes32,
        compute_channel_id,
    )
    from x402.mechanisms.evm.constants import PERMIT2_ADDRESS
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


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=TOKEN,
        amount="100",
        pay_to=RECEIVER,
        max_timeout_seconds=60,
        extra={"receiverAuthorizer": RECEIVER_AUTHORIZER},
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


class TestCreatePermit2DepositPayload:
    def test_payload_shape_and_voucher(self):
        signer = _signer()
        cc = _channel_config(signer)
        payload = create_batch_settlement_permit2_deposit_payload(
            signer=signer,
            requirements=_requirements(),
            channel_config=cc,
            deposit_amount="1000",
            max_claimable_amount="100",
        )
        assert payload.deposit.amount == "1000"
        permit2 = payload.deposit.authorization.permit2_authorization
        assert permit2 is not None
        assert permit2.from_address.lower() == signer.address.lower()
        assert permit2.spender.lower() == PERMIT2_DEPOSIT_COLLECTOR_ADDRESS.lower()
        assert permit2.permitted.amount == "1000"
        assert permit2.permitted.token.lower() == TOKEN.lower()
        cid = compute_channel_id(cc, NETWORK)
        assert permit2.witness.channel_id.lower() == cid.lower()
        assert payload.voucher is not None
        assert payload.voucher.max_claimable_amount == "100"

    def test_permit2_signature_recovers_to_signer(self):
        signer = _signer()
        cc = _channel_config(signer)
        payload = create_batch_settlement_permit2_deposit_payload(
            signer=signer,
            requirements=_requirements(),
            channel_config=cc,
            deposit_amount="1000",
            max_claimable_amount="100",
        )
        permit2 = payload.deposit.authorization.permit2_authorization
        cid = compute_channel_id(cc, NETWORK)

        domain = {
            "name": "Permit2",
            "chainId": CHAIN_ID,
            "verifyingContract": PERMIT2_ADDRESS,
        }
        message = {
            "permitted": {
                "token": to_checksum_address(TOKEN),
                "amount": 1000,
            },
            "spender": to_checksum_address(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS),
            "nonce": int(permit2.nonce),
            "deadline": int(permit2.deadline),
            "witness": {
                "channelId": coerce_bytes32(cid),
            },
        }
        signable = encode_typed_data(
            domain_data=domain,
            message_types=BATCH_PERMIT2_WITNESS_TYPES,
            message_data=message,
        )
        recovered = Account.recover_message(signable, signature=permit2.signature)
        assert recovered.lower() == signer.address.lower()

    def test_voucher_signer_override_signs_voucher(self):
        signer = _signer()
        other = EthAccountSigner(Account.from_key("0x" + "33" * 32))
        cc = ChannelConfig(
            payer=signer.address,
            payer_authorizer=other.address,
            receiver=RECEIVER,
            receiver_authorizer=RECEIVER_AUTHORIZER,
            token=TOKEN,
            withdraw_delay=900,
            salt="0x" + "00" * 32,
        )
        payload = create_batch_settlement_permit2_deposit_payload(
            signer=signer,
            requirements=_requirements(),
            channel_config=cc,
            deposit_amount="1000",
            max_claimable_amount="100",
            voucher_signer=other,
        )
        assert payload.deposit.authorization.permit2_authorization is not None
        # voucher_signer is the authorizer; payer remains the token holder
        assert payload.voucher is not None
