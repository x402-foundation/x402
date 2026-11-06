# X402 Server Guide

The X402 ResourceServer protects resources behind HTTP 402 Payment Required responses and verifies/settles payments.

## Table of Contents

- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Initialization](#initialization)
- [Building Requirements](#building-requirements)
- [Verifying Payments](#verifying-payments)
- [Settling Payments](#settling-payments)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Rack Middleware](#rack-middleware)
- [Rails Integration](#rails-integration)
- [Error Handling](#error-handling)
- [Advanced Usage](#advanced-usage)

## Quick Start

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Configure facilitator client
facilitator = X402::HTTP::FacilitatorClient.new(
  url: 'https://x402.org/facilitator'
)

# Create server
server = X402::ResourceServer.new(facilitator)

# Register scheme
server_scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
server.register('eip155:*', server_scheme)

# Initialize (fetches supported kinds)
server.initialize!

# Build payment requirements
config = X402::ResourceConfig.new(
  scheme: 'exact',
  network: 'eip155:8453',
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

## Core Concepts

### Resource Protection Flow

1. **Request arrives** without payment
2. **Server returns 402** with payment requirements
3. **Client creates payment** and retries with `Payment-Signature` header
4. **Server verifies payment** via facilitator
5. **Server settles payment** on-chain
6. **Server returns resource** with `Payment-Response` header

### Three-Phase Architecture

```ruby
# Phase 1: Build requirements (before request)
requirements = server.build_payment_requirements(config)

# Phase 2: Verify payment (on request)
verify_result = server.verify_payment(payload, requirements)

# Phase 3: Settle payment (after verification)
settle_result = server.settle_payment(payload, requirements)
```

## Initialization

### Single Facilitator

```ruby
facilitator = X402::HTTP::FacilitatorClient.new(
  url: 'https://x402.org/facilitator'
)

server = X402::ResourceServer.new(facilitator)
server.register('eip155:*', evm_scheme)
server.initialize!
```

### Multiple Facilitators

```ruby
# Different facilitators for different networks
facilitator1 = X402::HTTP::FacilitatorClient.new(
  url: 'https://evm-facilitator.example.com'
)

facilitator2 = X402::HTTP::FacilitatorClient.new(
  url: 'https://svm-facilitator.example.com'
)

server = X402::ResourceServer.new([facilitator1, facilitator2])
server.register('eip155:*', evm_scheme)
server.register('solana:*', svm_scheme)
server.initialize!
```

### Authentication

```ruby
facilitator = X402::HTTP::FacilitatorClient.new(
  url: 'https://facilitator.example.com',
  auth_headers: {
    'Authorization' => "Bearer #{ENV['FACILITATOR_API_KEY']}"
  }
)
```

### Initialization Requirement

**You must call `initialize!`** before building requirements:

```ruby
server.initialize!  # Fetches supported kinds from facilitators

# Now you can build requirements
requirements = server.build_payment_requirements(config)
```

This fetches supported payment kinds from facilitators and validates your registered schemes.

## Building Requirements

### Basic Configuration

```ruby
config = X402::ResourceConfig.new(
  scheme: 'exact',
  network: 'eip155:8453',      # Base mainnet
  pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  price: '$0.01'
)

requirements = server.build_payment_requirements(config)
```

### Price Formats

The server accepts various price formats:

```ruby
# Dollar string
price: '$1.00'

# Decimal string
price: '1.00'

# Numeric
price: 1.00

# With currency suffix
price: '1.00 USD'

# AssetAmount (direct)
price: X402::AssetAmount.new(amount: '1.00', asset: 'USD')
```

### Custom Asset

```ruby
config = X402::ResourceConfig.new(
  scheme: 'exact',
  network: 'eip155:8453',
  pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  price: '10.00',
  asset: '0x...'  # Custom ERC-20 token
)
```

### Timeout Configuration

```ruby
config = X402::ResourceConfig.new(
  scheme: 'exact',
  network: 'eip155:8453',
  pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  price: '$0.01',
  max_timeout_seconds: 1800  # 30 minutes
)
```

### Multiple Requirements

```ruby
# Let client choose network
requirements = [
  server.build_payment_requirements(
    X402::ResourceConfig.new(
      scheme: 'exact',
      network: 'eip155:8453',  # Base
      pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      price: '$0.01'
    )
  ),
  server.build_payment_requirements(
    X402::ResourceConfig.new(
      scheme: 'exact',
      network: 'eip155:1',     # Ethereum
      pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      price: '$0.01'
    )
  )
].flatten

payment_required = server.create_payment_required_response(requirements)
```

## Verifying Payments

### Basic Verification

```ruby
# Extract payload from request header
payment_header = request.headers['Payment-Signature']
payload = X402::HTTP::Utils.decode_payment_payload(payment_header)

# Verify
verify_result = server.verify_payment(payload, requirements)

if verify_result.valid?
  # Proceed to settlement
else
  # Return error
  [402, {}, [{ error: verify_result.invalid_reason }.to_json]]
end
```

### With Original Bytes

For signature verification, provide original bytes:

```ruby
payload_bytes = Base64.strict_decode64(payment_header)
requirements_bytes = JSON.generate(requirements.to_h)

verify_result = server.verify_payment(
  payload,
  requirements,
  payload_bytes: payload_bytes,
  requirements_bytes: requirements_bytes
)
```

### Handling Verification Errors

```ruby
verify_result = server.verify_payment(payload, requirements)

unless verify_result.valid?
  case verify_result.invalid_reason
  when 'insufficient_amount'
    return [402, {}, [{ error: 'Payment amount too low' }.to_json]]
  when 'invalid_signature'
    return [402, {}, [{ error: 'Invalid signature' }.to_json]]
  when 'expired'
    return [402, {}, [{ error: 'Payment expired' }.to_json]]
  else
    return [402, {}, [{ error: 'Payment invalid' }.to_json]]
  end
end
```

## Settling Payments

### Basic Settlement

```ruby
settle_result = server.settle_payment(payload, requirements)

if settle_result.success?
  # Payment settled successfully
  tx_hash = settle_result.transaction
  Rails.logger.info("Payment settled: #{tx_hash}")
else
  # Settlement failed
  Rails.logger.error("Settlement failed")
end
```

### Adding Payment Response Header

```ruby
settle_result = server.settle_payment(payload, requirements)

# Encode settlement result
payment_response = X402::HTTP::Utils.encode_payment_response(settle_result)

# Add to response headers
headers['Payment-Response'] = payment_response
```

### Complete Flow

```ruby
def handle_request(request)
  # Check for payment
  payment_header = request.headers['Payment-Signature']
  
  if payment_header.nil?
    # No payment - return 402
    return payment_required_response
  end
  
  # Decode payment
  payload = X402::HTTP::Utils.decode_payment_payload(payment_header)
  
  # Verify
  verify_result = server.verify_payment(payload, requirements)
  return [402, {}, ['Invalid payment']] unless verify_result.valid?
  
  # Settle
  settle_result = server.settle_payment(payload, requirements)
  return [500, {}, ['Settlement failed']] unless settle_result.success?
  
  # Return resource with payment response
  headers = { 'Payment-Response' => X402::HTTP::Utils.encode_payment_response(settle_result) }
  [200, headers, [resource_data]]
end
```

## Lifecycle Hooks

### Verification Hooks

```ruby
# Before verification
server.before_verify do |context|
  Rails.logger.info("Verifying payment from #{context.payload.get_network}")
  Rails.logger.info("Amount: #{context.requirements.amount}")
end

# After successful verification
server.after_verify do |context|
  Analytics.track('payment_verified', {
    network: context.payload.get_network,
    amount: context.requirements.amount
  })
end

# On verification failure
server.on_verify_failure do |context|
  Rails.logger.error("Verification failed: #{context.error.message}")
  
  # Could return RecoveredVerifyResult for fallback
  # Or nil to re-raise
  nil
end
```

### Settlement Hooks

```ruby
# Before settlement
server.before_settle do |context|
  Rails.logger.info("Settling payment")
  
  # Could abort settlement
  # X402::AbortResult.new(result: nil, error: StandardError.new("reason"))
end

# After successful settlement
server.after_settle do |context|
  Rails.logger.info("Payment settled: #{context.result.transaction}")
  
  # Store transaction record
  Payment.create!(
    transaction_hash: context.result.transaction,
    network: context.payload.get_network,
    amount: context.requirements.amount
  )
end

# On settlement failure
server.on_settle_failure do |context|
  Rails.logger.error("Settlement failed: #{context.error.message}")
  
  # Alert operations team
  AlertService.notify("Settlement failure", context.error)
  
  nil # Re-raise
end
```

## Rack Middleware

### Basic Setup

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Configure server
facilitator = X402::HTTP::FacilitatorClient.new(
  url: 'https://x402.org/facilitator'
)
server = X402::ResourceServer.new(facilitator)
server.register('eip155:*', X402::Mechanisms::EVM::Exact::ServerScheme.new)

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

### Wildcard Routes

```ruby
routes = {
  'GET /api/premium/*' => {  # Matches all paths under /api/premium/
    scheme: 'exact',
    network: 'eip155:8453',
    pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    price: '$1.00'
  }
}
```

### Dynamic Pricing

```ruby
routes = {
  'GET /api/data' => lambda do |request|
    # Dynamic pricing based on query params
    tier = request.params['tier'] || 'basic'
    
    {
      scheme: 'exact',
      network: 'eip155:8453',
      pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      price: tier == 'premium' ? '$1.00' : '$0.10'
    }
  end
}
```

## Rails Integration

### Application Configuration

```ruby
# config/initializers/x402.rb
require 'x402'
require 'x402/mechanisms/evm'

# Configure facilitator
$x402_facilitator = X402::HTTP::FacilitatorClient.new(
  url: ENV['X402_FACILITATOR_URL'] || 'https://x402.org/facilitator',
  auth_headers: {
    'Authorization' => "Bearer #{ENV['X402_API_KEY']}"
  }
)

# Configure server
$x402_server = X402::ResourceServer.new($x402_facilitator)
$x402_server.register(
  'eip155:*',
  X402::Mechanisms::EVM::Exact::ServerScheme.new
)

# Add hooks for logging
$x402_server.after_settle do |context|
  Rails.logger.info("Payment settled: #{context.result.transaction}")
end

# Initialize on app startup
Rails.application.config.after_initialize do
  $x402_server.initialize!
end
```

### Middleware Setup

```ruby
# config/application.rb
config.middleware.use X402::HTTP::Middleware::Rack,
  server: $x402_server,
  routes: {
    'GET /api/premium/*' => {
      scheme: 'exact',
      network: 'eip155:8453',
      pay_to: ENV['PAYMENT_WALLET'],
      price: '$1.00'
    }
  }
```

### Controller Action

```ruby
class ApiController < ApplicationController
  before_action :require_payment, only: [:premium_data]
  
  def premium_data
    render json: { data: 'premium content' }
  end
  
  private
  
  def require_payment
    # Check for payment header
    payment_header = request.headers['Payment-Signature']
    
    if payment_header.nil?
      render_payment_required
      return
    end
    
    # Verify and settle
    payload = X402::HTTP::Utils.decode_payment_payload(payment_header)
    requirements = build_requirements
    
    verify_result = $x402_server.verify_payment(payload, requirements)
    unless verify_result.valid?
      render json: { error: 'Invalid payment' }, status: 402
      return
    end
    
    settle_result = $x402_server.settle_payment(payload, requirements)
    unless settle_result.success?
      render json: { error: 'Settlement failed' }, status: 500
      return
    end
    
    # Add payment response header
    response.headers['Payment-Response'] = 
      X402::HTTP::Utils.encode_payment_response(settle_result)
  end
  
  def render_payment_required
    config = X402::ResourceConfig.new(
      scheme: 'exact',
      network: 'eip155:8453',
      pay_to: ENV['PAYMENT_WALLET'],
      price: '$1.00'
    )
    
    requirements = $x402_server.build_payment_requirements(config)
    payment_required = $x402_server.create_payment_required_response(
      requirements,
      resource: X402::ResourceInfo.new(
        url: request.original_url,
        description: 'Premium API data'
      )
    )
    
    headers = X402::HTTP::Utils.build_402_headers(payment_required)
    render json: payment_required, status: 402, headers: headers
  end
  
  def build_requirements
    config = X402::ResourceConfig.new(
      scheme: 'exact',
      network: 'eip155:8453',
      pay_to: ENV['PAYMENT_WALLET'],
      price: '$1.00'
    )
    
    $x402_server.build_payment_requirements(config).first
  end
end
```

## Error Handling

### Initialization Errors

```ruby
begin
  server.initialize!
rescue X402::SchemeNotFoundError => e
  Rails.logger.error("Scheme not found: #{e.scheme}")
  raise "Payment system configuration error"
end
```

### Verification Errors

```ruby
verify_result = server.verify_payment(payload, requirements)

if verify_result.valid?
  # Success
else
  # Check invalid_reason
  case verify_result.invalid_reason
  when X402::Mechanisms::EVM::Constants::ERR_AMOUNT_INSUFFICIENT
    render json: { error: 'Insufficient payment amount' }, status: 402
  when X402::Mechanisms::EVM::Constants::ERR_INVALID_SIGNATURE
    render json: { error: 'Invalid payment signature' }, status: 402
  else
    render json: { error: 'Payment verification failed' }, status: 402
  end
end
```

### Settlement Errors

```ruby
begin
  settle_result = server.settle_payment(payload, requirements)
  
  unless settle_result.success?
    Rails.logger.error("Settlement failed")
    render json: { error: 'Payment settlement failed' }, status: 500
    return
  end
rescue StandardError => e
  Rails.logger.error("Settlement error: #{e.message}")
  render json: { error: 'Settlement error' }, status: 500
end
```

## Advanced Usage

### Custom Money Parsers

```ruby
# Custom parser for non-USD prices
money_parser = lambda do |decimal_amount, network|
  if should_use_custom_token?(network)
    X402::AssetAmount.new(
      amount: (decimal_amount * 1_000_000).to_i.to_s,
      asset: get_custom_token_address(network)
    )
  else
    nil # Fall back to default
  end
end

scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new(
  money_parsers: [money_parser]
)
```

### Per-Route Configuration

```ruby
routes = {
  'GET /api/data' => lambda do |request|
    user = authenticate_user(request)
    
    # Discount for premium users
    price = user.premium? ? '$0.005' : '$0.01'
    
    {
      scheme: 'exact',
      network: 'eip155:8453',
      pay_to: ENV['PAYMENT_WALLET'],
      price: price
    }
  end
}
```

### Caching Requirements

```ruby
# Cache requirements to avoid rebuilding
@requirements_cache ||= {}

def get_requirements(resource_id)
  @requirements_cache[resource_id] ||= begin
    config = X402::ResourceConfig.new(
      scheme: 'exact',
      network: 'eip155:8453',
      pay_to: ENV['PAYMENT_WALLET'],
      price: get_price_for_resource(resource_id)
    )
    
    server.build_payment_requirements(config).first
  end
end
```

### Storing Payments

```ruby
server.after_settle do |context|
  Payment.create!(
    transaction_hash: context.result.transaction,
    network: context.payload.get_network,
    scheme: context.payload.get_scheme,
    amount: context.requirements.amount,
    asset: context.requirements.asset,
    recipient: context.requirements.pay_to,
    user_id: current_user.id,
    settled_at: Time.current
  )
end
```

## Best Practices

1. **Always initialize**: Call `server.initialize!` during app startup
   ```ruby
   Rails.application.config.after_initialize { $x402_server.initialize! }
   ```

2. **Use environment variables**: Configure payment recipients securely
   ```ruby
   pay_to: ENV['PAYMENT_WALLET']
   ```

3. **Add logging hooks**: Monitor payments in production
   ```ruby
   server.after_settle { |ctx| Rails.logger.info("Settled: #{ctx.result.transaction}") }
   ```

4. **Cache requirements**: Avoid rebuilding on every request
   ```ruby
   @requirements ||= server.build_payment_requirements(config)
   ```

5. **Handle errors gracefully**: Return clear error messages
   ```ruby
   unless verify_result.valid?
     render json: { error: verify_result.invalid_reason }, status: 402
   end
   ```

6. **Store transactions**: Keep payment records for reconciliation
   ```ruby
   Payment.create!(transaction_hash: settle_result.transaction, ...)
   ```

7. **Use middleware**: Simplify route protection with Rack middleware
   ```ruby
   use X402::HTTP::Middleware::Rack, server: server, routes: routes
   ```

## See Also

- [Client Guide](CLIENT.md) - Creating payments
- [Facilitator Guide](FACILITATOR.md) - Running a facilitator
- [API Documentation](https://rubydoc.info/gems/x402) - Full API reference
