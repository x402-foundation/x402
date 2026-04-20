# Prediction Market Oracle — x402 Example

A FastAPI server that gates live **Polymarket prediction market signals** behind x402 micropayments. Any x402-capable agent can pay $0.002 USDC per call and receive a directional signal with confidence score — no API key, no subscription.

Signals come from the [DeepBlue](https://deepbluebase.xyz) autonomous trading bot, which trades 5-minute BTC/ETH/SOL/XRP markets on Polymarket 24/7.

## Endpoints

| Endpoint | Payment | Price | What you get |
|----------|---------|-------|--------------|
| `GET /health` | No | Free | Server status |
| `GET /signal/{coin}` | Yes | $0.002 USDC | UP/DOWN signal + confidence for BTC, ETH, SOL, or XRP |
| `GET /markets` | Yes | $0.005 USDC | Top Polymarket crypto markets with live odds |

## Prerequisites

- Python 3.10+
- `uv` ([install](https://docs.astral.sh/uv/getting-started/installation/))
- EVM address on Base Mainnet to receive payments
- Solana address on Mainnet to receive payments

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

2. Fill in your wallet addresses:

```env
EVM_ADDRESS=0xYourBaseAddress
SVM_ADDRESS=YourSolanaAddress
```

3. Install dependencies:

```bash
uv sync
```

4. Run the server:

```bash
uv run python main.py
```

Server runs at `http://localhost:4022`.

## Example Usage

### Free health check
```bash
curl http://localhost:4022/health
# {"status":"ok","version":"1.0.0"}
```

### Request a signal (triggers 402)
```bash
curl -i http://localhost:4022/signal/BTC
# HTTP/1.1 402 Payment Required
# payment-required: <base64 payment requirements>
```

### Pay and receive signal (using x402 Python client)
```python
import httpx
from x402.http.client import x402Client

client = x402Client(wallet=your_wallet)
resp = client.get("http://localhost:4022/signal/BTC")
print(resp.json())
# {
#   "coin": "BTC",
#   "direction": "UP",
#   "confidence": 0.63,
#   "regime": "trending",
#   "source": "deepblue-polymarket-bot"
# }
```

## How It Works

1. Agent requests `GET /signal/BTC`
2. Server returns `402 Payment Required` with USDC payment details
3. Agent signs and submits payment via x402 (Base or Solana)
4. Server verifies payment through facilitator
5. Server fetches live signal from DeepBlue API and returns it

The oracle is backed by a real trading bot — [deepbluebase.xyz/performance](https://deepbluebase.xyz/performance) shows live P&L and win rates.

## Extending This Example

To wrap any prediction market API with x402, change the upstream fetch in `main.py`:

```python
# Replace with your oracle logic
async with httpx.AsyncClient() as client:
    resp = await client.get("https://your-data-source.com/signal")
```

Adjust the price per call in the `routes` dict to match your data's value.
