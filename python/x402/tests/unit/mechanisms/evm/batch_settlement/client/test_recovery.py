"""Unit tests for the client-side corrective-402 recovery flow."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account

    from x402.mechanisms.evm.batch_settlement.client.channel import (
        BatchSettlementClientDeps,
    )
    from x402.mechanisms.evm.batch_settlement.client.recovery import (
        process_corrective_payment_required,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.constants import (
        SCHEME_BATCH_SETTLEMENT,
    )
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
        ERR_CUMULATIVE_AMOUNT_MISMATCH,
    )
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import PaymentRequired, PaymentRequirements
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _deps() -> BatchSettlementClientDeps:
    return BatchSettlementClientDeps(
        signer=EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY)),
        storage=InMemoryClientChannelStorage(),
        salt="0x" + "00" * 32,
    )


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network="eip155:84532",
        asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount="0",
        pay_to="0x3333333333333333333333333333333333333333",
        max_timeout_seconds=60,
        extra={"receiverAuthorizer": "0x4444444444444444444444444444444444444444"},
    )


class TestProcessCorrectivePaymentRequired:
    def test_unknown_error_returns_false(self):
        deps = _deps()
        pr = PaymentRequired(
            x402_version=2,
            error="something_else",
            accepts=[_requirements()],
        )
        assert process_corrective_payment_required(deps, pr) is False

    def test_no_batch_settlement_accept_returns_false(self):
        deps = _deps()
        other = PaymentRequirements(
            scheme="exact",
            network="eip155:84532",
            asset="0x1",
            amount="0",
            pay_to="0x2",
            max_timeout_seconds=60,
            extra={},
        )
        pr = PaymentRequired(
            x402_version=2,
            error=ERR_CUMULATIVE_AMOUNT_MISMATCH,
            accepts=[other],
        )
        assert process_corrective_payment_required(deps, pr) is False

    def test_without_signer_read_contract_returns_false(self):
        """No on-chain reader → cannot validate or recover."""
        deps = _deps()
        # accept includes a channelState extra but no voucherState → falls back to onchain.
        req = _requirements()
        req.extra = {
            **req.extra,
            "channelState": {
                "channelId": "0x" + "ab" * 32,
                "balance": "0",
                "totalClaimed": "0",
                "chargedCumulativeAmount": "0",
            },
        }
        pr = PaymentRequired(
            x402_version=2,
            error=ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
            accepts=[req],
        )
        # EthAccountSigner has no read_contract → recovery cannot complete.
        assert process_corrective_payment_required(deps, pr) is False
