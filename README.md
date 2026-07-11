# hoodgate

**HTTP 402 Payment Rail on Robinhood Chain**

hoodgate is a toll gate for the internet. Every request hits the gate — pay USDG via EIP-3009, settle on-chain, and the data flows. No API keys. No accounts. No redirects. Just HTTP 402.

```
Request → 402 Payment Required → Client signs EIP-3009 → Facilitator settles on-chain → 200 OK
```

---

## Quick Start

```bash
# Clone
git clone https://github.com/neonize/hoodgate
cd hoodgate

# Run facilitator
cd rh-facilitator && npm install && npm start   # → :3001

# Run demo API
cd ../demo-api && npm install && npm start      # → :3005
```

Open `http://localhost:3005` — enter a city, pay 0.5 USDG, get weather data.

---

## How It Works

1. **402 Challenge** — Server demands 0.5 USDG for `/weather`
2. **EIP-3009 Sign** — Client signs authorization in-browser (no gas)
3. **Verify + Settle** — Facilitator verifies the signature, calls `transferWithAuthorization` on-chain
4. **200 OK** — Weather data delivered

---

## Architecture

```
┌──────────┐    402     ┌──────────────┐    EIP-3009    ┌────────────────┐
│  Client  │ ─────────→ │  demo-api    │ ─────────────→ │  rh-facilitator │
│ (browser)│ ←───────── │  (port 3005) │ ←───────────── │  (port 3001)    │
└──────────┘   200 OK   └──────────────┘    verified    └───────┬────────┘
                                                               │
                                                        settles on
                                                    ┌───▼───────────┐
                                                    │ Robinhood Chain│
                                                    │   (USDG)       │
                                                    └────────────────┘
```

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Chain | Robinhood Chain (testnet 46630) |
| Token | USDG (stablecoin) |
| Payment | EIP-3009 `transferWithAuthorization` |
| Facilitator | Node.js + ethers.js |
| Demo API | Express + ethers.js |
| UI | Single HTML file, JetBrains Mono, glassmorphism |

---

## Contract Addresses

### Testnet
| Contract | Address |
|----------|---------|
| MockUSDG | `0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4` |
| Facilitator / payTo | `0xb3D0265a0e9Ab5C4B39c5E7735958572BE16E985` |

### Mainnet (Chain ID 4663)
| Contract | Address |
|----------|---------|
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |

---

## API

hoodgate speaks the canonical **x402 v2 wire format** (matches `@x402/fetch@2.17.0`). Any spec-compliant x402 client works out of the box.

### `GET /health`
```json
{"status": "ok"}
```

### `POST /weather` — payment-gated

**Step 1 — 402 challenge**
```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64(JSON)>
Content-Type: application/json

{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:46630",
    "amount": "500000",
    "asset": "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4",
    "payTo": "0xb3D0265a0e9Ab5C4B39c5E7735958572BE16E985",
    "maxTimeoutSeconds": 60,
    "resource": "http://localhost:3005/weather",
    "description": "Real-time weather data for a given city",
    "mimeType": "application/json",
    "extra": { "name": "USDG", "version": "2" }
  }]
}
```

The `PAYMENT-REQUIRED` header carries a base64-encoded copy of the same JSON so SDKs can parse without reading the body.

**Step 2 — sign EIP-3009 `TransferWithAuthorization`** using the EIP-712 domain derived from `extra.name`/`extra.version` and `network` chain ID.

**Step 3 — retry with `PAYMENT-SIGNATURE`**
```
POST /weather HTTP/1.1
PAYMENT-SIGNATURE: <base64(JSON)>
Content-Type: application/json

{
  "x402Version": 2,
  "accepted": { /* full PaymentRequirements from step 1 */ },
  "payload": {
    "authorization": {
      "from": "0xad42...",
      "to":   "0xb3D0...",
      "value": "500000",
      "validAfter": "0",
      "validBefore": "1720000000",
      "nonce": "0x…"
    },
    "signature": "0x…"
  },
  "extensions": null
}
```

**Step 4 — 200 OK + settlement receipt**
```
HTTP/1.1 200 OK
PAYMENT-RESPONSE: <base64(JSON)>

{ "city": "Tokyo", "temp_f": 68, "condition": "Clear" }
```

The `PAYMENT-RESPONSE` header carries `{success, transaction, network, payer}`.

**Backward compatibility.** Legacy headers `X-PAYMENT` (request) and `X-PAYMENT-RESPONSE` (response) are still accepted/emitted so pre-v2 clients keep working.

---

## Security Invariants

The facilitator enforces the following before it will submit `transferWithAuthorization` on-chain. Each is covered by `rh-facilitator/e2e_security_invariants.mjs`:

| Invariant | Check | Failure mode blocked |
|-----------|-------|----------------------|
| Nonce not reused | `authorizationState(from, nonce) == false` | Replay attack |
| Signature valid | `ecrecover` matches `authorization.from` | Forged authorization |
| Amount matches | `authorization.value == requirements.amount` | Underpayment |
| **Recipient matches** | `authorization.to == requirements.payTo` | **Payment redirect to attacker** |
| Time window valid | `validAfter ≤ now < validBefore` | Expired / not-yet-valid replay |
| Sufficient balance | `balanceOf(from) ≥ value` | Wasted gas on failing tx |

Run the suite:
```bash
cd rh-facilitator
CLIENT_KEY=0x... node e2e_security_invariants.mjs
```

---

## Client SDK

Any spec-compliant x402 client works. Reference implementation with `@x402/fetch`:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const fetchWithPay = wrapFetchWithPayment(fetch, {
  account: privateKeyToAccount(process.env.PRIVATE_KEY),
});

const res = await fetchWithPay("http://localhost:3005/weather", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ city: "Jakarta" }),
});
console.log(await res.json());
```

---

## License

MIT