"""Extended EVM batch-settlement integration scenarios.

Mirrors the Go integration suite at
`/go/test/integration/evm_batch_settlement_test.go`, covering the 9 scenarios
beyond the basic deposit+voucher flow:

- HTTPMiddleware                       — full HTTP round-trip via Flask middleware
- MultiVoucherClaimSettle              — manager.claim + manager.settle
- RefundPartial                        — cooperative refund leaves channel open
- RefundDrainedChannelShortCircuit     — second refund fails locally without I/O
- RefundNonRecoverableFastFail         — refund_amount_exceeds_balance fast fail
- AutoClaimTick                        — auto-claim threading
- AutoClaimAndSettleTick               — auto-claim then auto-settle
- WithdrawalPendingRefund              — withdrawal-pending detection + manager.refund
- RefundRecoverableRetryExhaustion     — recoverable 402 → retry budget exhaustion

Each test acquires a fresh per-test channel salt and runs against Base Sepolia
with real USDC transfers. Tests are gated on EVM_CLIENT_PRIVATE_KEY +
EVM_FACILITATOR_PRIVATE_KEY and skip cleanly otherwise.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import threading
import time
from typing import Any
from wsgiref.simple_server import WSGIServer, make_server

import pytest
import requests
from eth_account import Account
from flask import Flask, jsonify, make_response, request
from web3 import Web3

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.http.clients.requests import wrapRequestsWithPayment
from x402.http.middleware.flask import payment_middleware as flask_payment_middleware
from x402.mechanisms.evm.batch_settlement import (
    BATCH_SETTLEMENT_ADDRESS,
    SCHEME_BATCH_SETTLEMENT,
)
from x402.mechanisms.evm.batch_settlement.abi import BATCH_SETTLEMENT_ABI
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementDepositPolicy,
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
    RefundOptions,
    compute_channel_id,
    has_channel,
    process_settle_response,
)
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementClientScheme,
)
from x402.mechanisms.evm.batch_settlement.errors import (
    ERR_REFUND_NO_BALANCE,
)
from x402.mechanisms.evm.batch_settlement.facilitator import (
    BatchSettlementEvmFacilitator,
)
from x402.mechanisms.evm.batch_settlement.server import (
    AutoSettlementConfig,
    BatchSettlementEvmSchemeServerConfig,
    ClaimOptions,
    ClaimResult,
    SettleResult,
)
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmScheme as BatchSettlementServerScheme,
)
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)

# Prefer EVM_CLIENT_EOA_PRIVATE_KEY (a plain EOA, not ERC-7702 delegated) so that
# strict verify_typed_data_strict routing (code-length-based) does not cause the
# facilitator to try EIP-1271 on an address that has been delegated for 7702 tests.
CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_EOA_PRIVATE_KEY") or os.environ.get(
    "EVM_CLIENT_PRIVATE_KEY"
)
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RECEIVER_AUTHORIZER_PRIVATE_KEY = os.environ.get(
    "EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", FACILITATOR_PRIVATE_KEY
)
RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")
NETWORK = "eip155:84532"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY,
    reason=(
        "EVM_CLIENT_EOA_PRIVATE_KEY (or EVM_CLIENT_PRIVATE_KEY) and EVM_FACILITATOR_PRIVATE_KEY "
        "environment variables required for batch-settlement integration tests"
    ),
)


# =============================================================================
# Helpers — shared pipeline + HTTP server lifecycle
# =============================================================================


class _BatchFacilitatorClientSync:
    """Adapts x402FacilitatorSync to the FacilitatorClient surface used by the server."""

    scheme = SCHEME_BATCH_SETTLEMENT
    network = NETWORK
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync):
        self._facilitator = facilitator

    def verify(self, p: PaymentPayload, r: PaymentRequirements) -> VerifyResponse:
        return self._facilitator.verify(p, r)

    def settle(self, p: PaymentPayload, r: PaymentRequirements) -> SettleResponse:
        return self._facilitator.settle(p, r)

    def get_supported(self) -> SupportedResponse:
        return self._facilitator.get_supported()


def _requirements(receiver: str, amount: str, receiver_authorizer: str) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=USDC_ADDRESS,
        amount=amount,
        pay_to=receiver,
        max_timeout_seconds=3600,
        extra={
            "name": "USDC",
            "version": "2",
            "assetTransferMethod": "eip3009",
            "receiverAuthorizer": receiver_authorizer,
        },
    )


def _resource() -> ResourceInfo:
    return ResourceInfo(
        url="https://example.com/api",
        description="Batched integration test resource",
        mime_type="application/json",
    )


def _read_onchain_channel(w3: Web3, channel_id: str) -> tuple[int, int]:
    """Return (balance, totalClaimed) from the on-chain contract."""
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
        abi=BATCH_SETTLEMENT_ABI,
    )
    cid = bytes.fromhex(channel_id.removeprefix("0x"))
    balance, claimed = contract.functions.channels(cid).call()
    return int(balance), int(claimed)


def _wait_for_balance(w3: Web3, channel_id: str, timeout_s: float = 30.0) -> int:
    """Poll until channel balance > 0; return the observed balance."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        balance, _ = _read_onchain_channel(w3, channel_id)
        if balance > 0:
            return balance
        time.sleep(0.25)
    raise AssertionError(f"Timed out waiting for channel {channel_id} balance > 0")


def _wait_for_claimed(w3: Web3, channel_id: str, expected: int, timeout_s: float = 8.0) -> int:
    """Poll until totalClaimed >= expected; return the observed totalClaimed."""
    deadline = time.time() + timeout_s
    last = 0
    while time.time() < deadline:
        _, claimed = _read_onchain_channel(w3, channel_id)
        last = claimed
        if claimed >= expected:
            return claimed
        time.sleep(0.2)
    raise AssertionError(
        f"Timed out waiting for channel {channel_id} totalClaimed >= {expected} (last {last})"
    )


def _wait_for_pending_transactions(address: str, timeout_s: float = 120.0) -> None:
    """Wait until a wallet has no pending transactions (matches Go integration tests)."""
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    checksum = Web3.to_checksum_address(address)
    deadline = time.time() + timeout_s
    confirmed = pending = 0
    while time.time() < deadline:
        confirmed = w3.eth.get_transaction_count(checksum, "latest")
        pending = w3.eth.get_transaction_count(checksum, "pending")
        if pending == confirmed:
            return
        time.sleep(2)
    raise AssertionError(
        f"Timed out waiting for pending transactions to clear for {address} "
        f"(confirmed={confirmed}, pending={pending})"
    )


def _wait_for_balance_eq(w3: Web3, channel_id: str, expected: int, timeout_s: float = 6.0) -> int:
    deadline = time.time() + timeout_s
    last = -1
    while time.time() < deadline:
        balance, _ = _read_onchain_channel(w3, channel_id)
        last = balance
        if balance == expected:
            return balance
        time.sleep(0.2)
    raise AssertionError(f"Channel {channel_id} balance != {expected} (last observed {last})")


class _Pipeline:
    """Wires together client, server, facilitator, signers, and (optionally) HTTP.

    Mirror of Go's `batchedPipeline`. A fresh `_Pipeline` per test guarantees a
    unique channel salt so on-chain state does not leak across tests.
    """

    def __init__(self, deposit_multiplier: int = 5) -> None:
        client_account = Account.from_key(CLIENT_PRIVATE_KEY)
        self.client_signer = EthAccountSigner(client_account)
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )
        self.authorizer_signer = LocalAuthorizerSigner(RECEIVER_AUTHORIZER_PRIVATE_KEY)

        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.address
        self.receiver_authorizer = self.authorizer_signer.address
        self.receiver_address = self.facilitator_address

        self.channel_salt = "0x" + secrets.token_bytes(32).hex()
        self.client_storage = InMemoryClientChannelStorage()

        self.client_scheme = BatchSettlementClientScheme(
            self.client_signer,
            BatchSettlementEvmSchemeOptions(
                storage=self.client_storage,
                salt=self.channel_salt,
                deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=deposit_multiplier),
            ),
        )
        self.x402_client = x402ClientSync().register(NETWORK, self.client_scheme)

        self.x402_facilitator = x402FacilitatorSync().register(
            [NETWORK],
            BatchSettlementEvmFacilitator(self.facilitator_signer, self.authorizer_signer),
        )
        self.facilitator_client = _BatchFacilitatorClientSync(self.x402_facilitator)

        self.server_scheme = BatchSettlementServerScheme(
            self.receiver_address,
            BatchSettlementEvmSchemeServerConfig(
                receiver_authorizer_signer=self.authorizer_signer,
            ),
        )
        self.x402_server = x402ResourceServerSync(self.facilitator_client)
        self.x402_server.register(NETWORK, self.server_scheme)
        self.x402_server.initialize()

        self.w3 = Web3(Web3.HTTPProvider(RPC_URL))

    def requirements(self, amount: str) -> PaymentRequirements:
        return _requirements(self.receiver_address, amount, self.receiver_authorizer)

    def channel_id_for(self, requirements: PaymentRequirements) -> str:
        config = self.client_scheme.build_channel_config(requirements)
        return compute_channel_id(config, str(requirements.network)).lower()

    # ---------- Direct-API helpers (no HTTP) ----------

    def direct_pay(self, amount: str) -> SettleResponse:
        """One direct-API paid request: verify + settle + process_settle_response."""
        accepts = [self.requirements(amount)]
        payment_required = self.x402_server.create_payment_required_response(accepts, _resource())
        payload = self.x402_client.create_payment_payload(payment_required)
        accepted = self.x402_server.find_matching_requirements(accepts, payload)
        assert accepted is not None
        verify = self.x402_server.verify_payment(payload, accepted)
        if not verify.is_valid:
            pytest.fail(f"verify failed: {verify.invalid_reason}")
        settle = self.x402_server.settle_payment(payload, accepted)
        if not settle.success:
            pytest.fail(f"settle failed: {settle.error_reason}: {settle.error_message}")
        process_settle_response(self.client_storage, settle)
        return settle


# =============================================================================
# HTTP server harness (Flask + WSGI in a thread)
# =============================================================================


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _HTTPServerHandle:
    """Wraps a daemon-thread Flask WSGI server for a single test."""

    def __init__(self, server: WSGIServer, thread: threading.Thread, url: str) -> None:
        self._server = server
        self._thread = thread
        self.url = url

    def shutdown(self) -> None:
        try:
            self._server.shutdown()
            self._server.server_close()
        finally:
            self._thread.join(timeout=2.0)


def _start_flask_resource_server(pipe: _Pipeline, route: str, price: str) -> _HTTPServerHandle:
    """Start a Flask app protected by the batch-settlement scheme on a free port."""
    app = Flask(f"x402-batched-test-{secrets.token_hex(4)}")

    @app.get(route)  # type: ignore[misc]
    def _handler() -> Any:
        return jsonify({"status": "ok"})

    routes = {
        f"GET {route}": {
            "accepts": {
                "scheme": SCHEME_BATCH_SETTLEMENT,
                "payTo": pipe.receiver_address,
                "price": price,
                "network": NETWORK,
                "extra": {
                    "name": "USDC",
                    "version": "2",
                    "assetTransferMethod": "eip3009",
                    "receiverAuthorizer": pipe.receiver_authorizer,
                },
            },
        }
    }
    flask_payment_middleware(app, routes, pipe.x402_server, sync_facilitator_on_start=False)

    port = _free_port()
    server = make_server("127.0.0.1", port, app)
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="bs-flask")
    thread.start()
    url = f"http://127.0.0.1:{port}{route}"
    # Quick liveness probe.
    deadline = time.time() + 5.0
    while time.time() < deadline:
        try:
            requests.get(url, timeout=0.5)
            break
        except Exception:
            time.sleep(0.05)
    return _HTTPServerHandle(server, thread, url)


def _make_paid_request(pipe: _Pipeline, url: str) -> requests.Response:
    """Make a single x402-authenticated GET against url and assert 200.

    Retries up to 3 times with backoff to handle transient RPC failures that
    occasionally cause the testnet facilitator to reject a valid deposit.
    """
    last: requests.Response | None = None
    for attempt in range(3):
        session = wrapRequestsWithPayment(requests.Session(), pipe.x402_client)
        last = session.get(url, timeout=90)
        if last.status_code == 200:
            return last
        if attempt < 2:
            time.sleep(3)
    assert last is not None and last.status_code == 200, (
        f"expected 200, got {last.status_code}: {last.text}"
    )
    return last  # unreachable — assertion above always raises


# =============================================================================
# Tests
# =============================================================================


class TestBatchSettlementHTTPMiddleware:
    """Scenario 2 (Go): negotiates a batched payment via HTTP middleware end-to-end."""

    def test_http_middleware_deposit_then_voucher(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/test", "$0.001")
        try:
            # 1st paid request — triggers on-chain deposit.
            resp1 = _make_paid_request(pipe, handle.url)
            payment_response_header = resp1.headers.get("PAYMENT-RESPONSE")
            assert payment_response_header, "expected PAYMENT-RESPONSE header on success"
            # 2nd paid request — should use a voucher (no on-chain tx, still 200).
            resp2 = _make_paid_request(pipe, handle.url)
            assert resp2.status_code == 200
        finally:
            handle.shutdown()


class TestBatchSettlementMultiVoucherClaimSettle:
    """Scenario 3 (Go): deposit + 3 voucher requests, then manager.claim + .settle."""

    def test_multi_voucher_claim_then_settle(self) -> None:
        pipe = _Pipeline()

        # 1st request — deposit + first voucher.
        deposit_settle = pipe.direct_pay("500")
        assert deposit_settle.transaction, "expected deposit tx"
        channel_id = pipe.channel_id_for(pipe.requirements("500"))
        _wait_for_balance(pipe.w3, channel_id)

        # Three more voucher requests (off-chain).
        for _ in range(3):
            pipe.direct_pay("500")

        manager = pipe.server_scheme.create_channel_manager_sync(pipe.facilitator_client, NETWORK)
        claimable = manager.get_claimable_vouchers()
        assert len(claimable) == 1, f"expected 1 claimable entry, got {len(claimable)}"

        results = manager.claim(ClaimOptions(max_claims_per_batch=50))
        assert len(results) == 1 and results[0].transaction, f"expected 1 claim tx, got {results}"

        _wait_for_claimed(pipe.w3, channel_id, expected=2000)  # 4 requests * 500

        settle_result = manager.settle()
        assert settle_result.transaction, "expected settle tx"


class TestBatchSettlementRefundPartial:
    """Scenario 4 (Go): partial refund leaves the channel open with reduced balance."""

    def test_partial_refund_leaves_channel_open(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/refund-partial", "$0.0005")
        try:
            _make_paid_request(pipe, handle.url)
            channel_id = pipe.channel_id_for(pipe.requirements("500"))
            balance_before = _wait_for_balance(pipe.w3, channel_id)

            refund = pipe.client_scheme.refund(handle.url, RefundOptions(amount="1000"))
            assert refund.success, f"refund failed: {refund.error_reason}"
            assert refund.transaction, "expected refund tx"

            _wait_for_balance_eq(pipe.w3, channel_id, balance_before - 1000)

            assert has_channel(pipe.client_storage, channel_id), (
                "expected local session to survive partial refund"
            )
        finally:
            handle.shutdown()


class TestBatchSettlementRefundDrainedShortCircuit:
    """Scenario 5 (Go): a second refund on a drained channel fails locally with
    'no remaining balance' without any HTTP/onchain round-trip."""

    def test_second_refund_on_drained_channel_fast_fails_locally(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/refund-drained", "$0.0005")
        try:
            _make_paid_request(pipe, handle.url)
            full = pipe.client_scheme.refund(handle.url, None)
            assert full.success, f"first refund failed: {full.error_reason}"

            # Tear down the HTTP server — a properly short-circuited refund must NOT
            # need a network round-trip to detect the drained channel.
            url = handle.url
            handle.shutdown()
            handle = None  # type: ignore[assignment]

            with pytest.raises(RuntimeError) as exc:
                pipe.client_scheme.refund(url, None)
            assert "no remaining balance" in str(exc.value), str(exc.value)
        finally:
            if handle is not None:
                handle.shutdown()


class TestBatchSettlementRefundNonRecoverableFastFail:
    """Scenario 6 (Go): refund_amount_exceeds_balance is non-recoverable; client
    must fail fast without retrying."""

    def test_refund_exceeding_balance_fails_fast(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/refund-exceeds", "$0.0005")
        try:
            _make_paid_request(pipe, handle.url)

            start = time.time()
            with pytest.raises(RuntimeError) as exc:
                pipe.client_scheme.refund(handle.url, RefundOptions(amount="999999999"))
            elapsed = time.time() - start

            msg = str(exc.value)
            # Server returns either an error or a non-recoverable settle failure.
            assert (
                "exceeds_balance" in msg.lower()
                or "amount_exceeds" in msg.lower()
                or "refund_amount" in msg.lower()
                or "invalid" in msg.lower()
            ), f"unexpected error: {msg}"
            assert elapsed < 30.0, f"fast-fail expected, took {elapsed:.2f}s"
        finally:
            handle.shutdown()


class TestBatchSettlementAutoClaimTick:
    """Scenario 8 (Go): claim_interval_secs triggers an auto-claim tick that
    invokes on_claim with a real tx hash."""

    def test_auto_claim_tick_emits_claim_result(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/auto-claim", "$0.0003")
        try:
            _make_paid_request(pipe, handle.url)
            for _ in range(2):
                _make_paid_request(pipe, handle.url)

            channel_id = pipe.channel_id_for(pipe.requirements("300"))
            _wait_for_balance(pipe.w3, channel_id)
            _wait_for_pending_transactions(pipe.facilitator_address)

            manager = pipe.server_scheme.create_channel_manager_sync(
                pipe.facilitator_client, NETWORK
            )
            claim_events: list[ClaimResult] = []
            error_events: list[BaseException] = []
            claim_signal = threading.Event()

            def on_claim(r: ClaimResult) -> None:
                claim_events.append(r)
                claim_signal.set()

            def on_error(err: BaseException) -> None:
                error_events.append(err)
                claim_signal.set()

            manager.start(
                AutoSettlementConfig(
                    claim_interval_secs=2,
                    max_claims_per_batch=50,
                    on_claim=on_claim,
                    on_error=on_error,
                )
            )
            try:
                fired = claim_signal.wait(timeout=60.0)
            finally:
                manager.stop(flush=False)

            assert fired, "auto-claim timer never fired"
            assert not error_events, f"auto-claim raised: {error_events}"
            assert claim_events and claim_events[0].transaction, "claim tx missing"

            _wait_for_claimed(pipe.w3, channel_id, expected=900)  # 3 * 300
        finally:
            handle.shutdown()


class TestBatchSettlementAutoClaimAndSettleTick:
    """Scenario 9 (Go): claim then settle on subsequent auto-tick."""

    def test_auto_claim_then_auto_settle(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/auto-settle", "$0.0003")
        try:
            _make_paid_request(pipe, handle.url)
            for _ in range(2):
                _make_paid_request(pipe, handle.url)

            channel_id = pipe.channel_id_for(pipe.requirements("300"))
            _wait_for_balance(pipe.w3, channel_id)
            _wait_for_pending_transactions(pipe.facilitator_address)

            manager = pipe.server_scheme.create_channel_manager_sync(
                pipe.facilitator_client, NETWORK
            )
            claim_events: list[ClaimResult] = []
            settle_events: list[SettleResult] = []
            error_events: list[BaseException] = []
            claim_signal = threading.Event()
            settle_signal = threading.Event()

            def on_claim(r: ClaimResult) -> None:
                claim_events.append(r)
                claim_signal.set()

            def on_settle(r: SettleResult) -> None:
                settle_events.append(r)
                settle_signal.set()

            def on_error(err: BaseException) -> None:
                error_events.append(err)
                claim_signal.set()
                settle_signal.set()

            manager.start(
                AutoSettlementConfig(
                    claim_interval_secs=2,
                    settle_interval_secs=2,
                    on_claim=on_claim,
                    on_settle=on_settle,
                    on_error=on_error,
                )
            )
            try:
                assert claim_signal.wait(timeout=90.0), "auto-claim never fired"
                assert settle_signal.wait(timeout=90.0), "auto-settle never fired"
            finally:
                manager.stop(flush=False)

            assert not error_events, f"auto-loop raised: {error_events}"
            assert claim_events and claim_events[0].transaction
            assert settle_events and settle_events[0].transaction
        finally:
            handle.shutdown()


class TestBatchSettlementWithdrawalPendingRefund:
    """Scenario 10 (Go): manager detects withdraw-pending sessions and refunds
    them via the cooperative manager.refund flow."""

    def test_manager_refund_drains_withdraw_pending_channel(self) -> None:
        pipe = _Pipeline()
        handle = _start_flask_resource_server(pipe, "/api/withdraw-pending", "$0.0004")
        try:
            _make_paid_request(pipe, handle.url)
            _make_paid_request(pipe, handle.url)

            channel_id = pipe.channel_id_for(pipe.requirements("400"))
            _wait_for_balance(pipe.w3, channel_id)

            storage = pipe.server_scheme.get_storage()
            session = storage.get(channel_id)
            assert session is not None, "expected session after paid request"
            from x402.mechanisms.evm.batch_settlement.server.storage import Channel

            def mark_withdraw(current: Channel | None) -> Channel | None:
                if current is None:
                    return current
                nxt = current.copy()
                nxt.withdraw_requested_at = int(time.time())
                return nxt

            storage.update_channel(channel_id, mark_withdraw)

            manager = pipe.server_scheme.create_channel_manager_sync(
                pipe.facilitator_client, NETWORK
            )
            pending = manager.get_withdrawal_pending_sessions()
            assert len(pending) == 1
            assert pending[0].channel_id.lower() == channel_id

            _wait_for_pending_transactions(pipe.facilitator_address)
            results = manager.refund([channel_id])
            assert len(results) == 1 and results[0].transaction, (
                f"expected 1 refund result with tx hash, got {results}"
            )

            # Session must be deleted post-refund.
            post = storage.get(channel_id)
            assert post is None, f"expected session deleted, still present: {post}"
        finally:
            handle.shutdown()


class TestBatchSettlementRefundRecoverableRetryExhaustion:
    """Scenario 7 (Go): a recoverable 402 (cumulative_amount_mismatch / similar
    advisory) should be retried exactly once and then bail with a clear error.

    Uses a mock Flask server that always returns a recoverable 402 so the client
    cannot make forward progress; the deposit was already made against a real
    Flask server so a real on-chain channel exists.
    """

    def test_recoverable_402_retries_and_fails(self) -> None:
        from x402.mechanisms.evm.batch_settlement.errors import (
            ERR_CUMULATIVE_AMOUNT_MISMATCH,
        )

        pipe = _Pipeline()
        deposit_handle = _start_flask_resource_server(pipe, "/api/refund-retry", "$0.0005")
        try:
            _make_paid_request(pipe, deposit_handle.url)
            channel_id = pipe.channel_id_for(pipe.requirements("500"))
            _wait_for_balance(pipe.w3, channel_id)
        finally:
            deposit_handle.shutdown()

        # Mock server: always 402 with PAYMENT-REQUIRED carrying the recoverable
        # error. The client should attempt once, decode the corrective response,
        # retry once, see the same error, and bail out with "after 2 attempt(s)".
        recoverable_error = ERR_CUMULATIVE_AMOUNT_MISMATCH
        receiver_authorizer = pipe.receiver_authorizer
        receiver_address = pipe.receiver_address

        app = Flask(f"x402-batched-mock-{secrets.token_hex(4)}")

        @app.get("/api/refund-retry")  # type: ignore[misc]
        def _stale_handler() -> Any:
            payment_required: dict[str, Any] = {
                "x402Version": 2,
                "accepts": [
                    {
                        "scheme": SCHEME_BATCH_SETTLEMENT,
                        "network": NETWORK,
                        "asset": USDC_ADDRESS,
                        "amount": "500",
                        "payTo": receiver_address,
                        "maxTimeoutSeconds": 3600,
                        "extra": {
                            "name": "USDC",
                            "version": "2",
                            "assetTransferMethod": "eip3009",
                            "receiverAuthorizer": receiver_authorizer,
                        },
                    }
                ],
            }
            if request.headers.get("PAYMENT-SIGNATURE"):
                payment_required["error"] = recoverable_error
            import base64

            encoded = base64.b64encode(json.dumps(payment_required).encode()).decode()
            resp = make_response(jsonify(payment_required), 402)
            resp.headers["PAYMENT-REQUIRED"] = encoded
            return resp

        port = _free_port()
        srv = make_server("127.0.0.1", port, app)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        mock_url = f"http://127.0.0.1:{port}/api/refund-retry"
        try:
            # Liveness probe.
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    requests.get(mock_url, timeout=0.5)
                    break
                except Exception:
                    time.sleep(0.05)

            with pytest.raises(RuntimeError) as exc:
                pipe.client_scheme.refund(mock_url, None)
            # Python's implementation reports "after N attempt(s)" once retry
            # budget is exhausted (see refund_channel in client/refund.py).
            assert "after 2 attempt(s)" in str(exc.value), str(exc.value)
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=2.0)


# Silence unused-import linters — these imports document the public surface
# this file exercises.
_ = (ERR_REFUND_NO_BALANCE,)
