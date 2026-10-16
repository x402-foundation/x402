# X402 Ruby SDK Examples

This directory contains complete, runnable examples demonstrating all aspects of the x402 protocol.

## Examples

### 1. Basic Client (`client_basic/`)

Demonstrates how to create payments for protected resources.

**Features:**
- EVM signer configuration
- Policy-based requirement selection
- Payment payload creation
- HTTP header encoding
- Full payment flow with retries

**Run:**
```bash
cd client_basic
export PRIVATE_KEY="0x..."
export API_URL="https://example.com/api/data"
ruby client.rb
```

[→ Client Example Documentation](client_basic/README.md)

### 2. Rack Server (`server_rack/`)

Complete Rack application with payment-protected endpoints.

**Features:**
- Rack middleware integration
- Multiple protected routes
- Dynamic pricing per endpoint
- Wildcard route matching
- Verification and settlement

**Run:**
```bash
cd server_rack
export PAYMENT_WALLET="0x..."
bundle exec rackup -p 9292
```

[→ Server Example Documentation](server_rack/README.md)

### 3. Facilitator (`facilitator/`)

Simple facilitator service using Sinatra.

**Features:**
- Payment verification
- On-chain settlement
- Supported kinds advertisement
- Health checks
- Logging hooks

**Run:**
```bash
cd facilitator
export FEE_PAYER_PRIVATE_KEY="0x..."
ruby app.rb
```

[→ Facilitator Example Documentation](facilitator/README.md)

## End-to-End Testing

Run all three components together:

### Terminal 1: Facilitator
```bash
cd facilitator
export FEE_PAYER_ADDRESS="0x..."
export FEE_PAYER_PRIVATE_KEY="0x..."
export BASE_RPC_URL="https://mainnet.base.org"
ruby app.rb
```

### Terminal 2: Server
```bash
cd server_rack
export FACILITATOR_URL="http://localhost:3402"
export PAYMENT_WALLET="0x..."
bundle exec rackup -p 9292
```

### Terminal 3: Client
```bash
cd client_basic
export API_URL="http://localhost:9292/api/premium/weather"
export PRIVATE_KEY="0x..."
ruby client.rb
```

## Quick Start

### 1. Install Dependencies

Each example has its own dependencies. Install them:

```bash
# Client
cd client_basic && bundle install

# Server
cd ../server_rack && bundle install

# Facilitator
cd ../facilitator && bundle install
```

### 2. Set Environment Variables

Create a `.env` file in each directory:

**client_basic/.env:**
```bash
PRIVATE_KEY=0x...
API_URL=http://localhost:9292/api/premium/weather
```

**server_rack/.env:**
```bash
FACILITATOR_URL=http://localhost:3402
PAYMENT_WALLET=0x...
PAYMENT_PRICE=$0.01
PAYMENT_NETWORK=eip155:8453
```

**facilitator/.env:**
```bash
FEE_PAYER_ADDRESS=0x...
FEE_PAYER_PRIVATE_KEY=0x...
BASE_RPC_URL=https://mainnet.base.org
ETH_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/...
PORT=3402
```

### 3. Run Examples

See individual README files for detailed instructions.

## Common Use Cases

### Testing Locally

Use the provided examples with test networks:

```bash
# Facilitator on Base Sepolia testnet
export PAYMENT_NETWORK="eip155:84532"
export BASE_RPC_URL="https://sepolia.base.org"

# Use testnet USDC addresses in code
```

### Production Deployment

For production:
1. Use dedicated RPC providers (Alchemy, Infura)
2. Secure private keys with secrets management
3. Add authentication to facilitator endpoints
4. Implement rate limiting
5. Add comprehensive monitoring
6. Use load balancers for high availability

### Custom Networks

Add support for additional networks:

```ruby
# In server_scheme.rb
server.register('eip155:137', evm_scheme)  # Polygon

# In facilitator
facilitator.register(
  ['eip155:137'],
  evm_scheme_with_polygon_rpc
)
```

## Architecture

```
┌─────────┐                    ┌─────────┐                    ┌─────────────┐
│ Client  │                    │ Server  │                    │ Facilitator │
└────┬────┘                    └────┬────┘                    └──────┬──────┘
     │                              │                                │
     │  1. GET /api/premium/data    │                                │
     ├─────────────────────────────>│                                │
     │                              │                                │
     │  2. 402 Payment Required     │                                │
     │     (with requirements)      │                                │
     │<─────────────────────────────┤                                │
     │                              │                                │
     │  3. Create payment payload   │                                │
     │     (sign with private key)  │                                │
     │                              │                                │
     │  4. GET /api/premium/data    │                                │
     │     (with Payment-Signature) │                                │
     ├─────────────────────────────>│                                │
     │                              │  5. Verify payment             │
     │                              ├───────────────────────────────>│
     │                              │                                │
     │                              │  6. Verification result        │
     │                              │<───────────────────────────────┤
     │                              │                                │
     │                              │  7. Settle payment             │
     │                              ├───────────────────────────────>│
     │                              │                                │
     │                              │  8. Settlement result          │
     │                              │     (transaction hash)         │
     │                              │<───────────────────────────────┤
     │                              │                                │
     │  9. 200 OK with resource     │                                │
     │     (with Payment-Response)  │                                │
     │<─────────────────────────────┤                                │
     │                              │                                │
```

## Troubleshooting

### Client Issues

**"No matching requirements"**
- Check that client has registered scheme for required network
- Verify policies aren't filtering out all requirements

**"Invalid signature"**
- Verify private key is correct
- Check EIP-712 domain parameters match

### Server Issues

**"Facilitator not responding"**
- Check `FACILITATOR_URL` is correct
- Verify facilitator is running
- Check network connectivity

**"Payment invalid"**
- Check verification logs in facilitator
- Verify payment amount matches requirements
- Check payment hasn't expired

### Facilitator Issues

**"Insufficient gas"**
- Check fee payer has sufficient native token (ETH, etc.)
- Fund fee payer account

**"RPC error"**
- Verify RPC URLs are correct and accessible
- Check RPC provider status
- Consider using fallback RPCs

## Additional Resources

- [Client Guide](../CLIENT.md)
- [Server Guide](../SERVER.md)
- [Facilitator Guide](../FACILITATOR.md)
- [API Documentation](https://rubydoc.info/gems/x402)
- [x402 Protocol Specification](https://x402.org)

## Contributing

Found an issue or want to improve examples?
See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
