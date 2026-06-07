"""x402 HTTP client for the ERC-8004 ticket demo.

Makes two paid requests (USDC + DAI), verifies attestation headers, then
submits Path A feedback for the USDC ticket and Path B sponsored feedback
for the DAI ticket.

Prerequisites: bootstrap_fork.py running, facilitator + agent server up.

Run:
    cd examples/python/clients/erc8004
    uv sync
    uv run python run_x402_client.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

from dotenv import load_dotenv
from eth_account import Account
from eth_utils import keccak
from web3 import Web3

from utils import ensure_dai_permit2_allowance

from x402 import x402Client
from x402.extensions.erc8004 import (
    ATTESTATION_HEADER,
    ERC8004ClientExtension,
    ERC8004Config,
    ERCFeedbackClient,
    FeedbackParams,
    InteractionAttestation,
    verify_interaction_attestation,
)
from x402.extensions.erc8004.constants import (
    REPUTATION_REGISTRY_ABI,
    X402_AGENT_REPUTATION_ABI,
)
from x402.http import x402HTTPClient
from x402.http.clients.httpx import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

load_dotenv()

PAYER_KEY = os.getenv("PAYER_PRIVATE_KEY")
RELAYER_KEY = os.getenv("RELAYER_PRIVATE_KEY")
AGENT_SERVER_URL = os.getenv("AGENT_SERVER_URL", "http://127.0.0.1:4021")
EVM_RPC_URL = os.getenv("EVM_RPC_URL", "http://127.0.0.1:8545")
NETWORK = os.getenv("NETWORK", "eip155:1")
WRAPPER_ADDRESS = os.getenv("WRAPPER_ADDRESS")
FEEDBACK_GATEWAY = os.getenv("FEEDBACK_GATEWAY")
REPUTATION_REGISTRY = os.getenv("REPUTATION_REGISTRY")
IDENTITY_REGISTRY = os.getenv("IDENTITY_REGISTRY", "0x" + "00" * 20)
AGENT_ID = os.getenv("AGENT_ID")
AGENT_ADDRESS = os.getenv("AGENT_ADDRESS")
AGENT_OWNER_ADDRESS = os.getenv("AGENT_OWNER_ADDRESS", AGENT_ADDRESS)
DAI_ADDRESS = os.getenv("DAI_ADDRESS")
AMOUNT_DAI = int(os.getenv("AMOUNT_DAI", "1000000000000000000"))
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "http://127.0.0.1:4022")


def _require_env() -> None:
    missing = []
    if not PAYER_KEY:
        missing.append("PAYER_PRIVATE_KEY")
    if not RELAYER_KEY:
        missing.append("RELAYER_PRIVATE_KEY")
    if not WRAPPER_ADDRESS:
        missing.append("WRAPPER_ADDRESS")
    if not FEEDBACK_GATEWAY:
        missing.append("FEEDBACK_GATEWAY")
    if not REPUTATION_REGISTRY:
        missing.append("REPUTATION_REGISTRY")
    if not AGENT_ID:
        missing.append("AGENT_ID")
    if not DAI_ADDRESS:
        missing.append("DAI_ADDRESS")
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}")
        print("Run bootstrap_fork.py --write-env first.")
        sys.exit(1)


def _wait_for_url(url: str, label: str, timeout_s: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_s
    health = url.rstrip("/") + "/health"
    while time.monotonic() < deadline:
        try:
            with urlopen(health, timeout=2) as resp:
                if resp.status == 200:
                    print(f"  {label} ready at {url}")
                    return
        except (URLError, OSError, TimeoutError):
            pass
        time.sleep(0.5)
    print(f"ERROR: {label} not reachable at {health} after {timeout_s}s")
    sys.exit(1)


def _header_get(headers: dict[str, str], name: str) -> str | None:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


def _parse_attestation(headers: dict[str, str]) -> InteractionAttestation | None:
    raw = _header_get(headers, ATTESTATION_HEADER)
    if not raw:
        return None
    return InteractionAttestation.from_dict(json.loads(raw))


def _verify_attestation(att: InteractionAttestation, wrapper: str, owner: str) -> None:
    ok = verify_interaction_attestation(att, wrapper_address=wrapper, expected_owner=owner)
    if not ok:
        raise RuntimeError("interaction attestation signature verification failed")


async def _paid_get(
    http: x402HttpxClient,
    http_helper: x402HTTPClient,
    url: str,
    wrapper: str,
    owner: str,
) -> tuple[int, InteractionAttestation]:
    print(f"\nGET {url}")
    response = await http.get(url)
    await response.aread()

    print(f"  status={response.status_code}")
    if response.status_code != 200:
        print(f"  body={response.text[:500]}")
        raise RuntimeError(f"expected 200, got {response.status_code}")

    settle = http_helper.get_payment_settle_response(lambda name: response.headers.get(name))
    print(f"  settle tx={settle.transaction}")
    erc8004 = (settle.extensions or {}).get("erc8004", {})
    ticket_id_raw = erc8004.get("ticketId")
    if ticket_id_raw is None:
        raise RuntimeError(
            f"PAYMENT-RESPONSE missing extensions.erc8004.ticketId "
            f"(extensions={settle.extensions!r}). "
            "Ensure agent server routes declare extensions.erc8004."
        )
    ticket_id = int(ticket_id_raw)
    print(f"  ticketId={ticket_id}")

    header_map = dict(response.headers)
    att = _parse_attestation(header_map)
    if att is None:
        keys = ", ".join(sorted(header_map.keys()))
        raise RuntimeError(f"missing {ATTESTATION_HEADER} header (have: {keys})")
    _verify_attestation(att, wrapper, owner)
    print(f"  attestation verified (ticketId={att.ticket_id})")
    return ticket_id, att


def _config() -> ERC8004Config:
    return ERC8004Config(
        network=NETWORK,
        reputation_registry=Web3.to_checksum_address(REPUTATION_REGISTRY),  # type: ignore[arg-type]
        wrapper_address=Web3.to_checksum_address(WRAPPER_ADDRESS),  # type: ignore[arg-type]
        feedback_gateway=Web3.to_checksum_address(FEEDBACK_GATEWAY),  # type: ignore[arg-type]
        identity_registry=IDENTITY_REGISTRY,
        rpc_url=EVM_RPC_URL,
    )


def _path_a_feedback(w3: Web3, payer: Account, ticket_id: int, agent_id: int) -> None:
    """Self-paid: payer delegates its EOA to the gateway (EIP-7702) and submits feedback."""
    print(f"\nPath A: self-paid feedback (EIP-7702) for ticket #{ticket_id}")
    client = ERCFeedbackClient(_config(), payer)
    params = FeedbackParams(
        agent_id=agent_id,
        value=95,
        value_decimals=0,
        tag1="quality",
        tag2="x402-usdc",
        endpoint=f"{AGENT_SERVER_URL}/agent/usdc",
        feedback_uri=f"mem://x402-demo/usdc-ticket-{ticket_id}",
        feedback_hash=keccak(f"x402-usdc-ticket-{ticket_id}".encode()),
    )
    tx_hash = client.submit_feedback_self_paid(ticket_id, params)
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"self-paid feedback reverted: {tx_hash}")
    print(f"  tx={tx_hash}")


def _path_b_feedback(
    w3: Web3,
    payer: Account,
    relayer: Account,
    ticket_id: int,
    agent_id: int,
) -> None:
    """Sponsored: payer signs a set-code authorization + EIP-712 intent; relayer pays gas."""
    print(f"\nPath B: sponsored feedback (EIP-7702, relayer-paid) for ticket #{ticket_id}")
    cfg = _config()
    payer_client = ERCFeedbackClient(cfg, payer)
    relayer_client = ERCFeedbackClient(cfg, relayer)

    params = FeedbackParams(
        agent_id=agent_id,
        value=80,
        value_decimals=0,
        tag1="quality",
        tag2="x402-dai-sponsored",
        endpoint=f"{AGENT_SERVER_URL}/agent/dai",
        feedback_uri=f"mem://x402-demo/dai-ticket-{ticket_id}",
        feedback_hash=keccak(f"x402-dai-ticket-{ticket_id}".encode()),
    )
    nonce = ticket_id
    deadline = w3.eth.get_block("latest")["timestamp"] + 3600

    # Payer delegates its EOA to the gateway and signs the feedback intent.
    authorization = payer_client.authorize_gateway()
    domain, types, message = payer_client.build_feedback_intent(ticket_id, params, nonce, deadline)
    signed = Account.sign_typed_data(
        payer.key,
        domain_data=domain,
        message_types={k: v for k, v in types.items() if k != "EIP712Domain"},
        message_data=message,
    )

    tx_hash = relayer_client.submit_feedback_sponsored(
        client_address=payer.address,
        client_authorization=authorization,
        ticket_id=ticket_id,
        params=params,
        nonce=nonce,
        deadline=deadline,
        signature=signed.signature,
    )
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"sponsored feedback reverted: {tx_hash}")
    print(f"  relayer tx={tx_hash}")


async def main() -> int:
    _require_env()
    agent_id = int(AGENT_ID)  # type: ignore[arg-type]
    wrapper = Web3.to_checksum_address(WRAPPER_ADDRESS)  # type: ignore[arg-type]
    owner = Web3.to_checksum_address(AGENT_OWNER_ADDRESS)  # type: ignore[arg-type]

    print("Waiting for facilitator and agent server...")
    _wait_for_url(FACILITATOR_URL, "Facilitator")
    _wait_for_url(AGENT_SERVER_URL, "Agent server")

    payer = Account.from_key(PAYER_KEY)  # type: ignore[arg-type]
    relayer = Account.from_key(RELAYER_KEY)  # type: ignore[arg-type]
    w3 = Web3(Web3.HTTPProvider(EVM_RPC_URL))

    print(f"\nPayer:   {payer.address}")
    print(f"Relayer: {relayer.address}")
    print(f"Wrapper: {wrapper}")

    client = x402Client()
    client.register_extension(ERC8004ClientExtension())
    register_exact_evm_client(client, EthAccountSigner(payer), networks=NETWORK)
    http_helper = x402HTTPClient(client)

    usdc_url = f"{AGENT_SERVER_URL}/agent/usdc"
    dai_url = f"{AGENT_SERVER_URL}/agent/dai"

    # DAI settles through the canonical x402ExactPermit2Proxy (standard x402 Permit2),
    # so the payer must have approved Permit2 once. USDC uses EIP-3009 (no approval).
    print("\nEnsuring payer has approved Permit2 for DAI...")
    ensure_dai_permit2_allowance(w3, payer, DAI_ADDRESS, AMOUNT_DAI)  # type: ignore[arg-type]

    async with x402HttpxClient(client) as http:
        ticket_usdc, _ = await _paid_get(http, http_helper, usdc_url, wrapper, owner)
        ticket_dai, _ = await _paid_get(http, http_helper, dai_url, wrapper, owner)

    _path_a_feedback(w3, payer, ticket_usdc, agent_id)
    _path_b_feedback(w3, payer, relayer, ticket_dai, agent_id)

    wrapper_c = w3.eth.contract(address=wrapper, abi=X402_AGENT_REPUTATION_ABI)
    for tid, label in ((ticket_usdc, "USDC"), (ticket_dai, "DAI")):
        consumed = wrapper_c.functions.tickets(tid).call()[5]
        print(f"\nTicket #{tid} ({label}) consumed={consumed}")
        if not consumed:
            raise RuntimeError(f"ticket #{tid} not consumed")

    # Feedback is stored on the canonical ReputationRegistry, authored by the payer.
    registry_c = w3.eth.contract(
        address=Web3.to_checksum_address(REPUTATION_REGISTRY),  # type: ignore[arg-type]
        abi=REPUTATION_REGISTRY_ABI,
    )
    idx = registry_c.functions.getLastIndex(agent_id, payer.address).call()
    print(f"canonical ReputationRegistry.getLastIndex(agentId={agent_id}, payer) = {idx}")
    if idx != 2:
        raise RuntimeError(f"expected 2 canonical feedbacks by payer, got {idx}")

    print("\nDONE — x402 HTTP flow complete (USDC + DAI tickets, attestation, 7702 feedback Path A + B).")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
