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

from utils import send_tx

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
from x402.extensions.erc8004.constants import X402_AGENT_REPUTATION_ABI
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
IDENTITY_REGISTRY = os.getenv("IDENTITY_REGISTRY", "0x" + "00" * 20)
AGENT_ID = os.getenv("AGENT_ID")
AGENT_ADDRESS = os.getenv("AGENT_ADDRESS")
AGENT_OWNER_ADDRESS = os.getenv("AGENT_OWNER_ADDRESS", AGENT_ADDRESS)
DAI_ADDRESS = os.getenv("DAI_ADDRESS")
AMOUNT_DAI = int(os.getenv("AMOUNT_DAI", "1000000000000000000"))
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "http://127.0.0.1:4022")
FACILITATOR_KEY = os.getenv("FACILITATOR_PRIVATE_KEY")

GET_LAST_INDEX_ABI = [
    {
        "name": "getLastIndex",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "clientAddress", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint64"}],
    },
]


def _require_env() -> None:
    missing = []
    if not PAYER_KEY:
        missing.append("PAYER_PRIVATE_KEY")
    if not RELAYER_KEY:
        missing.append("RELAYER_PRIVATE_KEY")
    if not WRAPPER_ADDRESS:
        missing.append("WRAPPER_ADDRESS")
    if not AGENT_ID:
        missing.append("AGENT_ID")
    if not DAI_ADDRESS:
        missing.append("DAI_ADDRESS")
    if not FACILITATOR_KEY:
        missing.append("FACILITATOR_PRIVATE_KEY")
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


def _path_a_feedback(
    w3: Web3,
    payer: Account,
    ticket_id: int,
    agent_id: int,
    wrapper: str,
) -> None:
    print(f"\nPath A: giveFeedbackWithTicket for ticket #{ticket_id}")
    cfg = ERC8004Config(
        network=NETWORK,
        reputation_registry=wrapper,
        wrapper_address=wrapper,
        identity_registry=IDENTITY_REGISTRY,
        rpc_url=EVM_RPC_URL,
    )
    client = ERCFeedbackClient(cfg, payer)
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
    tx_hash = client.submit_feedback_with_ticket(ticket_id, params)
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"giveFeedbackWithTicket reverted: {tx_hash}")
    print(f"  tx={tx_hash}")


def _mint_dai_ticket_transfer_from(
    w3: Web3,
    wrapper: str,
    payer: Account,
    facilitator: Account,
    agent_id: int,
    agent_address: str,
    amount: int,
) -> int:
    """Mint a DAI ticket via settleAndMintTicket (transferFrom).

    Standard x402 Permit2 uses the x402 proxy witness; the wrapper expects a
    TicketWitness signature. Until the SDK signs that witness, the demo mints
    the DAI ticket with the same transferFrom path as run_ticket_demo.py.
    """
    from x402.extensions.erc8004.constants import get_ticket_minted_topic

    dai = w3.eth.contract(
        address=Web3.to_checksum_address(DAI_ADDRESS),  # type: ignore[arg-type]
        abi=[
            {
                "name": "approve",
                "type": "function",
                "stateMutability": "nonpayable",
                "inputs": [
                    {"name": "spender", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                ],
                "outputs": [{"name": "", "type": "bool"}],
            },
        ],
    )
    approve_data = dai.functions.approve(
        Web3.to_checksum_address(wrapper), 2**256 - 1
    ).build_transaction({"from": payer.address})["data"]
    send_tx(w3, payer, {"to": Web3.to_checksum_address(DAI_ADDRESS), "data": approve_data, "value": 0, "gas": 120_000})  # type: ignore[arg-type]

    contract = w3.eth.contract(address=Web3.to_checksum_address(wrapper), abi=X402_AGENT_REPUTATION_ABI)
    func = contract.functions.settleAndMintTicket(
        payer.address,
        agent_id,
        Web3.to_checksum_address(agent_address),
        (Web3.to_checksum_address(DAI_ADDRESS), Web3.to_checksum_address(agent_address), amount),  # type: ignore[arg-type]
    )
    data = func.build_transaction({"from": facilitator.address})["data"]
    rcpt = send_tx(
        w3,
        facilitator,
        {"to": Web3.to_checksum_address(wrapper), "data": data, "value": 0, "gas": 600_000},
    )

    topic0 = get_ticket_minted_topic()
    for log in rcpt.get("logs", []) or []:
        topics = log.get("topics") or []
        if not topics:
            continue
        t0 = topics[0].hex() if hasattr(topics[0], "hex") else str(topics[0])
        if not t0.startswith("0x"):
            t0 = "0x" + t0
        if t0.lower() == topic0.lower():
            tid = topics[1]
            return int(tid.hex(), 16) if hasattr(tid, "hex") else int(str(tid), 16)
    raise RuntimeError("TicketMinted log not found after DAI settleAndMintTicket")


def _path_b_feedback(
    w3: Web3,
    payer: Account,
    relayer: Account,
    ticket_id: int,
    agent_id: int,
    wrapper: str,
) -> None:
    print(f"\nPath B: sponsored giveFeedbackWithTicketFor for ticket #{ticket_id}")
    cfg = ERC8004Config(
        network=NETWORK,
        reputation_registry=wrapper,
        wrapper_address=wrapper,
        identity_registry=IDENTITY_REGISTRY,
        rpc_url=EVM_RPC_URL,
    )
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
    domain, types, message = payer_client.build_feedback_intent(
        ticket_id, params, nonce, deadline
    )
    signed = Account.sign_typed_data(
        payer.key,
        domain_data=domain,
        message_types={k: v for k, v in types.items() if k != "EIP712Domain"},
        message_data=message,
    )
    tx_hash = relayer_client.submit_feedback_sponsored(
        payer=payer.address,
        ticket_id=ticket_id,
        params=params,
        nonce=nonce,
        deadline=deadline,
        signature=signed.signature,
    )
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"giveFeedbackWithTicketFor reverted: {tx_hash}")
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

    facilitator = Account.from_key(FACILITATOR_KEY)  # type: ignore[arg-type]
    agent_addr = Web3.to_checksum_address(AGENT_ADDRESS)  # type: ignore[arg-type]
    usdc_url = f"{AGENT_SERVER_URL}/agent/usdc"

    async with x402HttpxClient(client) as http:
        ticket_usdc, _ = await _paid_get(http, http_helper, usdc_url, wrapper, owner)

    _path_a_feedback(w3, payer, ticket_usdc, agent_id, wrapper)

    print("\nMinting DAI ticket via settleAndMintTicket (transferFrom)...")
    print("  (TicketWitness Permit2 over x402 HTTP is not yet in the SDK; see README.)")
    ticket_dai = _mint_dai_ticket_transfer_from(
        w3, wrapper, payer, facilitator, agent_id, agent_addr, AMOUNT_DAI
    )
    print(f"  ticketId={ticket_dai}")
    _path_b_feedback(w3, payer, relayer, ticket_dai, agent_id, wrapper)

    contract = w3.eth.contract(
        address=wrapper, abi=X402_AGENT_REPUTATION_ABI + GET_LAST_INDEX_ABI
    )
    for tid, label in ((ticket_usdc, "USDC"), (ticket_dai, "DAI")):
        consumed = contract.functions.tickets(tid).call()[5]
        print(f"\nTicket #{tid} ({label}) consumed={consumed}")
        if not consumed:
            raise RuntimeError(f"ticket #{tid} not consumed")

    idx = contract.functions.getLastIndex(agent_id, payer.address).call()
    print(f"getLastIndex(agentId={agent_id}, payer) = {idx}")
    if idx != 2:
        raise RuntimeError(f"expected 2 feedbacks, got {idx}")

    print("\nDONE — x402 HTTP flow complete (USDC + DAI tickets, attestation, Path A + B).")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
