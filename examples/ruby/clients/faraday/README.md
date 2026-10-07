# x402 Faraday Client Example

This example demonstrates how to use the x402 Ruby SDK with Faraday to make requests to 402-protected endpoints with EVM (Ethereum) payments.

## Setup

1. Copy `.env-local` to `.env` and add your private key:

```bash
cp .env-local .env
```

2. Install dependencies:

```bash
bundle install
```

## Usage

Run the example:

```bash
ruby main.rb
```

## How it Works

1. **Create EVM signer** - Initialize a signer from your private key
2. **Register payment scheme** - Enable EVM exact payments on the client
3. **Make request** - The client handles the 402 flow automatically:
   - Makes initial request, receives 402 with payment requirements
   - Creates and signs payment payload
   - Retries request with payment header
   - Returns successful response

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Your EVM private key (hex, with or without 0x prefix) |
| `RESOURCE_SERVER_URL` | Base URL of the x402-protected server |
| `ENDPOINT_PATH` | Path to the protected endpoint |

## Learn More

- [x402 Ruby SDK](../../../../ruby/x402/)
- [x402 Protocol](https://x402.org)
