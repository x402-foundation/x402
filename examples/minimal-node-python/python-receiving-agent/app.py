"""
x402 Python Receiving Agent — reference implementation (local + Base Sepolia)

In local mode:  simulates settlement, returns a fake tx hash.
In Sepolia mode: receives an EIP-3009 transferWithAuthorization from the paying agent,
                 submits it on-chain, waits for confirmation, returns the real tx hash.

Set SETTLEMENT_MODE=sepolia and BASE_SEPOLIA_RPC in .env to enable real settlement.
"""

import json
import base64
import time
import os
from flask import Flask, request, jsonify, make_response
from eth_abi import encode
from eth_keys import keys
from Crypto.Hash import keccak as pysha3

# ── Settlement mode ───────────────────────────────────────────────────────────
SETTLEMENT_MODE     = os.environ.get("SETTLEMENT_MODE", "local")
BASE_SEPOLIA_RPC    = os.environ.get("BASE_SEPOLIA_RPC", "https://sepolia.base.org")
AGENT_PRIVATE_KEY   = os.environ.get("AGENT_PRIVATE_KEY", "")
USDC_ADDRESS        = os.environ.get("USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")

# ── EIP-712 constants for x402Grant (specs/grants.md) ────────────────────────
DOMAIN = {
    "name":              "x402-AgentGrant",
    "version":           "1",
    "chainId":           84532,          # Base Sepolia — swap to 8453 for mainnet
    "verifyingContract": "0x0000000000000000000000000000000000000000",
}

TYPES = [
    ("grantId",       "uint256"),
    ("principal",     "address"),
    ("agent",         "address"),
    ("issuedAt",      "uint256"),
    ("expiration",    "uint256"),
    ("totalBudget",   "uint256"),
    ("perRequestCap", "uint256"),
    ("scopes",        "bytes32[]"),
    ("salt",          "bytes32"),
]

# This agent's authorized address (Hardhat account #1 — or set your own)
MY_AGENT_ADDRESS = os.environ.get(
    "RECEIVING_AGENT_ADDRESS",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
)


# ── EIP-712 helpers (canonical — matches all 6 conformance test vectors) ──────
def _keccak(data: bytes) -> bytes:
    k = pysha3.new(digest_bits=256)
    k.update(data)
    return bytes.fromhex(k.hexdigest())


def _compute_digest(grant: dict) -> bytes:
    type_string = "x402Grant(" + ",".join(f"{t} {n}" for n, t in TYPES) + ")"
    type_hash   = _keccak(type_string.encode())
    scopes      = grant["scopes"]
    scopes_enc  = encode(
        ["bytes32"] * len(scopes),
        [bytes.fromhex(s.removeprefix("0x").ljust(64, "0")) for s in scopes]
    )
    scopes_hash = _keccak(scopes_enc)
    salt_bytes  = bytes.fromhex(grant["salt"].removeprefix("0x").ljust(64, "0"))
    struct_enc  = encode(
        ["bytes32","uint256","address","address","uint256","uint256","uint256","uint256","bytes32","bytes32"],
        [type_hash, int(grant["grantId"]), grant["principal"], grant["agent"],
         int(grant["issuedAt"]), int(grant["expiration"]),
         int(grant["totalBudget"]), int(grant["perRequestCap"]),
         scopes_hash, salt_bytes]
    )
    struct_hash = _keccak(struct_enc)
    domain_type      = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    domain_type_hash = _keccak(domain_type.encode())
    domain_enc  = encode(
        ["bytes32","bytes32","bytes32","uint256","address"],
        [domain_type_hash, _keccak(DOMAIN["name"].encode()),
         _keccak(DOMAIN["version"].encode()),
         DOMAIN["chainId"], DOMAIN["verifyingContract"]]
    )
    domain_sep = _keccak(domain_enc)
    return _keccak(b"\x19\x01" + domain_sep + struct_hash)


def _recover_signer(digest: bytes, sig: str) -> str:
    sig_bytes = bytes.fromhex(sig.removeprefix("0x"))
    r = int.from_bytes(sig_bytes[:32], "big")
    s = int.from_bytes(sig_bytes[32:64], "big")
    v = sig_bytes[64]
    if v >= 27:
        v -= 27
    pub_key = keys.Signature(vrs=(v, r, s)).recover_public_key_from_msg_hash(digest)
    return pub_key.to_checksum_address()


def verify_grant(grant: dict, signature: str, current_agent: str, now: int = None) -> bool:
    if now is None:
        now = int(time.time())
    if int(grant["expiration"]) <= now + 30:
        print(f"  [verify] FAIL: expired")
        return False
    if int(grant["issuedAt"]) > now + 30:
        print(f"  [verify] FAIL: future issuedAt")
        return False
    if grant["agent"].lower() != current_agent.lower():
        print(f"  [verify] FAIL: wrong agent")
        return False
    try:
        digest    = _compute_digest(grant)
        recovered = _recover_signer(digest, signature)
        if recovered.lower() != grant["principal"].lower():
            print(f"  [verify] FAIL: signer mismatch")
            return False
    except Exception as e:
        print(f"  [verify] FAIL: {e}")
        return False
    return True


def should_check_revocation(grant: dict, now: int = None) -> bool:
    if now is None:
        now = int(time.time())
    lifetime  = int(grant["expiration"]) - int(grant["issuedAt"])
    remaining = int(grant["expiration"]) - now
    return remaining < lifetime * 0.3


# ── On-chain settlement (Sepolia mode) ────────────────────────────────────────
def settle_on_chain(eip3009_auth: dict, amount: str) -> dict:
    """
    Submit USDC transferWithAuthorization on Base Sepolia.
    Returns: {"txHash": "0x...", "settledAt": <unix>}
    """
    from web3 import Web3
    from eth_account import Account

    w3      = Web3(Web3.HTTPProvider(BASE_SEPOLIA_RPC))
    account = Account.from_key(AGENT_PRIVATE_KEY)

    # Minimal USDC ABI for transferWithAuthorization (EIP-3009)
    usdc_abi = [
        {
            "name": "transferWithAuthorization",
            "type": "function",
            "stateMutability": "nonpayable",
            "inputs": [
                {"name": "from",        "type": "address"},
                {"name": "to",          "type": "address"},
                {"name": "value",       "type": "uint256"},
                {"name": "validAfter",  "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce",       "type": "bytes32"},
                {"name": "v",           "type": "uint8"},
                {"name": "r",           "type": "bytes32"},
                {"name": "s",           "type": "bytes32"},
            ],
            "outputs": [],
        }
    ]

    usdc   = w3.eth.contract(address=Web3.to_checksum_address(USDC_ADDRESS), abi=usdc_abi)
    sig    = eip3009_auth["signature"]
    sig_b  = bytes.fromhex(sig.removeprefix("0x"))
    v_val  = sig_b[64]
    if v_val < 27:
        v_val += 27
    r_val  = sig_b[:32]
    s_val  = sig_b[32:64]

    nonce_hex = eip3009_auth["nonce"]
    nonce_b32 = bytes.fromhex(nonce_hex.removeprefix("0x").ljust(64, "0"))

    tx = usdc.functions.transferWithAuthorization(
        Web3.to_checksum_address(eip3009_auth["from"]),
        Web3.to_checksum_address(eip3009_auth["to"]),
        int(eip3009_auth["value"]),
        int(eip3009_auth["validAfter"]),
        int(eip3009_auth["validBefore"]),
        nonce_b32,
        v_val,
        r_val,
        s_val,
    ).build_transaction({
        "from":     account.address,
        "nonce":    w3.eth.get_transaction_count(account.address),
        "gas":      200_000,
        "gasPrice": w3.eth.gas_price,
        "chainId":  84532,
    })

    signed  = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"  [settlement] tx submitted: {tx_hash.hex()}")

    # Wait up to 30s for confirmation
    for _ in range(15):
        time.sleep(2)
        try:
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt and receipt.status == 1:
                print(f"  [settlement] Confirmed! block={receipt.blockNumber}")
                return {"txHash": tx_hash.hex(), "settledAt": int(time.time())}
            elif receipt and receipt.status == 0:
                raise RuntimeError("Transaction reverted")
        except Exception:
            pass

    raise TimeoutError("Settlement timeout after 30s")


# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)


@app.post("/api/tool")
def handle_tool():
    # Step 1: decode X-402-Payment header
    header_b64 = request.headers.get("X-402-Payment")
    if not header_b64:
        return jsonify({"error": "missing X-402-Payment header"}), 402

    try:
        payment = json.loads(base64.b64decode(header_b64))
    except Exception:
        return jsonify({"error": "malformed X-402-Payment header"}), 400

    grant        = payment.get("grant", {})
    signature    = payment.get("signature", "")
    receipt_hash = payment.get("receiptHash", "")
    eip3009_auth = payment.get("eip3009Auth")

    print(f"\nIncoming request — grantId={grant.get('grantId')}, "
          f"mode={SETTLEMENT_MODE}, "
          f"principal={str(grant.get('principal', ''))[:12]}...")

    # Step 2: verify grant
    if not verify_grant(grant, signature, MY_AGENT_ADDRESS):
        return jsonify({"error": "invalid grant"}), 401
    print("  [verify] OK")

    # Step 3: optional revocation check
    if should_check_revocation(grant):
        print("  [revocation] In final 30% — would query on-chain registry")

    # Step 4: replay protection
    body_bytes    = request.get_data()
    expected_hash = "0x" + _keccak(body_bytes).hex()
    if receipt_hash.lower() != expected_hash.lower():
        print(f"  [replay] FAIL")
        return jsonify({"error": "receiptHash mismatch — possible replay"}), 401
    print("  [replay] OK")

    # Step 5: settlement
    receipt_id = "0x" + "deadbeef" * 8  # overwritten in sepolia mode
    tx_hash    = "0x" + "1234abcd" * 8  # overwritten in sepolia mode

    if SETTLEMENT_MODE == "sepolia" and eip3009_auth and AGENT_PRIVATE_KEY:
        try:
            print("  [settlement] Submitting USDC transferWithAuthorization on Base Sepolia...")
            result   = settle_on_chain(eip3009_auth, grant.get("perRequestCap", "5000000"))
            tx_hash  = result["txHash"]
            receipt_id = "0x" + _keccak(bytes.fromhex(tx_hash.removeprefix("0x"))).hex()
            print(f"  [settlement] Real tx: https://sepolia.basescan.org/tx/{tx_hash}")
        except Exception as e:
            print(f"  [settlement] FAILED: {e}")
            refund = {"reason": str(e), "refundedAt": int(time.time())}
            resp   = make_response(jsonify({"error": "settlement failed"}), 402)
            resp.headers["X-402-Refund"] = base64.b64encode(json.dumps(refund).encode()).decode()
            return resp
    else:
        print("  [settlement] Simulated (local mode)")
        time.sleep(0.1)

    receipt = {
        "receiptId": receipt_id,
        "grantId":   str(grant.get("grantId")),
        "amount":    grant.get("perRequestCap", "5000000"),
        "settledAt": int(time.time()),
        "txHash":    tx_hash,
        "network":   payment.get("network", "local"),
    }
    print(f"  [done] receiptId={receipt['receiptId'][:12]}...")

    receipt_b64 = base64.b64encode(json.dumps(receipt).encode()).decode()
    response    = make_response(jsonify({"result": "tool executed successfully"}), 200)
    response.headers["X-402-Receipt"] = receipt_b64
    return response


if __name__ == "__main__":
    print(f"x402 Python Receiving Agent")
    print(f"Settlement mode: {SETTLEMENT_MODE}")
    print(f"Agent address:   {MY_AGENT_ADDRESS}")
    print(f"Listening on:    http://localhost:3000\n")
    app.run(port=3000, debug=False)
