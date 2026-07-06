"""Shared helpers for the ERC-8004 demo scripts.

Pure helpers — no demo orchestration, no IPFS, no Pinata.

  - get_env / send_tx: env + EIP-1559 tx plumbing,
  - fund_gas_if_low / fund_erc20_from_whale: top up ETH / ERC-20 balances on
    a local Anvil fork (whale impersonation),
  - register_agent / agent_id_from_receipt: register a fresh agent on the
    ERC-8004 IdentityRegistry,
  - ensure_dai_permit2_allowance / settle_dai_via_x402_permit2_proxy: DAI
    settlement via the x402 Permit2 proxy.

Used by `bootstrap_fork.py` and `run_x402_client.py`, and available for any
other demo that wants the same plumbing.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from eth_account import Account
from web3 import Web3

from x402.mechanisms.evm.constants import (
    PERMIT2_ADDRESS,
    X402_EXACT_PERMIT2_PROXY_ABI,
    X402_EXACT_PERMIT2_PROXY_ADDRESS,
)
from x402.mechanisms.evm.exact.permit2_utils import _build_permit2_settle_args
from x402.mechanisms.evm.types import ExactPermit2Payload
from x402.schemas.payments import PaymentRequirements

# Minimal ERC-20 ABI for the settlement transfer + balance checks.
ERC20_ABI = [
    {"name": "transfer", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "decimals", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
    {"name": "allowance", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "approve", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
]

# ERC-8004 IdentityRegistry: register() mints an agent owned by msg.sender and
# emits Registered(agentId, tokenURI, owner). It's also an ERC-721 (mint emits
# Transfer(0x0, owner, tokenId)) which we use as a fallback to read the new id.
IDENTITY_REGISTER_ABI = [
    {"name": "register", "type": "function", "stateMutability": "nonpayable",
     "inputs": [], "outputs": [{"name": "agentId", "type": "uint256"}]},
    {"name": "ownerOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "id", "type": "uint256"}], "outputs": [{"name": "", "type": "address"}]},
    {"anonymous": False, "name": "Registered", "type": "event", "inputs": [
        {"indexed": True, "name": "agentId", "type": "uint256"},
        {"indexed": False, "name": "tokenURI", "type": "string"},
        {"indexed": True, "name": "owner", "type": "address"}]},
    {"anonymous": False, "name": "Transfer", "type": "event", "inputs": [
        {"indexed": True, "name": "from", "type": "address"},
        {"indexed": True, "name": "to", "type": "address"},
        {"indexed": True, "name": "tokenId", "type": "uint256"}]},
]


def get_env(name: str, default: str | None = None, required: bool = False) -> str | None:
    val = os.getenv(name, default)
    if required and not val:
        print(f"ERROR: ${name} is required.")
        sys.exit(1)
    return val


def send_tx(w3: Web3, signer: Account, tx: dict) -> Any:
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
    return w3.eth.wait_for_transaction_receipt(tx_hash)


def fund_gas_if_low(w3: Web3, payer: Account, to: str, min_eth: float = 0.02, topup_eth: float = 0.05) -> None:
    """Top up `to` with ETH from `payer` if it can't cover its own gas."""
    addr = Web3.to_checksum_address(to)
    if w3.eth.get_balance(addr) >= w3.to_wei(min_eth, "ether"):
        return
    print(f"funding agent {addr} with {topup_eth} ETH for registration gas...")
    rcpt = send_tx(w3, payer, {"to": addr, "value": w3.to_wei(topup_eth, "ether"), "gas": 21000})
    if rcpt["status"] != 1:
        raise RuntimeError("gas funding transfer to the agent failed")


def agent_id_from_receipt(w3: Web3, addr: str, owner: str, rcpt: Any) -> int:
    """Read the new agentId from a register() receipt (Registered, else ERC-721 mint)."""
    from web3.logs import DISCARD

    c = w3.eth.contract(address=addr, abi=IDENTITY_REGISTER_ABI)
    regs = c.events.Registered().process_receipt(rcpt, errors=DISCARD)
    if regs:
        return int(regs[0]["args"]["agentId"])
    for ev in c.events.Transfer().process_receipt(rcpt, errors=DISCARD):
        if int(ev["args"]["from"], 16) == 0 and Web3.to_checksum_address(ev["args"]["to"]) == owner:
            return int(ev["args"]["tokenId"])
    raise RuntimeError("register() succeeded but no Registered/mint event found to read agentId")


def register_agent(w3: Web3, signer: Account, identity_registry: str) -> int:
    """Register a fresh agent owned by `signer`; return its agentId.

    Tries register() first, then register(string) with a tokenURI, dry-running
    each via eth_call so a revert surfaces a clear reason instead of a traceback.
    """
    from eth_abi import encode as abi_encode
    from eth_utils import function_signature_to_4byte_selector as selector

    addr = Web3.to_checksum_address(identity_registry)
    owner = Web3.to_checksum_address(signer.address)
    attempts = [
        ("register()", selector("register()")),
        (
            'register("https://x402-erc8004-demo")',
            selector("register(string)") + abi_encode(["string"], ["https://x402-erc8004-demo"]),
        ),
    ]

    last_err: str | None = None
    for label, data in attempts:
        try:
            w3.eth.call({"from": owner, "to": addr, "data": data})
        except Exception as e:  # reverted — try the next overload
            last_err = f"{label}: {e}"
            print(f"  {label} dry-run reverted, trying next variant...")
            continue
        rcpt = send_tx(w3, signer, {"to": addr, "data": "0x" + data.hex(), "value": 0, "gas": 600000})
        if rcpt["status"] != 1:
            raise RuntimeError(f"{label} reverted on-chain (tx {rcpt['transactionHash'].hex()})")
        return agent_id_from_receipt(w3, addr, owner, rcpt)

    raise RuntimeError(
        "register() reverted for all variants on this IdentityRegistry; "
        f"last reason: {last_err}. The deployed registry may require EIP-7702 "
        "delegated registration, a fee, or a different signature."
    )


def fund_erc20_from_whale(
    w3: Web3, token: str, recipient: str, needed: int, whale: str, gas_eth: float = 10.0
) -> None:
    """On a local Anvil fork, top up `recipient` with `token` by impersonating a whale.

    No-op if the recipient already holds at least `needed`. Uses
    anvil_setBalance + anvil_impersonateAccount so the whale can sign and pay gas.
    """
    from eth_abi import encode as abi_encode
    from eth_utils import function_signature_to_4byte_selector as selector

    token_cs = Web3.to_checksum_address(token)
    recipient_cs = Web3.to_checksum_address(recipient)
    whale_cs = Web3.to_checksum_address(whale)
    erc20 = w3.eth.contract(address=token_cs, abi=ERC20_ABI)

    bal = int(erc20.functions.balanceOf(recipient_cs).call())
    if bal >= needed:
        print(f"  recipient already holds {bal} of {token_cs} (need {needed}); no whale funding")
        return

    whale_bal = int(erc20.functions.balanceOf(whale_cs).call())
    if whale_bal < needed:
        raise RuntimeError(
            f"whale {whale_cs} holds {whale_bal} of {token_cs}, < needed {needed}. "
            "Set ASSET_WHALE / DAI_WHALE to an address with a larger balance."
        )

    w3.provider.make_request("anvil_setBalance", [whale_cs, hex(w3.to_wei(gas_eth, "ether"))])
    w3.provider.make_request("anvil_impersonateAccount", [whale_cs])
    try:
        data = selector("transfer(address,uint256)") + abi_encode(
            ["address", "uint256"], [recipient_cs, needed]
        )
        tx_hash = w3.eth.send_transaction(
            {"from": whale_cs, "to": token_cs, "data": "0x" + data.hex(), "value": 0, "gas": 200000}
        )
        rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
        if rcpt["status"] != 1:
            raise RuntimeError("whale ERC-20 transfer reverted")
    finally:
        w3.provider.make_request("anvil_stopImpersonatingAccount", [whale_cs])
    print(f"  funded {recipient_cs} with {needed} of {token_cs} from whale {whale_cs}")


def ensure_dai_permit2_allowance(w3: Web3, payer: Account, dai: str, amount: int) -> None:
    """Ensure `payer` has approved Uniswap Permit2 to spend at least `amount` DAI."""
    token = w3.eth.contract(address=Web3.to_checksum_address(dai), abi=ERC20_ABI)
    permit2 = Web3.to_checksum_address(PERMIT2_ADDRESS)
    cur = int(token.functions.allowance(payer.address, permit2).call())
    if cur >= amount:
        return
    print(f"approving Permit2 on DAI (allowance was {cur}, need {amount})...")
    data = token.functions.approve(permit2, 2**256 - 1).build_transaction({"from": payer.address})["data"]
    rcpt = send_tx(w3, payer, {"to": Web3.to_checksum_address(dai), "data": data, "value": 0, "gas": 120000})
    if rcpt["status"] != 1:
        raise RuntimeError("DAI approve(Permit2) reverted")


def settle_dai_via_x402_permit2_proxy(
    w3: Web3, payer: Account, requirements: PaymentRequirements, inner_payload: dict[str, Any]
) -> str:
    """Execute `x402ExactPermit2Proxy.settle` using a signed `create_permit2_payload` dict."""
    payload_obj = ExactPermit2Payload.from_dict(inner_payload)
    permit_tuple, owner_addr, witness_tuple, sig_bytes = _build_permit2_settle_args(payload_obj)
    proxy = Web3.to_checksum_address(X402_EXACT_PERMIT2_PROXY_ADDRESS)
    c = w3.eth.contract(address=proxy, abi=X402_EXACT_PERMIT2_PROXY_ABI)
    func = c.functions.settle(permit_tuple, owner_addr, witness_tuple, sig_bytes)
    gas = int(func.estimate_gas({"from": payer.address}) * 1.25)
    data = func.build_transaction({"from": payer.address})["data"]
    rcpt = send_tx(
        w3,
        payer,
        {"to": proxy, "data": data, "value": 0, "gas": min(max(gas, 250000), 2_000_000)},
    )
    if rcpt["status"] != 1:
        raise RuntimeError("x402ExactPermit2Proxy.settle reverted")
    h = rcpt["transactionHash"].hex()
    return h if h.startswith("0x") else "0x" + h
