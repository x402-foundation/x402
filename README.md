# x402 — Agent Payment Standard

An open protocol for agent-to-agent payments on Base L2, using signed EIP-712 grants and HTTP 402 Payment Required headers.

**Status:** V1 Reference Implementation  
**Spec Files:**
- [specs/grants.md](specs/grants.md) — Grant lifecycle, EIP-712 schema, verification rules
- [specs/payment-flow.md](specs/payment-flow.md) — Complete end-to-end payment flow
- [specs/test-vectors.json](specs/test-vectors.json) — Conformance test cases (all 6 vectors)

**Examples:**
- [examples/minimal-node-python/](examples/minimal-node-python/) — Node.js paying agent + Python receiving agent (clone-and-run)

**Test Suite:**
- [test/conformance.js](test/conformance.js) — Runs all 6 test vectors against the reference EIP-712 implementation

## Quick Start

```bash
# Clone
git clone https://github.com/agentpay/x402.git
cd x402

# Read the spec
cat specs/grants.md

# Run conformance tests
node test/conformance.js

# Run the end-to-end example
cd examples/minimal-node-python
npm install && npm start  # Terminal 1
cd python-receiving-agent && python app.py  # Terminal 2
```

## What is x402?

x402 is the standardized way agents authorize payments to each other.

**The Problem:** Agent A wants to pay Agent B for a service. How does B know A is authorized? How does B verify the payment will actually settle on-chain?

**The Solution:** Agent A signs a **spend grant** (EIP-712) containing:
- Who is spending (principal)
- How much per request (perRequestCap)
- Total budget (totalBudget)
- Expiration time
- Digital signature

Agent B receives the grant in an `X-402-Payment` HTTP header, verifies the signature against the signer's wallet, checks the remaining budget, and executes the tool. Settlement happens automatically on Base L2 via USDC escrow.

## How It Works

1. **Grant Creation** → Principal signs an EIP-712 grant struct
2. **HTTP Request** → Paying agent sends grant in `X-402-Payment` header (base64)
3. **Verification** → Receiving agent validates signature and budget
4. **Settlement** → Event-driven daemon on Base L2 confirms payment (2–6 seconds)
5. **Receipt** → Receiving agent returns `X-402-Receipt` header with proof

[Full lifecycle in specs/payment-flow.md](specs/payment-flow.md)

## Key Concepts

### Grant ID
Every grant has a unique `grantId` (uint256). Combined with the principal's address, it creates a globally unique payment authorization.

### Revocation Registry
Grants can be revoked on-chain. Receiving agents only check the registry during the final **30% of the grant's lifetime** to optimize performance.

### Test Vectors
All 6 conformance test vectors (valid grant, expired, invalid signature, replay attack, etc.) are in [specs/test-vectors.json](specs/test-vectors.json).

## Deployment

### Base Sepolia (Testnet)
See [specs/BASE_SEPOLIA.md](specs/BASE_SEPOLIA.md) for registry deployment and environment setup.

### Base Mainnet (Production)
Registry contract address: `0x...` (to be deployed — awaiting x402GrantRegistry deploy)

x402-escrow Program ID: `CNwRWLCUL7jgk3xEgvMCeUFyt73LNEPtvucwxm3YqsFb`

## Architecture

x402 is intentionally minimal:
- **No centralized payment processor** — payments settle directly on-chain
- **No agent whitelist** — any agent can request payments from any other agent
- **No escrow custody** — funds are held in a transparent smart contract
- **Reputation-based** — the Graph indexes settlement history for trust scoring

Think of it like **OAuth for payments**: instead of storing passwords, agents sign grants. The receiving agent validates the signature once, and settlement is automatic.

## Contributing

This is an open standard. Contributions, implementations, and feedback are welcome.

---

**Maintained by:** AgentPay Team  
**License:** MIT  
**Last Updated:** May 2026
