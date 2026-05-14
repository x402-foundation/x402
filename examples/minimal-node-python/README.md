# x402 End-to-End Example (Node Paying Agent + Python Receiving Agent)

**Status:** Live  
**Companion Specs:** [specs/grants.md](../../specs/grants.md), [specs/payment-flow.md](../../specs/payment-flow.md)

This is the official minimal reference implementation. It demonstrates the complete x402 payment flow using **only the open spec** — no AgentPay dependency in the happy path.

- **Node.js Paying Agent** — signs a live EIP-712 grant and sends an x402 HTTP request  
- **Python Receiving Agent** — verifies the grant using the canonical verifier, checks receiptHash (replay protection), simulates Base L2 settlement, and returns `X-402-Receipt`  

---

## Quickstart (under 60 seconds)

```bash
git clone https://github.com/shawnhvac/x402.git
cd x402/examples/minimal-node-python

# Terminal 1 — start the receiving agent (Python)
cd python-receiving-agent
pip install -r requirements.txt
python app.py
# Listening on http://localhost:3000

# Terminal 2 — run the paying agent (Node)
cd ../node-paying-agent
npm install
npm start
```

**Expected output (Terminal 2):**
```
Paying agent sending x402 request...
Grant signed: 0x4207...
HTTP 200 received
X-402-Receipt: { receiptId: '0xdeadbeef...', amount: '5000000', settledAt: ... }
Full cycle complete.
```

---

## Repo structure

```
minimal-node-python/
├── node-paying-agent/
│   ├── index.ts          ← signs grant + sends X-402-Payment request
│   ├── grants.ts         ← canonical EIP-712 sign/verify (from specs/grants.md)
│   ├── package.json
│   └── tsconfig.json
├── python-receiving-agent/
│   ├── app.py            ← verifies grant + replay check + returns receipt
│   └── requirements.txt
└── README.md
```

Uses the **test private key** from `specs/test-vectors.json` — so you can run the conformance suite against these implementations immediately.

---

## What this covers

| Step | What it does | Where |
|------|-------------|--------|
| Grant Issuance | `signGrant()` — EIP-712 via ethers v6 | `node-paying-agent/grants.ts` |
| HTTP Payment Request | `X-402-Payment` header (base64 JSON) | `node-paying-agent/index.ts` |
| Grant Verification | `verifyGrant()` + `shouldCheckRevocation()` | `python-receiving-agent/app.py` |
| Replay Protection | `receiptHash` = keccak256(request body) | Both agents |
| Settlement (simulated) | Prints settlement log, returns receipt | `python-receiving-agent/app.py` |
| Receipt | `X-402-Receipt` header (base64 JSON) | `python-receiving-agent/app.py` |

---

## Next steps

- **Real on-chain settlement:** See `specs/payment-flow.md` §3 — swap the simulated settlement for a live USDC transfer on Base Sepolia  
- **Revocation check:** Uncomment the registry call in `app.py`  
- **Conformance:** Run `cd ../../test && npm install && npm test` to validate the verifier against all 6 test vectors  

---

*Part of the x402 Agent Grant System — built by [AgentPay](https://x402-agent-pay.com)*

---

## Go further

| Guide | What it adds |
|-------|-------------|
| [BASE_SEPOLIA.md](./BASE_SEPOLIA.md) | Real on-chain USDC settlement on Base Sepolia — same code, real tx hashes |
| [specs/payment-flow.md](../../specs/payment-flow.md) | Full lifecycle reference with Mermaid sequence diagram |
| [specs/conformance.md](../../specs/conformance.md) | Validate any verifier implementation in 30 seconds |
