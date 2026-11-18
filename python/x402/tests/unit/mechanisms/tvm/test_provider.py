"""Focused tests for the Toncenter TVM provider client."""

from __future__ import annotations

import base64
import json
import logging

import httpx
import pytest

pytest.importorskip("pytoniq_core")

from pytoniq.contract.contract import Contract
from pytoniq_core import Address, begin_cell

import x402.mechanisms.tvm.provider as provider_module
from x402.mechanisms.tvm import (
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    TONAPI_MAINNET_BASE_URL,
    TONAPI_TESTNET_BASE_URL,
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
)
from x402.mechanisms.tvm.provider import (
    TonapiRestClient,
    ToncenterRestClient,
    _default_base_url,
    create_tvm_provider_client,
)


def _cell_b64(value: int) -> str:
    return base64.b64encode(begin_cell().store_uint(value, 8).end_cell().to_boc()).decode("ascii")


def _cell_hex(value: int) -> str:
    return begin_cell().store_uint(value, 8).end_cell().to_boc().hex()


def _address_cell_b64(address: str) -> str:
    return base64.b64encode(
        begin_cell().store_address(Address(address)).end_cell().to_boc()
    ).decode("ascii")


def _address_cell_hex(address: str) -> str:
    return begin_cell().store_address(Address(address)).end_cell().to_boc().hex()


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
        assert _default_base_url(TVM_MAINNET, TVM_PROVIDER_TONAPI) == TONAPI_MAINNET_BASE_URL
        assert _default_base_url(TVM_TESTNET, TVM_PROVIDER_TONAPI) == TONAPI_TESTNET_BASE_URL
        assert _default_base_url(TVM_TESTNET, " TonAPI ") == TONAPI_TESTNET_BASE_URL

    def test_should_reject_unsupported_network(self):
        with pytest.raises(ValueError, match="Unsupported TVM network"):
            _default_base_url("tvm:123")

    def test_should_reject_unsupported_provider(self):
        with pytest.raises(ValueError, match="Unsupported TVM provider"):
            _default_base_url(TVM_TESTNET, "unknown")


class TestProviderFactory:
    def test_should_create_toncenter_client_by_default(self):
        client = create_tvm_provider_client(TVM_TESTNET)

        try:
            assert isinstance(client, ToncenterRestClient)
        finally:
            client.close()

    def test_should_create_tonapi_client_when_selected(self):
        client = create_tvm_provider_client(TVM_TESTNET, provider=" TonAPI ")

        try:
            assert isinstance(client, TonapiRestClient)
        finally:
            client.close()


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
    def test_should_debug_log_successful_provider_responses(self, caplog):
        client = ToncenterRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient([_json_response(200, {"ok": True}, path="/api/test")])

        with caplog.at_level(logging.DEBUG, logger=provider_module.logger.name):
            result = client._request("GET", "/api/test")

        assert result == {"ok": True}
        assert "Toncenter response: method=GET path=/api/test" in caplog.text
        assert "status=200" in caplog.text
        assert """body='{"ok": true}'""" in caplog.text

    def test_should_retry_retryable_http_statuses(self, monkeypatch):
        client = ToncenterRestClient(TVM_TESTNET)
        fake_client = _FakeHttpClient(
            [
                _json_response(500, {"error": "boom"}, path="/api/test"),
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
        fake_client = _FakeHttpClient([_json_response(400, {"error": "bad"}, path="/api/test")])
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


class TestTonapiRestClient:
    def test_should_use_bearer_authentication_header(self):
        client = TonapiRestClient(TVM_TESTNET, api_key="tonapi-key")

        try:
            assert client._client.headers["authorization"] == "Bearer tonapi-key"
        finally:
            client.close()

    def test_get_account_state_should_decode_raw_account_state(self):
        address = "0:" + "1" * 64
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "address": address,
                        "balance": 123,
                        "status": "active",
                        "code": _cell_hex(1),
                        "data": _cell_hex(2),
                        "last_transaction_lt": 1,
                        "storage": {},
                    },
                    path=f"/v2/blockchain/accounts/{address}",
                )
            ]
        )

        account = client.get_account_state(address)

        assert account.address == address
        assert account.balance == 123
        assert account.is_active is True
        assert account.state_init is not None

    def test_get_account_state_should_return_uninitialized_for_404(self):
        address = "0:" + "2" * 64
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [_json_response(404, {"error": "not found"}, path=f"/v2/blockchain/accounts/{address}")]
        )

        account = client.get_account_state(address)

        assert account.address == address
        assert account.is_uninitialized is True
        assert account.balance == 0

    def test_run_get_method_should_convert_arguments_and_stack_records(self):
        asset = "0:" + "3" * 64
        owner = "0:" + "4" * 64
        wallet = "0:" + "5" * 64
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "success": True,
                        "exit_code": 0,
                        "stack": [
                            {
                                "type": "cell",
                                "cell": _address_cell_hex(wallet),
                            }
                        ],
                    },
                    path=f"/v2/blockchain/accounts/{asset}/methods/get_wallet_address",
                )
            ]
        )

        resolved_wallet = client.get_jetton_wallet(asset, owner)

        assert resolved_wallet == wallet
        method, path, kwargs = client._client.calls[0]
        assert method == "POST"
        assert path == f"/v2/blockchain/accounts/{asset}/methods/get_wallet_address"
        assert kwargs["json"]["args"] == [{"type": "slice", "value": owner}]

    def test_get_jetton_wallet_data_should_parse_tonapi_stack(self):
        owner = "0:" + "2" * 64
        minter = "0:" + "3" * 64
        address = "0:" + "4" * 64
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "success": True,
                        "exit_code": 0,
                        "stack": [
                            {"type": "num", "num": "123"},
                            {"type": "cell", "cell": _address_cell_hex(owner)},
                            {"type": "cell", "cell": _address_cell_hex(minter)},
                        ],
                    },
                    path=f"/v2/blockchain/accounts/{address}/methods/get_wallet_data",
                )
            ]
        )

        data = client.get_jetton_wallet_data(address)

        assert data.balance == 123
        assert data.owner == owner
        assert data.jetton_minter == minter

    def test_send_message_should_return_normalized_external_message_hash(self):
        destination = "0:" + "6" * 64
        body = begin_cell().store_uint(1, 8).end_cell()
        external_message = Contract.create_external_msg(dest=Address(destination), body=body)
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient([_json_response(200, {}, path="/v2/blockchain/message")])

        message_hash = client.send_message(external_message.serialize().to_boc())

        assert len(message_hash) == 64
        assert bytes.fromhex(message_hash)
        method, path, kwargs = client._client.calls[0]
        assert method == "POST"
        assert path == "/v2/blockchain/message"
        assert kwargs["json"]["boc"]

    def test_emulate_trace_should_adapt_tonapi_trace_shape(self):
        account = "0:" + "7" * 64
        raw_body = begin_cell().store_uint(0x0F8A7EA5, 32).end_cell()
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "transaction": {
                            "hash": "a" * 64,
                            "account": {
                                "address": account,
                                "is_scam": False,
                                "is_wallet": True,
                            },
                            "end_balance": 1000,
                            "aborted": False,
                            "compute_phase": {
                                "skipped": False,
                                "success": True,
                                "gas_fees": 100,
                            },
                            "action_phase": {
                                "success": True,
                                "fwd_fees": 20,
                                "total_fees": 30,
                            },
                            "storage_phase": {
                                "fees_collected": 5,
                                "status_change": "unchanged",
                            },
                            "in_msg": {
                                "hash": "b" * 64,
                                "source": {
                                    "address": account,
                                    "is_scam": False,
                                    "is_wallet": True,
                                },
                                "destination": {
                                    "address": account,
                                    "is_scam": False,
                                    "is_wallet": True,
                                },
                                "decoded_op_name": "JettonTransfer",
                                "raw_body": raw_body.to_boc().hex(),
                                "fwd_fee": 10,
                            },
                            "out_msgs": [],
                        },
                        "interfaces": [],
                    },
                    path="/v2/traces/emulate",
                )
            ]
        )

        trace = client.emulate_trace(b"boc-bytes", ignore_chksig=True, timeout=7.5)

        transaction = trace["transactions"]["a" * 64]
        assert transaction["account"] == account
        assert "balance" not in transaction
        assert transaction["description"]["compute_ph"]["gas_fees"] == 100
        assert transaction["description"]["action"]["total_fwd_fees"] == 20
        assert transaction["in_msg"]["decoded_opcode"] == "jetton_transfer"
        assert transaction["in_msg"]["message_content"]["hash"] == base64.b64encode(
            raw_body.hash
        ).decode("ascii")
        method, path, kwargs = client._client.calls[0]
        assert method == "POST"
        assert path == "/v2/traces/emulate"
        assert kwargs["params"] == {"ignore_signature_check": True}
        assert kwargs["timeout"] == 7.5

    def test_emulate_trace_should_recover_parent_out_msgs_from_child_transactions(self):
        parent_account = "0:" + "7" * 64
        child_account = "0:" + "8" * 64
        child_in_body = begin_cell().store_uint(0x0F8A7EA5, 32).end_cell()
        child_message_hash = "c" * 64
        client = TonapiRestClient(TVM_TESTNET)
        client._client = _FakeHttpClient(
            [
                _json_response(
                    200,
                    {
                        "transaction": {
                            "hash": "a" * 64,
                            "account": {"address": parent_account},
                            "aborted": False,
                            "compute_phase": {"skipped": False, "success": True},
                            "action_phase": {"success": True},
                            "storage_phase": {},
                            "in_msg": {"hash": "b" * 64, "destination": parent_account},
                            "out_msgs": [],
                        },
                        "children": [
                            {
                                "transaction": {
                                    "hash": "d" * 64,
                                    "account": {"address": child_account},
                                    "aborted": False,
                                    "compute_phase": {"skipped": False, "success": True},
                                    "action_phase": {"success": True},
                                    "storage_phase": {},
                                    "in_msg": {
                                        "hash": child_message_hash,
                                        "source": {"address": parent_account},
                                        "destination": {"address": child_account},
                                        "decoded_op_name": "JettonTransfer",
                                        "raw_body": child_in_body.to_boc().hex(),
                                    },
                                    "out_msgs": [],
                                },
                                "children": [],
                            }
                        ],
                    },
                    path="/v2/traces/emulate",
                )
            ]
        )

        trace = client.emulate_trace(b"boc-bytes")

        parent = trace["transactions"]["a" * 64]
        child = trace["transactions"]["d" * 64]
        assert parent["out_msgs"] == [child["in_msg"]]
        assert parent["out_msgs"][0]["hash"] == child_message_hash
        assert parent["out_msgs"][0]["destination"] == child_account
        assert parent["out_msgs"][0]["message_content"]["hash"] == base64.b64encode(
            child_in_body.hash
        ).decode("ascii")
