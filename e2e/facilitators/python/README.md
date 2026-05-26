# Python x402 Facilitator (E2E)

A Python implementation of an x402 facilitator service for end-to-end testing.

## Features

- **Multi-Chain Support**: Handles EVM (Base Sepolia), SVM (Solana Devnet), and TVM (TON testnet/mainnet) networks
- **Protocol Versions**: Supports both x402 V1 and V2 protocols
- **Bazaar Extension**: Full support for resource discovery and cataloging
- **Lifecycle Hooks**: Payment verification tracking and discovery info extraction

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) for dependency management

## Setup

```bash
# Install dependencies
./install.sh

# Or manually
uv sync
```

## Running

```bash
# Using run.sh (recommended for e2e tests)
./run.sh

# Or manually
uv run python main.py

# Or with uvicorn directly
uv run uvicorn main:app --port 4022
```

## Environment Variables

| Variable             | Required      | Description                                         |
| -------------------- | ------------- | --------------------------------------------------- |
| `PORT`               | No            | Server port (default: 4022)                         |
| `EVM_PRIVATE_KEY`    | Conditionally | Private key for EVM transactions                    |
| `SVM_PRIVATE_KEY`    | Conditionally | Private key for SVM transactions                    |
| `TVM_PRIVATE_KEY`    | Conditionally | Private key for the TVM highload facilitator wallet |
| `EVM_RPC_URL`        | No            | Custom EVM RPC URL (default: Base Sepolia)          |
| `EVM_NETWORK`        | No            | EVM network identifier                              |
| `SVM_NETWORK`        | No            | SVM network identifier                              |
| `TVM_NETWORK`        | No            | TVM network identifier (default: `tvm:-3`)          |
| `TVM_PROVIDER`       | No            | TVM provider: `toncenter` (default) or `tonapi`     |
| `TONCENTER_API_KEY`  | No            | Toncenter API key for TVM testnet                   |
| `TONCENTER_BASE_URL` | No            | Custom Toncenter base URL for TVM                   |
| `TONAPI_API_KEY`     | No            | TonAPI API key when `TVM_PROVIDER=tonapi`           |
| `TONAPI_BASE_URL`    | No            | Custom TonAPI base URL for TVM                      |

### TVM funding notes

To fund the TVM facilitator wallet, request testnet TON from [@testgiver_ton_bot](https://t.me/testgiver_ton_bot). The facilitator wallet only needs TON for relay fees and must hold **at least 1.1 TON** before running tests.

> **Note:** the facilitator uses a highload-wallet-v3 account, so the facilitator's wallet address differs from your W5 address — fund the highload-v3 address, not the W5 one derived from the same key.

To get testnet-USDT for the payer wallet, open the [testnet USDT transfer link](https://app.tonkeeper.com/transfer/kQDNUDJC0iQvJoZp0ml-YteL1NtTXKphU03CTI5v4VtBhGYs?amount=49000000&bin=te6cckEBAQEAFgAAKClXdJkAAAAAAAAAAAAAAAAAmJaAhDUekg) or scan the QR code below:
<img width="228" height="228" alt="QR code for the testnet USDT transfer link" src="https://github.com/user-attachments/assets/da09ad03-388d-4960-88bf-afbacf4a7c65" />

## Endpoints

| Method | Path                   | Description                                |
| ------ | ---------------------- | ------------------------------------------ |
| POST   | `/verify`              | Verify a payment against requirements      |
| POST   | `/settle`              | Settle a payment on-chain                  |
| GET    | `/supported`           | Get supported payment kinds and extensions |
| GET    | `/discovery/resources` | List discovered resources (bazaar)         |
| GET    | `/health`              | Health check                               |
| POST   | `/close`               | Graceful shutdown                          |

## API Examples

### Verify Payment

```bash
curl -X POST http://localhost:4022/verify \
  -H "Content-Type: application/json" \
  -d '{
    "paymentPayload": {...},
    "paymentRequirements": {...}
  }'
```

### Settle Payment

```bash
curl -X POST http://localhost:4022/settle \
  -H "Content-Type: application/json" \
  -d '{
    "paymentPayload": {...},
    "paymentRequirements": {...}
  }'
```

### Health Check

```bash
curl http://localhost:4022/health
```

## Architecture

The facilitator uses:

- **FastAPI**: Web framework for HTTP endpoints
- **x402 Python SDK**: Core x402 functionality
- **web3.py**: EVM blockchain interactions
- **solders**: SVM blockchain interactions
- **pytoniq + Toncenter/TonAPI**: TVM blockchain interactions

## E2E Test Integration

This facilitator is automatically discovered by the e2e test framework via
`test.config.json`. The framework will:

1. Start the facilitator on an available port
2. Wait for the "Facilitator listening" log message
3. Run tests through the facilitator
4. Shut down via POST `/close`
