"""A minimal synchronous JSON-RPC client for the SVM mechanism.

Only the handful of methods the exact scheme needs are implemented, and each one
parses the raw response with the matching ``solders.rpc.responses`` type, so
callers get the same objects the equivalent typed RPC client would return.
"""

from __future__ import annotations

import base64
from typing import Any, TypeVar, cast

try:
    import httpx
    from solders.pubkey import Pubkey
    from solders.rpc.responses import (
        GetAccountInfoResp,
        GetLatestBlockhashResp,
        GetSignatureStatusesResp,
        SendTransactionResp,
        SimulateTransactionResp,
    )
    from solders.signature import Signature
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

PROCESSED = "processed"
CONFIRMED = "confirmed"
FINALIZED = "finalized"

DEFAULT_TIMEOUT_SECONDS = 30.0

# Every solders response type models `from_json` as possibly returning one of the
# JSON-RPC error variants. _call has already raised on any response carrying an
# `error` member, so what reaches these parsers is always a success envelope.
_Resp = TypeVar("_Resp")


class SvmRpcError(Exception):
    """An error the JSON-RPC server returned in the ``error`` member."""

    def __init__(self, method: str, error: dict[str, Any]):
        """Create the error.

        Args:
            method: The JSON-RPC method that failed.
            error: The ``error`` member of the response.
        """
        super().__init__(f"{method} failed: {error.get('message', error)}")
        self.error = error


class SvmRpcClient:
    """A Solana JSON-RPC client over a single reused HTTP connection.

    Attributes:
        url: The endpoint every request is sent to.
    """

    def __init__(
        self,
        url: str,
        commitment: str = FINALIZED,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        """Create SvmRpcClient.

        Args:
            url: RPC endpoint URL.
            commitment: Commitment used by requests that do not name their own.
            timeout: Per-request timeout in seconds.
        """
        self.url = url
        self._commitment = commitment
        self._http = httpx.Client(timeout=timeout)
        self._next_id = 0

    def close(self) -> None:
        """Close the underlying HTTP connection."""
        self._http.close()

    def _parse(self, resp_type: type[_Resp], body: str) -> _Resp:
        """Parse a success envelope with the solders type for its method.

        Args:
            resp_type: The solders response type to parse into.
            body: The raw JSON response body.

        Returns:
            The parsed response.
        """
        return cast(_Resp, resp_type.from_json(body))  # type: ignore[attr-defined]

    def _call(self, method: str, params: list[Any]) -> str:
        """Send one request and return the raw response body.

        The body is handed back undecoded because each caller parses it with the
        solders response type for its method, which validates the envelope.

        Args:
            method: JSON-RPC method name.
            params: Positional parameters for the method.

        Returns:
            The raw JSON response body.

        Raises:
            SvmRpcError: The server answered with an ``error`` member.
        """
        self._next_id += 1
        response = self._http.post(
            self.url,
            json={
                "jsonrpc": "2.0",
                "id": self._next_id,
                "method": method,
                "params": params,
            },
        )
        response.raise_for_status()
        payload = response.json()
        if "error" in payload:
            raise SvmRpcError(method, payload["error"])
        return response.text

    def get_latest_blockhash(self, commitment: str | None = None) -> GetLatestBlockhashResp:
        """Fetch a recent blockhash and the last block height it is valid for.

        Args:
            commitment: Commitment to query at, defaulting to the client's.

        Returns:
            The getLatestBlockhash response.
        """
        body = self._call("getLatestBlockhash", [{"commitment": commitment or self._commitment}])
        return self._parse(GetLatestBlockhashResp, body)

    def get_account_info(self, pubkey: Pubkey, commitment: str | None = None) -> GetAccountInfoResp:
        """Fetch an account's owner and data.

        Args:
            pubkey: Account to query.
            commitment: Commitment to query at, defaulting to the client's.

        Returns:
            The getAccountInfo response.
        """
        body = self._call(
            "getAccountInfo",
            [
                str(pubkey),
                {"commitment": commitment or self._commitment, "encoding": "base64"},
            ],
        )
        return self._parse(GetAccountInfoResp, body)

    def simulate_transaction(
        self,
        tx: VersionedTransaction,
        sig_verify: bool = False,
        commitment: str | None = None,
    ) -> SimulateTransactionResp:
        """Simulate a transaction without broadcasting it.

        Args:
            tx: The transaction to simulate.
            sig_verify: Whether the server must verify the signatures.
            commitment: Commitment to simulate against, defaulting to the client's.

        Returns:
            The simulateTransaction response.
        """
        body = self._call(
            "simulateTransaction",
            [
                base64.b64encode(bytes(tx)).decode(),
                {
                    "encoding": "base64",
                    "sigVerify": sig_verify,
                    "commitment": commitment or self._commitment,
                },
            ],
        )
        return self._parse(SimulateTransactionResp, body)

    def send_raw_transaction(
        self,
        tx_bytes: bytes,
        skip_preflight: bool = False,
        preflight_commitment: str | None = None,
    ) -> SendTransactionResp:
        """Broadcast an already-serialized, fully-signed transaction.

        Args:
            tx_bytes: The transaction exactly as it goes on the wire.
            skip_preflight: Whether to skip the preflight simulation.
            preflight_commitment: Commitment for preflight, defaulting to the client's.

        Returns:
            The sendTransaction response carrying the signature.
        """
        body = self._call(
            "sendTransaction",
            [
                base64.b64encode(tx_bytes).decode(),
                {
                    "encoding": "base64",
                    "skipPreflight": skip_preflight,
                    "preflightCommitment": preflight_commitment or self._commitment,
                },
            ],
        )
        return self._parse(SendTransactionResp, body)

    def get_signature_statuses(
        self, signatures: list[Signature], search_transaction_history: bool = False
    ) -> GetSignatureStatusesResp:
        """Fetch the confirmation status of each given signature.

        Args:
            signatures: Signatures to look up.
            search_transaction_history: Whether to search beyond the recent status cache.

        Returns:
            The getSignatureStatuses response.
        """
        body = self._call(
            "getSignatureStatuses",
            [
                [str(sig) for sig in signatures],
                {"searchTransactionHistory": search_transaction_history},
            ],
        )
        return self._parse(GetSignatureStatusesResp, body)
