"""Deploy MockUSDG to Robinhood Chain testnet (46630)."""
import json
from web3 import Web3
import os

# ── Config ───────────────────────────────────────────────
RPC = os.getenv("RH_RPC", "https://rpc.testnet.chain.robinhood.com")
PRIVATE_KEY = os.getenv("DEPLOYER_KEY", "")
w3 = Web3(Web3.HTTPProvider(RPC))

if not w3.is_connected():
    print("❌ Cannot connect to", RPC)
    exit(1)

deployer = w3.eth.account.from_key(PRIVATE_KEY)
print(f"Chain ID: {w3.eth.chain_id}")
print(f"Deployer: {deployer.address}")
print(f"Balance:   {w3.from_wei(w3.eth.get_balance(deployer.address), 'ether')} ETH")

# ── Load contract ────────────────────────────────────────
with open("/root/x402-robinhood/contracts/out/x402-robinhood_contracts_MockUSDG_sol_MockUSDG.abi") as f:
    abi = json.load(f)
with open("/root/x402-robinhood/contracts/out/x402-robinhood_contracts_MockUSDG_sol_MockUSDG.bin") as f:
    bytecode = f.read().strip()

Contract = w3.eth.contract(abi=abi, bytecode=bytecode)

# ── Deploy ───────────────────────────────────────────────
tx = Contract.constructor().build_transaction({
    "from": deployer.address,
    "nonce": w3.eth.get_transaction_count(deployer.address),
    "gas": 2_000_000,
    "gasPrice": w3.eth.gas_price,
})
signed = deployer.sign_transaction(tx)
tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
print(f"Tx sent: {tx_hash.hex()}")

receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
print(f"✅ MockUSDG deployed at: {receipt.contractAddress}")
print(f"   Gas used: {receipt.gasUsed}")
print(f"   Block: {receipt.blockNumber}")