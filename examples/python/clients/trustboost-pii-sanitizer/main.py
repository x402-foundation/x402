"""
TrustBoost PII Sanitizer — x402 Client Example

Demonstrates autonomous PII sanitization before x402 payments.
The agent sanitizes sensitive data before it reaches LLMs or
external services — with proof anchored on Solana.

Usage:
    uv run python main.py
    TRUSTBOOST_TX_HASH=your_tx_hash uv run python main.py
"""

import os
import json
import requests
from dotenv import load_dotenv

load_dotenv()

API_URL = os.getenv("TRUSTBOOST_API_URL", "https://api.trustboost.dev")
TX_HASH = os.getenv("TRUSTBOOST_TX_HASH", "TRIAL")
WALLET  = os.getenv("TRUSTBOOST_WALLET", "x402-agent")
CONTEXT = os.getenv("TRUSTBOOST_CONTEXT", "general")


def discover_agent(url: str = API_URL) -> dict:
    """Discover TrustBoost via agent-card.json (x402 standard)."""
    r = requests.get(f"{url}/.well-known/agent-card.json", timeout=10)
    r.raise_for_status()
    card = r.json()
    print(f"[TrustBoost] Agent: {card.get('name')} v{card.get('version')}")
    print(f"[TrustBoost] Languages: {card.get('languages', [])}")
    print(f"[TrustBoost] Compliance: {card.get('compliance', [])}")
    return card


def sanitize(text: str, context: str = CONTEXT) -> dict:
    """
    Sanitize PII using TrustBoost with x402 payment flow.

    x402 flow:
    1. POST /sanitize without tx_hash -> HTTP 402
    2. Read payment instructions from 402 response
    3. Pay 149 USDC on Solana autonomously
    4. Retry with tx_hash -> sanitized text + on-chain proof
    """
    print(f"\n[Sanitizing] {len(text)} chars | context={context}")

    # Step 1: Probe for x402 payment info
    probe = requests.post(
        f"{API_URL}/sanitize",
        json={"text": text, "context": context},
        timeout=10
    )

    if probe.status_code == 402:
        payment_info = probe.json()
        x402 = payment_info.get("x402", {})
        accepts = x402.get("accepts", [])
        if accepts:
            acc = accepts[0]
            print(f"[x402] HTTP 402 — payment required")
            print(f"[x402] Amount: {acc.get('amount')} {acc.get('currency')}")
            print(f"[x402] Network: {acc.get('network')}")
            print(f"[x402] Address: {acc.get('payment_address')}")
        print(f"[x402] Paying autonomously with tx_hash={TX_HASH}")
    elif TX_HASH == "TRIAL":
        print("[TrustBoost] Using TRIAL mode — 50 free sanitizations")

    # Step 2: Sanitize with payment
    r = requests.post(
        f"{API_URL}/sanitize",
        json={
            "text": text,
            "tx_hash": TX_HASH,
            "wallet_address": WALLET,
            "context": context,
        },
        timeout=30
    )
    r.raise_for_status()
    result = r.json()

    if result.get("status") == "empty_input":
        return {"sanitized_content": text, "risk_category": "CLEAN", "safety_score": 1.0}

    data = result.get("data", {})
    print(f"[Result] {data.get('sanitized_content', '')[:80]}...")
    print(f"[Score]  {data.get('safety_score')} | Risk: {data.get('risk_category')}")

    # Check for on-chain proof (paid mode only)
    proof = data.get("proof_of_sanitization")
    if proof:
        print(f"[Proof]  {proof.get('verify_url')}")

    return data


def verify_proof(anchor_tx: str) -> dict:
    """Verify a Proof of Sanitization on Solana."""
    r = requests.get(f"{API_URL}/verify/{anchor_tx}", timeout=10)
    return r.json()


def main():
    print("=" * 60)
    print("TrustBoost PII Sanitizer — x402 Client Example")
    print("=" * 60)
    print(f"Mode: {'TRIAL (50 free)' if TX_HASH == 'TRIAL' else 'PAID (x402 Solana)'}")
    print(f"API:  {API_URL}")

    # Discover agent capabilities
    discover_agent()

    # Test cases across languages and contexts
    test_cases = [
        {
            "description": "English — financial payload",
            "text": "Wire $50,000 to john@acme.com, account 4111111111111111",
            "context": "financial",
        },
        {
            "description": "Spanish LATAM — legal document",
            "text": "Contribuyente RFC: LOPJ850101ABC, CURP: LOPJ850101HDFRZN09",
            "context": "legal",
        },
        {
            "description": "Portuguese BR — medical record",
            "text": "Paciente CPF: 123.456.789-09, email: joao@hospital.com.br",
            "context": "medical",
        },
        {
            "description": "Code — credentials in source",
            "text": "API_KEY=sk-proj-abc123XYZ789 OPENAI_KEY=sk-ant-api03-xxx",
            "context": "code",
        },
        {
            "description": "Japanese — government ID",
            "text": "田中太郎様のマイナンバー：123456789012、Tel：090-1234-5678",
            "context": "general",
        },
        {
            "description": "Clean input — no PII",
            "text": "Analyze Q3 revenue trends for the technology sector.",
            "context": "financial",
        },
    ]

    print(f"\nRunning {len(test_cases)} test cases...\n" + "=" * 60)

    results = []
    for case in test_cases:
        print(f"\n[{case['description']}]")
        print(f"Input: {case['text']}")
        try:
            result = sanitize(case["text"], case["context"])
            results.append({
                "description": case["description"],
                "risk": result.get("risk_category", "UNKNOWN"),
                "score": result.get("safety_score", 0),
            })
        except requests.exceptions.RequestException as e:
            print(f"[Error] {e}")

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    for r in results:
        print(f"{r['description']}: {r['risk']} (score={r['score']})")

    print("\nPII sanitized. Safe to proceed with x402 payment.")
    print(f"Verify paid proof: GET {API_URL}/verify/{{anchor_tx}}")
    print("=" * 60)


if __name__ == "__main__":
    main()
