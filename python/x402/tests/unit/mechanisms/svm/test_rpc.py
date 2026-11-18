"""Tests for the minimal SVM JSON-RPC client."""

import json

import httpx
import pytest
from solders.hash import Hash
from solders.pubkey import Pubkey

from x402.mechanisms.svm.rpc import CONFIRMED, SvmRpcClient, SvmRpcError

BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"


def _client(handler) -> tuple[SvmRpcClient, list[dict]]:
    requests: list[dict] = []

    def record(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        return handler(body)

    client = SvmRpcClient("https://rpc.example")
    client._http = httpx.Client(transport=httpx.MockTransport(record))
    return client, requests


def _ok(result: object) -> httpx.Response:
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": result})


def test_get_latest_blockhash_parses_the_solders_response():
    client, requests = _client(
        lambda _: _ok(
            {
                "context": {"slot": 1},
                "value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 42},
            }
        )
    )
    response = client.get_latest_blockhash(CONFIRMED)
    assert response.value.blockhash == Hash.from_string(BLOCKHASH)
    assert response.value.last_valid_block_height == 42
    assert requests[0]["method"] == "getLatestBlockhash"
    assert requests[0]["params"] == [{"commitment": "confirmed"}]


def test_send_raw_transaction_sends_base64_with_options():
    signature = "1" * 64
    client, requests = _client(lambda _: _ok(signature))
    response = client.send_raw_transaction(b"\x81\x00", skip_preflight=True)
    assert str(response.value) == signature
    params = requests[0]["params"]
    assert params[0] == "gQA="
    assert params[1]["encoding"] == "base64"
    assert params[1]["skipPreflight"] is True


def test_get_account_info_requests_base64():
    client, requests = _client(lambda _: _ok({"context": {"slot": 1}, "value": None}))
    response = client.get_account_info(Pubkey.default())
    assert response.value is None
    assert requests[0]["params"][1]["encoding"] == "base64"


def test_error_member_raises():
    client, _ = _client(
        lambda _: httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": 1, "error": {"code": -32002, "message": "boom"}},
        )
    )
    with pytest.raises(SvmRpcError, match="getLatestBlockhash failed: boom"):
        client.get_latest_blockhash()
