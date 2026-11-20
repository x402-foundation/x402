# x402 Rack Server Example

This example demonstrates how to use the x402 Ruby SDK with Rack middleware to protect endpoints with payment requirements.

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

Run the server:

```bash
rackup config.ru -p 4021
```

## How it Works

1. **Configure facilitator** - Connect to an x402 facilitator for payment verification
2. **Create resource server** - Register EVM payment scheme
3. **Define routes** - Specify payment requirements per endpoint
4. **Apply middleware** - Rack middleware handles 402 responses automatically

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EVM_PAYEE_ADDRESS` | Address to receive payments |
| `FACILITATOR_URL` | URL of the x402 facilitator |
| `PAYMENT_NETWORK` | EVM network in CAIP-2 format (default: `eip155:84532`) |
| `PORT` | Server port (default: `4021`) |

## Learn More

- [x402 Ruby SDK](../../../../ruby/x402/)
- [x402 Protocol](https://x402.org)
