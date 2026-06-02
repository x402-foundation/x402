"""End-to-end demo for the ERC-8004 *ticket* flow on a local Anvil.

Spins up Anvil, deploys TicketMinter + ReputationRegistryV3, exercises both
settlement modes (plain ERC-20 transferFrom AND EIP-3009 USDC-style
transferWithAuthorization) and both feedback paths (direct + sponsored),
and verifies the tickets are consumed.

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

  Scenario 1 — plain ERC-20 (transferFrom path)
  1. payer approves the minter,
  2. facilitator calls ``TicketMinter.settleAndMintTicket`` → one tx,
     ``transferFrom`` + ticket mint, ``TicketMinted`` log emitted,
  3. Path A: payer calls ``giveFeedbackWithTicket(ticketId, …)`` →
     ticket consumed, ``NewFeedback`` emitted with ``ticketId`` field set.
  4. Path B (sponsored): payer signs an EIP-712 ``FeedbackIntent``; a
     relayer submits ``giveFeedbackWithTicketFor(submission, nonce,
     deadline, sig)`` → ticket consumed, no payer-paid gas.

  Scenario 2 — USDC-style EIP-3009 (transferWithAuthorization path)
  5. payer signs an EIP-3009 ``TransferWithAuthorization`` (no on-chain
     approval needed),
  6. facilitator calls ``TicketMinter.settleAndMintTicketEIP3009`` → one
     tx, token-level ``transferWithAuthorization`` + ticket mint,
  7. Path A: same as #3 against the new ticket.
  8. Path B (sponsored): same as #4 against the new ticket.
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

    return _recover_ticket_id_from_rcpt(rcpt)


def _recover_ticket_id_from_rcpt(rcpt: Any) -> tuple[int, str]:
    """Parse the TicketMinted log to recover (ticketId, settlement_tx_hash)."""
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
    raise RuntimeError("settle tx did not emit TicketMinted")


def _sign_eip3009_authorization(
    payer: Account,
    *,
    chain_id: int,
    token_addr: str,
    token_name: str,
    token_version: str,
    to: str,
    value: int,
    valid_after: int,
    valid_before: int,
    nonce: bytes,
) -> bytes:
    """Sign a USDC-style EIP-3009 TransferWithAuthorization message.

    Real USDC verifies this signature on-chain inside `transferWithAuthorization`.
    The MockERC3009Token used in this demo skips the check and just performs
    the transfer, but we still produce a real signature so the flow mirrors
    what a production payer does (and the bytes are accepted by both the
    mock and a real EIP-3009 token).
    """
    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": token_name,
            "version": token_version,
            "chainId": chain_id,
            "verifyingContract": Web3.to_checksum_address(token_addr),
        },
        "message": {
            "from": payer.address,
            "to": Web3.to_checksum_address(to),
            "value": value,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        },
    }
    signed = Account.sign_typed_data(payer.key, full_message=typed_data)
    return bytes(signed.signature)


def _settle_and_mint_eip3009(
    w3: Web3,
    minter: Any,
    token_addr: str,
    token_name: str,
    token_version: str,
    payer: Account,
    facilitator_signer: Account,
    pay_to: str,
    amount: int,
    agent_id: int,
    request_hash: bytes,
    interaction_hash: bytes,
    endpoint: str,
    nonce_seed: bytes,
) -> tuple[int, str]:
    """USDC-style: payer signs EIP-3009; facilitator calls settleAndMintTicketEIP3009."""
    valid_after = 0
    valid_before = w3.eth.get_block("latest")["timestamp"] + 3600
    nonce = keccak(nonce_seed)

    signature = _sign_eip3009_authorization(
        payer,
        chain_id=w3.eth.chain_id,
        token_addr=token_addr,
        token_name=token_name,
        token_version=token_version,
        to=pay_to,
        value=amount,
        valid_after=valid_after,
        valid_before=valid_before,
        nonce=nonce,
    )

    settlement = (
        Web3.to_checksum_address(token_addr),
        Web3.to_checksum_address(pay_to),
        amount,
        valid_after,
        valid_before,
        nonce,
        signature,
    )
    tx = minter.functions.settleAndMintTicketEIP3009(
        payer.address,
        agent_id,
        request_hash,
        interaction_hash,
        endpoint,
        settlement,
    ).build_transaction({"from": facilitator_signer.address})
    tx.pop("chainId", None); tx.pop("nonce", None); tx.pop("from", None)
    rcpt = _send(w3, facilitator_signer, {**tx, "gas": 600_000})
    return _recover_ticket_id_from_rcpt(rcpt)


def _path_a_direct(
    w3: Web3, registry_addr: str, payer: Account, ticket_id: int, agent_id: int
) -> None:
    """Path A: payer submits giveFeedbackWithTicket directly (pays own gas).

    Each ticket gets its own feedback_hash — the registry dedups by
    ``(agentId, payer, feedbackHash)``, so reusing one hash across tickets
    would revert with ``FeedbackHashAlreadyUsed``.
    """
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
        feedback_uri=f"mem://demo-path-a/ticket-{ticket_id}",
        feedback_hash=keccak(f"demo-artifact-path-a/ticket-{ticket_id}".encode()),
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
        feedback_uri=f"mem://demo-path-b/ticket-{ticket_id}",
        feedback_hash=keccak(f"demo-artifact-path-b/ticket-{ticket_id}".encode()),
    )
    # The relayer-replay nonce is scoped per payer in the registry, so different
    # tickets need different nonces (or the second sponsored submission reverts
    # with InvalidNonce). Use the ticketId itself for a stable, unique value.
    nonce = ticket_id
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

        # ---- Deploy MockERC20 + MockERC3009Token + MockIdentityRegistry + TicketMinter + RegistryV3 ----
        print("\nDeploying contracts via forge artifacts...")
        token_addr = _deploy(w3, deployer, "MockERC20", "MockERC20", "MERC", 6)
        print(f"  MockERC20             = {token_addr}")
        usdc_name, usdc_version = "USD Coin", "2"
        usdc_addr = _deploy(w3, deployer, "MockERC3009Token", usdc_name, "USDC", 6)
        print(f"  MockERC3009Token      = {usdc_addr}  (name=\"{usdc_name}\", version={usdc_version})")

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
        usdc_abi = _load_artifact("MockERC3009Token")["abi"]
        usdc = w3.eth.contract(address=usdc_addr, abi=usdc_abi)

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

        # ---- Mint both tokens to payer ----
        amount = 1_000_000  # 1 unit (6 decimals)
        for tok, label in ((token, "MockERC20"), (usdc, "MockERC3009Token")):
            mint_tx = tok.functions.mint(payer.address, amount * 10).build_transaction(
                {"from": deployer.address}
            )
            mint_tx.pop("chainId", None); mint_tx.pop("nonce", None); mint_tx.pop("from", None)
            _send(w3, deployer, {**mint_tx, "gas": 120_000})
            print(f"\nMinted {amount * 10} of {label} to payer.")

        # ====================================================================
        # Scenario 1: plain ERC-20 (transferFrom path)
        # ====================================================================
        print("\n\n=== Scenario 1 — plain ERC-20 (settleAndMintTicket / transferFrom) ===")

        # Ticket #1 — Path A (direct)
        print("\n--- mint ticket #1 via transferFrom ---")
        ticket_id_1, tx_1 = _settle_and_mint(
            w3, minter, token_addr, payer, facilitator,
            pay_to=agent.address, amount=amount, agent_id=agent_id,
            request_hash=keccak(b"req-1"), interaction_hash=keccak(b"int-1"),
            endpoint="https://agent.example/r",
        )
        print(f"  settle+mint tx = {tx_1}  ticketId = {ticket_id_1}")
        _print_ticket(w3, minter, ticket_id_1, "mint")
        _path_a_direct(w3, registry_addr, payer, ticket_id_1, agent_id)
        _print_ticket(w3, minter, ticket_id_1, "feedback")

        # Ticket #2 — Path B (sponsored)
        print("\n--- mint ticket #2 via transferFrom (then sponsored feedback) ---")
        ticket_id_2, tx_2 = _settle_and_mint(
            w3, minter, token_addr, payer, facilitator,
            pay_to=agent.address, amount=amount, agent_id=agent_id,
            request_hash=keccak(b"req-2"), interaction_hash=keccak(b"int-2"),
            endpoint="https://agent.example/r",
        )
        print(f"  settle+mint tx = {tx_2}  ticketId = {ticket_id_2}")
        _print_ticket(w3, minter, ticket_id_2, "mint")
        _path_b_sponsored(w3, registry_addr, payer, relayer, ticket_id_2, agent_id)
        _print_ticket(w3, minter, ticket_id_2, "feedback")

        # ====================================================================
        # Scenario 2: USDC-style EIP-3009 (transferWithAuthorization path)
        # ====================================================================
        print("\n\n=== Scenario 2 — USDC EIP-3009 (settleAndMintTicketEIP3009) ===")

        # Ticket #3 — Path A
        print("\n--- mint ticket #3 via EIP-3009 transferWithAuthorization ---")
        ticket_id_3, tx_3 = _settle_and_mint_eip3009(
            w3, minter, usdc_addr, usdc_name, usdc_version,
            payer, facilitator,
            pay_to=agent.address, amount=amount, agent_id=agent_id,
            request_hash=keccak(b"req-3"), interaction_hash=keccak(b"int-3"),
            endpoint="https://agent.example/r",
            nonce_seed=b"eip3009-demo-nonce-3",
        )
        print(f"  payer signed EIP-3009 TransferWithAuthorization (no on-chain approval)")
        print(f"  settle+mint tx = {tx_3}  ticketId = {ticket_id_3}")
        _print_ticket(w3, minter, ticket_id_3, "mint")
        _path_a_direct(w3, registry_addr, payer, ticket_id_3, agent_id)
        _print_ticket(w3, minter, ticket_id_3, "feedback")

        # Ticket #4 — Path B
        print("\n--- mint ticket #4 via EIP-3009 (then sponsored feedback) ---")
        ticket_id_4, tx_4 = _settle_and_mint_eip3009(
            w3, minter, usdc_addr, usdc_name, usdc_version,
            payer, facilitator,
            pay_to=agent.address, amount=amount, agent_id=agent_id,
            request_hash=keccak(b"req-4"), interaction_hash=keccak(b"int-4"),
            endpoint="https://agent.example/r",
            nonce_seed=b"eip3009-demo-nonce-4",
        )
        print(f"  settle+mint tx = {tx_4}  ticketId = {ticket_id_4}")
        _print_ticket(w3, minter, ticket_id_4, "mint")
        _path_b_sponsored(w3, registry_addr, payer, relayer, ticket_id_4, agent_id)
        _print_ticket(w3, minter, ticket_id_4, "feedback")

        # ---- Final assertions ----
        ticket_ids = (ticket_id_1, ticket_id_2, ticket_id_3, ticket_id_4)
        states = [minter.functions.tickets(tid).call()[5] for tid in ticket_ids]
        assert all(s == 2 for s in states), f"some tickets not CONSUMED: {dict(zip(ticket_ids, states))}"

        # NewFeedback is recorded per (agent, payer, feedbackHash); the demo
        # uses 4 distinct feedback hashes, but Path B feedbacks come from the
        # relayer in the registry's eyes via giveFeedbackWithTicketFor (which
        # records the *payer* as clientAddress). So getLastIndex(agent, payer)
        # should hit 4.
        idx = registry.functions.getLastIndex(agent_id, payer.address).call()
        assert idx == 4, f"expected 4 feedbacks recorded under payer, got {idx}"

        print("\n\nDONE — both scenarios, both feedback paths green.")
        print(f"  Scenario 1 (ERC-20 transferFrom):")
        print(f"    ticket #{ticket_id_1}: MINTED -> CONSUMED  (Path A direct)")
        print(f"    ticket #{ticket_id_2}: MINTED -> CONSUMED  (Path B sponsored)")
        print(f"  Scenario 2 (USDC EIP-3009):")
        print(f"    ticket #{ticket_id_3}: MINTED -> CONSUMED  (Path A direct)")
        print(f"    ticket #{ticket_id_4}: MINTED -> CONSUMED  (Path B sponsored)")
        print(f"  ReputationRegistryV3.getLastIndex(agentId={agent_id}, payer) = {idx}")
        return 0

    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    sys.exit(main())
