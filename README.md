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
| Facilitator | `0xb3D0265a0e9Ab5C4B39c5E7735958572BE16E985` |
| Payment Dest | `0x5131c099eB615227aB2Bb8b542D4cBd622910a25` |

### Mainnet (Chain ID 4663)
| Contract | Address |
|----------|---------|
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |

---

## API

### `GET /health`
```json
{"status": "ok"}
```

### `GET /weather?city=Tokyo`
```
HTTP/1.1 402 Payment Required
X-Payment-Address: 0x5131c099eB615227aB2Bb8b542D4cBd622910a25
X-Payment-Amount: 500000
X-Payment-Token: USDG
X-Payment-Chain-Id: 46630
```

Pay the invoice, retry with the same `Authorization` header, get weather data.

---

## Client SDK (Coming Soon)

```js
import { hoodgate } from 'hoodgate'

const data = await hoodgate.pay({
  url: 'https://api.example.com/weather?city=Jakarta',
  chain: 46630,
  token: 'USDG',
  signer: wallet
})
```

---

## License

MIT