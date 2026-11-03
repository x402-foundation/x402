"""Independent protocol/lifecycle checks using public resource-server methods.
No external RPC, live transactions, or credentials. Accounts and values are synthetic.
"""

import asyncio

import pytest
from eth_account import Account

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.mechanisms.evm.batch_settlement.client.channel import (
    BatchSettlementClientDeps,
    build_channel_config,
)
from x402.mechanisms.evm.batch_settlement.client.storage import InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
from x402.mechanisms.evm.batch_settlement.server.scheme import (
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeServerConfig,
)
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.schemas import (
    AbortResult,
    PaymentAbortedError,
    PaymentPayload,
    PaymentRequirements,
    RecoveredSettleResult,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)

NETWORK = "eip155:84532"
RECEIVER = "0x3333333333333333333333333333333333333333"
AUTH = "0x4444444444444444444444444444444444444444"
TOKEN = "0x5555555555555555555555555555555555555555"


class RefundSigner:
    address = "0x6666666666666666666666666666666666666666"

    def __init__(self, fail=False):
        self.fail = fail
        self.messages = []

    def sign_typed_data(self, **kwargs):
        self.messages.append(kwargs)
        if self.fail:
            raise RuntimeError("synthetic signer outage")
        return "0x" + "12" * 65


class Remote:
    def __init__(self):
        self.calls = []
        self.verify_extra = {
            "pendingId": "trusted-admission",
            "chargedCumulativeAmount": "1000",
            "balance": "10000",
            "totalClaimed": "0",
            "refundNonce": "7",
            "withdrawRequestedAt": 0,
        }
        self.outcomes = []

    def get_supported(self):
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=2,
                    scheme="batch-settlement",
                    network=NETWORK,
                    extra={
                        "voucherManager": ["server", "facilitator"],
                        "receiverAuthorizer": AUTH,
                        "withdrawDelay": 900,
                        "delegatedRefund": True,
                    },
                )
            ],
            extensions=[],
            signers={},
        )

    def verify(self, p, r):
        self.calls.append(("verify", p, r))
        return VerifyResponse(is_valid=True, extra=self.verify_extra)

    def settle(self, p, r):
        self.calls.append(("settle", p, r))
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return self.receipt(p)

    def receipt(self, p):
        return SettleResponse(
            success=True,
            transaction="0xsynthetic",
            amount="500",
            network=NETWORK,
            extra={
                "chargeCount": 0,
                "channelState": {
                    "channelId": p.payload["voucher"]["channelId"],
                    "chargedCumulativeAmount": "1000",
                    "balance": "9500",
                    "totalClaimed": "1000",
                    "refundNonce": "8",
                    "withdrawRequestedAt": 0,
                },
            },
        )


class AsyncRemote(Remote):
    async def verify(self, p, r):
        return super().verify(p, r)

    async def settle(self, p, r):
        return super().settle(p, r)


def scenario(async_mode=False, kind="refund", signer=None):
    remote = AsyncRemote() if async_mode else Remote()
    scheme = BatchSettlementEvmScheme(
        RECEIVER,
        BatchSettlementEvmSchemeServerConfig(
            voucher_store_mode="facilitator", refund_authorizer_signer=signer
        ),
    )
    server = (
        x402ResourceServer(remote) if async_mode else x402ResourceServerSync(remote)
    ).register(NETWORK, scheme)
    server.initialize()
    req = scheme.enhance_payment_requirements(
        PaymentRequirements(
            scheme="batch-settlement",
            network=NETWORK,
            asset=TOKEN,
            amount="100",
            pay_to=RECEIVER,
            max_timeout_seconds=60,
            extra={},
        ),
        remote.get_supported().kinds[0],
        [],
    )
    wallet = EthAccountSigner(Account.create())
    config = build_channel_config(
        BatchSettlementClientDeps(wallet, InMemoryClientChannelStorage(), "1"), req
    )
    channel_id = compute_channel_id(config, NETWORK)
    raw = {
        "type": kind,
        "channelConfig": config.to_dict(),
        "voucher": sign_voucher(
            wallet, channel_id, "1000" if kind == "refund" else "1100", NETWORK
        ).to_dict(),
    }
    if kind == "refund":
        raw["amount"] = "500"
    p = PaymentPayload(x402_version=2, accepted=req, payload=raw)
    return remote, scheme, server, p


def invoke(async_mode, call):
    return asyncio.run(call) if async_mode else call


def verify(async_mode, server, p):
    return invoke(async_mode, server.verify_payment(p, p.accepted))


def settle(async_mode, server, p):
    return invoke(async_mode, server.settle_payment(p, p.accepted))


def cancel_calls(remote):
    return [c for c in remote.calls if c[0] == "settle" and c[1].payload.get("cancel") is True]


@pytest.mark.parametrize("async_mode", [False, True])
def test_signer_outage_releases_known_undispatched_admission(async_mode):
    remote, scheme, server, p = scenario(async_mode, signer=RefundSigner(True))
    assert verify(async_mode, server, p).is_valid
    with pytest.raises(RuntimeError, match="synthetic signer outage"):
        settle(async_mode, server, p)
    calls = cancel_calls(remote)
    assert len(calls) == 1
    assert calls[0][1].payload["pendingId"] == "trusted-admission" and calls[0][2].amount == "0"
    assert scheme.read_request_context(p) is None


@pytest.mark.parametrize("async_mode", [False, True])
def test_explicit_before_settle_abort_releases_admission(async_mode):
    remote, scheme, server, p = scenario(async_mode, kind="voucher")
    assert verify(async_mode, server, p).is_valid
    server.on_before_settle(
        lambda c: AbortResult(reason="application declined") if c.phase != "cancel" else None
    )
    with pytest.raises(PaymentAbortedError, match="application declined"):
        settle(async_mode, server, p)
    assert len(cancel_calls(remote)) == 1
    assert cancel_calls(remote)[0][2].amount == "0"
    assert scheme.read_request_context(p) is None


@pytest.mark.parametrize("async_mode", [False, True])
def test_failed_cancellation_retains_identity_and_original_error(async_mode):
    remote, scheme, server, p = scenario(async_mode, signer=RefundSigner(True))
    assert verify(async_mode, server, p).is_valid
    remote.outcomes = [
        SettleResponse(
            success=False, transaction="", network=NETWORK, error_reason="synthetic_cancel_failure"
        )
    ]
    with pytest.raises(RuntimeError, match="synthetic signer outage"):
        settle(async_mode, server, p)
    assert len(cancel_calls(remote)) == 1
    assert scheme.read_request_context(p).pending_id == "trusted-admission"


@pytest.mark.parametrize("async_mode", [False, True])
def test_pending_bounded_retry_retains_refund_context(async_mode):
    remote, scheme, server, p = scenario(async_mode)
    assert verify(async_mode, server, p).is_valid
    pending = SettleResponse(
        success=False, error_reason="settlement_pending", transaction="0xpending", network=NETWORK
    )
    remote.outcomes = [pending, pending]
    result = settle(async_mode, server, p)
    assert result is pending
    assert len([c for c in remote.calls if c[0] == "settle"]) == 2
    assert not cancel_calls(remote)
    assert scheme.read_request_context(p).pending_id == "trusted-admission"
    # A later explicit retry must enrich the identical reservation and reach the facilitator.
    result = settle(async_mode, server, p)
    assert result.success
    assert remote.calls[-1][1].payload["pendingId"] == "trusted-admission"


@pytest.mark.parametrize("async_mode", [False, True])
def test_unknown_remote_exception_retains_identity_without_cancellation(async_mode):
    remote, scheme, server, p = scenario(async_mode)
    assert verify(async_mode, server, p).is_valid
    remote.outcomes = [RuntimeError("synthetic connection dropped")]
    with pytest.raises(RuntimeError, match="synthetic connection dropped"):
        settle(async_mode, server, p)
    assert not cancel_calls(remote)
    assert scheme.read_request_context(p).pending_id == "trusted-admission"
    assert settle(async_mode, server, p).success


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize(
    "key",
    [
        "balance",
        "totalClaimed",
        "chargedCumulativeAmount",
        "refundNonce",
        "withdrawRequestedAt",
        "pendingId",
    ],
)
def test_incomplete_admission_fails_before_handler_and_releases_known_lock(async_mode, key):
    remote, scheme, server, p = scenario(async_mode, kind="voucher")
    remote.verify_extra.pop(key)
    result = verify(async_mode, server, p)
    assert not result.is_valid
    assert result.invalid_reason == "invalid_batch_settlement_evm_verification_state_unavailable"
    assert len(cancel_calls(remote)) == (0 if key == "pendingId" else 1)
    if key != "pendingId":
        assert cancel_calls(remote)[0][1].payload["pendingId"] == "trusted-admission"


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize(
    "key",
    ["balance", "chargedCumulativeAmount", "totalClaimed", "refundNonce", "withdrawRequestedAt"],
)
def test_incomplete_committed_receipt_fails_closed_and_preserves_receipt(async_mode, key):
    remote, scheme, server, p = scenario(async_mode)
    assert verify(async_mode, server, p).is_valid
    receipt = remote.receipt(p)
    receipt.extra["channelState"].pop(key)
    remote.outcomes = [receipt]
    result = settle(async_mode, server, p)
    assert result is receipt and not result.success
    assert result.transaction == "0xsynthetic" and result.amount == "500"
    assert result.extra["chargeCount"] == 0 and key not in result.extra["channelState"]
    assert not cancel_calls(remote)
    assert scheme.read_request_context(p) is None


@pytest.mark.parametrize("async_mode", [False, True])
def test_local_failure_recovery_short_circuits_cancel(async_mode):
    remote, scheme, server, p = scenario(async_mode, signer=RefundSigner(True))
    assert verify(async_mode, server, p).is_valid
    recovered = SettleResponse(success=True, transaction="0xrecovered", network=NETWORK)
    server.on_settle_failure(lambda c: RecoveredSettleResult(result=recovered))
    assert settle(async_mode, server, p) is recovered
    assert not cancel_calls(remote)


@pytest.mark.parametrize("async_mode", [False, True])
def test_full_width_nonce_reaches_signer_exactly(async_mode):
    signer = RefundSigner()
    remote, scheme, server, p = scenario(async_mode, signer=signer)
    nonce = (1 << 200) + 12345
    remote.verify_extra["refundNonce"] = str(nonce)
    assert verify(async_mode, server, p).is_valid
    assert settle(async_mode, server, p).success
    assert remote.calls[-1][1].payload["refundNonce"] == str(nonce)
    assert signer.messages[-1]["message"]["nonce"] == nonce


@pytest.mark.parametrize("async_mode", [False, True])
def test_direct_voucher_settle_leaves_full_reverification_to_facilitator(async_mode):
    remote, scheme, server, p = scenario(async_mode, kind="voucher")
    result = settle(async_mode, server, p)
    assert result.success
    assert len(remote.calls) == 1 and remote.calls[0][0] == "settle"
    assert "pendingId" not in remote.calls[0][1].payload
    assert not cancel_calls(remote)
    assert scheme.read_request_context(p) is None
