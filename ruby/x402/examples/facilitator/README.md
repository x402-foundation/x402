# Facilitator Example

This example demonstrates how to run an x402 facilitator service using Sinatra.

## Overview

A facilitator:
- **Verifies** payment signatures and validity
- **Settles** payments on-chain
- **Reports** supported payment kinds to servers

## Setup

1. Install dependencies:
```bash
bundle install
```

2. Set environment variables:
```bash
export FEE_PAYER_ADDRESS="0x..."
export FEE_PAYER_PRIVATE_KEY="0x..."
export BASE_RPC_URL="https://mainnet.base.org"
export ETH_RPC_URL="https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY"
export PORT=3402
```

## Running

```bash
ruby app.rb
```

The facilitator will start on http://localhost:3402

## API Endpoints

### Health Check

```bash
curl http://localhost:3402/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": 1234567890
}
```

### Get Supported Kinds

```bash
curl http://localhost:3402/supported
```

Response:
```json
{
  "kinds": [
    {
      "scheme": "exact",
      "networks": ["eip155:8453", "eip155:1"],
      "x402Version": 2
    }
  ],
  "extensions": [],
  "signers": {}
}
```

### Verify Payment

```bash
curl -X POST http://localhost:3402/verify \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:8453",
      "inner": {
        "authorization": { ... },
        "signature": "0x..."
      }
    },
    "requirements": {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "1000000",
      "payTo": "0x...",
      "maxTimeoutSeconds": 3600
    }
  }'
```

Response (success):
```json
{
  "valid": true
}
```

Response (failure):
```json
{
  "valid": false,
  "invalidReason": "insufficient_amount",
  "extra": {
    "expected": 1000000,
    "got": 500000
  }
}
```

### Settle Payment

```bash
curl -X POST http://localhost:3402/settle \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { ... },
    "requirements": { ... }
  }'
```

Response (success):
```json
{
  "success": true,
  "transaction": "0xabc123...",
  "extra": {
    "network": "eip155:8453",
    "block": 12345678
  }
}
```

Response (failure):
```json
{
  "success": false,
  "extra": {
    "error": "Transaction reverted"
  }
}
```

## Testing

### With Server Example

1. Start facilitator:
```bash
cd examples/facilitator
ruby app.rb
```

2. Configure server to use local facilitator:
```bash
cd examples/server_rack
export FACILITATOR_URL="http://localhost:3402"
bundle exec rackup -p 9292
```

3. Test with client:
```bash
cd examples/client_basic
export API_URL="http://localhost:9292/api/premium/weather"
ruby client.rb
```

### Manual Testing

```bash
# Check health
curl http://localhost:3402/health

# Get supported kinds
curl http://localhost:3402/supported | jq

# Verify a payment (need valid payload)
curl -X POST http://localhost:3402/verify \
  -H "Content-Type: application/json" \
  -d @test_verify.json | jq

# Settle a payment (need valid payload)
curl -X POST http://localhost:3402/settle \
  -H "Content-Type: application/json" \
  -d @test_settle.json | jq
```

## Configuration

### Supported Networks

Currently configured for:
- **Base** (eip155:8453)
- **Ethereum** (eip155:1)

Add more networks by registering additional schemes:

```ruby
$facilitator.register(
  ['eip155:137', 'eip155:43114'],  # Polygon, Avalanche
  evm_scheme
)
```

### Fee Payer Management

The fee payer account:
- Pays gas fees for on-chain settlements
- Should have sufficient ETH/native token balance
- Should be monitored and funded regularly

**Security**: Use separate accounts for fee paying vs business funds.

### RPC Configuration

For production:
- Use dedicated RPC providers (Alchemy, Infura, QuickNode)
- Set up fallback RPC URLs
- Monitor RPC health and switch on failure

## Deployment

### Docker

```bash
docker build -t x402-facilitator .
docker run -p 3402:3402 \
  -e FEE_PAYER_ADDRESS="0x..." \
  -e FEE_PAYER_PRIVATE_KEY="0x..." \
  -e BASE_RPC_URL="https://..." \
  x402-facilitator
```

### Production Considerations

1. **Use secrets management**: AWS Secrets Manager, HashiCorp Vault
2. **Rate limiting**: Protect against abuse
3. **Monitoring**: Track verification/settlement rates, failures
4. **Health checks**: Monitor RPC connectivity, fee payer balance
5. **Logging**: Structured logs for debugging
6. **Authentication**: Require API keys from servers
7. **HTTPS**: Use TLS for all connections
8. **Idempotency**: Handle duplicate requests gracefully

## Security

### Private Key Protection

**Never** commit private keys to git:
- Use environment variables
- Use secrets management services
- Consider hardware security modules (HSM) for production

### API Security

Add authentication:

```ruby
before do
  halt 401, 'Unauthorized' unless authorized?
end

def authorized?
  request.env['HTTP_X_API_KEY'] == ENV['API_KEY']
end
```

### Nonce Tracking

Implement replay protection:

```ruby
# Before verification
nonce = payload.inner['authorization']['nonce']
if Redis.current.exists?("nonce:#{nonce}")
  return X402::VerifyResponse.new(
    valid: false,
    invalid_reason: 'nonce_reused'
  )
end

# After successful verification
Redis.current.setex("nonce:#{nonce}", 86400, '1')
```

## Monitoring

Key metrics to track:
- Verification requests per second
- Settlement success rate
- Average verification time
- Average settlement time
- Fee payer balance
- Gas prices paid
- Failed transactions

Example with StatsD:

```ruby
$facilitator.after_verify do |context|
  StatsD.increment('facilitator.verifications.success')
  StatsD.timing('facilitator.verification_time', context.duration_ms)
end

$facilitator.after_settle do |context|
  StatsD.increment('facilitator.settlements.success')
  StatsD.timing('facilitator.settlement_time', context.duration_ms)
  StatsD.histogram('facilitator.gas_used', context.result.extra['gas_used'])
end
```

## See Also

- [Server Example](../server_rack/README.md)
- [Client Example](../client_basic/README.md)
- [Facilitator Guide](../../FACILITATOR.md)
