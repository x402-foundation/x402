# X402 Ruby SDK

Ruby implementation of the [x402 protocol](https://x402.org) - HTTP 402 Payment Required with cryptocurrency micropayments.

## Installation

Add this line to your application's Gemfile:

```ruby
gem 'x402'
```

Or install it yourself:

```bash
gem install x402
```

### Optional Dependencies

```ruby
# For EVM (Ethereum) support
gem 'eth', '~> 0.5'

# For SVM (Solana) support
gem 'base58'
gem 'ed25519'

# For web framework integration
gem 'rack', '~> 3.0'
gem 'faraday', '~> 2.0'
```

## Quick Start

### Client (Creating Payments)

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Create signer
signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(ENV['PRIVATE_KEY'])

# Create client scheme
client_scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)

# Register with client
client = X402::Client.new
client.register('eip155:*', client_scheme)

# Create payment from 402 response
payment_required = X402::Helpers.parse_payment_required(response_body)
payment_payload = client.create_payment_payload(payment_required)

# Send payment in header
headers = {
  'Payment-Signature' => X402::HTTP::Utils.encode_payment_payload(payment_payload)
}
```

### Server (Protecting Resources)

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Configure facilitator client
facilitator = X402::HTTP::FacilitatorClient.new(url: 'https://x402.org/facilitator')

# Create server
server = X402::ResourceServer.new(facilitator)

# Register EVM scheme
server_scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
server.register('eip155:*', server_scheme)

# Initialize (fetches supported kinds)
server.initialize!

# Build payment requirements
config = X402::ResourceConfig.new(
  scheme: 'exact',
  network: 'eip155:8453',  # Base mainnet
  pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  price: '$0.01'
)

requirements = server.build_payment_requirements(config)

# Create 402 response
payment_required = server.create_payment_required_response(
  requirements,
  resource: X402::ResourceInfo.new(
    url: 'https://example.com/api/data',
    description: 'Weather API data'
  )
)

# Return to client
[402, X402::HTTP::Utils.build_402_headers(payment_required), [payment_required.to_json]]
```

### Middleware (Rack Integration)

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Configure server
facilitator = X402::HTTP::FacilitatorClient.new(url: 'https://x402.org/facilitator')
server = X402::ResourceServer.new(facilitator)

server_scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
server.register('eip155:*', server_scheme)

# Define protected routes
routes = {
  'GET /api/weather' => {
    scheme: 'exact',
    network: 'eip155:8453',
    pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    price: '$0.01'
  },
  'GET /api/premium/*' => {
    scheme: 'exact',
    network: 'eip155:8453',
    pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    price: '$1.00'
  }
}

# Add middleware
use X402::HTTP::Middleware::Rack, server: server, routes: routes
```

## Features

### Core Components

- **X402::Client** - Creates signed payment payloads with policy system
- **X402::ResourceServer** - Protects resources and verifies/settles payments
- **X402::Facilitator** - Verifies and settles payments on-chain

### Blockchain Support

- **EVM (Ethereum)** - EIP-3009 (TransferWithAuthorization) for USDC payments
  - Supported networks: Ethereum, Base, Polygon, Avalanche, MegaETH
  - EIP-712 typed data signing
  - Private key signer with eth gem
  - Full production-ready implementation

- **SVM (Solana)** - SPL Token transfers with TransferChecked
  - Supported networks: Solana mainnet, devnet, testnet
  - Ed25519 signing
  - _Note: Simplified implementation - full Solana transaction building requires additional libraries_

### HTTP Integration

- **Faraday HTTP Client** - Facilitator communication
- **Rack Middleware** - Universal web framework integration
- Base64-encoded headers for 402 responses
- Payment signature verification

### Type Safety

- Built with dry-struct for runtime type validation
- Automatic camelCase JSON serialization
- Immutable data structures

### Lifecycle Hooks

All components support before/after/on_failure hooks:

```ruby
server.before_verify do |context|
  puts "Verifying payment from #{context.payment_payload.get_network}"
end

server.after_settle do |context|
  puts "Settled: #{context.result.transaction}"
end

server.on_verify_failure do |context|
  Rails.logger.error("Verification failed: #{context.error}")
  nil  # Re-raise error
end
```

### Policy System

Client supports policies for requirement selection:

```ruby
client.register_policy(X402::Client.prefer_network('eip155:8453'))
client.register_policy(X402::Client.max_amount(1_000_000))
```

## Supported Networks

### EVM Networks (via eip155:chainId)

- Ethereum Mainnet (`eip155:1`)
- Base Mainnet (`eip155:8453`)
- Base Sepolia Testnet (`eip155:84532`)
- Polygon (`eip155:137`)
- Avalanche C-Chain (`eip155:43114`)
- MegaETH (`eip155:4326`)

### Network Aliases

```ruby
'base' => 'eip155:8453'
'base-sepolia' => 'eip155:84532'
'ethereum' => 'eip155:1'
'polygon' => 'eip155:137'
```

## Architecture

The SDK follows the protocol specification:

1. **Server** builds payment requirements and returns 402
2. **Client** creates signed payment payload
3. **Server** verifies payment via facilitator
4. **Facilitator** settles payment on-chain
5. **Server** returns protected resource with payment response

## Protocol Version

This SDK implements **x402 Protocol V2** with:
- CAIP-2 network identifiers (e.g., `eip155:8453`)
- Scheme-based payment mechanisms
- EIP-712 typed data signing
- Facilitator-based verification and settlement

## Examples

See the `/examples` directory for complete applications:

- `examples/client_basic/` - Basic client usage
- `examples/server_rack/` - Rack server with middleware
- `examples/server_rails/` - Rails integration

## Documentation

- [Client Guide](CLIENT.md) - Detailed client implementation
- [Server Guide](SERVER.md) - Server setup and configuration
- [Facilitator Guide](FACILITATOR.md) - Running a facilitator
- [API Documentation](https://rubydoc.info/gems/x402) - YARD docs

## Development

```bash
# Install dependencies
bundle install

# Run tests
bundle exec rspec

# Run linter
bundle exec rubocop

# Generate docs
bundle exec yard doc
```

## Testing

```bash
# Run all tests
rake spec

# Run unit tests only
rake unit

# Run integration tests only
rake integration
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -am 'Add some feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Create a Pull Request

## License

Apache-2.0

## Links

- [x402 Protocol](https://x402.org)
- [Python SDK](../python/x402/)
- [TypeScript SDK](../../typescript/packages/x402/)
- [Go SDK](../../go/x402/)
