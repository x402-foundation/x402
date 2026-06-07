"""Bootstrap a mainnet fork for the ERC-8004 x402 HTTP ticket demo.

Starts Anvil (blocks until Ctrl+C), deploys ``X402AgentReputation``, registers a
fresh agent, funds the payer with USDC + DAI, and optionally writes ``.env``
files for the facilitator, agent server, and client examples.

Run (terminal 1 — leave running):
    cd examples/python/clients/erc8004
    uv sync
    uv run python bootstrap_fork.py --write-env

Then start facilitator, agent server, and client in separate terminals.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from eth_account import Account
from web3 import Web3

from x402.mechanisms.evm.constants import X402_EXACT_PERMIT2_PROXY_ADDRESS

from utils import fund_erc20_from_whale, fund_gas_if_low, register_agent, send_tx

ANVIL_KEY_DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

REPO_ROOT = Path(__file__).resolve().parents[4]
EXAMPLES_PYTHON = Path(__file__).resolve().parents[2]
FOUNDRY_OUT = REPO_ROOT / "contracts" / "evm" / "out"
FOUNDRY_DIR = REPO_ROOT / "contracts" / "evm"

MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
MAINNET_DAI = "0x6B175474E89094C44Da98b954Eedeac495271d0F"
MAINNET_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"

DEFAULT_PUBLIC_RPCS = (
    "https://eth.merkle.io",
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
)
DEFAULT_USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8"
DEFAULT_DAI_WHALE = "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf"

AMOUNT_USDC = 1_000_000
AMOUNT_DAI = 10**18
FACILITATOR_PORT = 4022
AGENT_SERVER_PORT = 4021


def _load_artifact(name: str) -> dict[str, Any]:
    path = FOUNDRY_OUT / f"{name}.sol" / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Build artifact missing: {path}. Run `FOUNDRY_PROFILE=erc8004 forge build` first."
        )
    return json.loads(path.read_text())


def _ensure_built() -> None:
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


def _deploy(w3: Web3, signer: Account, artifact_name: str, *args: Any) -> str:
    artifact = _load_artifact(artifact_name)
    contract = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"]["object"])
    tx = contract.constructor(*args).build_transaction({"from": signer.address})
    tx.pop("chainId", None)
    tx.pop("nonce", None)
    tx.pop("from", None)
    rcpt = send_tx(w3, signer, {**tx, "gas": 5_000_000})
    return Web3.to_checksum_address(rcpt["contractAddress"])


def _fund_eth(w3: Web3, address: str, eth: float) -> None:
    w3.provider.make_request(
        "anvil_setBalance",
        [Web3.to_checksum_address(address), hex(w3.to_wei(eth, "ether"))],
    )


def _require_exact_permit2_proxy(w3: Web3) -> str:
    """Return the canonical x402ExactPermit2Proxy address, asserting it exists on the fork.

    The x402 SDK signs Permit2 payloads with ``spender = X402_EXACT_PERMIT2_PROXY_ADDRESS``
    and Permit2 enforces that the on-chain caller equals the signed spender, so settlement
    must go through the proxy at exactly that address. The canonical proxy (and Permit2
    itself) are already deployed on mainnet, so a mainnet fork inherits both — no deploy
    needed. We only confirm the code is present and fail loudly if the fork lacks it.
    """
    canonical = Web3.to_checksum_address(X402_EXACT_PERMIT2_PROXY_ADDRESS)
    code = w3.eth.get_code(canonical)
    if not code or code == b"\x00":
        raise RuntimeError(
            f"x402ExactPermit2Proxy not found at canonical {canonical} on the fork. "
            "The mainnet fork should inherit it; check the fork is mainnet (chainId 1)."
        )
    print(f"  x402ExactPermit2Proxy present at canonical {canonical}")
    return canonical


def _start_anvil_fork(port: int, fork_url: str) -> subprocess.Popen[Any]:
    cmd = ["anvil", "--fork-url", fork_url, "--port", str(port)]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _wait_for_rpc(w3: Web3, timeout_s: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if w3.is_connected():
                return True
        except Exception:
            pass
        time.sleep(0.1)
    return False


def _try_fork(port: int, candidates: tuple[str, ...]) -> tuple[str, subprocess.Popen[Any]] | None:
    for url in candidates:
        print(f"  trying fork from {url} ...")
        proc = _start_anvil_fork(port, url)
        w3 = Web3(Web3.HTTPProvider(f"http://127.0.0.1:{port}"))
        if _wait_for_rpc(w3, timeout_s=15.0):
            try:
                _ = w3.eth.chain_id
                _ = w3.eth.block_number
                print(f"  OK: {url}")
                return url, proc
            except Exception as e:
                print(f"  fork didn't initialize ({url}): {e}")
        proc.terminate()
        proc.wait()
    return None


def _key_hex(acct: Account) -> str:
    raw = acct.key.hex()
    return raw if raw.startswith("0x") else f"0x{raw}"


def _write_env_file(path: Path, lines: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join(f"{k}={v}" for k, v in lines.items()) + "\n"
    path.write_text(content)
    print(f"  wrote {path}")


def _write_envs(state: dict[str, str]) -> None:
    facilitator_env = {
        "EVM_PRIVATE_KEY": state["facilitator_private_key"],
        "EVM_RPC_URL": state["rpc_url"],
        "NETWORK": state["network"],
        "WRAPPER_ADDRESS": state["wrapper_address"],
        "PORT": str(FACILITATOR_PORT),
    }
    server_env = {
        "AGENT_OWNER_PRIVATE_KEY": state["agent_owner_private_key"],
        "FACILITATOR_URL": state["facilitator_url"],
        "EVM_RPC_URL": state["rpc_url"],
        "NETWORK": state["network"],
        "WRAPPER_ADDRESS": state["wrapper_address"],
        "IDENTITY_REGISTRY": state["identity_registry"],
        "AGENT_ID": state["agent_id"],
        "AGENT_ADDRESS": state["agent_address"],
        "USDC_ADDRESS": state["usdc_address"],
        "DAI_ADDRESS": state["dai_address"],
        "AMOUNT_USDC": state["amount_usdc"],
        "AMOUNT_DAI": state["amount_dai"],
        "PORT": str(AGENT_SERVER_PORT),
    }
    client_env = {
        "PAYER_PRIVATE_KEY": state["payer_private_key"],
        "RELAYER_PRIVATE_KEY": state["relayer_private_key"],
        "AGENT_SERVER_URL": state["agent_server_url"],
        "EVM_RPC_URL": state["rpc_url"],
        "NETWORK": state["network"],
        "WRAPPER_ADDRESS": state["wrapper_address"],
        "IDENTITY_REGISTRY": state["identity_registry"],
        "AGENT_ID": state["agent_id"],
        "AGENT_ADDRESS": state["agent_address"],
        "USDC_ADDRESS": state["usdc_address"],
        "DAI_ADDRESS": state["dai_address"],
        "AMOUNT_USDC": state["amount_usdc"],
        "AMOUNT_DAI": state["amount_dai"],
        "AGENT_OWNER_ADDRESS": state["agent_address"],
        "FACILITATOR_URL": state["facilitator_url"],
        "FACILITATOR_PRIVATE_KEY": state["facilitator_private_key"],
    }
    _write_env_file(EXAMPLES_PYTHON / "facilitator" / "erc8004" / ".env", facilitator_env)
    _write_env_file(EXAMPLES_PYTHON / "servers" / "erc8004" / ".env", server_env)
    _write_env_file(Path(__file__).parent / ".env", client_env)


def bootstrap(write_env: bool) -> subprocess.Popen[Any]:
    port = int(os.getenv("ANVIL_PORT", "8545"))
    usdc_addr = Web3.to_checksum_address(os.getenv("USDC_ASSET", MAINNET_USDC))
    dai_addr = Web3.to_checksum_address(os.getenv("DAI_ASSET", MAINNET_DAI))
    usdc_whale = Web3.to_checksum_address(os.getenv("USDC_WHALE", DEFAULT_USDC_WHALE))
    dai_whale = Web3.to_checksum_address(os.getenv("DAI_WHALE", DEFAULT_DAI_WHALE))

    candidates: tuple[str, ...]
    if os.getenv("RPC_URL"):
        candidates = (os.environ["RPC_URL"],)
    else:
        candidates = DEFAULT_PUBLIC_RPCS

    print("Bringing up a local mainnet fork...")
    forked = _try_fork(port, candidates)
    if forked is None:
        print(
            "ERROR: no upstream mainnet RPC could be forked. Set RPC_URL=<your-rpc>."
        )
        sys.exit(1)

    _upstream, proc = forked
    rpc_url = f"http://127.0.0.1:{port}"
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    network = f"eip155:{w3.eth.chain_id}"

    deployer = Account.from_key(ANVIL_KEY_DEPLOYER)
    payer = Account.create()
    agent = Account.create()
    relayer = Account.create()

    for acct, label in (
        (deployer, "deployer"),
        (payer, "payer"),
        (agent, "agent"),
        (relayer, "relayer"),
    ):
        _fund_eth(w3, acct.address, 100.0)
        print(f"  funded {label} {acct.address} with 100 ETH")

    identity_addr = Web3.to_checksum_address(
        os.getenv("IDENTITY_REGISTRY", MAINNET_IDENTITY_REGISTRY)
    )
    identity_code = w3.eth.get_code(identity_addr)
    if not identity_code or identity_code == b"\x00":
        print(f"ERROR: no IdentityRegistry at {identity_addr} on the fork.")
        sys.exit(1)

    print(f"\nFunding payer with USDC + DAI from whales...")
    fund_erc20_from_whale(w3, usdc_addr, payer.address, AMOUNT_USDC * 10, usdc_whale)
    fund_erc20_from_whale(w3, dai_addr, payer.address, AMOUNT_DAI * 10, dai_whale)

    fund_gas_if_low(w3, payer, agent.address)
    print(f"Registering agent (owner = {agent.address})...")
    agent_id = register_agent(w3, agent, identity_addr)
    print(f"  agentId = {agent_id}")

    print("\nResolving canonical x402ExactPermit2Proxy on the fork...")
    proxy_addr = _require_exact_permit2_proxy(w3)

    print("\nDeploying X402AgentReputation...")
    wrapper_addr = _deploy(
        w3,
        deployer,
        "X402AgentReputation",
        deployer.address,
        proxy_addr,
        identity_addr,
    )
    print(f"  wrapper = {wrapper_addr}")
    # Settlement is permissionless (gated by the signed payment authorization) — no
    # facilitator allowlist to wire.

    state = {
        "rpc_url": rpc_url,
        "network": network,
        "chain_id": str(w3.eth.chain_id),
        "wrapper_address": wrapper_addr,
        "identity_registry": identity_addr,
        "agent_id": str(agent_id),
        "agent_address": agent.address,
        "usdc_address": usdc_addr,
        "dai_address": dai_addr,
        "amount_usdc": str(AMOUNT_USDC),
        "amount_dai": str(AMOUNT_DAI),
        "facilitator_private_key": ANVIL_KEY_DEPLOYER,
        "agent_owner_private_key": _key_hex(agent),
        "payer_private_key": _key_hex(payer),
        "relayer_private_key": _key_hex(relayer),
        "facilitator_url": f"http://127.0.0.1:{FACILITATOR_PORT}",
        "agent_server_url": f"http://127.0.0.1:{AGENT_SERVER_PORT}",
    }

    demo_state_path = Path(__file__).parent / "demo_state.json"
    demo_state_path.write_text(json.dumps(state, indent=2))
    print(f"\nWrote {demo_state_path}")

    if write_env:
        print("\nWriting .env files for facilitator, server, and client...")
        _write_envs(state)

    print(
        "\nBootstrap complete. Anvil is running — leave this terminal open.\n"
        "  Terminal 2: cd examples/python/facilitator/erc8004 && uv sync && uv run python main.py\n"
        "  Terminal 3: cd examples/python/servers/erc8004 && uv sync && uv run python main.py\n"
        "  Terminal 4: cd examples/python/clients/erc8004 && uv sync && uv run python run_x402_client.py\n"
    )
    return proc


def main() -> int:
    if shutil.which("anvil") is None or shutil.which("forge") is None:
        print("ERROR: Foundry (anvil + forge) required on PATH.")
        return 1

    parser = argparse.ArgumentParser(description="Bootstrap ERC-8004 x402 demo fork")
    parser.add_argument(
        "--write-env",
        action="store_true",
        help="Write .env files for facilitator, server, and client examples",
    )
    args = parser.parse_args()

    _ensure_built()
    proc = bootstrap(write_env=args.write_env)

    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\nStopping Anvil...")
        proc.terminate()
        proc.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
