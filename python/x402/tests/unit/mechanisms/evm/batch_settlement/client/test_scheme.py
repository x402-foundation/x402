"""Unit tests for the client-side `BatchSettlementEvmScheme`."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account

    from x402.mechanisms.evm.batch_settlement.client.config import (
        BatchSettlementDepositPolicy,
        BatchSettlementEvmSchemeOptions,
    )
    from x402.mechanisms.evm.batch_settlement.client.scheme import (
        BatchSettlementEvmScheme,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.constants import (
        SCHEME_BATCH_SETTLEMENT,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import PaymentRequirements, SettleResponse
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:84532"
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
RECEIVER = "0x3333333333333333333333333333333333333333"
RECEIVER_AUTHORIZER = "0x4444444444444444444444444444444444444444"
TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _signer() -> EthAccountSigner:
    return EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY))


def _requirements(
    amount: str = "100",
    extra: dict | None = None,
) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=TOKEN,
        amount=amount,
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


def _channel_id_for(signer: EthAccountSigner, salt: str = "0x" + "00" * 32) -> str:
    config = ChannelConfig(
        payer=signer.address,
        payer_authorizer=signer.address,
        receiver=RECEIVER,
        receiver_authorizer=RECEIVER_AUTHORIZER,
        token=TOKEN,
        withdraw_delay=900,
        salt=salt,
    )
    return compute_channel_id(config, NETWORK).lower()


class TestConstruction:
    def test_basic_construction(self):
        s = BatchSettlementEvmScheme(_signer())
        assert s.scheme == SCHEME_BATCH_SETTLEMENT

    def test_payer_authorizer_must_match_voucher_signer(self):
        signer = _signer()
        # voucher_signer differs from payer_authorizer → must raise.
        other_voucher_signer = EthAccountSigner(Account.from_key("0x" + "11" * 32))
        opts = BatchSettlementEvmSchemeOptions(
            payer_authorizer="0x9999999999999999999999999999999999999999",
            voucher_signer=other_voucher_signer,
        )
        with pytest.raises(ValueError, match="payer_authorizer"):
            BatchSettlementEvmScheme(signer, opts)


class TestCreatePaymentPayload:
    def test_first_request_creates_deposit_payload(self):
        signer = _signer()
        s = BatchSettlementEvmScheme(signer)
        out = s.create_payment_payload(_requirements(amount="100"))
        assert out["type"] == "deposit"
        assert "channelConfig" in out
        assert "voucher" in out
        assert "deposit" in out

    def test_existing_channel_with_balance_emits_voucher(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        cid = _channel_id_for(signer)
        storage.set(
            cid,
            BatchSettlementClientContext(
                balance="10000",
                charged_cumulative_amount="0",
            ),
        )
        s = BatchSettlementEvmScheme(
            signer,
            BatchSettlementEvmSchemeOptions(storage=storage),
        )
        out = s.create_payment_payload(_requirements(amount="100"))
        assert out["type"] == "voucher"
        assert out["voucher"]["maxClaimableAmount"] == "100"

    def test_top_up_when_max_claimable_exceeds_balance(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        cid = _channel_id_for(signer)
        storage.set(
            cid,
            BatchSettlementClientContext(
                balance="50",
                charged_cumulative_amount="0",
            ),
        )
        s = BatchSettlementEvmScheme(
            signer,
            BatchSettlementEvmSchemeOptions(storage=storage),
        )
        out = s.create_payment_payload(_requirements(amount="100"))
        assert out["type"] == "deposit"

    def test_deposit_strategy_can_skip(self):
        """When deposit_strategy returns False on top-up scenario, fall back to voucher-only."""
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        cid = _channel_id_for(signer)
        storage.set(
            cid,
            BatchSettlementClientContext(
                balance="10000",  # enough balance, no top-up needed → voucher anyway
            ),
        )
        # Strategy returning False would only matter if a deposit was needed.
        s = BatchSettlementEvmScheme(
            signer,
            BatchSettlementEvmSchemeOptions(
                storage=storage,
                deposit_strategy=lambda ctx: False,
            ),
        )
        out = s.create_payment_payload(_requirements(amount="100"))
        assert out["type"] == "voucher"

    def test_unsupported_asset_transfer_method_raises(self):
        signer = _signer()
        s = BatchSettlementEvmScheme(signer)
        req = _requirements(
            amount="100",
            extra={
                "receiverAuthorizer": RECEIVER_AUTHORIZER,
                "assetTransferMethod": "bogus",
                "name": "USDC",
                "version": "2",
            },
        )
        with pytest.raises(ValueError, match="assetTransferMethod"):
            s.create_payment_payload(req)


class TestProcessSettleResponse:
    def test_updates_client_storage(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        s = BatchSettlementEvmScheme(signer, BatchSettlementEvmSchemeOptions(storage=storage))
        settle = SettleResponse(
            success=True,
            transaction="0xtx",
            network=NETWORK,
            extra={
                "channelState": {
                    "channelId": "0xabc",
                    "balance": "500",
                    "totalClaimed": "100",
                    "chargedCumulativeAmount": "100",
                }
            },
        )
        s.process_settle_response(settle)
        got = storage.get("0xabc")
        assert got is not None
        assert got.balance == "500"


class TestBuildChannelConfig:
    def test_build_channel_config_uses_signer_address(self):
        signer = _signer()
        s = BatchSettlementEvmScheme(signer)
        config = s.build_channel_config(_requirements())
        # Payer == signer (checksummed)
        assert config.payer.lower() == signer.address.lower()
        assert config.token.lower() == TOKEN.lower()


class TestDepositPolicyConstruction:
    def test_policy_alone_accepted(self):
        signer = _signer()
        s = BatchSettlementEvmScheme(signer, BatchSettlementDepositPolicy(deposit_multiplier=7))
        assert s.scheme == SCHEME_BATCH_SETTLEMENT

    def test_invalid_policy_rejected(self):
        signer = _signer()
        with pytest.raises(ValueError):
            BatchSettlementEvmScheme(signer, BatchSettlementDepositPolicy(deposit_multiplier=2))
