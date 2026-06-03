"""Unit tests for the client-side payment-response hook."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account

    from x402.mechanisms.evm.batch_settlement.client.channel import (
        BatchSettlementClientDeps,
    )
    from x402.mechanisms.evm.batch_settlement.client.hooks import (
        PaymentResponseContext,
        create_batch_settlement_client_hooks,
        handle_batch_settlement_payment_response,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import PaymentRequired, PaymentRequirements, SettleResponse
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _deps() -> BatchSettlementClientDeps:
    return BatchSettlementClientDeps(
        signer=EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY)),
        storage=InMemoryClientChannelStorage(),
        salt="0x" + "00" * 32,
    )


def _settle(channel_id: str | None = "0xabc", balance: str = "100") -> SettleResponse:
    extra = (
        {
            "channelState": {
                "channelId": channel_id,
                "balance": balance,
                "totalClaimed": "0",
                "chargedCumulativeAmount": "0",
            }
        }
        if channel_id is not None
        else None
    )
    return SettleResponse(success=True, transaction="0xtx", network="eip155:8453", extra=extra)


class TestHandlePaymentResponse:
    def test_no_inputs_is_noop(self):
        deps = _deps()
        result = handle_batch_settlement_payment_response(deps, PaymentResponseContext())
        assert result is None

    def test_voucher_settle_response_updates_storage(self):
        deps = _deps()
        result = handle_batch_settlement_payment_response(
            deps,
            PaymentResponseContext(
                payment_payload={
                    "type": "voucher",
                    "voucher": {"channelId": "0xabc"},
                },
                settle_response=_settle(),
            ),
        )
        assert result is None
        got = deps.storage.get("0xabc")
        assert got is not None
        assert got.balance == "100"

    def test_refund_payload_uses_refund_update_path(self):
        deps = _deps()
        deps.storage.set("0xabc", BatchSettlementClientContext(balance="500"))
        result = handle_batch_settlement_payment_response(
            deps,
            PaymentResponseContext(
                payment_payload={
                    "type": "refund",
                    "channelConfig": {},
                    "voucher": {"channelId": "0xabc"},
                },
                settle_response=_settle(balance="50"),
            ),
        )
        assert result is None
        got = deps.storage.get("0xabc")
        assert got is not None
        assert got.balance == "50"

    def test_refund_with_zero_balance_keeps_sentinel_channel(self):
        deps = _deps()
        deps.storage.set("0xabc", BatchSettlementClientContext(balance="500"))
        handle_batch_settlement_payment_response(
            deps,
            PaymentResponseContext(
                payment_payload={
                    "type": "refund",
                    "channelConfig": {},
                    "voucher": {"channelId": "0xabc"},
                },
                settle_response=_settle(balance="0"),
            ),
        )
        # Full refund keeps a sentinel so the next refund fails locally.
        ctx = deps.storage.get("0xabc")
        assert ctx is not None
        assert ctx.balance == "0"

    def test_refund_without_channel_id_in_extra_is_noop(self):
        deps = _deps()
        deps.storage.set("0xabc", BatchSettlementClientContext(balance="100"))
        result = handle_batch_settlement_payment_response(
            deps,
            PaymentResponseContext(
                payment_payload={
                    "type": "refund",
                    "channelConfig": {},
                    "voucher": {"channelId": "0xabc"},
                },
                settle_response=SettleResponse(
                    success=True,
                    transaction="0xtx",
                    network="eip155:8453",
                    extra={},
                ),
            ),
        )
        assert result is None
        # Untouched.
        assert deps.storage.get("0xabc") is not None

    def test_payment_required_without_recoverable_returns_none(self):
        deps = _deps()
        pr = PaymentRequired(
            x402_version=2,
            error="some_unrelated_error",
            accepts=[
                PaymentRequirements(
                    scheme="batch-settlement",
                    network="eip155:8453",
                    asset="0xabc",
                    amount="0",
                    pay_to="0x0",
                    max_timeout_seconds=0,
                    extra={},
                )
            ],
        )
        result = handle_batch_settlement_payment_response(
            deps, PaymentResponseContext(payment_required=pr)
        )
        assert result is None


class TestCreateBatchSettlementClientHooks:
    def test_returns_callable_bound_to_deps(self):
        deps = _deps()
        hook = create_batch_settlement_client_hooks(deps)
        result = hook(
            PaymentResponseContext(
                payment_payload={
                    "type": "voucher",
                    "voucher": {"channelId": "0xabc"},
                },
                settle_response=_settle(),
            )
        )
        assert result is None
        assert deps.storage.get("0xabc") is not None
