# Rack Server Example

This example demonstrates how to protect API endpoints with x402 payment requirements using Rack middleware.

## Setup

1. Install dependencies:
```bash
bundle install
```

2. Set environment variables:
```bash
export FACILITATOR_URL="https://x402.org/facilitator"
export PAYMENT_WALLET="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
export PAYMENT_PRICE="$0.01"
export PAYMENT_NETWORK="eip155:8453" # Base mainnet
```

## Running

```bash
bundle exec rackup -p 9292
```

The server will start on http://localhost:9292

## Endpoints

### Free Endpoint
```bash
curl http://localhost:9292/api/free
```

Returns without payment requirement.

### Premium Endpoints (Payment Required)

**Weather API** ($0.01):
```bash
curl http://localhost:9292/api/premium/weather
```

**Stocks API** ($0.05):
```bash
curl http://localhost:9292/api/premium/stocks
```

**Other Premium** ($1.00):
```bash
curl http://localhost:9292/api/premium/anything
```

## Payment Flow

1. **Request without payment**:
```bash
curl -i http://localhost:9292/api/premium/weather
```

Returns:
```
HTTP/1.1 402 Payment Required
Payment-Required: <base64 encoded payment requirements>
Content-Type: application/json

{
  "x402Version": 2,
  "requirements": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "10000",
    "payTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "maxTimeoutSeconds": 3600
  }],
  "resource": {
    "url": "http://localhost:9292/api/premium/weather",
    "description": "Protected API endpoint"
  }
}
```

2. **Request with payment** (use client example to create payment):
```bash
# Create payment with client
payment_sig=$(./client create_payment --requirements <base64>)

# Retry with payment
curl -i -H "Payment-Signature: $payment_sig" \
  http://localhost:9292/api/premium/weather
```

Returns:
```
HTTP/1.1 200 OK
Payment-Response: <base64 encoded settlement result>
Content-Type: application/json

{
  "data": "weather data",
  "temp": 72
}
```

## Route Configuration

Routes are configured with pricing:

```ruby
routes = {
  'GET /api/free' => nil,  # No payment required
  'GET /api/premium/weather' => {
    scheme: 'exact',
    network: 'eip155:8453',
    pay_to: '0x...',
    price: '$0.01'
  },
  'GET /api/premium/*' => {  # Wildcard for all premium routes
    scheme: 'exact',
    network: 'eip155:8453',
    pay_to: '0x...',
    price: '$1.00'
  }
}
```

## Middleware Behavior

The `X402::HTTP::Middleware::Rack` middleware:
1. Checks if the route requires payment
2. If payment required and missing → returns 402
3. If payment present → verifies with facilitator
4. If valid → settles payment and adds Payment-Response header
5. Passes request to application

## Testing with Client

Use the client example to test payment flow:

```bash
# Terminal 1: Start server
cd examples/server_rack
bundle exec rackup -p 9292

# Terminal 2: Run client
cd examples/client_basic
export API_URL="http://localhost:9292/api/premium/weather"
export PRIVATE_KEY="0x..."
ruby client.rb
```

## Notes

- Requires running facilitator (or use x402.org facilitator)
- Payment wallet receives USDC payments
- Supports dynamic pricing per route
- Automatically handles verification and settlement
- Returns clear 402 responses with payment requirements
