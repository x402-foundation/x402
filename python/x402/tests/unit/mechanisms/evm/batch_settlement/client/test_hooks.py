"""Unit tests for the client-side payment-response hook."""

from __future__ import annotations

from typing import Any

import pytest

try:
    from eth_account import Account

    from x402.mechanisms.evm.batch_settlement.client.channel import (
        BatchSettlementClientDeps,
        build_channel_config,
    )
    from x402.mechanisms.evm.batch_settlement.client.hooks import (
        create_batch_settlement_client_hooks,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import (
        PaymentPayload,
        PaymentRequirements,
        PaymentResponseContext,
        SettleResponse,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"
NETWORK = "eip155:84532"
ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
RECEIVER_ADDRESS = "0x9876543210987654321098765432109876543210"
RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111"
HOSTILE_CHANNEL_ID = "0xabc12300000000000000000000000000000000000000000000000000000000aa"


def _signer() -> EthAccountSigner:
    return EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY))


def _deps(
    signer: EthAccountSigner | None = None,
    storage: InMemoryClientChannelStorage | None = None,
) -> BatchSettlementClientDeps:
    return BatchSettlementClientDeps(
        signer=signer or _signer(),
        storage=storage or InMemoryClientChannelStorage(),
        salt="0x" + "00" * 32,
    )


def _make_requirements(amount: str = "1000") -> PaymentRequirements:
    return PaymentRequirements(
        scheme="batch-settlement",
        network=NETWORK,
        amount=amount,
        asset=ASSET,
        pay_to=RECEIVER_ADDRESS,
        max_timeout_seconds=3600,
        extra={
            "name": "USDC",
            "version": "2",
            "receiverAuthorizer": RECEIVER_AUTHORIZER,
            "withdrawDelay": 900,
        },
    )


def _make_payment_payload(payload: dict[str, Any]) -> PaymentPayload:
    return PaymentPayload(x402_version=2, accepted=_make_requirements(), payload=payload)


def _make_settle(signer_address: str, extra: dict[str, Any]) -> SettleResponse:
    return SettleResponse(
        success=True,
        transaction="0x",
        network=NETWORK,
        payer=signer_address,
        extra=extra,
    )


def _make_failed_settle(signer_address: str, extra: dict[str, Any] | None = None) -> SettleResponse:
    return SettleResponse(
        success=False,
        transaction="",
        network=NETWORK,
        payer=signer_address,
        error_reason="settlement_failed",
        extra=extra or {},
    )


def _seed_channel(
    storage: InMemoryClientChannelStorage,
    channel_id: str,
    *,
    balance: str,
    charged_cumulative_amount: str,
    total_claimed: str | None = None,
) -> None:
    storage.set(
        channel_id.lower(),
        BatchSettlementClientContext(
            balance=balance,
            charged_cumulative_amount=charged_cumulative_amount,
            total_claimed=total_claimed,
        ),
    )


class TestUpdateChannelFromSettleSchemeHooks:
    def test_applies_capped_charged_amount_to_local_cumulative_and_leaves_balance_unchanged(
        self,
    ):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        requirements = _make_requirements(amount="1000")
        deps = _deps(signer=signer, storage=storage)
        channel_id = compute_channel_id(build_channel_config(deps, requirements), NETWORK)
        _seed_channel(
            storage,
            channel_id,
            balance="9000",
            charged_cumulative_amount="0",
            total_claimed="500",
        )

        hooks = create_batch_settlement_client_hooks(deps)
        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload({"type": "voucher"}),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {
                        "chargedAmount": "1000",
                        "channelState": {
                            "channelId": channel_id,
                            "chargedCumulativeAmount": "1000",
                            "balance": "1",
                            "totalClaimed": "999",
                        },
                    },
                ),
            )
        )
        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "1000"
        assert ctx.balance == "9000"
        assert ctx.total_claimed == "500"

    def test_does_not_record_a_locally_signed_deposit_when_settlement_fails(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        deps = _deps(signer=signer, storage=storage)
        hooks = create_batch_settlement_client_hooks(deps)
        requirements = _make_requirements()
        config = build_channel_config(deps, requirements)
        channel_id = compute_channel_id(config, NETWORK)

        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload(
                    {
                        "type": "deposit",
                        "channelConfig": config.to_dict(),
                        "voucher": {
                            "channelId": channel_id,
                            "maxClaimableAmount": "1000",
                            "signature": "0xdead",
                        },
                        "deposit": {
                            "amount": "5000",
                            "authorization": {},
                        },
                    }
                ),
                requirements=requirements,
                settle_response=_make_failed_settle(signer.address, {"chargedAmount": "1000"}),
            )
        )

        assert storage.get(channel_id.lower()) is None

    def test_routes_refund_settle_responses_through_refund_reconciliation(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        deps = _deps(signer=signer, storage=storage)
        hooks = create_batch_settlement_client_hooks(deps)
        requirements = _make_requirements()
        config = build_channel_config(deps, requirements)
        channel_id = compute_channel_id(config, NETWORK)

        storage.set(
            channel_id.lower(),
            BatchSettlementClientContext(charged_cumulative_amount="1000"),
        )
        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload(
                    {
                        "type": "refund",
                        "channelConfig": config.to_dict(),
                        "voucher": {
                            "channelId": channel_id,
                            "maxClaimableAmount": "1000",
                            "signature": "0xdead",
                        },
                    }
                ),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {"channelState": {"channelId": channel_id, "balance": "9999"}},
                ),
            )
        )

        assert storage.get(channel_id.lower()) is None

        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload({"type": "voucher"}),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {"channelState": {"channelId": channel_id, "balance": "0"}},
                ),
            )
        )

        assert storage.get(channel_id.lower()) is None

    def test_subtracts_payload_amount_on_a_partial_refund_and_ignores_server_balance(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        deps = _deps(signer=signer, storage=storage)
        hooks = create_batch_settlement_client_hooks(deps)
        requirements = _make_requirements()
        config = build_channel_config(deps, requirements)
        channel_id = compute_channel_id(config, NETWORK)

        _seed_channel(storage, channel_id, charged_cumulative_amount="1000", balance="10000")
        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload(
                    {
                        "type": "refund",
                        "channelConfig": config.to_dict(),
                        "voucher": {
                            "channelId": channel_id,
                            "maxClaimableAmount": "1000",
                            "signature": "0xdead",
                        },
                        "amount": "2000",
                    }
                ),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {"channelState": {"channelId": channel_id, "balance": "0"}},
                ),
            )
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.balance == "8000"
        assert ctx.charged_cumulative_amount == "1000"

    def test_leaves_local_state_unchanged_when_refund_settlement_fails(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        deps = _deps(signer=signer, storage=storage)
        hooks = create_batch_settlement_client_hooks(deps)
        requirements = _make_requirements()
        config = build_channel_config(deps, requirements)
        channel_id = compute_channel_id(config, NETWORK)
        previous = BatchSettlementClientContext(
            charged_cumulative_amount="1000",
            balance="10000",
            total_claimed="500",
        )
        storage.set(channel_id.lower(), previous)

        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload(
                    {
                        "type": "refund",
                        "channelConfig": config.to_dict(),
                        "voucher": {
                            "channelId": channel_id,
                            "maxClaimableAmount": "1000",
                            "signature": "0xdead",
                        },
                        "amount": "2000",
                    }
                ),
                requirements=requirements,
                settle_response=_make_failed_settle(signer.address),
            )
        )

        assert storage.get(channel_id.lower()) == previous

    def test_keys_refund_reconciliation_by_the_locally_computed_channel_id(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        deps = _deps(signer=signer, storage=storage)
        hooks = create_batch_settlement_client_hooks(deps)
        requirements = _make_requirements()
        config = build_channel_config(deps, requirements)
        local_id = compute_channel_id(config, NETWORK)
        hostile_id = "0xabc12300000000000000000000000000000000000000000000000000000000ff"

        _seed_channel(storage, local_id, charged_cumulative_amount="1000", balance="5000")
        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload(
                    {
                        "type": "refund",
                        "channelConfig": config.to_dict(),
                        "voucher": {
                            "channelId": local_id,
                            "maxClaimableAmount": "1000",
                            "signature": "0xdead",
                        },
                    }
                ),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {"channelState": {"channelId": hostile_id, "balance": "9999"}},
                ),
            )
        )

        assert storage.get(local_id.lower()) is None
        assert storage.get(hostile_id.lower()) is None


class TestUpdateChannelFromSettleLocalTruth:
    def test_does_not_write_a_second_key_when_extra_channel_id_does_not_match(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        requirements = _make_requirements(amount="10000")
        deps = _deps(signer=signer, storage=storage)
        channel_id = compute_channel_id(build_channel_config(deps, requirements), NETWORK)
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        hooks = create_batch_settlement_client_hooks(deps)
        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload({"type": "voucher"}),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {
                        "chargedAmount": "10000",
                        "channelState": {
                            "channelId": HOSTILE_CHANNEL_ID,
                            "chargedCumulativeAmount": "10000",
                            "balance": "50000",
                        },
                    },
                ),
            )
        )

        assert storage.get(HOSTILE_CHANNEL_ID) is None
        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "10000"
        assert ctx.balance == "50000"

    def test_ignores_voucher_only_channel_state_balance_deflation(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        requirements = _make_requirements(amount="10000")
        deps = _deps(signer=signer, storage=storage)
        channel_id = compute_channel_id(build_channel_config(deps, requirements), NETWORK)
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        hooks = create_batch_settlement_client_hooks(deps)
        hooks.on_payment_response(
            PaymentResponseContext(
                payment_payload=_make_payment_payload({"type": "voucher"}),
                requirements=requirements,
                settle_response=_make_settle(
                    signer.address,
                    {
                        "chargedAmount": "10000",
                        "channelState": {
                            "channelId": channel_id,
                            "chargedCumulativeAmount": "10000",
                            "balance": "10000",
                        },
                    },
                ),
            )
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "10000"
        assert ctx.balance == "50000"
