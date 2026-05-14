# x402 End-to-End on Base Sepolia (Real On-Chain Settlement)

**Status:** Live  
**Network:** Base Sepolia (chainId: 84532)  
**Token:** USDC — `0x036CbD53842c5426634e7929541eC2318f3dCF7e`  
**Companion:** [README.md](./README.md), [specs/payment-flow.md](../../specs/payment-flow.md)

This guide upgrades the minimal example to use **real** Base Sepolia settlement via
USDC's native `transferWithAuthorization` (EIP-3009) — the same mechanism used by
the official x402 facilitator on Base mainnet.

No escrow contract to deploy. No Hardhat required. Just a test wallet + test USDC.

---

## 1. One-time setup

### Get test ETH on Base Sepolia

```bash
# Option A — Coinbase faucet (recommended, fastest)
open https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet

# Option B — Superchain faucet (works without Coinbase account)
open https://app.optimism.io/faucet?activeTab=automatic
```

### Get test USDC on Base Sepolia

```bash
# Official Circle USDC testnet faucet — free, no KYC
open https://faucet.circle.com
# Select: "Base Sepolia" → paste your wallet address → request 10 USDC
```

USDC contract address (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

---

## 2. Configure your environment

Create `.env` in `examples/minimal-node-python/`:

```bash
# Your test wallet private key (NEVER use a funded mainnet key here)
PRIVATE_KEY=0x<your-test-wallet-private-key>

# The address of the agent being paid (Hardhat acct #1 by default, or your receiving agent wallet)
RECEIVING_AGENT_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# Base Sepolia RPC (public, no API key needed)
BASE_SEPOLIA_RPC=https://sepolia.base.org

# USDC on Base Sepolia (official Circle deployment)
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

---

## 3. Run the real on-chain flow

```bash
# Terminal 1 — Python receiving agent (unchanged from local example)
cd python-receiving-agent
pip install -r requirements.txt
python app.py

# Terminal 2 — Node paying agent (Sepolia mode)
cd ../node-paying-agent
npm install
npm run start:sepolia
```

**What you'll see:**
```
Connecting to Base Sepolia...
Wallet: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
USDC balance: 10.000000
Grant signed: 0x4207...
EIP-3009 transferWithAuthorization signature: 0xab3c...
Sending x402 request to receiving agent...
HTTP 200 received (2.4s settlement)
X-402-Receipt: {
  "receiptId": "0x...",
  "txHash": "0x<real-base-sepolia-tx>",
  "amount": "5000000",
  "settledAt": 1747258200
}
View on explorer: https://sepolia.basescan.org/tx/0x...
```

---

## 4. How EIP-3009 settlement works

The x402 protocol uses USDC's `transferWithAuthorization` function — no escrow contract needed.
The paying agent signs an off-chain authorization; the receiving agent submits it on-chain.

```
Paying Agent                    Receiving Agent              Base L2
     |                                 |                        |
     |  -- X-402-Payment header -----> |                        |
     |     {grant, sig, eip3009Auth}   |                        |
     |                                 |  -- transferWithAuth-> |
     |                                 |     (USDC.sol)         |
     |                                 |  <-- tx confirmed ---- |
     |  <-- HTTP 200 + X-402-Receipt - |                        |
```

The `eip3009Auth` object in the payment header:
```json
{
  "from":        "0xf39Fd...",
  "to":          "0x70997...",
  "value":       "5000000",
  "validAfter":  "0",
  "validBefore": "1747258500",
  "nonce":       "0x<random-32-bytes>",
  "signature":   "0x<eip712-sig>"
}
```

---

## 5. Verify on Basescan

Every settlement produces a real on-chain USDC transfer visible at:
```
https://sepolia.basescan.org/token/0x036CbD53842c5426634e7929541eC2318f3dCF7e?a=<your-wallet>
```

---

## 6. Differences from the local example

| | Local (simulated) | Base Sepolia (real) |
|---|---|---|
| Settlement | `time.sleep(0.1)` | `USDC.transferWithAuthorization()` |
| Receipt `txHash` | fake `0x1234...` | real Base Sepolia tx hash |
| Latency | ~0ms | 2–6 seconds |
| Cost | free | ~0 ETH (gas covered by receiving agent) |
| Revocation | skipped | live check against grant expiry |

---

## 7. Going to mainnet

Swap these two values — everything else stays identical:

```bash
# Mainnet
BASE_SEPOLIA_RPC=https://mainnet.base.org
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Chain ID changes from `84532` → `8453` in the grant's EIP-712 domain.

---

*Part of the x402 Agent Grant System — built by [AgentPay](https://x402-agent-pay.com)*
