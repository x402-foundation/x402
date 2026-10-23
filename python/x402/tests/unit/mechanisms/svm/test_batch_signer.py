"""RPC normalization and fail-closed confirmation behavior."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.rpc.responses import GetSignatureStatusesResp
from solders.signature import Signature

from x402.mechanisms.svm.batch_settlement.signer import BatchFacilitatorKeypairSigner
from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.payment_channels import build_request_close_transaction

PAYER, SPONSOR = (Keypair.from_seed(bytes([i] * 32)) for i in (1, 2))
NETWORK = SOLANA_DEVNET_CAIP2


def signer():
    value = BatchFacilitatorKeypairSigner(SPONSOR)
    rpc = MagicMock()
    value._clients[NETWORK] = rpc
    return value, rpc


def test_account_read_passes_confirmation_slot_and_preserves_owner():
    value, rpc = signer()
    rpc._provider.make_request.return_value = SimpleNamespace(
        context=SimpleNamespace(slot=99),
        value=SimpleNamespace(owner=PAYER.pubkey(), data=b"state", executable=False),
    )
    result = value.get_account_info(str(PAYER.pubkey()), NETWORK, min_context_slot=98)
    assert result == {
        "data": b"state",
        "owner": str(PAYER.pubkey()),
        "executable": False,
        "context_slot": 99,
    }
    request = json.loads(rpc._provider.make_request.call_args.args[0].to_json())
    assert request["params"][1]["minContextSlot"] == 98
    assert request["params"][1]["commitment"] == "confirmed"
    with pytest.raises(RuntimeError, match="precedes"):
        value.get_account_info(str(PAYER.pubkey()), NETWORK, min_context_slot=100)


def test_absent_account_preserves_context_and_rejects_stale_rpc():
    value, rpc = signer()
    rpc._provider.make_request.return_value = SimpleNamespace(
        context=SimpleNamespace(slot=99),
        value=None,
    )
    assert value.get_account_info_with_context(
        str(PAYER.pubkey()), NETWORK, min_context_slot=99
    ) == {"context_slot": 99, "account": None}
    assert value.get_account_info(str(PAYER.pubkey()), NETWORK, min_context_slot=99) is None
    for read in (value.get_account_info, value.get_account_info_with_context):
        with pytest.raises(RuntimeError, match="precedes"):
            read(str(PAYER.pubkey()), NETWORK, min_context_slot=100)


def test_confirmed_failed_transaction_is_never_success():
    value, rpc = signer()
    response = {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "context": {"slot": 99},
            "value": [
                {
                    "slot": 98,
                    "confirmations": 2,
                    "err": {"InstructionError": [0, "InvalidArgument"]},
                    "confirmationStatus": "confirmed",
                    "status": {"Err": {"InstructionError": [0, "InvalidArgument"]}},
                }
            ],
        },
    }
    rpc.get_signature_statuses.return_value = GetSignatureStatusesResp.from_json(
        json.dumps(response)
    )
    with pytest.raises(RuntimeError, match="Transaction failed"):
        value.confirm_transaction(str(Signature.default()), NETWORK)
    response["result"]["value"][0].update(err=None, status={"Ok": None})
    rpc.get_signature_statuses.return_value = GetSignatureStatusesResp.from_json(
        json.dumps(response)
    )
    assert value.confirm_transaction(str(Signature.default()), NETWORK) == 98
    assert rpc.get_signature_statuses.call_args.kwargs["search_transaction_history"] is True


def test_simulation_checks_errors_with_and_without_signature_verification():
    value, rpc = signer()
    wire = build_request_close_transaction(
        payer=PAYER,
        channel_id=str(Pubkey.new_unique()),
        fee_payer=str(SPONSOR.pubkey()),
        blockhash=str(PAYER.pubkey()),
    )
    rpc.simulate_transaction.return_value = SimpleNamespace(
        value=SimpleNamespace(err=None), context=SimpleNamespace(slot=99)
    )
    value.simulate_transaction(wire, NETWORK, sig_verify=False)
    assert rpc.simulate_transaction.call_args.kwargs["sig_verify"] is False
    value.simulate_transaction(wire, NETWORK)
    assert rpc.simulate_transaction.call_args.kwargs["sig_verify"] is True
    rpc.simulate_transaction.return_value.value.err = "InvalidArgument"
    with pytest.raises(RuntimeError, match="Simulation failed"):
        value.simulate_transaction(wire, NETWORK)


def test_discovery_filters_and_raw_transaction_preserve_balance_metadata():
    value, rpc = signer()
    rpc.get_program_accounts.return_value = SimpleNamespace(
        value=[
            SimpleNamespace(
                pubkey=PAYER.pubkey(),
                account=SimpleNamespace(data=b"channel", owner=SPONSOR.pubkey(), executable=False),
            )
        ]
    )
    rows = value.get_program_accounts(
        str(SPONSOR.pubkey()),
        NETWORK,
        filters=[
            {"dataSize": 256},
            {"memcmp": {"offset": 88, "bytes": str(PAYER.pubkey())}},
        ],
    )
    assert rows[0]["account"]["data"] == b"channel"
    filters = rpc.get_program_accounts.call_args.kwargs["filters"]
    assert filters[0] == 256 and filters[1].offset == 88
    raw = {
        "meta": {"err": None, "preTokenBalances": [], "postTokenBalances": [{"accountIndex": 1}]},
        "slot": 99,
        "transaction": {"message": {"accountKeys": [str(PAYER.pubkey())]}},
    }
    rpc.get_transaction.return_value.to_json.return_value = json.dumps({"result": raw})
    assert value.get_transaction(str(Signature.default()), NETWORK) == raw
    assert rpc.get_transaction.call_args.kwargs["max_supported_transaction_version"] == 0


def test_expiry_queries_original_blockhash_only_after_finalized_simulation_context():
    value, rpc = signer()
    rpc._provider.make_request.return_value = SimpleNamespace(
        value=False, context=SimpleNamespace(slot=100)
    )
    assert value.is_blockhash_valid(str(PAYER.pubkey()), NETWORK, min_context_slot=99) is False
    request = json.loads(rpc._provider.make_request.call_args.args[0].to_json())
    assert request["method"] == "isBlockhashValid"
    assert request["params"][0] == str(PAYER.pubkey())
    assert request["params"][1] == {"commitment": "finalized", "minContextSlot": 99}
    with pytest.raises(RuntimeError, match="precedes"):
        value.is_blockhash_valid(str(PAYER.pubkey()), NETWORK, min_context_slot=101)
