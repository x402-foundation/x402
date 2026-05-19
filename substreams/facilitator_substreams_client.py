"""
AgentPay Facilitator — Substreams Settlement Client
====================================================
Replaces the eth_getTransactionReceipt polling loop with a streaming
subscription to the agentpay_substreams `map_confirmed_settlements` module.

Architecture:
  Before: facilitator polls RPC every 500ms until tx confirmed → 1-3s latency
  After:  Substreams pushes SettlementEvent at block finalization → <500ms

FIX (Grok Q3): asyncio.Future is NOT safe in synchronous Flask — it deadlocks
or races under load. Replaced with threading.Event + queue.Queue for safe
cross-thread signaling. Substreams client runs in its own dedicated thread
with its own event loop, completely isolated from Flask workers.

Usage:
  # Start alongside Flask (in facilitator.py startup):
  from facilitator_substreams_client import SubstreamsClient, register_pending
  client = SubstreamsClient()
  client.start_background()  # spins up dedicated thread + event loop

  # In Flask route — wait for on-chain confirmation:
  event, result_queue = register_pending(payment_id)
  confirmed = event.wait(timeout=60)
  if confirmed:
      settlement = result_queue.get_nowait()
      release_service(payment_id)
  else:
      mark_payment_failed(payment_id)

Requires:
  pip install grpcio grpcio-tools substreams-python
  SUBSTREAMS_API_TOKEN env var (from app.streamingfast.io/keys)
"""

import os
import asyncio
import logging
import threading
import queue
import grpc
from typing import Optional, Tuple

log = logging.getLogger("agentpay.substreams")

# ── Config ────────────────────────────────────────────────────────────────────
SUBSTREAMS_ENDPOINT   = "mainnet.base.streamingfast.io:443"
SUBSTREAMS_API_TOKEN  = os.getenv("SUBSTREAMS_API_TOKEN", "")
SPKG_PATH             = os.getenv("SUBSTREAMS_SPKG", "./agentpay_substreams-v0.1.0.spkg")
MODULE_NAME           = "map_confirmed_settlements"
START_BLOCK           = int(os.getenv("SUBSTREAMS_START_BLOCK", "0"))

# ── Pending Payments Registry ─────────────────────────────────────────────────
# Maps payment_id → (threading.Event, queue.Queue)
# Flask route calls register_pending() to get an Event to wait on.
# Substreams thread calls _resolve_payment() when the on-chain event arrives.
# Both ops are thread-safe — dict access protected by a Lock.
_pending: dict[str, Tuple[threading.Event, queue.Queue]] = {}
_pending_lock = threading.Lock()


def register_pending(payment_id: str) -> Tuple[threading.Event, queue.Queue]:
    """
    Register a payment as pending confirmation.
    Returns (event, result_queue) — call event.wait(timeout=60) in your Flask route.

    Usage:
        event, result_queue = register_pending(payment_id)
        confirmed = event.wait(timeout=60)
        if confirmed:
            settlement = result_queue.get_nowait()
            release_service(payment_id)
        else:
            mark_payment_failed(payment_id)
    """
    evt = threading.Event()
    q = queue.Queue(maxsize=1)
    with _pending_lock:
        _pending[payment_id] = (evt, q)
    log.info(f"[substreams] registered pending: {payment_id}")
    return evt, q


def _resolve_payment(payment_id: str, settlement: dict):
    """
    Called from Substreams thread when on-chain SettlementEvent arrives.
    Signals the waiting Flask route via threading.Event — no asyncio, no deadlock.
    """
    with _pending_lock:
        entry = _pending.pop(payment_id, None)
    if entry:
        evt, q = entry
        q.put_nowait(settlement)
        evt.set()
        log.info(
            f"[substreams] confirmed: {payment_id} "
            f"| block={settlement.get('block_num')} "
            f"| amount=${int(settlement.get('amount_usdc', 0)) / 1e6:.4f} USDC"
        )


# ── Substreams Client ─────────────────────────────────────────────────────────
class SubstreamsClient:
    """
    Connects to StreamingFast gRPC endpoint and streams SettlementEvents.
    Runs in a dedicated background thread with its own asyncio event loop —
    completely isolated from Flask's synchronous worker threads.
    """

    def __init__(self):
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._running = False

    def start_background(self):
        """Start the streaming client in a dedicated daemon thread."""
        if self._running:
            log.warning("[substreams] already running")
            return

        self._running = True
        self._thread = threading.Thread(
            target=self._thread_main,
            name="substreams-client",
            daemon=True,  # dies with the Flask process
        )
        self._thread.start()
        log.info("[substreams] background thread started")

    def _thread_main(self):
        """Dedicated thread — creates its own event loop, runs forever."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._stream_forever())
        except Exception as e:
            log.error(f"[substreams] thread died: {e}")
        finally:
            self._loop.close()
            self._running = False

    async def _stream_forever(self):
        """Reconnecting stream loop — runs inside the dedicated event loop."""
        if not SUBSTREAMS_API_TOKEN:
            raise RuntimeError(
                "SUBSTREAMS_API_TOKEN not set — get yours at https://app.streamingfast.io/keys"
            )

        from substreams.client import Client as SFClient  # pip install substreams

        client = SFClient(SUBSTREAMS_ENDPOINT, SUBSTREAMS_API_TOKEN)

        while self._running:
            try:
                log.info(f"[substreams] streaming from block {START_BLOCK}...")
                async for response in client.stream(
                    spkg=SPKG_PATH,
                    module=MODULE_NAME,
                    start_block=START_BLOCK,
                    stop_block=0,  # stream forever
                ):
                    await self._handle_response(response)

            except grpc.aio.AioRpcError as e:
                log.warning(f"[substreams] gRPC error {e.code()} — reconnecting in 5s")
                await asyncio.sleep(5)
            except Exception as e:
                log.error(f"[substreams] error: {e} — reconnecting in 10s")
                await asyncio.sleep(10)

    async def _handle_response(self, response):
        """Parse Substreams MapOutput → dispatch SettlementEvents."""
        try:
            from agentpay.v1.agentpay_pb2 import SettlementEvents
            events = SettlementEvents()
            events.ParseFromString(response.data.map_output.value)

            for s in events.settlements:
                settlement_dict = {
                    "payment_id":     s.payment_id,
                    "agent_wallet":   s.agent_wallet,
                    "service_wallet": s.service_wallet,
                    "amount_usdc":    s.amount_usdc,
                    "settled":        s.settled,
                    "block_num":      s.block_num,
                    "timestamp":      s.timestamp,
                    "tx_hash":        s.tx_hash,
                    "nonce":          s.nonce.hex(),
                    "facilitator_id": s.facilitator_id,
                }
                # Call from async context — safe, _resolve_payment is pure threading
                _resolve_payment(s.payment_id, settlement_dict)

        except Exception as e:
            log.debug(f"[substreams] parse skip: {e}")

    def stop(self):
        self._running = False
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)


# ── Flask Integration Example ─────────────────────────────────────────────────
"""
Drop this into facilitator.py:

    from facilitator_substreams_client import SubstreamsClient, register_pending

    # Start once at Flask boot
    _substreams = SubstreamsClient()
    _substreams.start_background()

    @app.route('/pay', methods=['POST'])
    def pay():
        payment_id = str(uuid.uuid4())
        # ... create payment, send EIP-3009 authorization to agent ...

        # Wait for on-chain confirmation — no polling, no RPC calls
        event, result_queue = register_pending(payment_id)
        confirmed = event.wait(timeout=60)

        if confirmed:
            settlement = result_queue.get_nowait()
            release_service(payment_id, settlement)
            return jsonify({"status": "confirmed", "tx": settlement["tx_hash"]})
        else:
            return jsonify({"status": "timeout"}), 408
"""

# ── Clickhouse Sink Config ────────────────────────────────────────────────────
CLICKHOUSE_SINK_CONFIG = {
    "endpoint":  SUBSTREAMS_ENDPOINT,
    "token":     SUBSTREAMS_API_TOKEN,
    "spkg":      SPKG_PATH,
    "module":    "map_analytics_events",
    "clickhouse": {
        "dsn":   os.getenv("CLICKHOUSE_DSN", "clickhouse://localhost:9000/agentpay"),
        "table": "settlement_events",
        "schema": {
            "agent":          "String",
            "counterparty":   "String",
            "amount_usdc":    "UInt64",
            "block_num":      "UInt64",
            "timestamp":      "DateTime",
            "tx_hash":        "FixedString(66)",
            "settled":        "Bool",
            "score_ppm":      "UInt64",
            "city":           "LowCardinality(String)",
            "facilitator_id": "String",
        },
    },
}

# ── Standalone Entry Point ────────────────────────────────────────────────────
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import signal, time

    client = SubstreamsClient()
    client.start_background()

    def _shutdown(sig, frame):
        log.info("Shutting down...")
        client.stop()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Keep main thread alive
    while client._running:
        time.sleep(1)
