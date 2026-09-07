# x402 Facilitator Example

This example demonstrates how to run an x402 facilitator using the Ruby SDK with Sinatra.

## Setup

1. Copy `.env-local` to `.env` and configure:

```bash
cp .env-local .env
```

2. Install dependencies:

```bash
bundle install
```

## Usage

Run the facilitator:

```bash
ruby main.rb
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/supported` | List supported payment kinds |
| POST | `/verify` | Verify a payment payload |
| POST | `/settle` | Settle a payment |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Fee payer private key |
| `PORT` | Server port (default: `3402`) |

## Learn More

- [x402 Ruby SDK](../../../../ruby/x402/)
- [x402 Protocol](https://x402.org)
