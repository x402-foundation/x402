"""Focused tests for the Toncenter TVM provider client."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

pytest.importorskip("pytoniq_core")

from pytoniq_core import Address, begin_cell

import x402.mechanisms.tvm.provider as provider_module
from x402.mechanisms.tvm import (
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    TVM_MAINNET,
    TVM_TESTNET,
)
from x402.mechanisms.tvm.provider import ToncenterRestClient, _default_base_url


def _cell_b64(value: int) -> str:
    return base64.b64encode(begin_cell().store_uint(value, 8).end_cell().to_boc()).decode("ascii")


def _address_cell_b64(address: str) -> str:
    return base64.b64encode(
        begin_cell().store_address(Address(address)).end_cell().to_boc()
    ).decode("ascii")


class _FakeHttpClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, str, object]] = []
        self.closed = False

    def request(self, method: str, path: str, **kwargs):
        self.calls.append((method, path, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def close(self):
        self.closed = True


def _json_response(
    status_code: int,
    data,
    *,
    path: str = "/api/test",
    headers: dict[str, str] | None = None,
    text: str = "",
):
    request = httpx.Request("GET", f"https://toncenter.example{path}")
    return httpx.Response(
        status_code,
        content=json.dumps(data).encode("utf-8"),
        request=request,
        headers={"Content-Type": "application/json", **(headers or {})},
    )


class TestDefaultBaseUrl:
    def test_should_select_default_base_url_for_supported_networks(self):
        assert _default_base_url(TVM_MAINNET) == "https://toncenter.com"
        assert _default_base_url(TVM_TESTNET) == "https://testnet.toncenter.com"

    def test_should_reject_unsupported_network(self):
        with pytest.raises(ValueError, match="Unsupported TVM network"):
            _default_base_url("tvm:123")


class TestToncenterRestClientParsing:
    def test_emulate_trace_should_forward_ignore_chksig_flag(self):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_http = _FakeHttpClient(
            [_json_response(200, {"transactions": {}}, path="/api/emulate/v1/emulateTrace")]
        )
        client._client = fake_http

        client.emulate_trace(b"boc-bytes", ignore_chksig=True)

        assert len(fake_http.calls) == 1
        method, path, kwargs = fake_http.calls[0]
        assert method == "POST"
        assert path == "/api/emulate/v1/emulateTrace"
        assert kwargs["json"]["ignore_chksig"] is True
        assert kwargs["json"]["with_actions"] is True
        assert kwargs["timeout"] == DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS

    def test_emulate_trace_should_allow_custom_timeout(self):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_http = _FakeHttpClient(
            [_json_response(200, {"transactions": {}}, path="/api/emulate/v1/emulateTrace")]
        )
        client._client = fake_http

        client.emulate_trace(b"boc-bytes", timeout=9.5)

        assert len(fake_http.calls) == 1
        _, _, kwargs = fake_http.calls[0]
        assert kwargs["timeout"] == 9.5

    def test_get_account_state_should_decode_active_state_init(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "accounts": [
                            {
                                "address": "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                                "balance": "123",
                                "status": "active",
                                "code_boc": _cell_b64(1),
                                "data_boc": _cell_b64(2),
                            }
                        ]
                    },
                    path="/api/v3/accountStates",
                )
            ]
        )

        account = client.get_account_state("0:" + "0" * 64)

        assert account.address == "0:" + "0" * 64
        assert account.balance == 123
        assert account.is_active is True
        assert account.is_uninitialized is False
        assert account.state_init is not None

    def test_get_account_state_should_decode_uninitialized_account_without_state_init(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "accounts": [
                            {
                                "address": "0:" + "1" * 64,
                                "balance": "0",
                                "status": "uninit",
                            }
                        ]
                    },
                    path="/api/v3/accountStates",
                )
            ]
        )

        account = client.get_account_state("0:" + "1" * 64)

        assert account.is_active is False
        assert account.is_uninitialized is True
        assert account.state_init is None

    def test_get_account_state_should_return_synthetic_uninitialized_state_for_empty_accounts(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {"accounts": []},
                    path="/api/v3/accountStates",
                )
            ]
        )

        account = client.get_account_state("0:" + "2" * 64)

        assert account.address == "0:" + "2" * 64
        assert account.balance == 0
        assert account.is_active is False
        assert account.is_uninitialized is True
        assert account.is_frozen is False
        assert account.state_init is None

    def test_run_get_method_should_reject_non_zero_exit_code(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [_json_response(200, {"exit_code": 1, "stack": []}, path="/api/v3/runGetMethod")]
        )

        with pytest.raises(RuntimeError, match="failed with exit code 1"):
            client.run_get_method("0:" + "1" * 64, "method", [])

    def test_run_get_method_should_reject_non_list_stack(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [_json_response(200, {"exit_code": 0, "stack": {}}, path="/api/v3/runGetMethod")]
        )

        with pytest.raises(RuntimeError, match="invalid stack"):
            client.run_get_method("0:" + "1" * 64, "method", [])

    def test_should_parse_stack_helpers_and_jetton_wallet_data(self):
        owner = "0:" + "2" * 64
        minter = "0:" + "3" * 64
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "exit_code": 0,
                        "stack": [
                            {"value": "123"},
                            {"value": _address_cell_b64(owner)},
                            {"value": _address_cell_b64(minter)},
                        ],
                    },
                    path="/api/v3/runGetMethod",
                )
            ]
        )

        data = client.get_jetton_wallet_data("0:" + "4" * 64)

        assert data.balance == 123
        assert data.owner == owner
        assert data.jetton_minter == minter

    def test_get_trace_by_message_hash_should_reject_malformed_response(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [_json_response(200, {"traces": {}}, path="/api/v3/traces")]
        )

        with pytest.raises(RuntimeError, match="invalid traces response"):
            client.get_trace_by_message_hash("hash-1")

    def test_get_trace_by_message_hash_should_reject_empty_traces(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [_json_response(200, {"traces": []}, path="/api/v3/traces")]
        )

        with pytest.raises(RuntimeError, match="returned no trace"):
            client.get_trace_by_message_hash("hash-1")


class TestToncenterRequestRetries:
    def test_should_retry_retryable_http_statuses(self, monkeypatch):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_client = _FakeHttpClient(
            [
                _json_response(500, {"error": "boom"}, path="/api/test", text="boom"),
                _json_response(200, {"ok": True}, path="/api/test"),
            ]
        )
        client._client = fake_client
        sleeps: list[float] = []
        monkeypatch.setattr(provider_module.time, "sleep", lambda seconds: sleeps.append(seconds))

        result = client._request("GET", "/api/test")

        assert result == {"ok": True}
        assert len(fake_client.calls) == 2
        assert sleeps == [0.25]

    def test_should_honor_retry_after_header(self, monkeypatch):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_client = _FakeHttpClient(
            [
                _json_response(
                    429,
                    {"error": "busy"},
                    path="/api/test",
                    headers={"Retry-After": "1.5"},
                    text="busy",
                ),
                _json_response(200, {"ok": True}, path="/api/test"),
            ]
        )
        client._client = fake_client
        sleeps: list[float] = []
        monkeypatch.setattr(provider_module.time, "sleep", lambda seconds: sleeps.append(seconds))

        result = client._request("GET", "/api/test")

        assert result == {"ok": True}
        assert sleeps == [1.5]

    def test_should_not_retry_non_retryable_http_statuses(self):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_client = _FakeHttpClient(
            [_json_response(400, {"error": "bad"}, path="/api/test", text="bad")]
        )
        client._client = fake_client

        with pytest.raises(httpx.HTTPStatusError):
            client._request("GET", "/api/test")

        assert len(fake_client.calls) == 1

    def test_should_retry_transport_errors_then_raise_last_error(self, monkeypatch):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_client = _FakeHttpClient(
            [
                httpx.RequestError(
                    "boom", request=httpx.Request("GET", "https://toncenter.example/api/test")
                )
            ]
            * 5
        )
        client._client = fake_client
        monkeypatch.setattr(provider_module.time, "sleep", lambda seconds: None)

        with pytest.raises(httpx.RequestError, match="boom"):
            client._request("GET", "/api/test")

        assert len(fake_client.calls) == 5

    def test_should_reject_non_object_json_payloads(self):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [_json_response(200, ["not", "an", "object"], path="/api/test")]
        )

        with pytest.raises(RuntimeError, match="non-object response"):
            client._request("GET", "/api/test")
