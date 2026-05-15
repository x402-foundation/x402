# x402 End-to-End Example: Node.js Paying Agent + Python Receiving Agent

**Status:** Live  
**Companion Specs:** [../../specs/grants.md](../../specs/grants.md), [../../specs/payment-flow.md](../../specs/payment-flow.md)

This is the official minimal reference implementation. Clone, run, done.

## Quickstart

```bash
cd x402/examples/minimal-node-python

# Terminal 1
cd python-receiving-agent && pip install flask web3 && python app.py

# Terminal 2  
cd ../node-paying-agent && npm install ethers tsx && npm start
```

You'll see the full x402 cycle: grant signing → verification → settlement → receipt.

## What Happens

1. Node.js signs an EIP-712 grant (authorize $5 USDC spend)
2. Sends HTTP request with grant in `X-402-Payment` header
3. Python verifies the grant signature offline (instant)
4. Executes the tool and returns a receipt with settlement proof
5. Node.js receives the receipt and verifies on-chain

Total time: ~100ms (no blockchain involved in this local demo).

---

**See specs/ for full documentation**
