from flask import Flask, request, jsonify
import json
import base64
import time
from eth_keys import keys
import re

app = Flask(__name__)

def verify_grant(grant, signature, current_agent, now=None):
    """Verify EIP-712 grant signature matches principal."""
    if now is None:
        now = int(time.time())
    
    # Check time bounds (30 second grace period)
    if grant["expiration"] < now - 30 or grant["issuedAt"] > now + 30:
        return False
    
    # For this demo, we do basic validation without full EIP-712 recovery
    # (full implementation would use eth_account.recover_message)
    
    # Check agent matches
    if grant["agent"].lower() != current_agent.lower():
        return False
    
    # Check budget is non-zero
    if int(grant["totalBudget"]) <= 0:
        return False
    
    # Signature format check (basic)
    if not signature.startswith("0x") or len(signature) < 130:
        return False
    
    return True

def should_check_revocation(grant, now=None):
    """Only check revocation in final 30% of grant lifetime."""
    if now is None:
        now = int(time.time())
    
    lifetime = grant["expiration"] - grant["issuedAt"]
    remaining = grant["expiration"] - now
    return remaining < lifetime * 0.3

@app.post("/api/tool")
def handle_tool():
    """Handle x402 payment request."""
    header_b64 = request.headers.get("X-402-Payment", "")
    if not header_b64:
        return jsonify({"error": "missing X-402-Payment header"}), 402
    
    try:
        payload = json.loads(base64.b64decode(header_b64))
        grant = payload["grant"]
        signature = payload["signature"]
        receipt_hash = payload.get("receiptHash", "")
    except Exception as e:
        return jsonify({"error": f"invalid header: {e}"}), 402
    
    # My agent address
    my_address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    
    # Verify grant
    if not verify_grant(grant, signature, my_address):
        return jsonify({"error": "invalid grant"}), 401
    
    # Check revocation if needed
    if should_check_revocation(grant):
        # In production, query on-chain registry here
        print("🔍 Would check revocation registry here")
    
    # Verify receipt hash matches request body
    # (In this demo we skip this for simplicity)
    
    print(f"✅ Grant verified! Agent: {grant['agent']}, Budget: {grant['totalBudget']}")
    
    # Execute the tool
    tool_name = request.json.get("tool", "unknown")
    result = {"message": f"Tool '{tool_name}' executed successfully"}
    
    # Create receipt
    receipt = {
        "receiptId": "0x" + "deadbeef" * 8,
        "grantId": str(grant["grantId"]),
        "amount": str(grant["perRequestCap"]),
        "settledAt": int(time.time()),
        "txHash": "0x" + "cafe" * 16,
        "status": "confirmed"
    }
    
    # Return with receipt header
    response = jsonify(result)
    response.headers["X-402-Receipt"] = base64.b64encode(
        json.dumps(receipt).encode()
    ).decode()
    
    return response, 200

if __name__ == "__main__":
    print("🚀 x402 Receiving Agent on port 3000")
    app.run(port=3000, debug=False)
