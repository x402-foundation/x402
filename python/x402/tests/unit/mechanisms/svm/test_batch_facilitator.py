"""Facilitator lifecycle, sponsor, and crash-recovery tests with real signatures."""

import base64
import json
import struct
import time
from dataclasses import asdict, replace
from unittest.mock import Mock

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import to_bytes_versioned
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm.batch_settlement.close_authorization import sign_close_authorization
from x402.mechanisms.svm.batch_settlement.errors import BatchError
from x402.mechanisms.svm.batch_settlement.facilitator import (
    BatchDelegatedReceiverAuth,
    BatchSvmFacilitatorConfig,
    BatchSvmScheme,
)
from x402.mechanisms.svm.batch_settlement.facilitator_storage import (
    MemoryBatchPendingSettlementStore,
    MemoryPaymentChannelStorage,
    PaymentChannelRecord,
    PendingSettlement,
)
from x402.mechanisms.svm.batch_settlement.receiver_binding import encode_receiver_binding_memo
from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS
from x402.mechanisms.svm.payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    Channel,
    ChannelSplit,
    ChannelStatus,
    build_open_transaction,
    build_request_close_transaction,
    build_top_up_transaction,
    distribution_hash,
    find_ata,
    find_payment_channel_pda,
    sign_voucher,
)
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse

PAYER, SPONSOR, RECEIVER, AUTH, MINT = [Keypair.from_seed(bytes([n]) * 32) for n in range(1, 6)]
NETWORK = SOLANA_DEVNET_CAIP2


def account_bytes(channel):
    data = bytearray(256)
    data[:4] = bytes([1, channel.version, channel.bump, channel.status])
    struct.pack_into(
        "<QQQQqqI",
        data,
        4,
        channel.salt,
        channel.deposit,
        channel.settled,
        channel.payout_watermark,
        channel.closure_started_at,
        channel.payer_withdrawn_at,
        channel.grace_period,
    )
    data[56:88] = channel.distribution_hash
    for i, key in enumerate(
        (channel.payer, channel.payee, channel.authorized_signer, channel.mint, channel.rent_payer)
    ):
        data[88 + 32 * i : 120 + 32 * i] = bytes(Pubkey.from_string(key))
    struct.pack_into("<Q", data, 248, channel.open_slot)
    return bytes(data)


class Transport:
    def __init__(self, channel_id, channel, req):
        self.channel_id, self.template, self.req = channel_id, channel, req
        self.channel = None
        self.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
        self.sent, self.simulations, self.signed = [], [], []
        self.on_send = lambda: None
        self.height, self.hash_valid = 1, True
        self.token_state = 1
        self.evidence = None

    def get_addresses(self):
        return [str(SPONSOR.pubkey())]

    def get_latest_blockhash(self, network):
        return {
            "blockhash": str(Hash.default()),
            "last_valid_block_height": 500,
            "context_slot": 1000,
        }

    def get_slot(self, network):
        return 123

    def get_block_height(self, network):
        return self.height

    def is_blockhash_valid(self, blockhash, network, *, min_context_slot=None):
        return self.hash_valid

    def get_signature_status(self, signature, network):
        return self.status

    def confirm_transaction(self, signature, network):
        if self.status is None:
            raise RuntimeError("timeout")
        return self.status["slot"]

    def get_transaction(self, signature, network):
        return self.evidence

    def simulate_transaction(self, wire, network, *, sig_verify=True):
        self.simulations.append((wire, sig_verify))
        return 1000

    def get_account_info(self, address, network, *, min_context_slot=None):
        if address == self.channel_id:
            return (
                None
                if self.channel is None
                else {
                    "owner": PAYMENT_CHANNELS_PROGRAM_ID,
                    "data": account_bytes(self.channel),
                    "executable": False,
                    "context_slot": 1000,
                }
            )
        if address == self.req.asset:
            data = bytearray(82)
            data[45] = 1
        else:
            from x402.mechanisms.svm.payment_channels import get_payment_channels_treasury_owner

            data = bytearray(165)
            data[:32] = bytes(Pubkey.from_string(self.req.asset))
            owners = [
                str(PAYER.pubkey()),
                self.req.pay_to,
                get_payment_channels_treasury_owner(network),
            ]
            owner = next(
                o for o in owners if find_ata(o, self.req.asset, TOKEN_PROGRAM_ADDRESS) == address
            )
            data[32:64] = bytes(Pubkey.from_string(owner))
            data[108] = self.token_state
            struct.pack_into("<Q", data, 64, 1_000_000)
        return {
            "owner": TOKEN_PROGRAM_ADDRESS,
            "data": bytes(data),
            "executable": False,
            "context_slot": 1000,
        }

    def get_account_info_with_context(self, address, network, *, min_context_slot=None):
        account = self.get_account_info(address, network, min_context_slot=min_context_slot)
        return {
            "context_slot": account["context_slot"] if account is not None else 1000,
            "account": account,
        }

    def sign_transaction(self, wire, fee_payer, network):
        self.signed.append(wire)
        tx = VersionedTransaction.from_bytes(base64.b64decode(wire))
        signatures = list(tx.signatures)
        signatures[0] = SPONSOR.sign_message(to_bytes_versioned(tx.message))
        return base64.b64encode(
            bytes(VersionedTransaction.populate(tx.message, signatures))
        ).decode()

    def send_transaction(self, wire, network):
        self.sent.append(wire)
        self.on_send()
        return str(VersionedTransaction.from_bytes(base64.b64decode(wire)).signatures[0])


@pytest.fixture
def fixture():
    req = PaymentRequirements(
        scheme="batch-settlement",
        network=NETWORK,
        amount="10",
        asset=str(MINT.pubkey()),
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
        extra={
            "feePayer": str(SPONSOR.pubkey()),
            "receiverAuthorizer": str(AUTH.pubkey()),
            "withdrawDelay": 900,
            "tokenProgram": TOKEN_PROGRAM_ADDRESS,
            "memo": "order",
        },
    )
    cfg = {
        "payer": str(PAYER.pubkey()),
        "payerAuthorizer": str(PAYER.pubkey()),
        "receiver": req.pay_to,
        "receiverAuthorizer": str(AUTH.pubkey()),
        "token": req.asset,
        "withdrawDelay": 900,
        "salt": "7",
        "openSlot": 123,
    }
    channel_id = find_payment_channel_pda(
        payer=cfg["payer"],
        payee=req.extra["feePayer"],
        mint=req.asset,
        authorized_signer=cfg["payerAuthorizer"],
        salt=7,
        open_slot=123,
    )
    channel = Channel(
        payer=cfg["payer"],
        payee=req.extra["feePayer"],
        authorized_signer=cfg["payerAuthorizer"],
        mint=req.asset,
        rent_payer=req.extra["feePayer"],
        salt=7,
        open_slot=123,
        deposit=100,
        settled=0,
        payout_watermark=0,
        grace_period=900,
        distribution_hash=distribution_hash([ChannelSplit(req.pay_to, 10000)]),
    )
    transport = Transport(channel_id, channel, req)
    store, pending = MemoryPaymentChannelStorage(), MemoryBatchPendingSettlementStore()
    config = BatchSvmFacilitatorConfig(channel_storage=store, pending_settlement_store=pending)
    scheme = BatchSvmScheme(transport, config)
    return scheme, transport, req, cfg, channel_id, channel


def voucher(channel_id, amount=10):
    return {
        "channelId": channel_id,
        "maxClaimableAmount": str(amount),
        "expiresAt": 0,
        "signature": sign_voucher(PAYER, channel_id, amount),
    }


def payment(req, raw):
    return PaymentPayload(x402_version=2, accepted=req, payload=raw)


def deposit(req, cfg, channel_id):
    wire = build_open_transaction(
        payer=PAYER,
        fee_payer=req.extra["feePayer"],
        payee=req.extra["feePayer"],
        mint=req.asset,
        authorized_signer=cfg["payerAuthorizer"],
        token_program=TOKEN_PROGRAM_ADDRESS,
        deposit=100,
        salt=int(cfg["salt"]),
        open_slot=cfg["openSlot"],
        grace_period=900,
        blockhash=str(Hash.default()),
        memo="order",
        binding_memo=encode_receiver_binding_memo(cfg["receiverAuthorizer"]),
        recipients=[ChannelSplit(req.pay_to, 10000)],
    )
    return payment(
        req,
        {
            "type": "deposit",
            "channelConfig": cfg,
            "voucher": voucher(channel_id),
            "deposit": {"amount": "100", "transaction": wire},
        },
    )


def test_deposit_verifies_readiness_before_handler_and_confirms_snapshot(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    payload = deposit(req, cfg, cid)
    result = scheme.verify(payload, req)
    assert result.is_valid, result.invalid_message
    assert result.extra == {"channelId": cid}
    assert len(rpc.simulations) == 2
    assert rpc.signed == rpc.sent == []
    rpc.on_send = lambda: setattr(rpc, "channel", channel)
    result = scheme.settle(payload, req)
    assert result.success, result.error_message
    assert result.amount == "100" and result.extra["channelState"]["balance"] == "100"
    assert scheme.channel_storage.get(NETWORK, cid).receiver_authorizer == cfg["receiverAuthorizer"]
    assert scheme.settle(payload, req) == result
    assert len(rpc.sent) == 1
    altered = req.model_copy(
        update={"extra": {**req.extra, "receiverAuthorizer": str(PAYER.pubkey())}}
    )
    changed = payload.model_copy(update={"accepted": altered})
    assert scheme.settle(changed, altered).error_reason == BatchError.RECEIVER_AUTHORIZER_MISMATCH
    assert len(rpc.sent) == 1


def test_lost_confirmation_recovers_after_restart_without_reopening(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    payload = deposit(req, cfg, cid)
    rpc.on_send = lambda: setattr(rpc, "channel", channel)
    rpc.status = None
    first = scheme.settle(payload, req)
    assert first.error_reason == "settlement_pending"
    assert first.transaction
    record = scheme.pending_store.find_pending(NETWORK, [cid])
    assert record.signature == first.transaction and record.wire_transaction == rpc.sent[0]
    rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
    restarted = BatchSvmScheme(rpc, scheme.config)
    result = restarted.settle(payload, req)
    assert result.success and result.transaction == first.transaction
    assert len(rpc.sent) == 1


@pytest.mark.parametrize("failure", ["write", "readback", "pending"])
def test_storage_failure_never_broadcasts(fixture, failure):
    scheme, rpc, req, cfg, cid, _ = fixture
    if failure == "write":
        scheme.channel_storage.record = Mock(side_effect=OSError("database offline"))
    elif failure == "readback":
        scheme.channel_storage.get = Mock(return_value=None)
    else:
        scheme.pending_store.reserve = Mock(side_effect=OSError("database offline"))
    result = scheme.settle(deposit(req, cfg, cid), req)
    assert not result.success and not rpc.sent


def test_frozen_recipient_is_rejected_before_signature(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    rpc.token_state = 2
    result = scheme.verify(deposit(req, cfg, cid), req)
    assert not result.is_valid and result.invalid_reason == BatchError.SETTLEMENT_SIMULATION
    assert not rpc.signed and not rpc.sent


def test_claim_and_payout_use_confirmed_token_delta_and_replay(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    claim = payment(
        req,
        {
            "type": "claim",
            "claims": [{"channelId": cid, "channelConfig": cfg, "voucher": voucher(cid, 30)}],
        },
    )
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=30))
    claimed = scheme.settle(claim, req)
    assert claimed.success, claimed.error_message
    assert claimed.extra["accepts"] == [{"channelId": cid, "totalClaimed": "30"}]
    assert scheme.settle(claim, req) == claimed
    distribute = payment(
        req, {"type": "settle", "channels": [{"channelId": cid, "channelConfig": cfg}]}
    )
    recipient = find_ata(req.pay_to, req.asset, TOKEN_PROGRAM_ADDRESS)
    escrow = find_ata(cid, req.asset, TOKEN_PROGRAM_ADDRESS)

    def balance(index, amount, owner):
        return {
            "accountIndex": index,
            "mint": req.asset,
            "owner": owner,
            "uiTokenAmount": {"amount": str(amount)},
        }

    rpc.evidence = {
        "meta": {
            "err": None,
            "preTokenBalances": [balance(0, 100, req.pay_to), balance(1, 100, cid)],
            "postTokenBalances": [balance(0, 128, req.pay_to), balance(1, 70, cid)],
        },
        "transaction": {"message": {"accountKeys": [recipient, escrow]}},
        "slot": 1000,
    }
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=30, payout_watermark=30))
    paid = scheme.settle(distribute, req)
    assert paid.success, paid.error_message
    assert paid.amount == "28"  # Actual receipt, not settled delta 30.
    assert scheme.settle(distribute, req) == paid
    assert len(rpc.sent) == 2
    # New earnings with the same recent blockhash must produce different wire bytes.
    rpc.channel = replace(channel, settled=40, payout_watermark=30)
    rpc.evidence["meta"]["preTokenBalances"][0]["uiTokenAmount"]["amount"] = "128"
    rpc.evidence["meta"]["postTokenBalances"][0]["uiTokenAmount"]["amount"] = "137"
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=40, payout_watermark=40))
    scheme.config.on_distribution_confirmed = Mock(
        side_effect=OSError("accounting database offline")
    )
    pending = scheme.settle(distribute, req)
    assert pending.error_reason == "settlement_pending"
    assert len(rpc.sent) == 3 and rpc.sent[1] != rpc.sent[2]
    scheme.config.on_distribution_confirmed = Mock()
    recovered = BatchSvmScheme(rpc, scheme.config).settle(distribute, req)
    assert recovered.success and recovered.amount == "9" and len(rpc.sent) == 3
    assert scheme.config.on_distribution_confirmed.call_count == 1


def test_expiry_requires_actual_hash_invalid_and_processed_errors_remain_pending(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    rpc.status = {"err": "temporary fork failure", "confirmation_status": "processed", "slot": 1000}
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == "settlement_pending"
    rpc.status, rpc.height = None, 501
    assert scheme.settle(payload, req).error_reason == "settlement_pending"
    rpc.hash_valid = False
    assert scheme.settle(payload, req).error_reason == "transaction_expired"
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert len(rpc.sent) == 3
    assert len(set(rpc.sent)) == 1 and len(rpc.signed) == 1


def test_cooperative_refund_authenticates_final_watermark_and_returns_unused_escrow(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = replace(channel, settled=20, payout_watermark=10)
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
        )
    )
    raw = {"type": "refund", "channelConfig": cfg, "voucher": voucher(cid, 30)}
    assert scheme.settle(payment(req, raw), req).error_reason == BatchError.CLOSE_AUTHORIZATION
    raw["closeAuthorization"] = sign_close_authorization(
        AUTH,
        network=NETWORK,
        fee_payer=req.extra["feePayer"],
        channel_id=cid,
        max_claimable_amount=30,
        valid_before=int(time.time()) + 30,
    )
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    result = scheme.settle(payment(req, raw), req)
    assert result.success, result.error_message
    assert result.amount == "70" and result.extra["channelState"]["totalClaimed"] == "30"


def test_lost_receiver_binding_only_sponsors_payer_signed_request_close(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    raw = {"type": "refund", "channelConfig": cfg, "voucher": voucher(cid, 0)}
    assert (
        scheme.settle(payment(req, raw), req).error_reason
        == BatchError.RECEIVER_BINDING_UNAVAILABLE
    )
    raw["transaction"] = build_request_close_transaction(
        payer=PAYER,
        channel_id=cid,
        fee_payer=req.extra["feePayer"],
        blockhash=str(Hash.default()),
        memo="order",
    )
    rpc.on_send = lambda: setattr(
        rpc, "channel", replace(channel, status=ChannelStatus.CLOSING, closure_started_at=100)
    )
    result = scheme.settle(payment(req, raw), req)
    assert result.success, result.error_message
    assert result.amount == "" and result.extra["channelState"]["withdrawRequestedAt"] == 100


def test_lost_delegated_identity_retains_payer_signed_escape_hatch(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    scheme.config.delegated_receiver_auth = BatchDelegatedReceiverAuth(
        cfg["receiverAuthorizer"], lambda ctx: None
    )
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
            caller_identity="",
        )
    )
    wire = build_request_close_transaction(
        payer=PAYER,
        channel_id=cid,
        fee_payer=req.extra["feePayer"],
        blockhash=str(Hash.default()),
        memo="order",
    )
    raw = {"type": "refund", "channelConfig": cfg, "voucher": voucher(cid, 0), "transaction": wire}
    rpc.on_send = lambda: setattr(
        rpc, "channel", replace(channel, status=ChannelStatus.CLOSING, closure_started_at=100)
    )
    result = scheme.settle(payment(req, raw), req)
    assert result.success and result.amount == ""
    assert rpc.channel.status == ChannelStatus.CLOSING


def test_delegated_open_requires_authenticated_caller(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    scheme.config.delegated_receiver_auth = BatchDelegatedReceiverAuth(
        cfg["receiverAuthorizer"], lambda ctx: None
    )
    result = scheme.settle(deposit(req, cfg, cid), req)
    assert result.error_reason == BatchError.DELEGATED_UNAUTHENTICATED
    assert not rpc.sent and not rpc.signed


def test_zero_price_voucher_still_must_advance_settled_and_immutable_terms_match(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = replace(channel, settled=10)
    req = req.model_copy(update={"amount": "0"})
    payload = payment(req, {"type": "voucher", "channelConfig": cfg, "voucher": voucher(cid, 10)})
    result = scheme.verify(payload, req)
    assert result.invalid_reason == BatchError.CUMULATIVE_AMOUNT_MISMATCH
    altered = req.model_copy(update={"max_timeout_seconds": 30})
    assert not scheme.verify(payload, altered).is_valid


def test_completed_operation_cannot_release_another_operations_reservation():
    store = MemoryBatchPendingSettlementStore()
    a = PendingSettlement("a", NETWORK, ("channel",), "sig", "wire", 500, "claim", "payer", {})
    b = replace(a, key="b")
    done = SettleResponse(success=True, network=NETWORK, transaction="sig")
    assert store.reserve(a)
    store.complete("a", done)
    assert store.reserve(b)
    store.complete("a", done)
    assert store.find_pending(NETWORK, ["channel"]).key == "b"


def test_proven_failed_claim_gets_fresh_attempt_and_can_then_recover(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    claim = payment(
        req,
        {
            "type": "claim",
            "claims": [{"channelId": cid, "channelConfig": cfg, "voucher": voucher(cid, 30)}],
        },
    )
    rpc.status = {"err": "program failure", "confirmation_status": "confirmed", "slot": 1000}
    failed = scheme.settle(claim, req)
    assert failed.error_reason == "transaction_failed"
    rpc.status = None
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=30))
    retried = scheme.settle(claim, req)
    assert retried.error_reason == "settlement_pending"
    assert len(rpc.sent) == 2 and retried.transaction != failed.transaction
    rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
    final = BatchSvmScheme(rpc, scheme.config).settle(claim, req)
    assert final.success and final.transaction == retried.transaction
    assert len(rpc.sent) == 2


def test_sealed_payout_alias_is_reported_with_confirmed_signature_not_invented_amount(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    req = req.model_copy(update={"pay_to": cfg["payer"]})
    cfg = {**cfg, "receiver": cfg["payer"]}
    rpc.req = req
    rpc.channel = replace(
        channel,
        status=ChannelStatus.SEALED,
        settled=30,
        payout_watermark=10,
        distribution_hash=distribution_hash([ChannelSplit(req.pay_to, 10000)]),
    )
    recipient = find_ata(req.pay_to, req.asset, TOKEN_PROGRAM_ADDRESS)
    escrow = find_ata(cid, req.asset, TOKEN_PROGRAM_ADDRESS)
    rpc.evidence = {
        "meta": {
            "err": None,
            "preTokenBalances": [
                {
                    "accountIndex": 0,
                    "mint": req.asset,
                    "owner": req.pay_to,
                    "uiTokenAmount": {"amount": "100"},
                }
            ],
            "postTokenBalances": [
                {
                    "accountIndex": 0,
                    "mint": req.asset,
                    "owner": req.pay_to,
                    "uiTokenAmount": {"amount": "190"},
                }
            ],
        },
        "transaction": {"message": {"accountKeys": [recipient, escrow]}},
    }
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    scheme.config.on_distribution_confirmed = Mock()
    payload = payment(
        req, {"type": "settle", "channels": [{"channelId": cid, "channelConfig": cfg}]}
    )
    result = scheme.settle(payload, req)
    assert result.error_reason == BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS
    assert result.transaction and result.amount is None
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert not scheme.config.on_distribution_confirmed.called
    assert scheme.settle(payload, req) == result


@pytest.mark.parametrize("observed", ["closing", "missing", "insufficient"])
def test_confirmed_deposit_postcondition_failure_releases_channel(fixture, observed):
    scheme, rpc, req, cfg, cid, channel = fixture
    state = {
        "closing": replace(
            channel, status=ChannelStatus.CLOSING, closure_started_at=int(time.time())
        ),
        "missing": None,
        "insufficient": replace(channel, deposit=99),
    }[observed]
    rpc.on_send = lambda: setattr(rpc, "channel", state)
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == (
        BatchError.CHANNEL_CLOSING if observed == "closing" else BatchError.CHANNEL_STATE
    )
    assert result.transaction
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert BatchSvmScheme(rpc, scheme.config).settle(payload, req) == result
    assert len(rpc.sent) == 1
    if observed == "closing":
        raw = close_payload("seal", req, cfg, cid, 10)
        rpc.on_send = lambda: setattr(rpc, "channel", None)
        sealed = scheme.settle(payment(req, raw), req)
        assert sealed.success, sealed.error_message


def test_confirmed_deposit_rpc_failure_keeps_reservation_until_fresh_read(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    original_read = scheme.read_channel
    rpc.on_send = lambda: setattr(
        scheme, "read_channel", Mock(side_effect=OSError("RPC temporarily unavailable"))
    )
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == "settlement_pending"
    assert scheme.pending_store.find_pending(NETWORK, [cid])
    scheme.read_channel = original_read
    rpc.channel = channel
    assert scheme.settle(payload, req).success
    assert len(rpc.sent) == len(rpc.signed) == 1


def test_top_up_identity_ignores_changed_voucher_and_charged_price(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    wire = build_top_up_transaction(
        payer=PAYER,
        channel_id=cid,
        mint=req.asset,
        token_program=TOKEN_PROGRAM_ADDRESS,
        fee_payer=req.extra["feePayer"],
        amount=50,
        blockhash=str(Hash.default()),
        memo="order",
    )
    raw = {
        "type": "deposit",
        "channelConfig": cfg,
        "voucher": voucher(cid, 10),
        "deposit": {"amount": "50", "transaction": wire},
    }
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, deposit=150))
    result = scheme.settle(payment(req, raw), req)
    assert result.success and result.extra["channelState"]["balance"] == "150"
    changed_req = req.model_copy(update={"amount": "20"})
    retry = {**raw, "voucher": voucher(cid, 30)}
    assert scheme.settle(payment(changed_req, retry), changed_req) == result
    assert len(rpc.sent) == len(rpc.signed) == 1
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    # The fee-payer placeholder does not change the fully signed transaction's identity.
    decoded = VersionedTransaction.from_bytes(base64.b64decode(wire))
    changed_signatures = list(decoded.signatures)
    changed_signatures[0] = AUTH.sign_message(b"untrusted sponsor placeholder")
    retry["deposit"] = {
        "amount": "50",
        "transaction": base64.b64encode(
            bytes(VersionedTransaction.populate(decoded.message, changed_signatures))
        ).decode(),
    }
    assert scheme.settle(payment(changed_req, retry), changed_req) == result
    assert len(rpc.sent) == 1


def close_payload(kind, req, cfg, cid, amount, *, validity=30):
    return {
        "type": kind,
        "channelId": cid,
        "channelConfig": cfg,
        "voucher": voucher(cid, amount),
        "closeAuthorization": sign_close_authorization(
            AUTH,
            network=NETWORK,
            fee_payer=req.extra["feePayer"],
            channel_id=cid,
            max_claimable_amount=amount,
            valid_before=int(time.time()) + validity,
        ),
    }


@pytest.mark.parametrize("kind", ["seal", "refund"])
def test_close_retries_with_refreshed_authorization_recover_same_result(fixture, kind):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = replace(
        channel,
        settled=20,
        payout_watermark=10,
        status=ChannelStatus.CLOSING if kind == "seal" else ChannelStatus.OPEN,
        closure_started_at=int(time.time()) if kind == "seal" else 0,
    )
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
        )
    )
    rpc.status = None
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    raw = close_payload(kind, req, cfg, cid, 30)
    first = scheme.settle(payment(req, raw), req)
    assert first.error_reason == "settlement_pending"
    pending = scheme.pending_store.find_pending(NETWORK, [cid])
    assert (
        json.loads(json.dumps(asdict(pending)))["metadata"]["before"][0]["distribution_hash"]
        == channel.distribution_hash.hex()
    )
    # Restore through the same JSON representation a durable store would use.
    stored = json.loads(json.dumps(asdict(pending)))
    scheme.pending_store._records[pending.key] = PendingSettlement(**stored)
    retry = close_payload(kind, req, cfg, cid, 30, validity=50)
    assert retry["closeAuthorization"] != raw["closeAuthorization"]
    rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
    restarted = BatchSvmScheme(rpc, scheme.config)
    final = restarted.settle(payment(req, retry), req)
    assert final.success and final.transaction == first.transaction
    assert final.amount == ("20" if kind == "seal" else "70")
    assert (
        restarted.settle(payment(req, close_payload(kind, req, cfg, cid, 30, validity=55)), req)
        == final
    )
    assert len(rpc.signed) == len(rpc.sent) == 1
    forged = {
        **retry,
        "closeAuthorization": {**retry["closeAuthorization"], "signature": "invalid"},
    }
    assert (
        restarted.settle(payment(req, forged), req).error_reason == BatchError.CLOSE_AUTHORIZATION
    )
    bad_voucher = {**retry, "voucher": {**retry["voucher"], "signature": "invalid"}}
    assert (
        restarted.settle(payment(req, bad_voucher), req).error_reason
        == BatchError.VOUCHER_SIGNATURE
    )
    changed_req = req.model_copy(update={"extra": {**req.extra, "withdrawDelay": 901}})
    changed = {**retry, "channelConfig": {**cfg, "withdrawDelay": 901}}
    assert (
        restarted.settle(payment(changed_req, changed), changed_req).error_reason
        == BatchError.CHANNEL_STATE
    )
    assert len(rpc.sent) == 1


def test_crash_after_persist_before_send_resends_saved_bytes_without_resigning(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    reserve = scheme.pending_store.reserve

    def crash(record):
        assert reserve(record)
        raise KeyboardInterrupt("process terminated before broadcast")

    scheme.pending_store.reserve = crash
    rpc.status = None
    with pytest.raises(KeyboardInterrupt):
        scheme.settle(deposit(req, cfg, cid), req)
    record = scheme.pending_store.find_pending(NETWORK, [cid])
    assert record and not rpc.sent and len(rpc.signed) == 1
    scheme.pending_store.reserve = reserve

    def landed():
        rpc.channel = channel
        rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}

    rpc.on_send = landed
    result = BatchSvmScheme(rpc, scheme.config).recover_pending(record)
    assert result.success and result.transaction == record.signature
    assert rpc.sent == [record.wire_transaction] and len(rpc.signed) == 1
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None


def test_completed_refund_recovers_as_manager_seal_with_equivalent_route_terms(fixture):
    from x402.mechanisms.svm.batch_settlement.client import align_refund_requirements
    from x402.mechanisms.svm.constants import TOKEN_2022_PROGRAM_ADDRESS

    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
        )
    )
    refund_req = align_refund_requirements(req, cfg)
    assert refund_req.extra["voucherSigner"] == "client"
    assert "voucherSigner" not in req.extra
    raw = close_payload("refund", refund_req, cfg, cid, 30)
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    result = scheme.settle(payment(refund_req, raw), refund_req)
    assert result.success, result.error_message
    manager_req = req.model_copy(
        update={
            "amount": "15",
            "max_timeout_seconds": 55,
            "extra": {**req.extra, "minDeposit": "200", "recentSlot": 456},
        }
    )
    seal = close_payload("seal", manager_req, cfg, cid, 30, validity=40)
    restarted = BatchSvmScheme(rpc, scheme.config)
    assert restarted.settle(payment(manager_req, seal), manager_req) == result
    # A different token program is an immutable binding, even after deallocation.
    changed_req = manager_req.model_copy(
        update={
            "extra": {**manager_req.extra, "tokenProgram": TOKEN_2022_PROGRAM_ADDRESS},
        }
    )
    assert (
        restarted.settle(payment(changed_req, seal), changed_req).error_reason
        == BatchError.CHANNEL_STATE
    )
    assert len(rpc.signed) == len(rpc.sent) == 1


def test_failed_rebroadcast_preserves_unknown_outcome(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    rpc.status = None
    result = scheme.settle(deposit(req, cfg, cid), req)
    record = scheme.pending_store.find_pending(NETWORK, [cid])
    rpc.send_transaction = Mock(side_effect=OSError("RPC disconnected"))
    recovered = BatchSvmScheme(rpc, scheme.config).recover_pending(record)
    assert recovered.error_reason == "settlement_pending"
    assert recovered.transaction == result.transaction
    rpc.send_transaction.assert_called_once_with(record.wire_transaction, NETWORK)
    assert scheme.pending_store.find_pending(NETWORK, [cid]) == record
    assert len(rpc.signed) == 1


@pytest.mark.parametrize("slot", [None, 123, "123", 122, "122", True, " 123", 2**53])
def test_open_checks_only_optional_challenged_slot(fixture, slot):
    scheme, rpc, req, cfg, cid, _ = fixture
    if slot is not None:
        req = req.model_copy(update={"extra": {**req.extra, "recentSlot": slot}})
    rpc.get_slot = Mock(side_effect=AssertionError("do not compare against a different RPC slot"))
    result = scheme.verify(deposit(req, cfg, cid), req)
    assert result.is_valid is (slot is None or slot in (123, "123"))
    rpc.get_slot.assert_not_called()


@pytest.mark.parametrize("operation", ["deposit", "claim", "request_close"])
def test_simulation_failures_have_stable_error_code(fixture, operation):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.simulate_transaction = Mock(side_effect=RuntimeError("simulation rejected"))
    if operation == "deposit":
        payload = deposit(req, cfg, cid)
        assert scheme.verify(payload, req).invalid_reason == BatchError.SETTLEMENT_SIMULATION
    elif operation == "claim":
        rpc.channel = channel
        payload = payment(
            req,
            {
                "type": "claim",
                "claims": [
                    {
                        "channelId": cid,
                        "channelConfig": cfg,
                        "voucher": voucher(cid, 10),
                    }
                ],
            },
        )
    else:
        rpc.channel = channel
        payload = payment(
            req,
            {
                "type": "refund",
                "channelConfig": cfg,
                "voucher": voucher(cid, 0),
                "transaction": build_request_close_transaction(
                    payer=PAYER,
                    channel_id=cid,
                    fee_payer=req.extra["feePayer"],
                    blockhash=str(Hash.default()),
                    memo="order",
                ),
            },
        )
    assert scheme.settle(payload, req).error_reason == BatchError.SETTLEMENT_SIMULATION
    assert not rpc.sent and scheme.pending_store.find_pending(NETWORK, [cid]) is None


@pytest.mark.parametrize("kind", ["voucher", "deposit", "claim"])
def test_voucher_above_deposit_has_distinct_error_code(fixture, kind):
    scheme, rpc, req, cfg, cid, channel = fixture
    if kind == "deposit":
        payload = deposit(req, cfg, cid)
        payload.payload["voucher"] = voucher(cid, 101)
        result = scheme.verify(payload, req)
    elif kind == "claim":
        rpc.channel = channel
        result = scheme.settle(
            payment(
                req,
                {
                    "type": "claim",
                    "claims": [
                        {
                            "channelId": cid,
                            "channelConfig": cfg,
                            "voucher": voucher(cid, 101),
                        }
                    ],
                },
            ),
            req,
        )
        assert result.error_reason == BatchError.CUMULATIVE_EXCEEDS_DEPOSIT
        return
    else:
        rpc.channel = channel
        result = scheme.verify(
            payment(
                req,
                {
                    "type": "voucher",
                    "channelConfig": cfg,
                    "voucher": voucher(cid, 101),
                },
            ),
            req,
        )
    assert result.invalid_reason == BatchError.CUMULATIVE_EXCEEDS_DEPOSIT


def test_facilitator_requires_actual_blockhash_validity_reader(fixture):
    scheme, rpc, *_ = fixture
    rpc.is_blockhash_valid = None
    with pytest.raises(TypeError, match="is_blockhash_valid"):
        BatchSvmScheme(rpc, scheme.config)


@pytest.mark.parametrize("missing", [True, False])
def test_facilitator_rejects_signer_without_callable_contextual_read(fixture, monkeypatch, missing):
    scheme, rpc, *_ = fixture
    if missing:
        monkeypatch.delattr(Transport, "get_account_info_with_context")
    else:
        rpc.get_account_info_with_context = None
    rpc.get_account_info = Mock(side_effect=AssertionError("startup must not query RPC"))
    with pytest.raises(TypeError, match="must implement get_account_info_with_context"):
        BatchSvmScheme(rpc, scheme.config)
    rpc.get_account_info.assert_not_called()
    assert not rpc.sent and not rpc.signed


def test_contextual_signer_accepts_new_open_after_another_channel_confirms(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.on_send = lambda: setattr(rpc, "channel", channel)
    assert scheme.settle(deposit(req, cfg, cid), req).success
    assert scheme._confirmation_slots[NETWORK] == 1000

    cfg = {**cfg, "salt": "8"}
    cid = find_payment_channel_pda(
        payer=cfg["payer"],
        payee=req.extra["feePayer"],
        mint=req.asset,
        authorized_signer=cfg["payerAuthorizer"],
        salt=8,
        open_slot=cfg["openSlot"],
    )
    rpc.channel_id, rpc.channel = cid, None
    rpc.get_account_info_with_context = Mock(wraps=rpc.get_account_info_with_context)
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, salt=8))
    payload = deposit(req, cfg, cid)
    assert scheme.verify(payload, req).is_valid
    rpc.get_account_info_with_context.assert_called_with(cid, NETWORK, min_context_slot=1000)
    result = scheme.settle(payload, req)
    assert result.success and result.extra["channelState"]["channelId"] == cid
    assert len(rpc.sent) == len(rpc.signed) == 2
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None


def test_stale_post_confirmation_read_cannot_release_deposit_reservation(fixture, monkeypatch):
    scheme, rpc, req, cfg, cid, channel = fixture
    original_read = rpc.get_account_info

    def stale_read(address, network, *, min_context_slot=None):
        account = original_read(address, network, min_context_slot=min_context_slot)
        if address == cid and account:
            account["context_slot"] = 999
        return account

    def landed():
        rpc.channel = replace(channel, status=ChannelStatus.CLOSING, closure_started_at=100)
        rpc.get_account_info = stale_read

    monkeypatch.setattr(time, "sleep", lambda _: None)
    rpc.on_send = landed
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == "settlement_pending"
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is not None
    rpc.get_account_info = original_read
    final = scheme.settle(payload, req)
    assert final.error_reason == BatchError.CHANNEL_CLOSING
    assert final.transaction == result.transaction
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert len(rpc.sent) == 1


@pytest.mark.parametrize("expired", [False, True])
def test_forced_refund_with_close_authorization_cannot_occupy_cooperative_key(fixture, expired):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    closing = replace(channel, status=ChannelStatus.CLOSING, closure_started_at=int(time.time()))
    raw = close_payload("refund", req, cfg, cid, 30)
    raw["transaction"] = build_request_close_transaction(
        payer=PAYER,
        channel_id=cid,
        fee_payer=req.extra["feePayer"],
        blockhash=str(Hash.default()),
        memo="order",
    )
    if expired:
        rpc.status, rpc.height, rpc.hash_valid = None, 501, False
    else:
        rpc.on_send = lambda: setattr(rpc, "channel", closing)
    result = scheme.settle(payment(req, raw), req)
    assert result.success is not expired
    if expired:
        assert result.error_reason == "transaction_expired"
    else:
        assert result.extra["channelState"]["totalClaimed"] == "0"
    assert scheme.settle(payment(req, raw), req) == result
    assert len(rpc.sent) == 1

    # Even after binding recovery, a forged seal cannot reuse the initiation result.
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
        )
    )
    rpc.channel = closing
    seal = close_payload("seal", req, cfg, cid, 30)
    forged = {**seal, "closeAuthorization": {**seal["closeAuthorization"], "signature": "invalid"}}
    assert scheme.settle(payment(req, forged), req).error_reason == BatchError.CLOSE_AUTHORIZATION
    assert len(rpc.sent) == 1
    forced_key = scheme._key(raw, req, request_close=True)
    assert scheme.pending_store.get(forced_key).kind == "request_close"
    assert scheme.pending_store.get(scheme._key(raw, req)) is None
    rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    final = scheme.settle(payment(req, seal), req)
    assert final.success and final.transaction != result.transaction
    assert final.extra["channelState"]["totalClaimed"] == "30"
    assert len(rpc.sent) == len(rpc.signed) == 2


def test_cooperative_cache_rejects_legacy_forced_close_record(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    raw = close_payload("refund", req, cfg, cid, 30)
    raw["transaction"] = build_request_close_transaction(
        payer=PAYER,
        channel_id=cid,
        fee_payer=req.extra["feePayer"],
        blockhash=str(Hash.default()),
        memo="order",
    )
    rpc.on_send = lambda: setattr(
        rpc,
        "channel",
        replace(channel, status=ChannelStatus.CLOSING, closure_started_at=int(time.time())),
    )
    assert scheme.settle(payment(req, raw), req).success
    record = scheme.pending_store.get(scheme._key(raw, req, request_close=True))
    # A durable store can still contain an incorrectly keyed record from an older version.
    legacy_key = scheme._key(raw, req)
    scheme.pending_store._records[legacy_key] = replace(record, key=legacy_key)
    seal = close_payload("seal", req, cfg, cid, 30)
    assert scheme.settle(payment(req, seal), req).error_reason == BatchError.CHANNEL_STATE
    assert len(rpc.sent) == 1


@pytest.mark.parametrize("kind", ["deposit", "seal", "refund"])
@pytest.mark.parametrize("malformed", [None, [], "invalid", {}])
def test_malformed_settlement_payload_preserves_validation_error(fixture, kind, malformed):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    if kind == "deposit":
        raw = deposit(req, cfg, cid).payload
        raw["deposit"] = {"amount": "100", "transaction": malformed}
        expected = BatchError.SETUP_TRANSACTION
    else:
        raw = close_payload(kind, req, cfg, cid, 30)
        raw["voucher"] = malformed
        expected = (
            BatchError.CHANNEL_ID_MISMATCH
            if kind == "refund" and malformed == {}
            else BatchError.VOUCHER_SIGNATURE
        )
    assert scheme.settle(payment(req, raw), req).error_reason == expected
    assert not rpc.sent and not rpc.signed


@pytest.mark.parametrize("context", [None, 999])
def test_unproven_absence_retains_confirmed_deposit_until_fresh_read(fixture, monkeypatch, context):
    scheme, rpc, req, cfg, cid, _ = fixture
    rpc.get_account_info_with_context = lambda *args, **kwargs: {
        "account": None,
        "context_slot": context,
    }
    monkeypatch.setattr(time, "sleep", lambda _: None)
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == "settlement_pending"
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is not None
    rpc.get_account_info_with_context = lambda *args, **kwargs: {
        "account": None,
        "context_slot": 1000,
    }
    final = BatchSvmScheme(rpc, scheme.config).settle(payload, req)
    assert final.error_reason == BatchError.CHANNEL_STATE
    assert final.transaction == result.transaction
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert len(rpc.sent) == len(rpc.signed) == 1


@pytest.mark.parametrize("invalid", ["owner", "executable", "pda", "data"])
def test_confirmed_deposit_fresh_invalid_account_releases_reservation(fixture, invalid):
    scheme, rpc, req, cfg, cid, channel = fixture
    original_read = rpc.get_account_info

    def invalid_read(address, network, *, min_context_slot=None):
        account = original_read(address, network, min_context_slot=min_context_slot)
        if address == cid:
            assert min_context_slot == 1000
            if invalid == "owner":
                # A reclaimed PDA can receive lamports and become a System Program account.
                account["owner"] = "11111111111111111111111111111111"
            elif invalid == "executable":
                account["executable"] = True
            elif invalid == "pda":
                account["data"] = account_bytes(replace(channel, salt=8))
            else:
                account["data"] = b"invalid"
        return account

    def landed():
        rpc.channel = channel
        rpc.get_account_info = invalid_read

    rpc.on_send = landed
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == (
        BatchError.CHANNEL_ID_MISMATCH if invalid == "pda" else BatchError.CHANNEL_STATE
    )
    assert result.transaction and scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert scheme.settle(payload, req) == result
    assert len(rpc.sent) == len(rpc.signed) == 1
