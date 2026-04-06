"""Toncenter-backed TVM RPC client."""

from __future__ import annotations

import base64
import logging
import time
from typing import Any

from .codecs.common import address_to_stack_item, normalize_address
from .constants import (
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    TONCENTER_MAINNET_BASE_URL,
    TONCENTER_TESTNET_BASE_URL,
    TVM_MAINNET,
    TVM_TESTNET,
)
from .types import TvmAccountState, TvmJettonWalletData

try:
    import httpx
    from pytoniq_core import Cell
    from pytoniq_core.tlb.account import StateInit
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages and httpx. Install with: pip install x402[tvm,httpx]"
    ) from e

logger = logging.getLogger(__name__)

_MAX_LOGGED_RESPONSE_BODY_LENGTH = 512


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
            return TvmAccountState(
                address=address,
                balance=0,
                is_active=False,
                is_uninitialized=True,
                is_frozen=False,
                state_init=None,
            )

        account = accounts[0]
        status = str(account.get("status") or "")
        state_init = None
        code_boc = account.get("code_boc")
        data_boc = account.get("data_boc")
        if status == "active" and isinstance(code_boc, str) and isinstance(data_boc, str):
            state_init = StateInit(
                code=Cell.one_from_boc(base64.b64decode(code_boc)),
                data=Cell.one_from_boc(base64.b64decode(data_boc)),
            )

        return TvmAccountState(
            address=address,
            balance=int(account.get("balance") or 0),
            is_active=status == "active",
            is_uninitialized=status in {"uninit", "nonexist"},
            is_frozen=status == "frozen",
            state_init=state_init,
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def get_jetton_wallet(self, asset: str, owner: str) -> str:
        result = self.run_get_method(asset, "get_wallet_address", [address_to_stack_item(owner)])
        return self._parse_stack_address(result[0])

    def get_jetton_wallet_data(self, address: str) -> TvmJettonWalletData:
        result = self.run_get_method(address, "get_wallet_data", [])
        if len(result) < 3:
            raise RuntimeError("Toncenter get_wallet_data returned an incomplete stack")

        return TvmJettonWalletData(
            address=normalize_address(address),
            balance=self._parse_stack_num(result[0]),
            owner=self._parse_stack_address(result[1]),
            jetton_minter=self._parse_stack_address(result[2]),
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

    def _parse_stack_address(self, item: dict[str, object]) -> str:
        cell = self._parse_stack_cell(item)
        address = cell.begin_parse().load_address()
        return normalize_address(address)

    def _parse_stack_cell(self, item: dict[str, object]) -> Cell:
        value = item.get("value")
        if not value:
            raise RuntimeError(f"Can't parse cell stack value")
        return Cell.one_from_boc(base64.b64decode(value))

    def _parse_stack_num(self, item: dict[str, object]) -> int:
        value = item.get("value")
        return int(value, 0)

    def _request(self, method: str, path: str, **kwargs: object) -> dict[str, Any]:
        attempts = 5
        backoff_seconds = 0.25
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                response = self._client.request(method, path, **kwargs)
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise RuntimeError(f"Toncenter returned a non-object response for {path}")
                return data
            except httpx.HTTPStatusError as exc:
                last_error = exc
                retryable = exc.response.status_code in {429, 500, 502, 503, 504}
                logger.warning(
                    "Toncenter request failed: method=%s path=%s url=%s status=%s "
                    "attempt=%s/%s retryable=%s body=%r",
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
                        "Toncenter request backing off per Retry-After: method=%s path=%s "
                        "retry_after=%s attempt=%s/%s",
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
                    "Toncenter request transport error: method=%s path=%s attempt=%s/%s error=%r",
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
        raise RuntimeError(f"Toncenter request for {path} failed without an exception")


def _default_base_url(network: str) -> str:
    if network == TVM_MAINNET:
        return TONCENTER_MAINNET_BASE_URL
    if network == TVM_TESTNET:
        return TONCENTER_TESTNET_BASE_URL
    raise ValueError(f"Unsupported TVM network: {network}")


def _truncate_response_body(body: str) -> str:
    if len(body) <= _MAX_LOGGED_RESPONSE_BODY_LENGTH:
        return body
    return body[:_MAX_LOGGED_RESPONSE_BODY_LENGTH] + "...<truncated>"
