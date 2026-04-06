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

| Variable              | Required      | Description                                      |
| --------------------- | ------------- | ------------------------------------------------ |
| `PORT`                | No            | Server port (default: 4022)                      |
| `EVM_PRIVATE_KEY`     | Conditionally | Private key for EVM transactions                 |
| `SVM_PRIVATE_KEY`     | Conditionally | Private key for SVM transactions                 |
| `TVM_PRIVATE_KEY`     | Conditionally | Private key for the TVM highload facilitator wallet |
| `EVM_RPC_URL`         | No            | Custom EVM RPC URL (default: Base Sepolia)       |
| `EVM_NETWORK`         | No            | EVM network identifier                           |
| `SVM_NETWORK`         | No            | SVM network identifier                           |
| `TVM_NETWORK`         | No            | TVM network identifier (default: `tvm:-3`)       |
| `TONCENTER_API_KEY`   | No            | Toncenter API key for TVM testnet                |
| `TONCENTER_BASE_URL`  | No            | Custom Toncenter base URL for TVM                |

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
- **pytoniq + Toncenter**: TVM blockchain interactions

## E2E Test Integration

This facilitator is automatically discovered by the e2e test framework via
`test.config.json`. The framework will:

1. Start the facilitator on an available port
2. Wait for the "Facilitator listening" log message
3. Run tests through the facilitator
4. Shut down via POST `/close`
