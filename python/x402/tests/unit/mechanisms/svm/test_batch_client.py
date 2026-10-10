"""Real signatures and transactions with deterministic mocked chain state."""

import base64
import struct
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.interfaces import PaymentPayloadContext
from x402.mechanisms.svm.batch_settlement.authorization import verify_batch_authorization
from x402.mechanisms.svm.batch_settlement.client import BatchSvmScheme, sign_batch_voucher
from x402.mechanisms.svm.batch_settlement.client_types import (
    BatchSvmClientConfig,
    InMemoryBatchClientChannelStorage,
)
from x402.mechanisms.svm.batch_settlement.trust import (
    BatchServerSignedChannelsPolicy,
    ServerSignedChannelsAsset,
    ServerSignedTrustPolicy,
    UntrustedOperatorError,
)
from x402.mechanisms.svm.constants import (
    SOLANA_DEVNET_CAIP2,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
)
from x402.mechanisms.svm.payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    ChannelSplit,
    distribution_hash,
    find_payment_channel_pda,
    verify_voucher,
)
from x402.mechanisms.svm.signers import KeypairSigner
from x402.schemas import (
    PaymentCreationFailureContext,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    PaymentResponseContext,
    SettleResponse,
)

PAYER, SPONSOR, RECEIVER, OPERATOR, AUTHOR = [
    Keypair.from_seed(bytes([i] * 32)) for i in range(1, 6)
]
BLOCKHASH = str(Hash.from_bytes(bytes([8] * 32)))


def requirements(amount="10", server=False, **extra):
    values = {
        "feePayer": str(SPONSOR.pubkey()),
        "receiverAuthorizer": str(AUTHOR.pubkey()),
        "withdrawDelay": 900,
        "tokenProgram": TOKEN_PROGRAM_ADDRESS,
        "recentBlockhash": BLOCKHASH,
        "recentSlot": 42,
    }
    if server:
        values.update(voucherSigner="server", operator=str(OPERATOR.pubkey()))
    values.update(extra)
    return PaymentRequirements(
        scheme="batch-settlement",
        network=SOLANA_DEVNET_CAIP2,
        asset=USDC_DEVNET_ADDRESS,
        amount=amount,
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
        extra=values,
    )


def client(config=None):
    config = config or BatchSvmClientConfig(discover_channels=False, deposit_amount=30)
    scheme = BatchSvmScheme(KeypairSigner(PAYER), config)
    rpc = MagicMock()
    rpc.get_account_info.return_value = SimpleNamespace(
        value=SimpleNamespace(
            owner=Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
            data=bytes(44) + bytes([6]) + bytes(37),
        )
    )
    rpc.get_program_accounts.return_value = SimpleNamespace(value=[])
    rpc.get_latest_blockhash.return_value = SimpleNamespace(
        value=SimpleNamespace(blockhash=Hash.from_string(BLOCKHASH))
    )
    scheme._clients[SOLANA_DEVNET_CAIP2] = rpc
    return scheme, rpc


def context(req, inner, response=None, required=None):
    return PaymentResponseContext(
        payment_payload=PaymentPayload(x402_version=2, accepted=req, payload=inner),
        requirements=req,
        settle_response=response,
        payment_required=required,
    )


def success(req, inner, cumulative=None, charged=None):
    cumulative = (
        cumulative if cumulative is not None else int(inner["voucher"]["maxClaimableAmount"])
    )
    return SettleResponse(
        success=True,
        transaction="",
        network=req.network,
        extra={
            "commitmentId": "opaque-accepted-id",
            "chargedAmount": charged or req.amount,
            "channelState": {"chargedCumulativeAmount": str(cumulative), "balance": "99999999"},
        },
    )


def confirm(scheme, req, inner, cumulative=None):
    scheme.on_payment_response(context(req, inner, success(req, inner, cumulative)))


def test_open_vouchers_topup_and_refund_use_real_payer_signatures():
    scheme, rpc = client()
    req = requirements()
    opened = scheme.create_payment_payload(req)
    assert opened["type"] == "deposit" and opened["deposit"]["amount"] == "30"
    voucher = opened["voucher"]
    assert verify_voucher(voucher["signature"], str(PAYER.pubkey()), voucher["channelId"], 10)
    tx = VersionedTransaction.from_bytes(base64.b64decode(opened["deposit"]["transaction"]))
    assert tx.verify_with_results() == [False, True]
    assert tx.signatures[0] == Signature.default()
    memo_data = [bytes(ix.data) for ix in tx.message.instructions]
    assert ("x402:batch-settlement:svm:rcvauth:v1:" + str(AUTHOR.pubkey())).encode() in memo_data
    assert scheme.create_payment_payload(req) == opened
    confirm(scheme, req, opened)
    for cumulative in (20, 30):
        payload = scheme.create_payment_payload(req)
        assert payload["type"] == "voucher"
        assert payload["voucher"]["maxClaimableAmount"] == str(cumulative)
        confirm(scheme, req, payload)
    topped = scheme.create_payment_payload(req)
    assert topped["type"] == "deposit" and topped["deposit"]["amount"] == "30"
    assert topped["voucher"]["maxClaimableAmount"] == "40"
    confirm(scheme, req, topped)
    refund = scheme.create_refund_payload(req, with_transaction=True)
    assert refund["voucher"]["maxClaimableAmount"] == "40"
    refund_tx = VersionedTransaction.from_bytes(base64.b64decode(refund["transaction"]))
    assert refund_tx.verify_with_results() == [False, True]
    assert "amount" not in refund
    assert next(iter(scheme._channels.values())).deposit == 60
    rpc.get_latest_blockhash.assert_not_called()


def test_concurrent_client_requests_reuse_exact_pending_allocation():
    scheme, _ = client()
    req = requirements()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: scheme.create_payment_payload(req), range(16)))
    assert all(value == results[0] for value in results)
    with pytest.raises(ValueError, match="different amount"):
        scheme.create_payment_payload(requirements("11"))
    with pytest.raises(ValueError, match="pending payment"):
        scheme.create_refund_payload(req)


def test_durable_pending_restores_and_unknown_transport_does_not_duplicate():
    storage = InMemoryBatchClientChannelStorage()
    config = BatchSvmClientConfig(
        discover_channels=False, channel_storage=storage, deposit_amount=30
    )
    first, _ = client(config)
    req = requirements()
    payload = first.create_payment_payload(req)
    restarted, _ = client(config)
    assert restarted.create_payment_payload(req) == payload
    restarted.on_payment_response(context(req, payload))
    assert restarted.create_payment_payload(req) == payload
    pending = SettleResponse(
        success=False,
        transaction="submitted",
        network=req.network,
        error_reason="settlement_pending",
    )
    restarted.on_payment_response(context(req, payload, pending))
    assert restarted.create_payment_payload(req) == payload
    confirm(restarted, req, payload)
    next_client, _ = client(config)
    following = next_client.create_payment_payload(req)
    assert following["type"] == "voucher" and following["voucher"]["maxClaimableAmount"] == "20"


def test_stale_response_cannot_clear_current_pending():
    scheme, _ = client()
    req = requirements()
    first = scheme.create_payment_payload(req)
    confirm(scheme, req, first)
    second = scheme.create_payment_payload(req)
    confirm(scheme, req, first)
    assert scheme.create_payment_payload(req) == second
    rejected = SettleResponse(
        success=False, transaction="", network=req.network, error_reason="denied"
    )
    scheme.on_payment_response(context(req, second, rejected))
    retry = scheme.create_payment_payload(req)
    assert retry["voucher"]["maxClaimableAmount"] == "20"


def test_trusted_server_mode_signs_fresh_bounded_proofs_and_verifies_actual_voucher():
    policy = BatchServerSignedChannelsPolicy(
        allowed_operators=[str(OPERATOR.pubkey())], max_deposit="$0.000025"
    )
    scheme, _ = client(
        BatchSvmClientConfig(discover_channels=False, server_signed_channels_policy=policy)
    )
    req = requirements(server=True, minDeposit="9999999")
    first = scheme.create_payment_payload(req)
    assert first["deposit"]["amount"] == "25"
    assert first["channelConfig"]["payerAuthorizer"] == str(OPERATOR.pubkey())
    assert "voucher" not in first
    auth = first["authorization"]
    assert verify_batch_authorization(auth, str(OPERATOR.pubkey()))
    with pytest.raises(ValueError, match="pending request"):
        scheme.create_payment_payload(req)
    response = success(req, first, cumulative=7, charged="7")
    response.extra["voucher"] = sign_batch_voucher(OPERATOR, auth["channelId"], 7)
    scheme.on_payment_response(context(req, first, response))
    second = scheme.create_payment_payload(req)
    assert second["type"] == "authorization"
    assert second["authorization"]["requestId"] != auth["requestId"]
    response = success(req, second, cumulative=17)
    response.extra["voucher"] = sign_batch_voucher(OPERATOR, auth["channelId"], 17)
    scheme.on_payment_response(context(req, second, response))
    with pytest.raises(ValueError, match="max_deposit"):
        scheme.create_payment_payload(req)
    refund = scheme.create_refund_payload(req)
    assert refund["authorization"]["authorizedAmount"] == "0"
    assert verify_batch_authorization(refund["authorization"], str(OPERATOR.pubkey()))


@pytest.mark.parametrize("malicious", ["signature", "ceiling", "commitment", "reported", "expiry"])
def test_server_success_never_adopts_unverified_accounting(malicious):
    policy = BatchServerSignedChannelsPolicy(allowed_operators=[str(OPERATOR.pubkey())])
    scheme, _ = client(
        BatchSvmClientConfig(discover_channels=False, server_signed_channels_policy=policy)
    )
    req = requirements(server=True)
    payment = scheme.create_payment_payload(req)
    channel_id = payment["authorization"]["channelId"]
    amount = 11 if malicious == "ceiling" else 7
    response = success(req, payment, cumulative=amount)
    response.extra["voucher"] = sign_batch_voucher(OPERATOR, channel_id, amount)
    if malicious == "signature":
        response.extra["voucher"]["signature"] = str(Signature.default())
    if malicious == "expiry":
        response.extra["voucher"]["expiresAt"] = 100
    if malicious == "commitment":
        response.extra["commitmentId"] = ""
    if malicious == "reported":
        response.extra["channelState"]["chargedCumulativeAmount"] = "9000"
    with pytest.raises(ValueError):
        scheme.on_payment_response(context(req, payment, response))
    assert not scheme._channels
    assert len(scheme._pending) == 1


def test_untrusted_fallback_preserves_resolved_spend_cap():
    scheme, _ = client(BatchSvmClientConfig(discover_channels=False))
    refused, fallback = requirements(server=True), requirements(minDeposit="99999")
    required = PaymentRequired(x402_version=2, accepts=[refused, fallback])
    with pytest.raises(UntrustedOperatorError) as caught:
        scheme.create_payment_payload(
            refused, context=PaymentPayloadContext(max_amount_per_payment="12")
        )
    recovered = scheme.scheme_hooks.on_payment_creation_failure(
        PaymentCreationFailureContext(
            payment_required=required,
            selected_requirements=refused,
            error=caught.value,
        )
    )
    assert recovered.payload.accepted == fallback
    assert recovered.payload.payload["deposit"]["amount"] == "60"
    assert scheme.payment_policy(2, [refused, fallback]) == [fallback]
    trusted = ServerSignedTrustPolicy(
        BatchServerSignedChannelsPolicy(allowed_operators=[str(OPERATOR.pubkey())])
    )
    assert trusted.filter_accepts([fallback, refused]) == [refused, fallback]


def test_nondefault_assets_require_opt_in_and_keys_are_case_sensitive():
    req = requirements(server=True).model_copy(update={"asset": str(RECEIVER.pubkey())})
    policy = BatchServerSignedChannelsPolicy(allowed_operators=[str(OPERATOR.pubkey())])
    with pytest.raises(UntrustedOperatorError, match="Non-default"):
        ServerSignedTrustPolicy(policy).grant_for(req)
    explicit = replace(
        policy, allowed_assets=[ServerSignedChannelsAsset("solana:*", req.asset, "50")]
    )
    assert ServerSignedTrustPolicy(explicit).grant_for(req).max_deposit == 50
    wrong = replace(
        policy, allowed_assets=[ServerSignedChannelsAsset("solana:*", req.asset.lower(), "50")]
    )
    with pytest.raises(UntrustedOperatorError):
        ServerSignedTrustPolicy(wrong).grant_for(req)


@pytest.mark.parametrize(
    "extra",
    [
        {"withdrawDelay": 899},
        {"withdrawDelay": True},
        {"withdrawDelay": 2592001},
        {"paymentFlow": "charge"},
        {"voucherSigner": "unknown"},
        {"operator": str(OPERATOR.pubkey())},
        {"tokenProgram": TOKEN_2022_PROGRAM_ADDRESS},
        {"feePayer": str(PAYER.pubkey())},
    ],
)
def test_invalid_challenge_terms_rejected_before_signing(extra):
    scheme, _ = client()
    with pytest.raises(ValueError):
        scheme.create_payment_payload(requirements(**extra))
    assert not scheme._pending


def corrective(req, payment, amount, proof=True, balance="30", claimed="0"):
    channel_id = (payment.get("voucher") or payment["authorization"])["channelId"]
    voucher = sign_batch_voucher(PAYER, channel_id, amount)
    extra = dict(
        req.extra,
        channelState={
            "channelId": channel_id,
            "balance": balance,
            "totalClaimed": claimed,
            "chargedCumulativeAmount": str(amount),
            "withdrawRequestedAt": 0,
        },
    )
    if proof:
        extra["voucherState"] = {
            "signedMaxClaimable": str(amount),
            "expiresAt": 0,
            "signature": voucher["signature"],
        }
    return PaymentRequired(
        x402_version=2,
        error="invalid_batch_settlement_svm_cumulative_amount_mismatch",
        accepts=[req.model_copy(update={"extra": extra})],
    )


def test_corrective_requires_valid_signature_and_never_inflates_escrow():
    scheme, _ = client()
    req = requirements()
    payment = scheme.create_payment_payload(req)
    good = corrective(req, payment, 10)
    recovered = scheme.on_payment_response(context(req, payment, required=good))
    assert recovered.recovered
    next_payment = scheme.create_payment_payload(req)
    assert next_payment["voucher"]["maxClaimableAmount"] == "20"
    bad = corrective(req, next_payment, 20, balance="999999")
    assert scheme.on_payment_response(context(req, next_payment, required=bad)) is None
    assert next(iter(scheme._channels.values())).cumulative == 10


def encoded_channel(channel_id, receiver=RECEIVER, *, deposit=30, settled=7, authorizer=PAYER):
    data = bytearray(256)
    data[:4] = bytes([1, 1, 0, 0])
    struct.pack_into("<QQQQqqI", data, 4, 0, deposit, settled, 0, 0, 0, 900)
    data[56:88] = distribution_hash([ChannelSplit(str(receiver.pubkey()), 10_000)])
    for index, key in enumerate(
        [
            PAYER.pubkey(),
            SPONSOR.pubkey(),
            authorizer.pubkey(),
            Pubkey.from_string(USDC_DEVNET_ADDRESS),
            SPONSOR.pubkey(),
        ]
    ):
        data[88 + index * 32 : 120 + index * 32] = bytes(key)
    struct.pack_into("<Q", data, 248, 42)
    return SimpleNamespace(
        pubkey=Pubkey.from_string(channel_id),
        account=SimpleNamespace(
            owner=Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID), data=bytes(data)
        ),
    )


def test_discovery_checks_pda_and_receiver_distribution_before_adopting():
    scheme, rpc = client(BatchSvmClientConfig(discover_channels=True))
    channel_id = find_payment_channel_pda(
        payer=str(PAYER.pubkey()),
        payee=str(SPONSOR.pubkey()),
        mint=USDC_DEVNET_ADDRESS,
        authorized_signer=str(PAYER.pubkey()),
        salt=0,
        open_slot=42,
    )
    valid = encoded_channel(channel_id)
    wrong_receiver = encoded_channel(channel_id, receiver=OPERATOR, deposit=999)
    wrong_pda = encoded_channel(str(OPERATOR.pubkey()), deposit=888)
    rpc.get_program_accounts.return_value = SimpleNamespace(
        value=[wrong_receiver, wrong_pda, valid]
    )
    payload = scheme.create_payment_payload(requirements())
    assert payload["type"] == "voucher"
    assert payload["voucher"]["channelId"] == channel_id
    assert payload["voucher"]["maxClaimableAmount"] == "17"


def test_unsigned_corrective_reads_actual_chain_instead_of_server_claim():
    scheme, rpc = client()
    req = requirements()
    payment = scheme.create_payment_payload(req)
    channel_id = payment["voucher"]["channelId"]
    rpc.get_account_info.return_value = SimpleNamespace(
        value=encoded_channel(channel_id, settled=7).account
    )
    fake = corrective(req, payment, 10, proof=False, claimed="10")
    assert scheme.on_payment_response(context(req, payment, required=fake)) is None
    payment = scheme.create_payment_payload(req)
    valid = corrective(req, payment, 7, proof=False, claimed="7")
    assert scheme.on_payment_response(context(req, payment, required=valid)).recovered
    assert next(iter(scheme._channels.values())).cumulative == 7


@pytest.mark.parametrize("server_mode,actual,requests", [(False, 10, 5), (True, 3, 10)])
def test_real_client_and_resource_server_cores_complete_channel_lifecycle(
    server_mode, actual, requests
):
    from x402 import x402ClientSync, x402ResourceServerSync
    from x402.mechanisms.svm.batch_settlement.server import (
        BatchSvmScheme as ServerScheme,
    )
    from x402.mechanisms.svm.batch_settlement.server import (
        BatchSvmServerConfig,
    )
    from x402.mechanisms.svm.payment_channels.verification import (
        verify_open_transaction,
        verify_top_up_transaction,
    )
    from x402.schemas import SupportedKind, SupportedResponse, VerifyResponse

    req = requirements(server=server_mode)
    config = BatchSvmClientConfig(
        discover_channels=False,
        deposit_amount=30,
        server_signed_channels_policy=BatchServerSignedChannelsPolicy(
            allowed_operators=[str(OPERATOR.pubkey())]
        )
        if server_mode
        else None,
    )
    scheme, _ = client(config)
    client_core = x402ClientSync().register(req.network, scheme)
    server_scheme = ServerScheme(
        BatchSvmServerConfig(
            receiver_authorizer=AUTHOR,
            operator=OPERATOR if server_mode else None,
        )
    )

    class Chain:
        deposit = 0
        onchain_calls = 0

        def get_supported(self):
            return SupportedResponse(
                kinds=[
                    SupportedKind(
                        x402_version=2,
                        scheme=req.scheme,
                        network=req.network,
                        extra=req.extra,
                    )
                ]
            )

        def verify(self, payment, _requirements):
            raw = payment.payload
            assert raw["type"] == "deposit", "confirmed vouchers should remain offchain"
            credential = raw.get("voucher") or raw["authorization"]
            if self.deposit:
                verify_top_up_transaction(
                    raw["deposit"]["transaction"],
                    channel_id=credential["channelId"],
                    channel_config=raw["channelConfig"],
                    fee_payer=req.extra["feePayer"],
                    token_program=TOKEN_PROGRAM_ADDRESS,
                    amount=int(raw["deposit"]["amount"]),
                )
                extra = {
                    "channelId": credential["channelId"],
                    "balance": str(self.deposit),
                    "totalClaimed": "0",
                    "withdrawRequestedAt": 0,
                }
            else:
                verify_open_transaction(
                    raw["deposit"]["transaction"],
                    channel_config=raw["channelConfig"],
                    fee_payer=req.extra["feePayer"],
                    token_program=TOKEN_PROGRAM_ADDRESS,
                    deposit=int(raw["deposit"]["amount"]),
                    current_slot=42,
                )
                extra = {"channelId": credential["channelId"]}
            return VerifyResponse(is_valid=True, extra=extra)

        def settle(self, payment, _requirements):
            raw = payment.payload
            assert raw["type"] == "deposit", "offchain acceptance must not call the facilitator"
            self.deposit += int(raw["deposit"]["amount"])
            self.onchain_calls += 1
            credential = raw.get("voucher") or raw["authorization"]
            return SettleResponse(
                success=True,
                transaction=f"confirmed-{self.onchain_calls}",
                network=req.network,
                extra={
                    "channelState": {
                        "channelId": credential["channelId"],
                        "balance": str(self.deposit),
                        "totalClaimed": "0",
                        "withdrawRequestedAt": 0,
                    }
                },
            )

    chain = Chain()
    server_core = x402ResourceServerSync(chain).register(req.network, server_scheme)
    server_core.initialize()
    for index in range(1, requests + 1):
        payment = client_core.create_payment_payload(PaymentRequired(x402_version=2, accepts=[req]))
        assert server_core.verify_payment(payment, req).is_valid
        result = server_core.settle_payment(payment, req.model_copy(update={"amount": str(actual)}))
        assert result.success and result.extra["chargedAmount"] == str(actual)
        client_core.handle_payment_response(
            PaymentResponseContext(
                payment_payload=payment,
                requirements=req,
                settle_response=result,
            )
        )
        local = next(iter(scheme._channels.values()))
        remote = server_scheme.store.get(local.channel_id)
        assert local.cumulative == remote.charged_cumulative_amount == index * actual
        assert local.deposit == remote.deposit == chain.deposit
    assert chain.onchain_calls == 2


def test_refund_probe_matches_client_channel_and_retries_forced_close_only_on_binding_failure():
    from x402.http.utils import (
        decode_payment_signature_header,
        encode_payment_required_header,
        encode_payment_response_header,
    )

    scheme, _ = client()
    req = requirements()
    payment = scheme.create_payment_payload(req)
    confirm(scheme, req, payment)
    calls = []

    def fetch(_url, headers):
        calls.append(headers)
        if not headers:
            required = PaymentRequired(x402_version=2, accepts=[requirements(server=True), req])
            return SimpleNamespace(
                status_code=402,
                headers={"PAYMENT-REQUIRED": encode_payment_required_header(required)},
            )
        refund = decode_payment_signature_header(headers["PAYMENT-SIGNATURE"])
        assert refund.accepted == req
        assert refund.payload["voucher"]["maxClaimableAmount"] == "10"
        if "transaction" not in refund.payload:
            response = SettleResponse(
                success=False,
                transaction="",
                network=req.network,
                error_reason="invalid_batch_settlement_svm_receiver_binding_unavailable",
            )
        else:
            response = SettleResponse(success=True, transaction="close", network=req.network)
        return SimpleNamespace(
            status_code=200, headers={"PAYMENT-RESPONSE": encode_payment_response_header(response)}
        )

    response = scheme.refund("https://resource.invalid/route", fetch=fetch)
    assert response.success and response.transaction == "close"
    assert len(calls) == 3 and not scheme._channels


def test_refund_restores_client_mode_from_storage_despite_server_first_probe():
    storage = InMemoryBatchClientChannelStorage()
    config = BatchSvmClientConfig(channel_storage=storage, discover_channels=False)
    scheme, _ = client(config)
    req = requirements()
    payment = scheme.create_payment_payload(req)
    confirm(scheme, req, payment)
    restarted, _ = client(config)
    refund = restarted.create_refund_payload(requirements(server=True))
    assert "authorization" not in refund
    assert refund["voucher"]["maxClaimableAmount"] == "10"


def test_durable_write_failure_never_exposes_unsigned_pending_payment():
    class BrokenStorage(InMemoryBatchClientChannelStorage):
        def set(self, key, record):
            raise OSError("unavailable")

    scheme, _ = client(
        BatchSvmClientConfig(discover_channels=False, channel_storage=BrokenStorage())
    )
    with pytest.raises(OSError, match="unavailable"):
        scheme.create_payment_payload(requirements())
    assert not scheme._channels and not scheme._pending


def test_canceled_large_setup_does_not_leave_credit_after_smaller_confirmed_setup():
    from x402.mechanisms.svm.batch_settlement.server import BatchSvmScheme as ServerScheme
    from x402.mechanisms.svm.batch_settlement.server import BatchSvmServerConfig
    from x402.schemas import VerifyResponse
    from x402.schemas.hooks import (
        SettleContext,
        SettleResultContext,
        VerifiedPaymentCanceledContext,
        VerifyContext,
        VerifyResultContext,
    )

    req = requirements()
    server = ServerScheme(BatchSvmServerConfig(receiver_authorizer=AUTHOR))
    large_client, _ = client(BatchSvmClientConfig(discover_channels=False, deposit_amount=100))
    large = PaymentPayload(
        x402_version=2, accepted=req, payload=large_client.create_payment_payload(req)
    )
    assert server.before_verify(VerifyContext(large, req)) is None
    assert (
        server.after_verify(VerifyResultContext(large, req, result=VerifyResponse(is_valid=True)))
        is None
    )
    server.on_verified_payment_canceled(VerifiedPaymentCanceledContext(large, req))
    small_client, _ = client(BatchSvmClientConfig(discover_channels=False, deposit_amount=10))
    small = PaymentPayload(
        x402_version=2, accepted=req, payload=small_client.create_payment_payload(req)
    )
    assert server.before_verify(VerifyContext(small, req)) is None
    assert (
        server.after_verify(VerifyResultContext(small, req, result=VerifyResponse(is_valid=True)))
        is None
    )
    assert server.before_settle(SettleContext(small, req)) is None
    cid = small.payload["voucher"]["channelId"]
    response = SettleResponse(
        success=True,
        transaction="confirmed",
        network=req.network,
        extra={
            "channelState": {
                "channelId": cid,
                "balance": "10",
                "totalClaimed": "0",
                "withdrawRequestedAt": 0,
            },
        },
    )
    server.after_settle(SettleResultContext(small, req, result=response))
    state = server.store.get(cid)
    assert state.deposit == state.charged_cumulative_amount == 10


@pytest.mark.parametrize("slot", [42, "42", "00042"])
def test_open_uses_integer_and_decimal_string_slot_hints(slot):
    scheme, rpc = client()
    payment = scheme.create_payment_payload(requirements(recentSlot=slot))
    assert payment["channelConfig"]["openSlot"] == 42
    rpc.get_slot.assert_not_called()


@pytest.mark.parametrize("slot", [None, True, -1, 1.5, "-1", " 42", "٤٢", str(2**64), 2**53])
def test_missing_or_invalid_open_slot_uses_finalized_rpc(slot):
    from x402.mechanisms.svm.payment_channels.verification import verify_open_transaction

    scheme, rpc = client()
    rpc.get_slot.side_effect = lambda *, commitment: SimpleNamespace(
        value=42 if commitment == "finalized" else 74
    )
    req = requirements(recentSlot=slot)
    if slot is None:
        req.extra.pop("recentSlot")
    payment = scheme.create_payment_payload(req)
    assert payment["channelConfig"]["openSlot"] == 42
    rpc.get_slot.assert_called_once_with(commitment="finalized")
    verify_open_transaction(
        payment["deposit"]["transaction"],
        channel_config=payment["channelConfig"],
        fee_payer=req.extra["feePayer"],
        token_program=req.extra["tokenProgram"],
        deposit=30,
        current_slot=42,
    )


def _valid_receipt(req, payment, cumulative):
    receipt = success(req, payment, cumulative=cumulative)
    if req.extra.get("voucherSigner") == "server":
        receipt.extra["voucher"] = sign_batch_voucher(
            OPERATOR, payment["authorization"]["channelId"], cumulative
        )
    return receipt


@pytest.mark.parametrize(
    "server_mode,malformed",
    [
        (False, "amount"),
        (False, "commitment"),
        (False, "state"),
        (False, "cumulative"),
        (True, "signature"),
        (True, "ceiling"),
        (True, "commitment"),
        (True, "state"),
        (True, "cumulative"),
    ],
)
def test_invalid_offchain_receipt_restores_persisted_confirmation_and_allows_refund(
    server_mode, malformed
):
    from x402.http.utils import decode_payment_signature_header, encode_payment_response_header

    storage = InMemoryBatchClientChannelStorage()
    config = BatchSvmClientConfig(
        discover_channels=False,
        channel_storage=storage,
        deposit_amount=30,
        server_signed_channels_policy=BatchServerSignedChannelsPolicy(
            allowed_operators=[str(OPERATOR.pubkey())]
        )
        if server_mode
        else None,
    )
    scheme, _ = client(config)
    req = requirements(server=server_mode)
    opened = scheme.create_payment_payload(req)
    scheme.on_payment_response(context(req, opened, _valid_receipt(req, opened, 10)))
    pending = scheme.create_payment_payload(req)
    assert pending["type"] == ("authorization" if server_mode else "voucher")
    receipt = _valid_receipt(req, pending, 20)
    if malformed == "amount":
        receipt.extra["chargedAmount"] = "11"
    elif malformed == "commitment":
        receipt.extra["commitmentId"] = ""
    elif malformed == "state":
        receipt.extra["channelState"] = []
    elif malformed == "cumulative":
        receipt.extra["channelState"]["chargedCumulativeAmount"] = "9000"
    elif malformed == "signature":
        receipt.extra["voucher"]["signature"] = str(Signature.default())
    elif malformed == "ceiling":
        receipt.extra["voucher"] = sign_batch_voucher(
            OPERATOR, pending["authorization"]["channelId"], 21
        )
    # A late response after restart must clear the persisted allocation too.
    restarted, _ = client(config)
    with pytest.raises(ValueError, match="PAYMENT-RESPONSE"):
        restarted.on_payment_response(context(req, pending, receipt))
    assert not restarted._pending
    assert next(iter(restarted._channels.values())).cumulative == 10
    assert all("pending" not in record for record in storage._records.values())
    refunded, _ = client(config)

    def fetch(_url, headers):
        payment = decode_payment_signature_header(headers["PAYMENT-SIGNATURE"])
        assert payment.payload["type"] == "refund"
        if server_mode:
            assert payment.payload["authorization"]["authorizedAmount"] == "0"
        else:
            assert payment.payload["voucher"]["maxClaimableAmount"] == "10"
        return SimpleNamespace(
            status_code=200,
            headers={
                "PAYMENT-RESPONSE": encode_payment_response_header(
                    SettleResponse(
                        success=True,
                        transaction="closed",
                        network=req.network,
                    )
                ),
            },
        )

    assert refunded.refund("https://resource.invalid/route", requirements=req, fetch=fetch).success
    assert not storage._records


@pytest.mark.parametrize("server_mode", [False, True])
@pytest.mark.parametrize("top_up", [False, True])
def test_invalid_funding_receipt_preserves_exact_pending_transaction_after_restart(
    server_mode, top_up
):
    storage = InMemoryBatchClientChannelStorage()
    config = BatchSvmClientConfig(
        discover_channels=False,
        channel_storage=storage,
        deposit_amount=30,
        server_signed_channels_policy=BatchServerSignedChannelsPolicy(
            allowed_operators=[str(OPERATOR.pubkey())]
        )
        if server_mode
        else None,
    )
    scheme, rpc = client(config)
    req = requirements(server=server_mode)
    payment = scheme.create_payment_payload(req)
    prior = 0
    if top_up:
        scheme.on_payment_response(context(req, payment, _valid_receipt(req, payment, 10)))
        prior = 10
        req = req.model_copy(update={"amount": "21"})
        payment = scheme.create_payment_payload(req)
    assert payment["type"] == "deposit"
    channel_id = (payment.get("voucher") or payment["authorization"])["channelId"]
    # Escrow being present does not independently establish the offchain charge.
    rpc.get_account_info.return_value = SimpleNamespace(
        value=encoded_channel(
            channel_id,
            deposit=60 if top_up else 30,
            settled=0,
            authorizer=OPERATOR if server_mode else PAYER,
        ).account
    )
    receipt = _valid_receipt(req, payment, prior + int(req.amount))
    receipt.extra["commitmentId"] = ""
    with pytest.raises(ValueError, match="PAYMENT-RESPONSE"):
        scheme.on_payment_response(context(req, payment, receipt))
    restarted, _ = client(config)
    if server_mode:
        with pytest.raises(ValueError, match="pending request"):
            restarted.create_payment_payload(req)
    else:
        assert restarted.create_payment_payload(req) == payment
    pending = next(iter(restarted._pending.values()))
    assert pending.payload == payment
    assert (pending.confirmed.cumulative if pending.confirmed else 0) == prior
    with pytest.raises(ValueError, match="pending payment"):
        restarted.create_refund_payload(req)
    # The valid receipt for that exact allocation still resolves uncertainty.
    restarted.on_payment_response(
        context(req, payment, _valid_receipt(req, payment, prior + int(req.amount)))
    )
    assert not restarted._pending
    assert next(iter(restarted._channels.values())).deposit == (60 if top_up else 30)
    assert restarted.create_refund_payload(req)["type"] == "refund"
