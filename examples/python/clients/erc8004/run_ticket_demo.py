"""End-to-end demo for the ERC-8004 *ticket* flow against a mainnet fork.

Forks Ethereum mainnet (or any RPC you point ``RPC_URL`` at) into a local
Anvil, impersonates known whales to fund the payer with **real USDC and DAI**
(no mocks), deploys ``X402AgentReputation`` onto the fork,
and exercises both feedback paths against each token's natural settlement
mode:

  Scenario 1 — USDC via EIP-3009 ``transferWithAuthorization``:
    Ticket #1 — Path A (direct ``giveFeedbackWithTicket``)
    Ticket #2 — Path B (payer signs ``FeedbackIntent``, relayer broadcasts)

  Scenario 2 — DAI via ``transferFrom`` (``X402AgentReputation.settleAndMintTicket``):
    Ticket #3 — Path A
    Ticket #4 — Path B

USDC supports EIP-3009 natively — the payer signs an off-chain authorization,
no on-chain approval needed. DAI doesn't expose ``transferWithAuthorization``
(it has its own non-standard ``permit``), so the ``transferFrom`` path of
``X402AgentReputation.settleAndMintTicket`` is the natural fit there.

Requirements:
  - Foundry (``anvil``, ``forge`` on PATH)
  - The x402 Python SDK installed in editable mode (``uv pip install -e .``
    from ``python/x402``).
  - Internet access (to talk to the upstream mainnet RPC). Defaults to a
    public RPC; override with ``RPC_URL=<your-rpc>``.

Run:
    cd python/x402
    uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py

Optional overrides (with sane defaults):
  RPC_URL          mainnet RPC to fork from
  ANVIL_PORT       local fork port (default 8545)
  USDC_WHALE       account to impersonate for USDC funding
  DAI_WHALE        account to impersonate for DAI funding
  IDENTITY_REGISTRY  if set, use this real IdentityRegistry on the fork
                     instead of deploying a MockIdentityRegistry.
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

# Local helpers — share the legacy demo's register_agent / fund_gas logic so we
# don't duplicate the IdentityRegistry calldata variants.
sys.path.insert(0, str(Path(__file__).parent))
from utils import fund_gas_if_low, register_agent  # noqa: E402

# Anvil dev account #0 — used as the deployer + facilitator. The other actors
# (payer, agent, relayer) are generated fresh each run because the well-known
# anvil dev addresses may be EIP-7702-delegated on mainnet, which causes
# USDC's EIP-3009 SignatureChecker to route through EIP-1271 and fail.
ANVIL_KEY_DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # acct 0

REPO_ROOT = Path(__file__).resolve().parents[4]
FOUNDRY_OUT = REPO_ROOT / "contracts" / "evm" / "out"
FOUNDRY_DIR = REPO_ROOT / "contracts" / "evm"

# Canonical mainnet tokens (override with real addresses on other chains).
MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
MAINNET_DAI = "0x6B175474E89094C44Da98b954Eedeac495271d0F"

# Canonical ERC-8004 IdentityRegistry on mainnet.
MAINNET_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"

# USDC EIP-712 domain (real USDC uses these). Verified against the
# `transferWithAuthorization` typed-data verifier on the deployed contract.
USDC_DOMAIN_NAME = "USD Coin"
USDC_DOMAIN_VERSION = "2"

# Default public RPCs. Free, no API key. The demo tries each in order until
# one responds. Override with ``RPC_URL=<your-rpc>`` to skip the probe.
DEFAULT_PUBLIC_RPCS = (
    "https://eth.merkle.io",
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
)

# Known whale addresses for funding the payer on the fork.
DEFAULT_USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8"  # Circle
DEFAULT_DAI_WHALE = "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf"   # Polygon bridge

# Minimal ABI for whale impersonation + balance/allowance checks.
ERC20_ABI = [
    {"name": "transfer", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "decimals", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
    {"name": "approve", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
]


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


def _try_fork(port: int, candidates: tuple[str, ...]) -> tuple[str, subprocess.Popen] | None:
    """Try each candidate RPC by actually launching ``anvil --fork-url`` against
    it. Returns ``(rpc_url, anvil_process)`` for the first one that comes up,
    or ``None`` if none work.

    We skip an HTTP probe because most public RPCs gate against bare ``curl``
    / ``urllib`` headers (403) but happily accept Anvil's own User-Agent.
    """
    for url in candidates:
        print(f"  trying fork from {url} ...")
        proc = _start_anvil_fork(port, url)
        w3 = Web3(Web3.HTTPProvider(f"http://127.0.0.1:{port}"))
        if _wait_for_rpc(w3, timeout_s=15.0):
            try:
                # Anvil RPC came up — verify it actually forked (chain_id readable).
                _ = w3.eth.chain_id
                _ = w3.eth.block_number
                print(f"  OK: {url}")
                return url, proc
            except Exception as e:
                print(f"  fork didn't initialize ({url}): {e}")
        proc.terminate(); proc.wait()
    return None


def _start_anvil_fork(port: int, fork_url: str) -> subprocess.Popen:
    """Spawn an Anvil that forks ``fork_url``. The fork is ephemeral."""
    cmd = ["anvil", "--fork-url", fork_url, "--port", str(port)]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _fund_eth(w3: Web3, address: str, eth: float) -> None:
    """Use anvil_setBalance to give ``address`` ``eth`` worth of ETH."""
    w3.provider.make_request(
        "anvil_setBalance",
        [Web3.to_checksum_address(address), hex(w3.to_wei(eth, "ether"))],
    )


def _fund_erc20_from_whale(
    w3: Web3, token: str, recipient: str, needed: int, whale: str
) -> None:
    """Top up ``recipient`` with ``needed`` of ``token`` by impersonating ``whale``.

    No-op if the recipient already holds at least ``needed``. Uses
    ``anvil_setBalance`` + ``anvil_impersonateAccount`` so the whale can pay
    for its own gas to transfer the token.
    """
    token_cs = Web3.to_checksum_address(token)
    recipient_cs = Web3.to_checksum_address(recipient)
    whale_cs = Web3.to_checksum_address(whale)
    erc20 = w3.eth.contract(address=token_cs, abi=ERC20_ABI)

    cur = int(erc20.functions.balanceOf(recipient_cs).call())
    if cur >= needed:
        print(f"  recipient already holds {cur} of {token_cs}; no funding needed")
        return

    whale_bal = int(erc20.functions.balanceOf(whale_cs).call())
    if whale_bal < needed:
        raise RuntimeError(
            f"whale {whale_cs} holds {whale_bal} of {token_cs}, < needed {needed}. "
            "Set USDC_WHALE / DAI_WHALE to an address with a larger balance."
        )

    _fund_eth(w3, whale_cs, 10.0)
    w3.provider.make_request("anvil_impersonateAccount", [whale_cs])
    try:
        # Build transfer(recipient, needed) calldata.
        sel = bytes.fromhex("a9059cbb")  # keccak("transfer(address,uint256)")[:4]
        addr_padded = bytes.fromhex(recipient_cs[2:]).rjust(32, b"\x00")
        amt_padded = needed.to_bytes(32, "big")
        data = "0x" + (sel + addr_padded + amt_padded).hex()
        tx_hash = w3.eth.send_transaction(
            {"from": whale_cs, "to": token_cs, "data": data, "value": 0, "gas": 200000}
        )
        rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
        if rcpt["status"] != 1:
            raise RuntimeError("whale ERC-20 transfer reverted")
    finally:
        w3.provider.make_request("anvil_stopImpersonatingAccount", [whale_cs])
    print(f"  whale {whale_cs[:10]}... → recipient {recipient_cs[:10]}...: {needed} of {token_cs}")


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
    sentinel = FOUNDRY_OUT / "X402AgentReputation.sol" / "X402AgentReputation.json"
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


def _print_ticket(w3: Web3, wrapper: Any, ticket_id: int, label: str) -> None:
    tdata = wrapper.functions.tickets(ticket_id).call()
    print(
        f"  ticket #{ticket_id} after {label}: payer={tdata[0]} agentId={tdata[1]} "
        f"agentAddress={tdata[2]} consumed={tdata[5]}"
    )


def _settle_and_mint(
    w3: Web3,
    wrapper: Any,
    token_addr: str,
    payer: Account,
    facilitator_signer: Account,
    pay_to: str,
    amount: int,
    agent_id: int,
) -> tuple[int, str]:
    """Approve + settleAndMintTicket. Returns (ticketId, settlement_tx_hash)."""
    erc20 = w3.eth.contract(address=Web3.to_checksum_address(token_addr), abi=ERC20_ABI)
    approve_tx = erc20.functions.approve(wrapper.address, 2**256 - 1).build_transaction({"from": payer.address})
    approve_tx.pop("chainId", None)
    approve_tx.pop("nonce", None)
    approve_tx.pop("from", None)
    _send(w3, payer, {**approve_tx, "gas": 100_000})

    settle_tx = wrapper.functions.settleAndMintTicket(
        payer.address,
        agent_id,
        Web3.to_checksum_address(pay_to),
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
    tx_hash = rcpt["transactionHash"]
    tx_hash_hex = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
    if not tx_hash_hex.startswith("0x"):
        tx_hash_hex = "0x" + tx_hash_hex

    for log in rcpt.get("logs", []) or []:
        topics = log.get("topics") or []
        if not topics:
            continue
        topic0_hex = topics[0].hex() if isinstance(topics[0], (bytes, bytearray)) else str(topics[0])
        if not topic0_hex.startswith("0x"):
            topic0_hex = "0x" + topic0_hex
        if topic0_hex.lower() != topic0.lower():
            continue
        tid = topics[1]
        if isinstance(tid, (bytes, bytearray)):
            return int.from_bytes(tid, "big"), tx_hash_hex
        tid_hex = str(tid)
        return int(tid_hex, 16), tx_hash_hex

    debug_topics = []
    for log in rcpt.get("logs", []) or []:
        topics = log.get("topics") or []
        if topics:
            t0 = topics[0].hex() if isinstance(topics[0], (bytes, bytearray)) else str(topics[0])
            debug_topics.append(t0 if str(t0).startswith("0x") else "0x" + str(t0))
    raise RuntimeError(
        f"settle tx did not emit TicketMinted (status={rcpt.get('status')}, "
        f"expected_topic={topic0}, log_topics={debug_topics[:8]})"
    )


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
    domain = {
        "name": token_name,
        "version": token_version,
        "chainId": int(chain_id),
        "verifyingContract": Web3.to_checksum_address(token_addr),
    }
    types = {
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ],
    }
    message = {
        "from": payer.address,
        "to": Web3.to_checksum_address(to),
        "value": int(value),
        "validAfter": int(valid_after),
        "validBefore": int(valid_before),
        "nonce": nonce,
    }
    signed = Account.sign_typed_data(
        payer.key,
        domain_data=domain,
        message_types=types,
        message_data=message,
    )
    return bytes(signed.signature)


def _settle_and_mint_eip3009(
    w3: Web3,
    wrapper: Any,
    token_addr: str,
    token_name: str,
    token_version: str,
    payer: Account,
    facilitator_signer: Account,
    pay_to: str,
    amount: int,
    agent_id: int,
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
    tx = wrapper.functions.settleAndMintTicketEIP3009(
        payer.address,
        agent_id,
        Web3.to_checksum_address(pay_to),
        settlement,
    ).build_transaction({"from": facilitator_signer.address})
    tx.pop("chainId", None); tx.pop("nonce", None); tx.pop("from", None)
    rcpt = _send(w3, facilitator_signer, {**tx, "gas": 600_000})
    return _recover_ticket_id_from_rcpt(rcpt)


def _path_a_direct(
    w3: Web3,
    wrapper_addr: str,
    payer: Account,
    ticket_id: int,
    agent_id: int,
) -> None:
    """Path A: payer submits giveFeedbackWithTicket directly (pays own gas).

    Each ticket gets its own feedback_hash — the registry dedups by
    ``(agentId, payer, feedbackHash)``, so reusing one hash across tickets
    would revert with ``FeedbackHashAlreadyUsed``.
    """
    print("\n--- Path A: direct giveFeedbackWithTicket ---")
    cfg = ERC8004Config(
        network=f"eip155:{w3.eth.chain_id}",
        reputation_registry=wrapper_addr,
        wrapper_address=wrapper_addr,
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
    wrapper_addr: str,
    payer: Account,
    relayer: Account,
    ticket_id: int,
    agent_id: int,
) -> None:
    """Path B: payer signs an EIP-712 FeedbackIntent; relayer broadcasts."""
    print("\n--- Path B: sponsored giveFeedbackWithTicketFor ---")
    cfg = ERC8004Config(
        network=f"eip155:{w3.eth.chain_id}",
        reputation_registry=wrapper_addr,
        wrapper_address=wrapper_addr,
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
    usdc_addr = Web3.to_checksum_address(os.getenv("USDC_ASSET", MAINNET_USDC))
    dai_addr = Web3.to_checksum_address(os.getenv("DAI_ASSET", MAINNET_DAI))
    usdc_whale = Web3.to_checksum_address(os.getenv("USDC_WHALE", DEFAULT_USDC_WHALE))
    dai_whale = Web3.to_checksum_address(os.getenv("DAI_WHALE", DEFAULT_DAI_WHALE))

    if os.getenv("RPC_URL"):
        candidates: tuple[str, ...] = (os.environ["RPC_URL"],)
    else:
        candidates = DEFAULT_PUBLIC_RPCS

    print("Bringing up a local mainnet fork...")
    forked = _try_fork(port, candidates)
    if forked is None:
        print(
            "ERROR: no upstream mainnet RPC could be forked. Set RPC_URL=<your-rpc> "
            "(an Alchemy / Infura / private RPC works reliably; the public RPCs in "
            "DEFAULT_PUBLIC_RPCS rate-limit or 403 sporadically)."
        )
        return 1
    rpc_url, proc = forked
    try:
        url = f"http://127.0.0.1:{port}"
        w3 = Web3(Web3.HTTPProvider(url))

        # Sanity-check we're actually forked from mainnet, not running stand-alone.
        if w3.eth.chain_id != 1:
            print(f"WARN: forked chainId = {w3.eth.chain_id} (expected 1 for mainnet)")
        else:
            print(f"  fork is live (chainId={w3.eth.chain_id}, head block={w3.eth.block_number})")

        deployer = Account.from_key(ANVIL_KEY_DEPLOYER)
        # Fresh random keys for payer / agent / relayer — see ANVIL_KEY_DEPLOYER
        # comment for why we don't reuse the public anvil dev keys here.
        payer = Account.create()
        agent = Account.create()
        relayer = Account.create()
        facilitator = deployer  # in this demo, the facilitator key == deployer

        # Fund all our accounts with ETH on the fork (gas).
        for acct, label in ((deployer, "deployer"), (payer, "payer"), (agent, "agent"), (relayer, "relayer")):
            _fund_eth(w3, acct.address, 100.0)
        print(f"\n  funded deployer/payer/agent/relayer with 100 ETH each on the fork")

        print(f"\nchainId           = {w3.eth.chain_id}")
        print(f"deployer/fac      = {deployer.address}")
        print(f"payer (client)    = {payer.address}")
        print(f"agent owner       = {agent.address}")
        print(f"relayer           = {relayer.address}")
        print(f"payTo             = {agent.address} (agent receives the payment)")
        print(f"USDC              = {usdc_addr}")
        print(f"DAI               = {dai_addr}")

        # ---- Sanity-check USDC + DAI are actually deployed on the fork ----
        for addr, label in ((usdc_addr, "USDC"), (dai_addr, "DAI")):
            code = w3.eth.get_code(addr)
            if not code or code == b"\x00":
                print(f"ERROR: {label} has no code at {addr} on the fork. Wrong RPC?")
                return 1

        # ---- Fund payer with USDC + DAI by impersonating whales ----
        amount_usdc = 1_000_000  # 1 USDC (6 decimals)
        amount_dai = 1 * 10**18  # 1 DAI (18 decimals)
        print("\nFunding payer with USDC + DAI from whales...")
        _fund_erc20_from_whale(w3, usdc_addr, payer.address, amount_usdc * 10, usdc_whale)
        _fund_erc20_from_whale(w3, dai_addr, payer.address, amount_dai * 10, dai_whale)

        # ---- Use the canonical ERC-8004 IdentityRegistry on the fork ----
        identity_addr = Web3.to_checksum_address(
            os.getenv("IDENTITY_REGISTRY", MAINNET_IDENTITY_REGISTRY)
        )
        identity_code = w3.eth.get_code(identity_addr)
        if not identity_code or identity_code == b"\x00":
            print(
                f"ERROR: no IdentityRegistry at {identity_addr} on the fork. "
                "Set IDENTITY_REGISTRY=<addr> if you're on a non-mainnet fork."
            )
            return 1
        print(f"\nIdentityRegistry (canonical, on-chain) = {identity_addr}")

        # Register a fresh agent (owned by `agent`). The ReputationRegistry
        # forbids self-feedback, so the agent owner MUST differ from the payer
        # — which is why we generate distinct random keys.
        fund_gas_if_low(w3, payer, agent.address)
        print(f"Registering a fresh agent (owner = {agent.address})...")
        agent_id = register_agent(w3, agent, identity_addr)
        print(f"  agentId = {agent_id}  (owner = ownerOf({agent_id}) = {agent.address})")

        # ---- Deploy X402AgentReputation (v2 wrapper) ----
        print("\nDeploying ticket-flow contracts onto the fork...")
        wrapper_addr = _deploy(
            w3,
            deployer,
            "X402AgentReputation",
            deployer.address,
            "0x" + "00" * 20,
            identity_addr,
        )
        print(f"  X402AgentReputation = {wrapper_addr}  (uses canonical IdentityRegistry)")

        wrapper = w3.eth.contract(address=wrapper_addr, abi=_load_artifact("X402AgentReputation")["abi"])

        # ---- Wire wrapper: facilitator allowlist ----
        print("\nWiring contracts...")
        tx = wrapper.functions.setFacilitator(facilitator.address, True).build_transaction(
            {"from": deployer.address}
        )
        tx.pop("chainId", None)
        tx.pop("nonce", None)
        tx.pop("from", None)
        _send(w3, deployer, {**tx, "gas": 200_000})
        print("  setFacilitator")

        # ====================================================================
        # Scenario 1: USDC via EIP-3009 transferWithAuthorization
        # ====================================================================
        print("\n\n=== Scenario 1 — USDC via EIP-3009 (settleAndMintTicketEIP3009) ===")

        # Ticket #1 — Path A
        print("\n--- mint ticket #1 (USDC EIP-3009, then Path A direct feedback) ---")
        ticket_id_1, tx_1 = _settle_and_mint_eip3009(
            w3, wrapper, usdc_addr, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION,
            payer, facilitator,
            pay_to=agent.address, amount=amount_usdc, agent_id=agent_id,
            nonce_seed=b"usdc-nonce-1",
        )
        print(f"  payer signed USDC TransferWithAuthorization (no on-chain approval)")
        print(f"  settle+mint tx = {tx_1}  ticketId = {ticket_id_1}")
        _print_ticket(w3, wrapper, ticket_id_1, "mint")
        _path_a_direct(w3, wrapper_addr, payer, ticket_id_1, agent_id)
        _print_ticket(w3, wrapper, ticket_id_1, "feedback")

        # Ticket #2 — Path B
        print("\n--- mint ticket #2 (USDC EIP-3009, then Path B sponsored feedback) ---")
        ticket_id_2, tx_2 = _settle_and_mint_eip3009(
            w3, wrapper, usdc_addr, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION,
            payer, facilitator,
            pay_to=agent.address, amount=amount_usdc, agent_id=agent_id,
            nonce_seed=b"usdc-nonce-2",
        )
        print(f"  settle+mint tx = {tx_2}  ticketId = {ticket_id_2}")
        _print_ticket(w3, wrapper, ticket_id_2, "mint")
        _path_b_sponsored(w3, wrapper_addr, payer, relayer, ticket_id_2, agent_id)
        _print_ticket(w3, wrapper, ticket_id_2, "feedback")

        # ====================================================================
        # Scenario 2: DAI via ERC-20 transferFrom (DAI lacks transferWithAuthorization)
        # ====================================================================
        print("\n\n=== Scenario 2 — DAI via transferFrom (settleAndMintTicket) ===")

        # Ticket #3 — Path A
        print("\n--- mint ticket #3 (DAI transferFrom, then Path A direct feedback) ---")
        ticket_id_3, tx_3 = _settle_and_mint(
            w3, wrapper, dai_addr, payer, facilitator,
            pay_to=agent.address, amount=amount_dai, agent_id=agent_id,
        )
        print(f"  settle+mint tx = {tx_3}  ticketId = {ticket_id_3}")
        _print_ticket(w3, wrapper, ticket_id_3, "mint")
        _path_a_direct(w3, wrapper_addr, payer, ticket_id_3, agent_id)
        _print_ticket(w3, wrapper, ticket_id_3, "feedback")

        # Ticket #4 — Path B
        print("\n--- mint ticket #4 (DAI transferFrom, then Path B sponsored feedback) ---")
        ticket_id_4, tx_4 = _settle_and_mint(
            w3, wrapper, dai_addr, payer, facilitator,
            pay_to=agent.address, amount=amount_dai, agent_id=agent_id,
        )
        print(f"  settle+mint tx = {tx_4}  ticketId = {ticket_id_4}")
        _print_ticket(w3, wrapper, ticket_id_4, "mint")
        _path_b_sponsored(w3, wrapper_addr, payer, relayer, ticket_id_4, agent_id)
        _print_ticket(w3, wrapper, ticket_id_4, "feedback")

        # ---- Final assertions ----
        ticket_ids = (ticket_id_1, ticket_id_2, ticket_id_3, ticket_id_4)
        states = [wrapper.functions.tickets(tid).call()[5] for tid in ticket_ids]
        assert all(s is True for s in states), f"some tickets not consumed: {dict(zip(ticket_ids, states))}"

        idx = wrapper.functions.getLastIndex(agent_id, payer.address).call()
        assert idx == 4, f"expected 4 feedbacks recorded under payer, got {idx}"
        idx_msg = f"  X402AgentReputation.getLastIndex(agentId={agent_id}, payer) = {idx}"

        # Confirm payer's balances dropped by exactly the payments and the
        # agent received them — proves the transfers actually happened on the
        # real token contracts, not on a mock.
        usdc = w3.eth.contract(address=usdc_addr, abi=ERC20_ABI)
        dai = w3.eth.contract(address=dai_addr, abi=ERC20_ABI)
        agent_usdc = int(usdc.functions.balanceOf(agent.address).call())
        agent_dai = int(dai.functions.balanceOf(agent.address).call())
        assert agent_usdc == 2 * amount_usdc, f"agent USDC balance = {agent_usdc}, expected {2 * amount_usdc}"
        assert agent_dai == 2 * amount_dai, f"agent DAI balance = {agent_dai}, expected {2 * amount_dai}"

        print("\n\nDONE — both scenarios, both feedback paths green.")
        print(f"  Scenario 1 (USDC EIP-3009):")
        print(f"    ticket #{ticket_id_1}: minted -> consumed  (Path A direct)")
        print(f"    ticket #{ticket_id_2}: minted -> consumed  (Path B sponsored)")
        print(f"  Scenario 2 (DAI transferFrom):")
        print(f"    ticket #{ticket_id_3}: minted -> consumed  (Path A direct)")
        print(f"    ticket #{ticket_id_4}: minted -> consumed  (Path B sponsored)")
        print(f"  agent received: USDC {agent_usdc} ({agent_usdc / 10**6} USDC), DAI {agent_dai} ({agent_dai / 10**18} DAI)")
        print(idx_msg)
        return 0

    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    sys.exit(main())
