"""TVM RPC provider clients."""

from __future__ import annotations

import base64
import binascii
import logging
import re
import time
from typing import Any, Protocol, cast
from urllib.parse import quote

from .codecs.common import address_to_stack_item, normalize_address
from .constants import (
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    JETTON_TRANSFER_OPCODE,
    SUPPORTED_TVM_PROVIDERS,
    TONAPI_MAINNET_BASE_URL,
    TONAPI_TESTNET_BASE_URL,
    TONCENTER_MAINNET_BASE_URL,
    TONCENTER_TESTNET_BASE_URL,
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_PROVIDER_TONCENTER,
    TVM_TESTNET,
    W5_EXTERNAL_SIGNED_OPCODE,
    W5_INTERNAL_SIGNED_OPCODE,
)
from .types import TvmAccountState, TvmJettonWalletData

try:
    import httpx
    from pytoniq_core import Address, Builder, Cell
    from pytoniq_core.tlb.account import StateInit
    from pytoniq_core.tlb.transaction import MessageAny
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages and httpx. Install with: pip install x402[tvm,httpx]"
    ) from e

logger = logging.getLogger(__name__)

_MAX_LOGGED_RESPONSE_BODY_LENGTH = 512
_JETTON_INTERNAL_TRANSFER_OPCODE = 0x178D4519
_OPCODE_NAMES = {
    JETTON_TRANSFER_OPCODE: "jetton_transfer",
    _JETTON_INTERNAL_TRANSFER_OPCODE: "jetton_internal_transfer",
    W5_INTERNAL_SIGNED_OPCODE: "w5_internal_signed_request",
    W5_EXTERNAL_SIGNED_OPCODE: "w5_external_signed_request",
}


class TvmProviderClient(Protocol):
    """Provider operations used by the TVM mechanism."""

    def get_account_state(self, address: str) -> TvmAccountState:
        """Get account state for a raw or user-friendly address."""
        ...

    def close(self) -> None:
        """Close provider-owned resources."""
        ...

    def get_jetton_wallet(self, asset: str, owner: str) -> str:
        """Resolve an owner's canonical jetton wallet."""
        ...

    def get_jetton_wallet_data(self, address: str) -> TvmJettonWalletData:
        """Read TEP-74 get_wallet_data."""
        ...

    def send_message(self, boc: bytes) -> str:
        """Broadcast a BOC and return the normalized external message hash."""
        ...

    def emulate_trace(
        self,
        boc: bytes,
        *,
        ignore_chksig: bool = False,
        timeout: float = DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        """Emulate a BOC and return a Toncenter-shaped trace."""
        ...

    def get_trace_by_message_hash(self, message_hash: str) -> dict[str, Any]:
        """Fetch a complete trace by normalized external message hash."""
        ...

    def run_get_method(
        self,
        address: str,
        method: str,
        stack: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        """Run a get-method and return a Toncenter-shaped stack."""
        ...


def create_tvm_provider_client(
    network: str,
    *,
    provider: str = TVM_PROVIDER_TONCENTER,
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: float = DEFAULT_TONCENTER_TIMEOUT_SECONDS,
) -> TvmProviderClient:
    """Create the configured TVM provider client."""
    normalized_provider = provider.strip().lower()
    if normalized_provider not in SUPPORTED_TVM_PROVIDERS:
        raise ValueError(f"Unsupported TVM provider: {normalized_provider}")
    if normalized_provider == TVM_PROVIDER_TONAPI:
        return TonapiRestClient(
            network,
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
        )
    return ToncenterRestClient(
        network,
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
    )


class ToncenterRestClient:
    """Minimal Toncenter v3 client used by the TVM mechanism."""

    def __init__(
        self,
        network: str,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    ) -> None:
        root_url = (base_url or _default_base_url(network)).rstrip("/")
        headers = {"Accept": "application/json"}
        if api_key:
            headers["X-Api-Key"] = api_key

        self._client = httpx.Client(base_url=root_url, headers=headers, timeout=timeout)

    def get_account_state(self, address: str) -> TvmAccountState:
        address = normalize_address(address)
        response = self._request(
            "GET",
            "/api/v3/accountStates",
            params={"address": [address], "include_boc": "true"},
        )
        accounts = response.get("accounts") or []
        if not accounts:
            return _synthetic_uninitialized_account(address)

        return _account_state_from_payload(
            address, accounts[0], code_key="code_boc", data_key="data_boc"
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def get_jetton_wallet(self, asset: str, owner: str) -> str:
        result = self.run_get_method(
            asset,
            "get_wallet_address",
            [cast(dict[str, object], address_to_stack_item(owner))],
        )
        return _parse_stack_address(result[0])

    def get_jetton_wallet_data(self, address: str) -> TvmJettonWalletData:
        result = self.run_get_method(address, "get_wallet_data", [])
        if len(result) < 3:
            raise RuntimeError("Toncenter get_wallet_data returned an incomplete stack")

        return TvmJettonWalletData(
            address=normalize_address(address),
            balance=_parse_stack_num(result[0]),
            owner=_parse_stack_address(result[1]),
            jetton_minter=_parse_stack_address(result[2]),
        )

    def send_message(self, boc: bytes) -> str:
        response = self._request(
            "POST",
            "/api/v3/message",
            json={"boc": base64.b64encode(boc).decode("utf-8")},
        )
        return str(response.get("message_hash_norm") or response["message_hash"])

    def emulate_trace(
        self,
        boc: bytes,
        *,
        ignore_chksig: bool = False,
        timeout: float = DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        response = self._request(
            "POST",
            "/api/emulate/v1/emulateTrace",
            json={
                "boc": base64.b64encode(boc).decode("utf-8"),
                "ignore_chksig": ignore_chksig,
                "with_actions": True,
            },
            timeout=timeout,
        )
        if not isinstance(response, dict):
            raise RuntimeError("Toncenter returned an invalid emulateTrace response")
        return response

    def get_trace_by_message_hash(self, message_hash: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            "/api/v3/traces",
            params={
                "msg_hash": [message_hash],
                "limit": 1,
                "sort": "desc",
            },
        )
        traces = response.get("traces")
        if not isinstance(traces, list):
            raise RuntimeError("Toncenter returned an invalid traces response")
        for trace in traces:
            if isinstance(trace, dict):
                return trace
        raise RuntimeError(f"Toncenter returned no trace for message hash {message_hash}")

    def run_get_method(
        self,
        address: str,
        method: str,
        stack: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        response = self._request(
            "POST",
            "/api/v3/runGetMethod",
            json={
                "address": normalize_address(address),
                "method": method,
                "stack": stack,
            },
        )
        if int(response.get("exit_code", 0)) != 0:
            raise RuntimeError(
                f"Toncenter get-method {method} failed with exit code {response['exit_code']}"
            )

        result = response.get("stack")
        if not isinstance(result, list):
            raise RuntimeError(f"Toncenter returned an invalid stack for get-method {method}")
        return [item for item in result if isinstance(item, dict)]

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        return _request_json(self._client, "Toncenter", method, path, **kwargs)


class TonapiRestClient:
    """Minimal TonAPI v2 client adapted to the TVM mechanism's provider contract."""

    def __init__(
        self,
        network: str,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    ) -> None:
        root_url = (base_url or _default_base_url(network, TVM_PROVIDER_TONAPI)).rstrip("/")
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        self._client = httpx.Client(base_url=root_url, headers=headers, timeout=timeout)

    def get_account_state(self, address: str) -> TvmAccountState:
        address = normalize_address(address)
        try:
            account = self._request("GET", f"/v2/blockchain/accounts/{address}")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise
            return _synthetic_uninitialized_account(address)

        return _account_state_from_payload(address, account, code_key="code", data_key="data")

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def get_jetton_wallet(self, asset: str, owner: str) -> str:
        result = self.run_get_method(
            asset,
            "get_wallet_address",
            [cast(dict[str, object], address_to_stack_item(owner))],
        )
        return _parse_stack_address(result[0])

    def get_jetton_wallet_data(self, address: str) -> TvmJettonWalletData:
        result = self.run_get_method(address, "get_wallet_data", [])
        if len(result) < 3:
            raise RuntimeError("TonAPI get_wallet_data returned an incomplete stack")

        return TvmJettonWalletData(
            address=normalize_address(address),
            balance=_parse_stack_num(result[0]),
            owner=_parse_stack_address(result[1]),
            jetton_minter=_parse_stack_address(result[2]),
        )

    def send_message(self, boc: bytes) -> str:
        self._request(
            "POST",
            "/v2/blockchain/message",
            json={"boc": base64.b64encode(boc).decode("utf-8")},
        )
        return _normalized_external_message_hash_hex(boc)

    def emulate_trace(
        self,
        boc: bytes,
        *,
        ignore_chksig: bool = False,
        timeout: float = DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        response = self._request(
            "POST",
            "/v2/traces/emulate",
            params={"ignore_signature_check": ignore_chksig},
            json={"boc": base64.b64encode(boc).decode("utf-8")},
            timeout=timeout,
        )
        return _tonapi_trace_to_toncenter(response)

    def get_trace_by_message_hash(self, message_hash: str) -> dict[str, Any]:
        trace_id = quote(message_hash, safe="")
        return _tonapi_trace_to_toncenter(self._request("GET", f"/v2/traces/{trace_id}"))

    def run_get_method(
        self,
        address: str,
        method: str,
        stack: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        response = self._request(
            "POST",
            f"/v2/blockchain/accounts/{normalize_address(address)}/methods/{quote(method, safe='')}",
            json={"args": [_tonapi_get_method_arg(item) for item in stack]},
        )
        if response.get("success") is False or int(response.get("exit_code", 0)) != 0:
            raise RuntimeError(
                f"TonAPI get-method {method} failed with exit code {response['exit_code']}"
            )

        result = response.get("stack")
        if not isinstance(result, list):
            raise RuntimeError(f"TonAPI returned an invalid stack for get-method {method}")
        return [
            _tonapi_stack_record_to_toncenter(item) for item in result if isinstance(item, dict)
        ]

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        return _request_json(
            self._client,
            "TonAPI",
            method,
            path,
            allow_empty_response=True,
            **kwargs,
        )


def _default_base_url(network: str, provider: str = TVM_PROVIDER_TONCENTER) -> str:
    normalized_provider = provider.strip().lower()
    if normalized_provider == TVM_PROVIDER_TONCENTER:
        if network == TVM_MAINNET:
            return TONCENTER_MAINNET_BASE_URL
        if network == TVM_TESTNET:
            return TONCENTER_TESTNET_BASE_URL
        raise ValueError(f"Unsupported TVM network: {network}")
    if normalized_provider == TVM_PROVIDER_TONAPI:
        if network == TVM_MAINNET:
            return TONAPI_MAINNET_BASE_URL
        if network == TVM_TESTNET:
            return TONAPI_TESTNET_BASE_URL
        raise ValueError(f"Unsupported TVM network: {network}")
    raise ValueError(f"Unsupported TVM provider: {provider}")


def _account_state_from_payload(
    address: str,
    account: dict[str, Any],
    *,
    code_key: str,
    data_key: str,
) -> TvmAccountState:
    status = str(account.get("status") or "")
    state_init = None
    code_boc = account.get(code_key)
    data_boc = account.get(data_key)
    if status == "active" and isinstance(code_boc, str) and isinstance(data_boc, str):
        state_init = StateInit(
            code=Cell.one_from_boc(_decode_boc_text(code_boc)),
            data=Cell.one_from_boc(_decode_boc_text(data_boc)),
        )

    return TvmAccountState(
        address=address,
        balance=int(account.get("balance") or 0),
        is_active=status == "active",
        is_uninitialized=status in {"uninit", "nonexist"},
        is_frozen=status == "frozen",
        state_init=state_init,
    )


def _synthetic_uninitialized_account(address: str) -> TvmAccountState:
    return TvmAccountState(
        address=address,
        balance=0,
        is_active=False,
        is_uninitialized=True,
        is_frozen=False,
        state_init=None,
    )


def _parse_stack_address(item: dict[str, object]) -> str:
    cell = _parse_stack_cell(item)
    address = cell.begin_parse().load_address()
    return normalize_address(address)


def _parse_stack_cell(item: dict[str, object]) -> Cell:
    value = item.get("value")
    if not value:
        raise RuntimeError("Can't parse cell stack value")
    return Cell.one_from_boc(base64.b64decode(str(value)))


def _parse_stack_num(item: dict[str, object]) -> int:
    return int(str(item.get("value")), 0)


def _request_json(
    client: httpx.Client,
    provider_label: str,
    method: str,
    path: str,
    *,
    allow_empty_response: bool = False,
    **kwargs: Any,
) -> dict[str, Any]:
    attempts = 5
    backoff_seconds = 0.25
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            response = client.request(method, path, **kwargs)
            _log_provider_response(
                provider_label,
                method,
                path,
                response,
                attempt=attempt + 1,
                attempts=attempts,
            )
            response.raise_for_status()
            if allow_empty_response and not response.content:
                return {}
            data = response.json()
            if not isinstance(data, dict):
                raise RuntimeError(f"{provider_label} returned a non-object response for {path}")
            return data
        except httpx.HTTPStatusError as exc:
            last_error = exc
            retryable = exc.response.status_code in {429, 500, 502, 503, 504}
            logger.warning(
                "%s request failed: method=%s path=%s url=%s status=%s "
                "attempt=%s/%s retryable=%s body=%r",
                provider_label,
                method,
                path,
                str(exc.request.url),
                exc.response.status_code,
                attempt + 1,
                attempts,
                retryable,
                _truncate_response_body(exc.response.text),
            )
            if not retryable or attempt == attempts - 1:
                raise
            retry_after = exc.response.headers.get("Retry-After")
            if retry_after:
                logger.info(
                    "%s request backing off per Retry-After: method=%s path=%s "
                    "retry_after=%s attempt=%s/%s",
                    provider_label,
                    method,
                    path,
                    retry_after,
                    attempt + 1,
                    attempts,
                )
                try:
                    time.sleep(float(retry_after))
                    continue
                except ValueError:
                    pass
        except httpx.RequestError as exc:
            last_error = exc
            logger.warning(
                "%s request transport error: method=%s path=%s attempt=%s/%s error=%r",
                provider_label,
                method,
                path,
                attempt + 1,
                attempts,
                exc,
            )
            if attempt == attempts - 1:
                raise
        time.sleep(backoff_seconds * (attempt + 1))

    if last_error is not None:
        raise last_error
    raise RuntimeError(f"{provider_label} request for {path} failed without an exception")


def _tonapi_get_method_arg(item: dict[str, object]) -> dict[str, str]:
    item_type = str(item.get("type") or "")
    value = item.get("value")
    if value is None:
        raise RuntimeError(f"TonAPI get-method stack item is missing value: {item!r}")

    if item_type == "slice":
        if isinstance(value, str):
            try:
                cell = Cell.one_from_boc(base64.b64decode(value, validate=True))
                address = cell.begin_parse().load_address()
                if address is not None:
                    return {"type": "slice", "value": normalize_address(address)}
            except Exception:
                pass
            return {"type": "slice_boc_hex", "value": _decode_boc_text(value).hex()}
    if item_type == "cell":
        return {"type": "cell_boc_base64", "value": str(value)}
    if item_type in {"num", "int"}:
        return {"type": "int257", "value": str(value)}
    if item_type in {"nan", "null", "tinyint", "int257", "cell_boc_base64", "slice_boc_hex"}:
        return {"type": item_type, "value": str(value)}
    raise RuntimeError(f"Unsupported TonAPI get-method stack item type: {item_type}")


def _tonapi_stack_record_to_toncenter(record: dict[str, object]) -> dict[str, object]:
    record_type = str(record.get("type") or "")
    tuple_value = record.get("tuple")
    if record_type == "num":
        return {"type": "num", "value": str(record.get("num") or "0")}
    if record_type == "cell" and record.get("cell") is not None:
        return {"type": "cell", "value": _cell_boc_to_base64(record["cell"])}
    if record_type == "tuple" and isinstance(tuple_value, list):
        return {
            "type": "tuple",
            "value": [
                _tonapi_stack_record_to_toncenter(item)
                for item in tuple_value
                if isinstance(item, dict)
            ],
        }
    if record_type == "null":
        return {"type": "null", "value": None}
    if record_type == "nan":
        return {"type": "nan", "value": "NaN"}
    if record_type == "slice" and record.get("slice") is not None:
        value = record["slice"]
        if isinstance(value, str):
            try:
                normalized_address = normalize_address(value)
                cell = Builder().store_address(Address(normalized_address)).end_cell()
                return {
                    "type": "slice",
                    "value": base64.b64encode(cell.to_boc()).decode("utf-8"),
                }
            except Exception:
                pass
        return {"type": "slice", "value": _cell_boc_to_base64(value)}
    raise RuntimeError(f"TonAPI returned an unsupported stack record: {record!r}")


def _tonapi_trace_to_toncenter(trace: dict[str, Any]) -> dict[str, Any]:
    transactions: dict[str, dict[str, object]] = {}

    def walk(node: dict[str, Any]) -> dict[str, object] | None:
        transaction = node.get("transaction")
        converted: dict[str, object] | None = None
        if isinstance(transaction, dict):
            converted = _tonapi_transaction_to_toncenter(transaction)
            transaction_hash = str(converted.get("hash") or len(transactions))
            transactions[transaction_hash] = converted
        children = node.get("children") or []
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    child_transaction = walk(child)
                    if converted is not None and child_transaction is not None:
                        _append_child_in_msg_as_parent_out_msg(converted, child_transaction)
        return converted

    walk(trace)
    return {
        "transactions": transactions,
        "is_incomplete": False,
    }


def _append_child_in_msg_as_parent_out_msg(
    parent_transaction: dict[str, object],
    child_transaction: dict[str, object],
) -> None:
    """TonAPI trace trees may omit parent out_msgs; recover them from child in_msg."""
    child_in_msg = child_transaction.get("in_msg")
    if not isinstance(child_in_msg, dict) or not child_in_msg:
        return

    out_msgs = parent_transaction.get("out_msgs")
    if not isinstance(out_msgs, list):
        out_msgs = []
        parent_transaction["out_msgs"] = out_msgs

    child_hash = child_in_msg.get("hash")
    if child_hash and any(
        isinstance(message, dict) and message.get("hash") == child_hash for message in out_msgs
    ):
        return

    out_msgs.append(dict(child_in_msg))


def _tonapi_transaction_to_toncenter(transaction: dict[str, Any]) -> dict[str, object]:
    converted: dict[str, object] = {
        "account": _tonapi_account_address(transaction.get("account")),
        "hash": str(transaction.get("hash") or ""),
        "hash_norm": str(transaction.get("hash") or ""),
        "description": {
            "aborted": transaction.get("aborted"),
            "compute_ph": _tonapi_compute_phase(transaction.get("compute_phase")),
            "action": _tonapi_action_phase(transaction.get("action_phase")),
            "storage_ph": _tonapi_storage_phase(transaction.get("storage_phase")),
        },
        "in_msg": _tonapi_message_to_toncenter(transaction.get("in_msg")),
        "out_msgs": [
            _tonapi_message_to_toncenter(message)
            for message in transaction.get("out_msgs") or []
            if isinstance(message, dict)
        ],
    }
    return converted


def _tonapi_compute_phase(phase: object) -> dict[str, object]:
    if not isinstance(phase, dict):
        return {"skipped": True, "success": False}
    return {
        "skipped": phase.get("skipped"),
        "success": phase.get("success"),
        "gas_fees": phase.get("gas_fees"),
    }


def _tonapi_action_phase(phase: object) -> dict[str, object] | None:
    if not isinstance(phase, dict):
        return None
    return {
        "success": phase.get("success"),
        "total_fwd_fees": phase.get("fwd_fees"),
        "fwd_fee": phase.get("fwd_fees"),
        "total_fees": phase.get("total_fees"),
    }


def _tonapi_storage_phase(phase: object) -> dict[str, object]:
    if not isinstance(phase, dict):
        return {}
    return {
        "storage_fees_collected": phase.get("fees_collected"),
        "storage_fees_due": phase.get("fees_due"),
    }


def _tonapi_message_to_toncenter(message: object) -> dict[str, object]:
    if not isinstance(message, dict):
        return {}
    converted: dict[str, object] = {
        "hash": str(message.get("hash") or ""),
        "hash_norm": str(message.get("hash") or ""),
        "source": _tonapi_account_address(message.get("source")),
        "destination": _tonapi_account_address(message.get("destination")),
        "decoded_opcode": _normalize_decoded_opcode(message),
        "fwd_fee": message.get("fwd_fee"),
        "value": message.get("value"),
    }
    message_content: dict[str, object] = {}
    raw_body = message.get("raw_body")
    if isinstance(raw_body, str) and raw_body:
        try:
            message_content["hash"] = base64.b64encode(
                Cell.one_from_boc(_decode_boc_text(raw_body)).hash
            ).decode("ascii")
        except Exception:
            pass
    decoded_body = message.get("decoded_body")
    if decoded_body is not None:
        message_content["decoded"] = decoded_body
    if message_content:
        converted["message_content"] = message_content
    return converted


def _tonapi_account_address(value: object) -> str:
    if isinstance(value, dict):
        address = value.get("address")
        return normalize_address(address) if isinstance(address, str) and address else ""
    if isinstance(value, str) and value:
        return normalize_address(value)
    return ""


def _normalize_decoded_opcode(message: dict[str, object]) -> str:
    opcode_name = message.get("decoded_op_name")
    if isinstance(opcode_name, str) and opcode_name:
        normalized = re.sub(r"(?<!^)(?=[A-Z])", "_", opcode_name).lower()
        return normalized.replace("__", "_")

    opcode = message.get("op_code")
    opcode_int: int | None = None
    if isinstance(opcode, int):
        opcode_int = opcode
    elif isinstance(opcode, str):
        try:
            opcode_int = int(opcode, 0)
        except ValueError:
            opcode_int = None
    if opcode_int is not None:
        return _OPCODE_NAMES.get(opcode_int, hex(opcode_int))
    return ""


def _cell_boc_to_base64(value: object) -> str:
    return base64.b64encode(_decode_boc_text(str(value))).decode("utf-8")


def _decode_boc_text(value: str) -> bytes:
    normalized = value.strip()
    if not normalized:
        raise ValueError("BOC value is empty")
    if len(normalized) % 2 == 0 and re.fullmatch(r"[0-9a-fA-F]+", normalized):
        return bytes.fromhex(normalized)
    try:
        return base64.b64decode(normalized, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("BOC value must be hex or base64") from exc


def _normalized_external_message_hash_hex(boc: bytes) -> str:
    message = MessageAny.deserialize(Cell.one_from_boc(boc).begin_parse())
    if not message.is_external:
        return str(message.body.hash.hex())
    return str(
        Builder()
        .store_uint(2, 2)
        .store_address(None)
        .store_address(message.info.dest)
        .store_coins(0)
        .store_bit(False)
        .store_bit(True)
        .store_ref(message.body)
        .end_cell()
        .hash.hex()
    )


def _truncate_response_body(body: str) -> str:
    if len(body) <= _MAX_LOGGED_RESPONSE_BODY_LENGTH:
        return body
    return body[:_MAX_LOGGED_RESPONSE_BODY_LENGTH] + "...<truncated>"


def _log_provider_response(
    provider_label: str,
    method: str,
    path: str,
    response: httpx.Response,
    *,
    attempt: int,
    attempts: int,
) -> None:
    if not logger.isEnabledFor(logging.DEBUG):
        return
    logger.debug(
        "%s response: method=%s path=%s url=%s status=%s attempt=%s/%s body=%r",
        provider_label,
        method,
        path,
        str(response.request.url),
        response.status_code,
        attempt,
        attempts,
        _truncate_response_body(response.text),
    )
