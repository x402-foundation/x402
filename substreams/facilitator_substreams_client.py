"""
AgentPay Facilitator — Substreams Settlement Client
====================================================
Replaces the eth_getTransactionReceipt polling loop with a streaming
subscription to the agentpay_substreams `map_confirmed_settlements` module.

Architecture:
  Before: facilitator polls RPC every 500ms until tx confirmed → 1-3s latency
  After:  Substreams pushes SettlementEvent at block finalization → <500ms

Usage:
  python3 facilitator_substreams_client.py

Requires:
  pip install grpcio grpcio-tools substreams-python
  SUBSTREAMS_API_TOKEN env var (from streamingfast.io dashboard)
"""

import os
import asyncio
import logging
import grpc
from typing import Optional

log = logging.getLogger("agentpay.substreams")

# ── Config ────────────────────────────────────────────────────────────────────
SUBSTREAMS_ENDPOINT = "mainnet.base.streamingfast.io:443"
SUBSTREAMS_API_TOKEN = os.getenv("SUBSTREAMS_API_TOKEN", "")
SPKG_PATH = os.getenv("SUBSTREAMS_SPKG", "./agentpay-substreams/agentpay_substreams-v0.1.0.spkg")
MODULE_NAME = "map_confirmed_settlements"

# Base L2 genesis + AgentPay contract deployment block
# Update START_BLOCK to the block where x402GrantRegistry was deployed
START_BLOCK = int(os.getenv("SUBSTREAMS_START_BLOCK", "0"))

# ── Pending Payments Registry ─────────────────────────────────────────────────
# In-memory map: payment_id → asyncio.Future
# Facilitator registers a future when it creates a payment,
# Substreams client resolves it when the on-chain event arrives.
_pending: dict[str, asyncio.Future] = {}

def register_pending(payment_id: str) -> asyncio.Future:
    """
    Call this when a new payment is initiated.
    Returns a Future that resolves when the on-chain settlement is confirmed.

    Usage in facilitator:
        future = register_pending(payment_id)
        try:
            settlement = await asyncio.wait_for(future, timeout=60)
            release_service(payment_id)
        except asyncio.TimeoutError:
            mark_payment_failed(payment_id)
    """
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    _pending[payment_id] = fut
    log.info(f"[substreams] registered pending payment: {payment_id}")
    return fut

def _resolve_payment(payment_id: str, settlement_event: dict):
    """Internal — called when Substreams pushes a matching SettlementEvent."""
    fut = _pending.pop(payment_id, None)
    if fut and not fut.done():
        fut.set_result(settlement_event)
        log.info(f"[substreams] resolved payment: {payment_id} "
                 f"| block={settlement_event.get('block_num')} "
                 f"| amount=${int(settlement_event.get('amount_usdc','0'))/1e6:.4f} USDC")

# ── gRPC Substreams Client ────────────────────────────────────────────────────
class SubstreamsClient:
    """
    Connects to the StreamingFast Substreams gRPC endpoint and streams
    SettlementEvents from the map_confirmed_settlements module.
    """

    def __init__(self):
        self.endpoint = SUBSTREAMS_ENDPOINT
        self.token = SUBSTREAMS_API_TOKEN
        self._channel: Optional[grpc.aio.Channel] = None

    async def connect(self):
        credentials = grpc.composite_channel_credentials(
            grpc.ssl_channel_credentials(),
            grpc.access_token_call_credentials(self.token),
        )
        self._channel = grpc.aio.secure_channel(self.endpoint, credentials)
        log.info(f"[substreams] connected to {self.endpoint}")

    async def stream(self):
        """
        Main streaming loop. Reconnects automatically on disconnect.
        Dispatches each SettlementEvent to _resolve_payment().
        """
        from substreams.client import Client as SFClient  # pip install substreams

        client = SFClient(self.endpoint, self.token)

        while True:
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
                log.warning(f"[substreams] gRPC error: {e.code()} — reconnecting in 5s")
                await asyncio.sleep(5)
            except Exception as e:
                log.error(f"[substreams] unexpected error: {e} — reconnecting in 10s")
                await asyncio.sleep(10)

    async def _handle_response(self, response):
        """Parse a Substreams MapOutput and dispatch settlement events."""
        # response.data contains the serialized SettlementEvents proto
        try:
            from agentpay.v1.agentpay_pb2 import SettlementEvents
            events = SettlementEvents()
            events.ParseFromString(response.data.map_output.value)

            for settlement in events.settlements:
                event_dict = {
                    "payment_id":     settlement.payment_id,
                    "agent_wallet":   settlement.agent_wallet,
                    "service_wallet": settlement.service_wallet,
                    "amount_usdc":    settlement.amount_usdc,
                    "settled":        settlement.settled,
                    "block_num":      settlement.block_num,
                    "timestamp":      settlement.timestamp,
                    "tx_hash":        settlement.tx_hash,
                    "nonce":          settlement.nonce.hex(),
                    "facilitator_id": settlement.facilitator_id,
                }
                _resolve_payment(settlement.payment_id, event_dict)

        except Exception as e:
            log.debug(f"[substreams] parse skip: {e}")

# ── Flask Integration Patch ───────────────────────────────────────────────────
# Drop this into facilitator.py to replace the polling loop.
#
# BEFORE (polling — current implementation):
#   def wait_for_confirmation(tx_hash, timeout=60):
#       deadline = time.time() + timeout
#       while time.time() < deadline:
#           receipt = w3.eth.get_transaction_receipt(tx_hash)
#           if receipt and receipt.status == 1:
#               return receipt
#           time.sleep(0.5)  # ← 500ms poll — bottleneck at scale
#       raise TimeoutError(f"tx {tx_hash} not confirmed in {timeout}s")
#
# AFTER (Substreams — streaming confirmation):
#   from facilitator_substreams_client import register_pending
#   async def wait_for_confirmation(payment_id, timeout=60):
#       future = register_pending(payment_id)
#       return await asyncio.wait_for(future, timeout=timeout)
#       # ↑ resolves in <500ms when block is finalized, zero polling

# ── Clickhouse Sink Config ────────────────────────────────────────────────────
CLICKHOUSE_SINK_CONFIG = {
    # streamingfast/substreams-sink-clickhouse compatible config
    # James's team uses this exact pattern for the Uniswap pipeline
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

# ── Entry Point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    if not SUBSTREAMS_API_TOKEN:
        raise RuntimeError(
            "SUBSTREAMS_API_TOKEN not set. "
            "Get yours at https://app.streamingfast.io/keys"
        )

    client = SubstreamsClient()

    async def main():
        await client.connect()
        await client.stream()

    asyncio.run(main())
