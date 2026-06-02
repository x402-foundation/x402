"""End-to-end demo for the ERC-8004 *ticket* flow on a local Anvil.

Spins up Anvil, deploys TicketMinter + ReputationRegistryV3 via the Foundry
script, exercises both feedback paths (direct + sponsored), and verifies the
ticket is consumed.

No Pinata, no external IPFS. The artifact stays in-memory because the demo's
goal is the on-chain ticket lifecycle, not the off-chain artifact pipeline
(``main.py`` covers that).

Requirements:
  - Foundry (``anvil``, ``forge`` on PATH)
  - The x402 Python SDK installed in editable mode (``uv pip install -e .``
    from ``python/x402``).

Run:
    cd python/x402
    uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py

What the demo proves:
  1. ``TicketMinter.settleAndMintTicket`` mints a ticket atomically with the
     ERC-20 transfer (one tx, ``TicketMinted`` log emitted).
  2. ``ticket_id_from_receipt`` recovers the ticketId from the log.
  3. Path A: payer calls ``giveFeedbackWithTicket(ticketId, …)`` → ticket
     consumed, ``NewFeedback`` emitted with ``ticketId`` field set.
  4. Path B (sponsored): payer signs an EIP-712 ``FeedbackIntent``; a relayer
     submits ``giveFeedbackWithTicketFor(submission, nonce, deadline, sig)`` →
     ticket consumed, no payer-paid gas.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from eth_account import Account
from eth_utils import keccak
from web3 import Web3

from x402.extensions.erc8004 import ERC8004Config, ERCFeedbackClient, FeedbackParams
from x402.extensions.erc8004.constants import get_ticket_minted_topic

# Anvil dev accounts (well-known pre-funded keys — NOT secrets).
ANVIL_KEY_DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # acct 0
ANVIL_KEY_PAYER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"     # acct 1
ANVIL_KEY_AGENT = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"     # acct 2
ANVIL_KEY_RELAYER = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"   # acct 3

# Trivial ERC-20 with public `mint(address,uint256)` and `approve`. Compiled
# from a minimal contract; constants here are the SAME bytecode forge produces
# from `MockERC20.sol`. Loaded at runtime from the foundry build artifacts.
REPO_ROOT = Path(__file__).resolve().parents[4]
FOUNDRY_OUT = REPO_ROOT / "contracts" / "evm" / "out"
FOUNDRY_DIR = REPO_ROOT / "contracts" / "evm"


def _load_artifact(name: str) -> dict[str, Any]:
    """Load a Foundry build artifact by contract name (e.g. ``MockERC20.sol/MockERC20.json``)."""
    path = FOUNDRY_OUT / f"{name}.sol" / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Build artifact missing: {path}. Run `FOUNDRY_PROFILE=erc8004 forge build` first."
        )
    return json.loads(path.read_text())


def _send(w3: Web3, signer: Account, tx: dict) -> Any:
    base_fee = w3.eth.get_block("latest")["baseFeePerGas"]
    tx = {
        **tx,
        "type": 2,
        "chainId": w3.eth.chain_id,
        "nonce": w3.eth.get_transaction_count(signer.address),
        "maxFeePerGas": w3.eth.max_priority_fee + 2 * base_fee,
        "maxPriorityFeePerGas": w3.eth.max_priority_fee,
    }
    signed = signer.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"tx reverted: {tx_hash.hex()}")
    return rcpt


def _deploy(w3: Web3, signer: Account, artifact_name: str, *args: Any) -> str:
    """Deploy a contract by name, using its forge build artifact, with constructor args."""
    artifact = _load_artifact(artifact_name)
    contract = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"]["object"])
    tx = contract.constructor(*args).build_transaction({"from": signer.address})
    tx.pop("chainId", None)
    tx.pop("nonce", None)
    tx.pop("from", None)
    rcpt = _send(w3, signer, {**tx, "gas": 5_000_000})
    return Web3.to_checksum_address(rcpt["contractAddress"])


def _start_anvil(port: int) -> subprocess.Popen:
    proc = subprocess.Popen(
        ["anvil", "--hardfork", "Prague", "--chain-id", "31337", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def _wait_for_rpc(w3: Web3, timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if w3.is_connected():
                return True
        except Exception:
            pass
        time.sleep(0.1)
    return False


def _ensure_built() -> None:
    """Make sure the erc8004 contracts are compiled. Builds via forge if needed."""
    sentinel = FOUNDRY_OUT / "TicketMinter.sol" / "TicketMinter.json"
    if sentinel.exists():
        return
    print("Building contracts (forge build, erc8004 profile)...")
    res = subprocess.run(
        ["forge", "build"],
        cwd=FOUNDRY_DIR,
        env={**os.environ, "FOUNDRY_PROFILE": "erc8004"},
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print("forge build failed:")
        print(res.stdout)
        print(res.stderr)
        sys.exit(1)


def _print_ticket(w3: Web3, minter: Any, ticket_id: int, label: str) -> None:
    tdata = minter.functions.tickets(ticket_id).call()
    print(
        f"  ticket #{ticket_id} after {label}: payer={tdata[0]} agentId={tdata[1]} "
        f"status={['NONE','MINTED','CONSUMED'][tdata[5]]}"
    )


def _settle_and_mint(
    w3: Web3,
    minter: Any,
    token_addr: str,
    payer: Account,
    facilitator_signer: Account,
    pay_to: str,
    amount: int,
    agent_id: int,
    request_hash: bytes,
    interaction_hash: bytes,
    endpoint: str,
) -> tuple[int, str]:
    """Approve + settleAndMintTicket. Returns (ticketId, settlement_tx_hash)."""
    # 1) payer approves the minter to pull tokens.
    erc20 = w3.eth.contract(address=Web3.to_checksum_address(token_addr), abi=_load_artifact("MockERC20")["abi"])
    approve_tx = erc20.functions.approve(minter.address, 2**256 - 1).build_transaction({"from": payer.address})
    approve_tx.pop("chainId", None)
    approve_tx.pop("nonce", None)
    approve_tx.pop("from", None)
    _send(w3, payer, {**approve_tx, "gas": 100_000})

    # 2) facilitator calls TicketMinter.settleAndMintTicket (1 tx, transferFrom + mint).
    settle_tx = minter.functions.settleAndMintTicket(
        payer.address,
        agent_id,
        request_hash,
        interaction_hash,
        endpoint,
        (Web3.to_checksum_address(token_addr), Web3.to_checksum_address(pay_to), amount),
    ).build_transaction({"from": facilitator_signer.address})
    settle_tx.pop("chainId", None)
    settle_tx.pop("nonce", None)
    settle_tx.pop("from", None)
    rcpt = _send(w3, facilitator_signer, {**settle_tx, "gas": 500_000})

    # 3) parse the TicketMinted log to recover ticketId.
    topic0 = get_ticket_minted_topic()
    for log in rcpt["logs"]:
        topics = log["topics"]
        topic0_hex = topics[0].hex() if isinstance(topics[0], (bytes, bytearray)) else str(topics[0])
        if not topic0_hex.startswith("0x"):
            topic0_hex = "0x" + topic0_hex
        if topic0_hex.lower() == topic0.lower():
            tid = topics[1]
            tid_hex = tid.hex() if isinstance(tid, (bytes, bytearray)) else str(tid)
            return int(tid_hex, 16), rcpt["transactionHash"].hex()
    raise RuntimeError("settleAndMintTicket did not emit TicketMinted")


def _path_a_direct(
    w3: Web3, registry_addr: str, payer: Account, ticket_id: int, agent_id: int
) -> None:
    """Path A: payer submits giveFeedbackWithTicket directly (pays own gas)."""
    print("\n--- Path A: direct giveFeedbackWithTicket ---")
    cfg = ERC8004Config(
        network=f"eip155:{w3.eth.chain_id}",
        reputation_registry=registry_addr,
        identity_registry="0x" + "00" * 20,
        rpc_url=w3.provider.endpoint_uri,
    )
    client = ERCFeedbackClient(cfg, payer)
    params = FeedbackParams(
        agent_id=agent_id,
        value=95,
        value_decimals=0,
        tag1="quality",
        tag2="x402-anvil",
        endpoint="https://agent.example/r",
        feedback_uri="mem://demo",
        feedback_hash=keccak(b"demo-artifact-path-a"),
    )
    tx_hash = client.submit_feedback_with_ticket(ticket_id, params)
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"giveFeedbackWithTicket reverted: {tx_hash}")
    print(f"  giveFeedbackWithTicket tx = {tx_hash} (block {rcpt['blockNumber']}, gas {rcpt['gasUsed']})")


def _path_b_sponsored(
    w3: Web3,
    registry_addr: str,
    payer: Account,
    relayer: Account,
    ticket_id: int,
    agent_id: int,
) -> None:
    """Path B: payer signs an EIP-712 FeedbackIntent; relayer broadcasts."""
    print("\n--- Path B: sponsored giveFeedbackWithTicketFor ---")
    cfg = ERC8004Config(
        network=f"eip155:{w3.eth.chain_id}",
        reputation_registry=registry_addr,
        identity_registry="0x" + "00" * 20,
        rpc_url=w3.provider.endpoint_uri,
    )
    # Two ERCFeedbackClients: one to *build* the intent (uses payer for chain_id
    # lookup), another to *submit* it (uses the relayer as the signer).
    payer_client = ERCFeedbackClient(cfg, payer)
    relayer_client = ERCFeedbackClient(cfg, relayer)

    params = FeedbackParams(
        agent_id=agent_id,
        value=80,
        value_decimals=0,
        tag1="quality",
        tag2="x402-sponsored",
        endpoint="https://agent.example/r",
        feedback_uri="mem://demo-sponsored",
        feedback_hash=keccak(b"demo-artifact-path-b"),
    )
    nonce = 1
    deadline = w3.eth.get_block("latest")["timestamp"] + 3600

    domain, types, message = payer_client.build_feedback_intent(ticket_id, params, nonce, deadline)
    signed = Account.sign_typed_data(
        payer.key,
        domain_data=domain,
        message_types={k: v for k, v in types.items() if k != "EIP712Domain"},
        message_data=message,
    )
    sig = signed.signature

    tx_hash = relayer_client.submit_feedback_sponsored(
        payer=payer.address,
        ticket_id=ticket_id,
        params=params,
        nonce=nonce,
        deadline=deadline,
        signature=sig,
    )
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if rcpt["status"] != 1:
        raise RuntimeError(f"giveFeedbackWithTicketFor reverted: {tx_hash}")
    print(f"  payer signed FeedbackIntent (no on-chain tx from payer)")
    print(f"  relayer {relayer.address[:10]}... submitted: tx = {tx_hash} (block {rcpt['blockNumber']})")


def main() -> int:
    if shutil.which("anvil") is None or shutil.which("forge") is None:
        print("ERROR: Foundry (anvil + forge) required on PATH. https://book.getfoundry.sh")
        return 1

    _ensure_built()

    port = int(os.getenv("ANVIL_PORT", "8545"))
    proc = _start_anvil(port)
    try:
        url = f"http://127.0.0.1:{port}"
        w3 = Web3(Web3.HTTPProvider(url))
        if not _wait_for_rpc(w3):
            print("ERROR: Anvil did not come up.")
            err = (proc.stderr.read() if proc.stderr else b"").decode(errors="replace")[:2000]
            print(err)
            return 1

        deployer = Account.from_key(ANVIL_KEY_DEPLOYER)
        payer = Account.from_key(ANVIL_KEY_PAYER)
        agent = Account.from_key(ANVIL_KEY_AGENT)
        relayer = Account.from_key(ANVIL_KEY_RELAYER)
        facilitator = deployer  # in this demo, the facilitator key == deployer

        print(f"chainId           = {w3.eth.chain_id}")
        print(f"deployer/fac      = {deployer.address}")
        print(f"payer (client)    = {payer.address}")
        print(f"agent owner       = {agent.address}")
        print(f"relayer           = {relayer.address}")
        print(f"payTo             = {agent.address} (agent receives the payment)")

        # ---- Deploy MockERC20 + MockIdentityRegistry + TicketMinter + RegistryV3 ----
        print("\nDeploying contracts via forge artifacts...")
        token_addr = _deploy(w3, deployer, "MockERC20", "USDC", "USDC", 6)
        print(f"  MockERC20             = {token_addr}")

        identity_addr = _deploy(w3, deployer, "MockIdentityRegistry")
        print(f"  MockIdentityRegistry  = {identity_addr}")

        # TicketMinter(owner=deployer, permit2=address(0))
        minter_addr = _deploy(
            w3, deployer, "TicketMinter", deployer.address, "0x" + "00" * 20
        )
        print(f"  TicketMinter          = {minter_addr}")

        registry_addr = _deploy(
            w3, deployer, "ReputationRegistryV3", identity_addr, minter_addr
        )
        print(f"  ReputationRegistryV3  = {registry_addr}")

        # Use the full forge ABI here (it includes admin setters like
        # setFacilitator + setReputationRegistry that TICKET_MINTER_ABI omits
        # because clients shouldn't need them).
        minter = w3.eth.contract(address=minter_addr, abi=_load_artifact("TicketMinter")["abi"])
        registry_abi = _load_artifact("ReputationRegistryV3")["abi"]
        registry = w3.eth.contract(address=registry_addr, abi=registry_abi)
        identity_abi = _load_artifact("MockIdentityRegistry")["abi"]
        identity = w3.eth.contract(address=identity_addr, abi=identity_abi)
        token_abi = _load_artifact("MockERC20")["abi"]
        token = w3.eth.contract(address=token_addr, abi=token_abi)

        # ---- Wire minter: facilitator + registry, then point identity at agent ----
        print("\nWiring contracts...")
        for fn, label in (
            (minter.functions.setFacilitator(facilitator.address, True), "setFacilitator"),
            (minter.functions.setReputationRegistry(registry_addr), "setReputationRegistry"),
            (identity.functions.setOwner(7, agent.address), "MockIdentity.setOwner(7, agent)"),
        ):
            tx = fn.build_transaction({"from": deployer.address})
            tx.pop("chainId", None); tx.pop("nonce", None); tx.pop("from", None)
            _send(w3, deployer, {**tx, "gas": 200_000})
            print(f"  {label}")

        agent_id = 7

        # ---- Mint USDC to payer ----
        amount = 1_000_000  # 1 USDC
        mint_tx = token.functions.mint(payer.address, amount * 10).build_transaction({"from": deployer.address})
        mint_tx.pop("chainId", None); mint_tx.pop("nonce", None); mint_tx.pop("from", None)
        _send(w3, deployer, {**mint_tx, "gas": 120_000})
        print(f"\nMinted {amount * 10} of MockUSDC to payer.")

        # ---- Settle + mint ticket for Path A ----
        print("\n=== Path A: settle + mint, then payer gives feedback ===")
        request_hash = keccak(b"request-A")
        interaction_hash = keccak(b"interaction-A")
        ticket_id_a, tx_a = _settle_and_mint(
            w3, minter, token_addr, payer, facilitator,
            pay_to=agent.address, amount=amount, agent_id=agent_id,
            request_hash=request_hash, interaction_hash=interaction_hash,
            endpoint="https://agent.example/r",
        )
        print(f"  settle+mint tx = {tx_a}")
        print(f"  recovered ticketId = {ticket_id_a}")
        _print_ticket(w3, minter, ticket_id_a, "mint")

        _path_a_direct(w3, registry_addr, payer, ticket_id_a, agent_id)
        _print_ticket(w3, minter, ticket_id_a, "feedback")

        # ---- Settle + mint ticket for Path B (sponsored) ----
        print("\n\n=== Path B: settle + mint, then RELAYER submits payer-signed feedback ===")
        request_hash_b = keccak(b"request-B")
        interaction_hash_b = keccak(b"interaction-B")
        ticket_id_b, tx_b = _settle_and_mint(
            w3, minter, token_addr, payer, facilitator,
            pay_to=agent.address, amount=amount, agent_id=agent_id,
            request_hash=request_hash_b, interaction_hash=interaction_hash_b,
            endpoint="https://agent.example/r",
        )
        print(f"  settle+mint tx = {tx_b}")
        print(f"  recovered ticketId = {ticket_id_b}")
        _print_ticket(w3, minter, ticket_id_b, "mint")

        _path_b_sponsored(w3, registry_addr, payer, relayer, ticket_id_b, agent_id)
        _print_ticket(w3, minter, ticket_id_b, "feedback")

        # ---- Final assertions ----
        a = minter.functions.tickets(ticket_id_a).call()
        b = minter.functions.tickets(ticket_id_b).call()
        assert a[5] == 2 and b[5] == 2, f"tickets not CONSUMED: A={a[5]}, B={b[5]}"
        idx_a = registry.functions.getLastIndex(agent_id, payer.address).call()
        # idx_a counts feedbacks from `payer` to `agent_id`, which is 2 (Path A + Path B).
        assert idx_a == 2, f"expected 2 feedbacks recorded, got {idx_a}"

        print("\n\nDONE — both paths green.")
        print(f"  ticket #{ticket_id_a}: MINTED -> CONSUMED (Path A direct)")
        print(f"  ticket #{ticket_id_b}: MINTED -> CONSUMED (Path B sponsored)")
        print(f"  ReputationRegistryV3.getLastIndex(agentId={agent_id}, payer) = {idx_a}")
        return 0

    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    sys.exit(main())
