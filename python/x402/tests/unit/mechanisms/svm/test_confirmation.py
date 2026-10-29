"""Confirmation must distinguish execution failure from an unknown outcome."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.rpc.responses import GetSignatureStatusesResp
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import (
    ERR_SETTLEMENT_PENDING,
    ERR_TRANSACTION_FAILED,
    SOLANA_DEVNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    TransactionOnchainFailureError,
)
from x402.mechanisms.svm.exact import ExactSvmClientScheme, ExactSvmFacilitatorScheme
from x402.mechanisms.svm.exact.v1.facilitator import ExactSvmSchemeV1
from x402.mechanisms.svm.signers import FacilitatorKeypairSigner, KeypairSigner
from x402.mechanisms.svm.utils import transaction_message_hash
from x402.schemas import PaymentPayload, PaymentRequirements
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

EXECUTION_ERROR = {"InstructionError": [2, {"Custom": 1}]}


def status_response(level, err=None):
    status = (
        None
        if level is None
        else {
            "slot": 101,
            "confirmations": None if level == "finalized" else 1,
            "confirmationStatus": level,
            "err": err,
            "status": {"Err": err} if err is not None else {"Ok": None},
        }
    )
    return GetSignatureStatusesResp.from_json(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {"context": {"slot": 102}, "value": [status]},
            }
        )
    )


@pytest.fixture
def signer_rpc():
    signer = FacilitatorKeypairSigner(Keypair())
    rpc = MagicMock()
    with patch.object(signer, "_get_client", return_value=rpc):
        yield signer, rpc


@pytest.fixture
def payment(signer_rpc):
    signer, rpc = signer_rpc
    payer = Keypair()
    requirements = PaymentRequirements(
        scheme="exact",
        network=SOLANA_DEVNET_CAIP2,
        asset=str(Keypair().pubkey()),
        amount="100000",
        pay_to=str(Keypair().pubkey()),
        max_timeout_seconds=3600,
        extra={"feePayer": signer.get_addresses()[0]},
    )
    rpc.get_latest_blockhash.return_value.value.blockhash = Hash.new_unique()
    rpc.get_account_info.return_value.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    rpc.get_account_info.return_value.value.data = bytes(44) + bytes([6]) + bytes(37)
    rpc.simulate_transaction.return_value.value.err = None
    client = ExactSvmClientScheme(KeypairSigner(payer))
    with patch.object(client, "_get_client", return_value=rpc):
        inner = client.create_payment_payload(requirements)
    signed = signer.sign_transaction(
        inner["transaction"], signer.get_addresses()[0], str(requirements.network)
    )
    tx = VersionedTransaction.from_bytes(base64.b64decode(signed))
    tx.verify_and_hash_message()

    def send_raw_transaction(wire, opts):
        sent = VersionedTransaction.from_bytes(wire)
        sent.verify_and_hash_message()
        assert opts.skip_preflight is True
        return SimpleNamespace(value=sent.signatures[0])

    rpc.send_raw_transaction.side_effect = send_raw_transaction
    return SimpleNamespace(
        payload=PaymentPayload(x402_version=2, accepted=requirements, payload=inner),
        requirements=requirements,
        tx_key=transaction_message_hash(tx),
        payer=str(payer.pubkey()),
        signature=str(tx.signatures[0]),
    )


def assert_response(response, payment, reason, network=SOLANA_DEVNET_CAIP2):
    assert response.success is (reason is None)
    assert response.error_reason == reason
    assert response.transaction == payment.signature
    assert response.payer == payment.payer
    assert response.network == network


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
@pytest.mark.parametrize("error", [EXECUTION_ERROR, "AccountNotFound"])
def test_confirmed_execution_failure_raises_typed_error(signer_rpc, level, error):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response(level, error)

    with pytest.raises(TransactionOnchainFailureError, match="Transaction failed"):
        signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)

    rpc.get_signature_statuses.assert_called_once()


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
def test_successful_confirmed_transaction_is_accepted(signer_rpc, level):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response(level)

    signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)

    rpc.get_signature_statuses.assert_called_once()


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
@pytest.mark.parametrize("error", [None, EXECUTION_ERROR])
def test_processed_error_waits_for_confirmed_outcome(signer_rpc, level, error):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.side_effect = [
        status_response("processed", EXECUTION_ERROR),
        status_response(level, error),
    ]

    with patch("x402.mechanisms.svm.signers.time.sleep"):
        if error is None:
            signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)
        else:
            with pytest.raises(TransactionOnchainFailureError):
                signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)

    assert rpc.get_signature_statuses.call_count == 2


@pytest.mark.parametrize(
    "level,error", [(None, None), ("processed", None), ("processed", EXECUTION_ERROR)]
)
def test_missing_or_processed_status_times_out_without_terminal_error(signer_rpc, level, error):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response(level, error)

    with (
        patch("x402.mechanisms.svm.signers.time.time", side_effect=[0, 0, 31]),
        patch("x402.mechanisms.svm.signers.time.sleep"),
        pytest.raises(RuntimeError, match="Transaction confirmation timeout") as exc,
    ):
        signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)

    assert not isinstance(exc.value, TransactionOnchainFailureError)


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
def test_settle_returns_terminal_execution_failure(signer_rpc, payment, level):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response(level, EXECUTION_ERROR)
    facilitator = ExactSvmFacilitatorScheme(signer)

    with patch.object(
        facilitator._pending_store, "set", wraps=facilitator._pending_store.set
    ) as record:
        response = facilitator.settle(payment.payload, payment.requirements)

    assert_response(response, payment, ERR_TRANSACTION_FAILED)
    assert "Transaction failed" in response.error_message
    assert facilitator._pending_store.get(payment.tx_key) is None
    assert payment.tx_key not in facilitator._settlement_cache.entries
    record.assert_not_called()
    rpc.send_raw_transaction.assert_called_once()


@pytest.mark.parametrize(
    "initial_error",
    [
        TimeoutError("confirmation timeout"),
        ConnectionError("RPC unavailable"),
        RuntimeError("Transaction failed: RPC unavailable"),
    ],
    ids=["timeout", "rpc", "generic-runtime"],
)
@pytest.mark.parametrize("outcome", ["pending", "success", "failure"])
def test_settle_retry_reconciles_original_signature(signer_rpc, payment, initial_error, outcome):
    signer, rpc = signer_rpc
    next_status = {
        "pending": TimeoutError("still unknown"),
        "success": status_response("confirmed"),
        "failure": status_response("finalized", EXECUTION_ERROR),
    }[outcome]
    rpc.get_signature_statuses.side_effect = [initial_error, next_status]
    facilitator = ExactSvmFacilitatorScheme(signer)

    with (
        patch.object(facilitator, "verify", wraps=facilitator.verify) as verify,
        patch.object(signer, "sign_transaction", wraps=signer.sign_transaction) as sign,
    ):
        first = facilitator.settle(payment.payload, payment.requirements)
        assert_response(first, payment, ERR_SETTLEMENT_PENDING)
        assert facilitator._pending_store.get(payment.tx_key) == payment.signature
        assert payment.tx_key in facilitator._settlement_cache.entries
        calls_before_retry = (
            verify.call_count,
            sign.call_count,
            rpc.simulate_transaction.call_count,
        )

        second = facilitator.settle(payment.payload, payment.requirements)

        assert (
            verify.call_count,
            sign.call_count,
            rpc.simulate_transaction.call_count,
        ) == calls_before_retry

    reason = {
        "pending": ERR_SETTLEMENT_PENDING,
        "success": None,
        "failure": ERR_TRANSACTION_FAILED,
    }[outcome]
    assert_response(second, payment, reason)
    assert facilitator._pending_store.get(payment.tx_key) == (
        payment.signature if outcome == "pending" else None
    )
    assert (payment.tx_key in facilitator._settlement_cache.entries) is (outcome != "failure")
    rpc.send_raw_transaction.assert_called_once()
    assert rpc.get_signature_statuses.call_count == 2


def test_processed_execution_error_remains_pending_on_timeout(signer_rpc, payment):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response("processed", EXECUTION_ERROR)
    facilitator = ExactSvmFacilitatorScheme(signer)

    with (
        patch("x402.mechanisms.svm.signers.time.time", side_effect=[0, 0, 31]),
        patch("x402.mechanisms.svm.signers.time.sleep"),
    ):
        response = facilitator.settle(payment.payload, payment.requirements)

    assert_response(response, payment, ERR_SETTLEMENT_PENDING)
    assert "confirmation timeout" in response.error_message
    assert facilitator._pending_store.get(payment.tx_key) == payment.signature
    assert payment.tx_key in facilitator._settlement_cache.entries


def test_terminal_failure_survives_cleanup_error_after_confirmation(signer_rpc, payment):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response("confirmed", EXECUTION_ERROR)
    facilitator = ExactSvmFacilitatorScheme(signer)
    facilitator._pending_store.set(payment.tx_key, payment.signature)
    assert facilitator._settlement_cache.is_duplicate(payment.tx_key) is False

    # Enter after the pending claim, so this tests cleanup of an observed failure.
    with (
        patch.object(
            facilitator._pending_store, "delete", side_effect=ConnectionError("store unavailable")
        ) as delete,
        patch.object(facilitator._pending_store, "set") as record,
    ):
        response = facilitator._await_confirmation(
            payment.tx_key, payment.signature, payment.payer, SOLANA_DEVNET_CAIP2
        )

    assert_response(response, payment, ERR_TRANSACTION_FAILED)
    assert "Transaction failed" in response.error_message
    delete.assert_called_once_with(payment.tx_key)
    record.assert_not_called()
    assert payment.tx_key not in facilitator._settlement_cache.entries
    assert facilitator._pending_store.get(payment.tx_key) == payment.signature


def v1_payment(payment):
    requirements = PaymentRequirementsV1(
        scheme="exact",
        network="solana-devnet",
        asset=payment.requirements.asset,
        max_amount_required=payment.requirements.amount,
        pay_to=payment.requirements.pay_to,
        max_timeout_seconds=3600,
        resource="https://example.com",
        extra=payment.requirements.extra,
    )
    payload = PaymentPayloadV1(
        scheme="exact", network="solana-devnet", payload=payment.payload.payload
    )
    return payload, requirements


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
def test_v1_confirmed_failure_preserves_signature(signer_rpc, payment, level):
    signer, rpc = signer_rpc
    rpc.get_signature_statuses.return_value = status_response(level, EXECUTION_ERROR)
    facilitator = ExactSvmSchemeV1(signer)

    response = facilitator.settle(*v1_payment(payment))

    assert_response(response, payment, ERR_TRANSACTION_FAILED, network="solana-devnet")
    assert payment.tx_key not in facilitator._settlement_cache.entries


@pytest.mark.parametrize("stage", ["sign_transaction", "send_transaction"])
@pytest.mark.parametrize("error_type", [RuntimeError, TransactionOnchainFailureError])
def test_v1_prebroadcast_failure_has_no_signature(signer_rpc, payment, stage, error_type):
    signer, _ = signer_rpc
    facilitator = ExactSvmSchemeV1(signer)
    with (
        patch.object(
            facilitator, "verify", return_value=SimpleNamespace(is_valid=True, payer=payment.payer)
        ),
        patch.object(signer, stage, side_effect=error_type("before broadcast")),
    ):
        response = facilitator.settle(*v1_payment(payment))

    assert response.success is False
    assert response.error_reason == ERR_TRANSACTION_FAILED
    assert response.transaction == ""
    assert payment.tx_key not in facilitator._settlement_cache.entries
