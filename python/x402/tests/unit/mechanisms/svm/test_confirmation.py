"""Confirmation must distinguish inclusion from successful execution."""

import json
from unittest.mock import MagicMock, patch

import pytest
from solders.keypair import Keypair
from solders.rpc.responses import GetSignatureStatusesResp
from solders.signature import Signature

from x402.mechanisms.svm import SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.exact import ExactSvmFacilitatorScheme
from x402.mechanisms.svm.signers import FacilitatorKeypairSigner

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
                "result": {
                    "context": {"slot": 102},
                    "value": [status],
                },
            }
        )
    )


@pytest.fixture
def signer_rpc():
    signer = FacilitatorKeypairSigner(Keypair())
    client = MagicMock()
    with patch.object(signer, "_get_client", return_value=client):
        yield signer, client


@pytest.mark.parametrize("level", ["processed", "confirmed", "finalized"])
def test_execution_failure_is_rejected_at_every_confirmation_level(signer_rpc, level):
    signer, client = signer_rpc
    client.get_signature_statuses.return_value = status_response(level, EXECUTION_ERROR)

    with pytest.raises(RuntimeError, match="Transaction failed"):
        signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
def test_successful_confirmed_transaction_is_accepted(signer_rpc, level):
    signer, client = signer_rpc
    client.get_signature_statuses.return_value = status_response(level)

    signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)

    client.get_signature_statuses.assert_called_once()


@pytest.mark.parametrize("level", [None, "processed"])
def test_missing_or_unconfirmed_status_does_not_succeed(signer_rpc, level):
    signer, client = signer_rpc
    client.get_signature_statuses.return_value = status_response(level)

    with (
        patch("x402.mechanisms.svm.signers.time.time", side_effect=[0, 0, 31]),
        patch("x402.mechanisms.svm.signers.time.sleep"),
        pytest.raises(RuntimeError, match="Transaction confirmation timeout"),
    ):
        signer.confirm_transaction(str(Signature.default()), SOLANA_DEVNET_CAIP2)


@pytest.mark.parametrize("level", ["confirmed", "finalized"])
def test_settlement_does_not_report_failed_execution_as_success(signer_rpc, level):
    signer, client = signer_rpc
    client.get_signature_statuses.return_value = status_response(level, EXECUTION_ERROR)
    facilitator = ExactSvmFacilitatorScheme(signer)

    response = facilitator._await_confirmation(
        "payment-key", str(Signature.default()), "payer", SOLANA_DEVNET_CAIP2
    )

    assert response.success is False
    assert "Transaction failed" in response.error_message
