# x402 Advanced Facilitator Examples (Python)

FastAPI facilitator service demonstrating advanced x402 patterns including all-networks support, bazaar discovery, and lifecycle hooks across EVM, SVM, and TVM.

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Any configured payment signer set:
  - EVM private key with Base Sepolia ETH for transaction fees
  - SVM private key with Solana Devnet SOL for transaction fees
  - TVM private key with TON testnet funds

To fund the TVM facilitator wallet, request testnet TON from [@testgiver_ton_bot](https://t.me/testgiver_ton_bot). The facilitator wallet only needs TON for relay fees and must hold **at least 1.1 TON** before running tests.

> **Note:** the facilitator uses a highload-wallet-v3 account, so the facilitator's wallet address differs from your W5 address — fund the highload-v3 address, not the W5 one derived from the same key.

To get testnet-USDT for the payer wallet, open the [testnet USDT transfer link](https://app.tonkeeper.com/transfer/kQDNUDJC0iQvJoZp0ml-YteL1NtTXKphU03CTI5v4VtBhGYs?amount=49000000&bin=te6cckEBAQEAFgAAKClXdJkAAAAAAAAAAAAAAAAAmJaAhDUekg) or scan the QR code below:
<img width="228" height="228" alt="QR code for the testnet USDT transfer link" src="https://github.com/user-attachments/assets/da09ad03-388d-4960-88bf-afbacf4a7c65" />

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

2. Fill required environment variables:

- `EVM_PRIVATE_KEY` - Ethereum private key
- `SVM_PRIVATE_KEY` - Solana private key
- `TVM_PRIVATE_KEY` - TVM private key for the facilitator wallet
- `TVM_NETWORK` - TVM CAIP-2 network (optional, defaults to `tvm:-3`)
- `TONCENTER_API_KEY` - Toncenter API key for TVM testnet (optional)
- `TONCENTER_BASE_URL` - Custom Toncenter base URL (optional)
- `PORT` - Server port (optional, defaults to 4022)

3. Install dependencies:

```bash
uv sync
```

4. Run the server:

```bash
uv run python all_networks.py   # All supported networks with optional chain configuration
uv run python bazaar.py         # Bazaar discovery extension
```

## Available Examples

| Example        | Command                         | Description                                              |
| -------------- | ------------------------------- | -------------------------------------------------------- |
| `all_networks` | `uv run python all_networks.py` | All supported networks with optional chain configuration |
| `bazaar`       | `uv run python bazaar.py`       | Bazaar discovery extension for cataloging x402 resources |

## API Endpoints

### GET /supported

Returns supported networks and schemes.

### POST /verify

Verifies a payment signature.

### POST /settle

Settles a verified payment by broadcasting the transaction on-chain.

## Network Identifiers

Networks use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet
- `tvm:-3` — TON Testnet
- `tvm:-239` — TON Mainnet
