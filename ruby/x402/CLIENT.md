# X402 Client Guide

The X402 Client creates signed payment payloads in response to HTTP 402 Payment Required responses.

## Table of Contents

- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Scheme Registration](#scheme-registration)
- [Policy System](#policy-system)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Error Handling](#error-handling)
- [Advanced Usage](#advanced-usage)

## Quick Start

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Create signer
signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(ENV['PRIVATE_KEY'])

# Create client scheme
client_scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)

# Create and configure client
client = X402::Client.new
client.register('eip155:*', client_scheme)

# Parse 402 response
payment_required = X402::Helpers.parse_payment_required(response_body)

# Create payment
payment_payload = client.create_payment_payload(payment_required)

# Encode for HTTP header
payment_header = X402::HTTP::Utils.encode_payment_payload(payment_payload)
```

## Core Concepts

### Payment Required

When a resource requires payment, the server returns an HTTP 402 response with a `PaymentRequired` object:

```ruby
{
  "x402Version": 2,
  "requirements": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "1000000",
      "payTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      "maxTimeoutSeconds": 3600
    }
  ],
  "resource": {
    "url": "https://example.com/api/data",
    "description": "Weather API data"
  }
}
```

### Payment Payload

The client creates a `PaymentPayload` containing the signed payment:

```ruby
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:8453",
  "inner": {
    "authorization": {
      "from": "0x...",
      "to": "0x...",
      "value": "1000000",
      "validAfter": "0",
      "validBefore": "1234567890",
      "nonce": "0x..."
    },
    "signature": "0x..."
  }
}
```

## Scheme Registration

### EVM Networks

```ruby
require 'x402/mechanisms/evm'

# Create signer
signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(private_key)

# Create client scheme
scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)

# Register for all EVM networks
client.register('eip155:*', scheme)

# Or register for specific networks
client.register('eip155:8453', scheme)  # Base mainnet only
```

### Multiple Networks

```ruby
# Register for multiple network types
client.register('eip155:*', evm_scheme)
client.register('solana:*', svm_scheme)
```

### Custom Selector

By default, the client selects the first matching requirement. Customize this:

```ruby
# Prefer lowest amount
selector = lambda do |version, requirements|
  requirements.min_by { |req| req.amount.to_i }
end

client = X402::Client.new(payment_requirements_selector: selector)
```

## Policy System

Policies filter and reorder requirements before selection.

### Built-in Policies

#### Prefer Network

```ruby
# Prioritize Base network
client.register_policy(X402::Client.prefer_network('eip155:8453'))
```

#### Prefer Scheme

```ruby
# Prioritize exact scheme
client.register_policy(X402::Client.prefer_scheme('exact'))
```

#### Max Amount

```ruby
# Filter out requirements above 1 USDC (1,000,000 micro-units)
client.register_policy(X402::Client.max_amount(1_000_000))
```

### Custom Policies

```ruby
# Only accept payments to specific recipient
client.register_policy(lambda do |version, requirements|
  requirements.select { |req| req.pay_to == ENV['APPROVED_RECIPIENT'] }
end)

# Prefer shorter timeouts
client.register_policy(lambda do |version, requirements|
  requirements.sort_by { |req| req.max_timeout_seconds }
end)
```

### Policy Chaining

Policies are applied in registration order:

```ruby
client.register_policy(X402::Client.prefer_network('eip155:8453'))
client.register_policy(X402::Client.max_amount(1_000_000))
# First prefers Base network, then filters by amount
```

## Lifecycle Hooks

Hooks execute at key points in the payment creation flow.

### Before Payment Creation

```ruby
client.before_payment_creation do |context|
  puts "Creating payment for #{context.requirements.scheme}"
  puts "Network: #{context.requirements.network}"
  puts "Amount: #{context.requirements.amount}"
end
```

### After Payment Creation

```ruby
client.after_payment_creation do |context|
  puts "Payment created successfully"
  puts "Scheme: #{context.result.scheme}"

  # Log for analytics
  Analytics.track('payment_created', {
    scheme: context.result.scheme,
    network: context.result.network
  })
end
```

### On Failure

```ruby
client.on_payment_creation_failure do |context|
  Rails.logger.error("Payment creation failed: #{context.error.message}")

  # Could return AbortResult to suppress error
  # X402::AbortResult.new(payload: nil, error: context.error)

  # Or return RecoveredPayloadResult with fallback
  # X402::RecoveredPayloadResult.new(payload: fallback_payload)

  # Return nil to re-raise original error
  nil
end
```

## Error Handling

### No Matching Requirements

```ruby
begin
  payment_payload = client.create_payment_payload(payment_required)
rescue X402::NoMatchingRequirementsError => e
  puts "No compatible payment method found"
  puts "Available: #{e.available_schemes}"
  puts "Supported: #{client.supported_schemes}"
end
```

### Scheme Not Found

```ruby
begin
  client.register('eip155:8453', scheme)
rescue X402::SchemeNotFoundError => e
  puts "Scheme not registered: #{e.scheme}"
end
```

### Recovery with Hooks

```ruby
client.on_payment_creation_failure do |context|
  case context.error
  when X402::NoMatchingRequirementsError
    # Try alternative service
    fallback_payload = FallbackService.create_payment(context.requirements)
    X402::RecoveredPayloadResult.new(payload: fallback_payload)
  else
    # Re-raise other errors
    nil
  end
end
```

## Advanced Usage

### Resource Info

Provide additional context when creating payments:

```ruby
payment_payload = client.create_payment_payload(
  payment_required,
  resource: X402::ResourceInfo.new(
    url: 'https://example.com/api/data',
    description: 'Weather API'
  )
)
```

### Extensions

Support protocol extensions:

```ruby
payment_payload = client.create_payment_payload(
  payment_required,
  extensions: {
    'bazaar' => {
      'discovery_url' => 'https://example.com/.well-known/x402'
    }
  }
)
```

### Multiple Facilitators

Handle requirements from different facilitators:

```ruby
# Requirements may come from different facilitators
# Client automatically selects based on registered schemes
payment_payload = client.create_payment_payload(payment_required)
```

### Protocol Versions

The client supports both V1 (legacy) and V2 protocols:

```ruby
# V2 (default) - CAIP-2 network identifiers
client.register('eip155:8453', scheme, x402_version: 2)

# V1 (legacy) - name-based identifiers
client.register('base', scheme, x402_version: 1)
```

### Debugging

Enable detailed logging:

```ruby
client.before_payment_creation do |context|
  Rails.logger.debug("Payment creation started")
  Rails.logger.debug("Requirements: #{context.requirements.to_json}")
end

client.after_payment_creation do |context|
  Rails.logger.debug("Payment created")
  Rails.logger.debug("Payload: #{context.result.to_json}")
end

client.on_payment_creation_failure do |context|
  Rails.logger.error("Payment failed: #{context.error.class}")
  Rails.logger.error("Message: #{context.error.message}")
  Rails.logger.error("Backtrace: #{context.error.backtrace.join("\n")}")
  nil
end
```

## HTTP Integration

### Manual HTTP Request

```ruby
require 'faraday'

# Make request
response = Faraday.get('https://example.com/api/data')

# Check for 402
if response.status == 402
  # Parse Payment-Required header
  payment_required = X402::HTTP::Utils.decode_payment_required(
    response.headers['Payment-Required']
  )

  # Create payment
  payment_payload = client.create_payment_payload(payment_required)

  # Retry with payment
  response = Faraday.get('https://example.com/api/data') do |req|
    req.headers['Payment-Signature'] = X402::HTTP::Utils.encode_payment_payload(payment_payload)
  end
end
```

### With Faraday Middleware (Future)

```ruby
# Coming soon: Automatic 402 handling
conn = Faraday.new(url: 'https://example.com') do |f|
  f.use X402::HTTP::Middleware::Faraday, client: client
  f.adapter Faraday.default_adapter
end

response = conn.get('/api/data') # Automatically handles 402
```

## Best Practices

1. **Register schemes broadly**: Use wildcards for network patterns
   ```ruby
   client.register('eip155:*', evm_scheme)  # Not 'eip155:8453'
   ```

2. **Use policies for constraints**: Filter by amount, network, or recipient
   ```ruby
   client.register_policy(X402::Client.max_amount(10_000_000))
   ```

3. **Handle errors gracefully**: Use hooks for recovery
   ```ruby
   client.on_payment_creation_failure { |ctx| handle_error(ctx) }
   ```

4. **Secure private keys**: Use environment variables
   ```ruby
   signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(ENV['PRIVATE_KEY'])
   ```

5. **Log for debugging**: Add hooks for production monitoring
   ```ruby
   client.after_payment_creation { |ctx| Analytics.track('payment', ctx) }
   ```

## See Also

- [Server Guide](SERVER.md) - Protecting resources
- [Facilitator Guide](FACILITATOR.md) - Running a facilitator
- [API Documentation](https://rubydoc.info/gems/x402) - Full API reference
