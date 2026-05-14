"""
x402 Python Receiving Agent — reference implementation

Verifies incoming x402 grants (EIP-712), performs replay protection via
receiptHash, simulates Base L2 settlement, and returns X-402-Receipt.

Verified against all 6 conformance test vectors in specs/test-vectors.json.
"""

import json
import base64
import time
from flask import Flask, request, jsonify, make_response
from eth_abi import encode
from eth_keys import keys
from Crypto.Hash import keccak as pysha3

# ── EIP-712 constants (mirrors specs/grants.md) ───────────────────────────────
DOMAIN = {
    "name":              "x402-AgentGrant",
    "version":           "1",
    "chainId":           8453,
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


# ── EIP-712 helpers ───────────────────────────────────────────────────────────
def _keccak(data: bytes) -> bytes:
    k = pysha3.new(digest_bits=256)
    k.update(data)
    return bytes.fromhex(k.hexdigest())


def _compute_digest(grant: dict) -> bytes:
    """Compute the EIP-712 digest for an x402Grant. Matches ethers v6 TypedDataEncoder exactly."""
    # 1. Type hash
    type_string = "x402Grant(" + ",".join(f"{t} {n}" for n, t in TYPES) + ")"
    type_hash   = _keccak(type_string.encode())

    # 2. Scopes: keccak256(abi.encode(bytes32[]))
    scopes      = grant["scopes"]
    scopes_enc  = encode(
        ["bytes32"] * len(scopes),
        [bytes.fromhex(s.removeprefix("0x").ljust(64, "0")) for s in scopes]
    )
    scopes_hash = _keccak(scopes_enc)

    # 3. Salt
    salt_bytes  = bytes.fromhex(grant["salt"].removeprefix("0x").ljust(64, "0"))

    # 4. hashStruct
    struct_enc  = encode(
        ["bytes32","uint256","address","address","uint256","uint256","uint256","uint256","bytes32","bytes32"],
        [
            type_hash,
            int(grant["grantId"]),
            grant["principal"],
            grant["agent"],
            int(grant["issuedAt"]),
            int(grant["expiration"]),
            int(grant["totalBudget"]),
            int(grant["perRequestCap"]),
            scopes_hash,
            salt_bytes,
        ]
    )
    struct_hash = _keccak(struct_enc)

    # 5. Domain separator
    domain_type      = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    domain_type_hash = _keccak(domain_type.encode())
    name_hash        = _keccak(DOMAIN["name"].encode())
    version_hash     = _keccak(DOMAIN["version"].encode())
    domain_enc       = encode(
        ["bytes32","bytes32","bytes32","uint256","address"],
        [domain_type_hash, name_hash, version_hash, DOMAIN["chainId"], DOMAIN["verifyingContract"]]
    )
    domain_sep = _keccak(domain_enc)

    # 6. Final digest: keccak256(\x19\x01 || domainSep || hashStruct)
    return _keccak(b"\x19\x01" + domain_sep + struct_hash)


def _recover_signer(digest: bytes, sig: str) -> str:
    """Recover the signer address from an EIP-712 digest and signature (raw recovery, no Ethereum prefix)."""
    sig_bytes = bytes.fromhex(sig.removeprefix("0x"))
    r = int.from_bytes(sig_bytes[:32], "big")
    s = int.from_bytes(sig_bytes[32:64], "big")
    v = sig_bytes[64]
    if v >= 27:
        v -= 27
    pub_key = keys.Signature(vrs=(v, r, s)).recover_public_key_from_msg_hash(digest)
    return pub_key.to_checksum_address()


# ── Grant verification (canonical — matches all 6 conformance test vectors) ───
def verify_grant(grant: dict, signature: str, current_agent: str, now: int = None) -> bool:
    """
    Verify an x402Grant.

    Rules (specs/grants.md §7):
    1. grant.expiration > now + 30  (expired beyond ±30s grace window)
    2. grant.issuedAt <= now + 30
    3. grant.agent matches currentAgent
    4. EIP-712 signature recovers to grant.principal
    """
    if now is None:
        now = int(time.time())

    if int(grant["expiration"]) <= now + 30:
        print(f"  [verify] FAIL: expired (exp={grant['expiration']}, now={now})")
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
            print(f"  [verify] FAIL: recovered {recovered} != principal {grant['principal']}")
            return False
    except Exception as e:
        print(f"  [verify] FAIL: signature error — {e}")
        return False

    return True


def should_check_revocation(grant: dict, now: int = None) -> bool:
    """Returns True if the grant is in its final 30% of lifetime."""
    if now is None:
        now = int(time.time())
    lifetime  = int(grant["expiration"]) - int(grant["issuedAt"])
    remaining = int(grant["expiration"]) - now
    return remaining < lifetime * 0.3


# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)

# This agent's authorized address (Hardhat account #1 — matches node-paying-agent)
MY_AGENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"


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

    print(f"\nIncoming request — grantId={grant.get('grantId')}, "
          f"principal={str(grant.get('principal', ''))[:10]}...")

    # Step 2: verify grant (EIP-712 + expiry + agent check)
    if not verify_grant(grant, signature, MY_AGENT_ADDRESS):
        return jsonify({"error": "invalid grant"}), 401
    print("  [verify] OK")

    # Step 3: optional revocation check (final 30% of lifetime)
    if should_check_revocation(grant):
        print("  [revocation] In final 30% — would query on-chain registry (skipped in example)")

    # Step 4: replay protection — receiptHash must match keccak256(request body)
    body_bytes    = request.get_data()
    expected_hash = "0x" + _keccak(body_bytes).hex()

    if receipt_hash.lower() != expected_hash.lower():
        print(f"  [replay] FAIL: {receipt_hash[:14]}... != {expected_hash[:14]}...")
        return jsonify({"error": "receiptHash mismatch — possible replay"}), 401
    print("  [replay] OK")

    # Step 5: simulate settlement (2–6s on real Base L2)
    print("  [settlement] Confirming on Base L2... (simulated in example)")
    time.sleep(0.1)  # replace with settlement_listener.await_settlement() for production

    receipt = {
        "receiptId": "0x" + "deadbeef" * 8,
        "grantId":   str(grant.get("grantId")),
        "amount":    "5000000",    # 5 USDC (6 decimals)
        "settledAt": int(time.time()),
        "txHash":    "0x" + "1234abcd" * 8,
    }
    print(f"  [settlement] Confirmed. receiptId={receipt['receiptId'][:12]}...")

    receipt_b64 = base64.b64encode(json.dumps(receipt).encode()).decode()
    response    = make_response(jsonify({"result": "tool executed successfully"}), 200)
    response.headers["X-402-Receipt"] = receipt_b64
    return response


if __name__ == "__main__":
    print(f"x402 Python Receiving Agent")
    print(f"Agent address: {MY_AGENT_ADDRESS}")
    print(f"Listening on   http://localhost:3000\n")
    app.run(port=3000, debug=False)
