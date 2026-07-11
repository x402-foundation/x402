"""Test full 402 flow with Firecrawl weather + on-chain settlement"""
import json, secrets, requests
from web3 import Web3
import eth_account

w3 = Web3(Web3.HTTPProvider("https://rpc.testnet.chain.robinhood.com"))
k = json.load(open("/root/.hermes/secrets/rh_client.json"))
mock_usdg = "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4"

# Step 1: request without payment
r1 = requests.post("http://localhost:3005/weather", json={"city": "Tokyo"})
print("Step 1 status:", r1.status_code)
reqs = r1.json()
print("402:", json.dumps(reqs, indent=2))

# Step 2: sign EIP-3009
nonce_bytes = w3.keccak(text=secrets.token_hex(16))
msg = {
    "from": k["address"],
    "to": "0x5131c099eB615227aB2Bb8b542D4cBd622910a25",
    "value": int(0.5 * 10**6),
    "validAfter": 0,
    "validBefore": int(w3.eth.get_block("latest")["timestamp"]) + 3600,
    "nonce": w3.to_hex(nonce_bytes),
}
signable = eth_account.messages.encode_typed_data(
    domain_data={"name": "USDG", "version": "2", "chainId": 46630, "verifyingContract": mock_usdg},
    message_types={"TransferWithAuthorization": [
        {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"},
    ]},
    message_data=msg,
)
signed = w3.eth.account.sign_message(signable, k["private_key"])
sig = "0x" + signed.signature.hex()
payload = json.dumps({**msg, "value": hex(msg["value"]), "validAfter": "0x0", "validBefore": hex(msg["validBefore"]), "signature": sig})

# Step 3: retry with payment
r2 = requests.post("http://localhost:3005/weather",
    headers={"payment-signature": sig, "payment-payload": payload, "payment-network": "eip155:46630"},
    json={"city": "Tokyo"})
data = r2.json()
print("Status:", r2.status_code)
print("City:", data.get("city"))
print("Temp:", data.get("temp_f"), "F /", data.get("temp_c"), "C")
print("Condition:", data.get("condition"))
print("Humidity:", data.get("humidity"), "%")
print("Wind:", data.get("wind"))
print("Source:", data.get("source"))
print("Paid:", data.get("paid"))
print("Tx:", data.get("settlement", {}).get("txHash", "none"))