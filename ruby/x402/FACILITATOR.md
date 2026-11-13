# X402 Facilitator Guide

The X402 Facilitator verifies payment signatures and settles transactions on-chain.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Scheme Registration](#scheme-registration)
- [Verification](#verification)
- [Settlement](#settlement)
- [HTTP API](#http-api)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Deployment](#deployment)
- [Security](#security)
- [Monitoring](#monitoring)

## Overview

A facilitator is a trusted service that:
1. **Verifies** payment signatures and validity
2. **Settles** payments on-chain via smart contracts or RPC
3. **Reports** supported payment kinds to servers
4. **Manages** fee payers and gas optimization

## Quick Start

```ruby
require 'x402'
require 'x402/mechanisms/evm'

# Create facilitator
facilitator = X402::Facilitator.new

# Register EVM scheme
evm_scheme = X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(
  managed_fee_payers: [ENV['FEE_PAYER_ADDRESS']],
  rpc_urls: {
    'eip155:8453' => ENV['BASE_RPC_URL']
  }
)

facilitator.register(
  ['eip155:8453', 'eip155:1'],  # Base and Ethereum
  evm_scheme
)

# Get supported kinds
supported = facilitator.get_supported
# Returns: { kinds: [...], extensions: [], signers: {} }

# Verify payment
verify_result = facilitator.verify(payload, requirements)

# Settle payment
settle_result = facilitator.settle(payload, requirements)
```

## Core Concepts

### Facilitator Responsibilities

1. **Signature Verification**: Validate cryptographic signatures
2. **On-chain Settlement**: Execute blockchain transactions
3. **Fee Management**: Pay transaction fees from managed accounts
4. **Kind Advertisement**: Inform servers of supported networks/schemes

### Trust Model

- Servers **trust** facilitators to verify and settle correctly
- Facilitators must be **auditable** and **reliable**
- Fee payers should be **segregated** from business funds
- Settlement should be **idempotent** where possible

## Scheme Registration

### Single Network

```ruby
# Register for Base mainnet only
facilitator.register(
  ['eip155:8453'],
  evm_scheme
)
```

### Multiple Networks

```ruby
# Register for multiple EVM networks
facilitator.register(
  ['eip155:8453', 'eip155:1', 'eip155:137'],  # Base, Ethereum, Polygon
  evm_scheme
)
```

### Multiple Schemes

```ruby
# EVM scheme
evm_scheme = X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(
  managed_fee_payers: [ENV['EVM_FEE_PAYER']],
  rpc_urls: {
    'eip155:8453' => ENV['BASE_RPC_URL']
  }
)

# SVM scheme
svm_scheme = X402::Mechanisms::SVM::Exact::FacilitatorScheme.new(
  managed_fee_payers: [ENV['SOLANA_FEE_PAYER']],
  rpc_client: solana_rpc_client
)

facilitator.register(['eip155:*'], evm_scheme)
facilitator.register(['solana:*'], svm_scheme)
```

## Verification

### Basic Verification

```ruby
verify_result = facilitator.verify(payload, requirements)

if verify_result.valid?
  # Proceed to settlement
else
  # Return error to server
  {
    error: verify_result.invalid_reason,
    details: verify_result.extra
  }
end
```

### Verification Checks

The facilitator scheme should verify:

1. **Signature validity**: Cryptographic signature is correct
2. **Amount sufficiency**: Payment amount ≥ required amount
3. **Recipient match**: Payment recipient matches requirements
4. **Token match**: Payment token matches required asset
5. **Expiry**: Payment is not expired (validBefore check)
6. **Nonce uniqueness**: Nonce hasn't been used (replay protection)

### EVM Verification Example

```ruby
class FacilitatorScheme
  def verify(payload, requirements)
    inner = payload.inner
    authorization = inner['authorization']
    signature = inner['signature']
    
    # 1. Verify signature
    unless valid_signature?(authorization, signature, requirements)
      return error_response('invalid_signature')
    end
    
    # 2. Check amount
    if authorization['value'].to_i < requirements.amount.to_i
      return error_response('insufficient_amount')
    end
    
    # 3. Check recipient
    unless authorization['to'].downcase == requirements.pay_to.downcase
      return error_response('recipient_mismatch')
    end
    
    # 4. Check expiry
    if Time.now.to_i > authorization['validBefore'].to_i
      return error_response('expired')
    end
    
    # 5. Check nonce uniqueness
    if nonce_used?(authorization['nonce'])
      return error_response('nonce_reused')
    end
    
    X402::VerifyResponse.new(valid: true)
  end
end
```

## Settlement

### Basic Settlement

```ruby
settle_result = facilitator.settle(payload, requirements)

if settle_result.success?
  # Transaction hash
  tx_hash = settle_result.transaction
  
  # Store for reconciliation
  Settlement.create!(
    transaction_hash: tx_hash,
    network: payload.get_network,
    amount: requirements.amount
  )
else
  # Settlement failed
  Rails.logger.error("Settlement failed")
end
```

### EVM Settlement Example

```ruby
def settle(payload, requirements)
  inner = payload.inner
  authorization = inner['authorization']
  signature = inner['signature']
  
  # Get network config
  config = get_network_config(requirements.network)
  
  # Build transaction
  contract = eth_contract(config.usdc_address)
  
  tx_hash = contract.transact_and_wait.transfer_with_authorization(
    authorization['from'],
    authorization['to'],
    authorization['value'],
    authorization['validAfter'],
    authorization['validBefore'],
    authorization['nonce'],
    signature
  )
  
  X402::SettleResponse.new(
    success: true,
    transaction: tx_hash,
    extra: {
      'network' => requirements.network,
      'block' => get_block_number(requirements.network)
    }
  )
rescue StandardError => e
  X402::SettleResponse.new(
    success: false,
    extra: { 'error' => e.message }
  )
end
```

### Idempotency

Implement idempotency to handle retries:

```ruby
def settle(payload, requirements)
  # Check if already settled
  nonce = payload.inner['authorization']['nonce']
  existing = Settlement.find_by(nonce: nonce)
  
  if existing
    return X402::SettleResponse.new(
      success: true,
      transaction: existing.transaction_hash,
      extra: { 'cached' => true }
    )
  end
  
  # Proceed with settlement
  # ...
end
```

## HTTP API

### Sinatra Application

```ruby
require 'sinatra'
require 'x402'
require 'x402/mechanisms/evm'

# Configure facilitator
$facilitator = X402::Facilitator.new
$facilitator.register(
  ['eip155:8453', 'eip155:1'],
  X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(
    managed_fee_payers: [ENV['FEE_PAYER']],
    rpc_urls: {
      'eip155:8453' => ENV['BASE_RPC_URL'],
      'eip155:1' => ENV['ETH_RPC_URL']
    }
  )
)

# GET /supported
get '/supported' do
  content_type :json
  $facilitator.get_supported.to_json
end

# POST /verify
post '/verify' do
  request_body = JSON.parse(request.body.read)
  
  payload = X402::PaymentPayload.from_json(
    JSON.generate(request_body['payload'])
  )
  requirements = X402::PaymentRequirements.from_json(
    JSON.generate(request_body['requirements'])
  )
  
  result = $facilitator.verify(payload, requirements)
  
  content_type :json
  result.to_json
end

# POST /settle
post '/settle' do
  request_body = JSON.parse(request.body.read)
  
  payload = X402::PaymentPayload.from_json(
    JSON.generate(request_body['payload'])
  )
  requirements = X402::PaymentRequirements.from_json(
    JSON.generate(request_body['requirements'])
  )
  
  result = $facilitator.settle(payload, requirements)
  
  content_type :json
  result.to_json
end
```

### Rails Application

```ruby
# config/routes.rb
namespace :facilitator do
  get 'supported', to: 'facilitator#supported'
  post 'verify', to: 'facilitator#verify'
  post 'settle', to: 'facilitator#settle'
end

# app/controllers/facilitator_controller.rb
class FacilitatorController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :authenticate_facilitator_request
  
  def supported
    render json: $facilitator.get_supported
  end
  
  def verify
    payload = X402::PaymentPayload.from_json(
      JSON.generate(params[:payload])
    )
    requirements = X402::PaymentRequirements.from_json(
      JSON.generate(params[:requirements])
    )
    
    result = $facilitator.verify(payload, requirements)
    render json: result
  end
  
  def settle
    payload = X402::PaymentPayload.from_json(
      JSON.generate(params[:payload])
    )
    requirements = X402::PaymentRequirements.from_json(
      JSON.generate(params[:requirements])
    )
    
    result = $facilitator.settle(payload, requirements)
    render json: result
  end
  
  private
  
  def authenticate_facilitator_request
    # Verify API key or other authentication
    api_key = request.headers['X-API-Key']
    
    unless valid_api_key?(api_key)
      render json: { error: 'Unauthorized' }, status: 401
    end
  end
end
```

## Lifecycle Hooks

### Verification Hooks

```ruby
# Before verification
facilitator.before_verify do |context|
  Rails.logger.info("Verifying payment")
  Rails.logger.info("Network: #{context.payload.get_network}")
  Rails.logger.info("Amount: #{context.requirements.amount}")
end

# After successful verification
facilitator.after_verify do |context|
  Rails.logger.info("Verification successful")
  
  # Log to database
  VerificationLog.create!(
    network: context.payload.get_network,
    amount: context.requirements.amount,
    valid: context.result.valid
  )
end

# On verification failure
facilitator.on_verify_failure do |context|
  Rails.logger.error("Verification error: #{context.error.message}")
  
  # Alert monitoring
  Sentry.capture_exception(context.error)
  
  nil # Re-raise
end
```

### Settlement Hooks

```ruby
# Before settlement
facilitator.before_settle do |context|
  Rails.logger.info("Settling payment")
  
  # Check balance before settlement
  if insufficient_gas_balance?(context.requirements.network)
    Rails.logger.error("Insufficient gas balance")
    # Could abort here
  end
end

# After successful settlement
facilitator.after_settle do |context|
  Rails.logger.info("Settlement successful: #{context.result.transaction}")
  
  # Store settlement record
  Settlement.create!(
    transaction_hash: context.result.transaction,
    network: context.payload.get_network,
    amount: context.requirements.amount,
    settled_at: Time.current
  )
  
  # Update metrics
  Metrics.increment('settlements.success')
end

# On settlement failure
facilitator.on_settle_failure do |context|
  Rails.logger.error("Settlement error: #{context.error.message}")
  
  # Alert operations team
  PagerDuty.trigger(
    summary: "Settlement failure",
    details: {
      error: context.error.message,
      network: context.payload.get_network,
      amount: context.requirements.amount
    }
  )
  
  Metrics.increment('settlements.failure')
  
  nil # Re-raise
end
```

## Deployment

### Environment Configuration

```bash
# .env
FEE_PAYER_ADDRESS=0x...
FEE_PAYER_PRIVATE_KEY=0x...

# RPC endpoints
BASE_RPC_URL=https://mainnet.base.org
ETH_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/...

# API keys
FACILITATOR_API_KEY=...

# Gas configuration
MAX_GAS_PRICE_GWEI=50
GAS_BUFFER_PERCENT=20
```

### Docker Deployment

```dockerfile
FROM ruby:3.2

WORKDIR /app

# Install dependencies
COPY Gemfile Gemfile.lock ./
RUN bundle install

# Copy application
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["bundle", "exec", "rackup", "-p", "3000"]
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: x402-facilitator
spec:
  replicas: 3
  selector:
    matchLabels:
      app: x402-facilitator
  template:
    metadata:
      labels:
        app: x402-facilitator
    spec:
      containers:
      - name: facilitator
        image: x402-facilitator:latest
        ports:
        - containerPort: 3000
        env:
        - name: FEE_PAYER_ADDRESS
          valueFrom:
            secretKeyRef:
              name: x402-secrets
              key: fee-payer-address
        - name: FEE_PAYER_PRIVATE_KEY
          valueFrom:
            secretKeyRef:
              name: x402-secrets
              key: fee-payer-private-key
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: x402-facilitator
spec:
  selector:
    app: x402-facilitator
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: LoadBalancer
```

## Security

### Private Key Management

**Never** commit private keys:

```ruby
# Use environment variables
private_key = ENV['FEE_PAYER_PRIVATE_KEY']

# Or use secrets management
private_key = AWS::SecretsManager.get_secret('x402/fee-payer-key')

# Or use hardware security modules
signer = HSM::Signer.new(key_id: ENV['HSM_KEY_ID'])
```

### API Authentication

Protect facilitator endpoints:

```ruby
before_action :authenticate_request

def authenticate_request
  api_key = request.headers['X-API-Key']
  api_secret = request.headers['X-API-Secret']
  
  unless valid_credentials?(api_key, api_secret)
    render json: { error: 'Unauthorized' }, status: 401
  end
end
```

### Rate Limiting

Prevent abuse:

```ruby
use Rack::Attack

# Throttle /settle requests
Rack::Attack.throttle('settle/ip', limit: 10, period: 60) do |req|
  req.ip if req.path == '/settle' && req.post?
end

# Block if too many verification failures
Rack::Attack.blocklist('block repeated verification failures') do |req|
  Redis.current.get("verification_failures:#{req.ip}").to_i > 50
end
```

### Nonce Tracking

Prevent replay attacks:

```ruby
class NonceStore
  def self.used?(nonce)
    Redis.current.exists?("nonce:#{nonce}")
  end
  
  def self.mark_used(nonce)
    # Store for 24 hours (longer than validBefore window)
    Redis.current.setex("nonce:#{nonce}", 86400, '1')
  end
end

def verify(payload, requirements)
  nonce = payload.inner['authorization']['nonce']
  
  if NonceStore.used?(nonce)
    return error_response('nonce_reused')
  end
  
  # ... verify signature, amount, etc.
  
  # Mark nonce as used
  NonceStore.mark_used(nonce)
  
  success_response
end
```

## Monitoring

### Metrics

Track key metrics:

```ruby
facilitator.after_verify do |context|
  StatsD.increment('facilitator.verifications.success')
  StatsD.histogram('facilitator.verification_time', context.duration_ms)
end

facilitator.after_settle do |context|
  StatsD.increment('facilitator.settlements.success')
  StatsD.histogram('facilitator.settlement_time', context.duration_ms)
  StatsD.histogram('facilitator.gas_used', context.result.extra['gas_used'])
end

facilitator.on_settle_failure do |context|
  StatsD.increment('facilitator.settlements.failure')
end
```

### Health Checks

```ruby
# Health check endpoint
get '/health' do
  checks = {
    database: database_healthy?,
    redis: redis_healthy?,
    base_rpc: rpc_healthy?('eip155:8453'),
    eth_rpc: rpc_healthy?('eip155:1'),
    fee_payer_balance: sufficient_balance?
  }
  
  if checks.values.all?
    status 200
    json checks.merge(status: 'healthy')
  else
    status 503
    json checks.merge(status: 'unhealthy')
  end
end
```

### Logging

Structure logs for analysis:

```ruby
facilitator.after_settle do |context|
  Rails.logger.info({
    event: 'settlement_success',
    transaction: context.result.transaction,
    network: context.payload.get_network,
    amount: context.requirements.amount,
    gas_used: context.result.extra['gas_used'],
    timestamp: Time.current.iso8601
  }.to_json)
end
```

## Best Practices

1. **Segregate fee payers**: Use dedicated accounts with limited funds
2. **Monitor balances**: Alert when gas balances run low
3. **Implement idempotency**: Handle duplicate settlement requests
4. **Track nonces**: Prevent replay attacks with nonce storage
5. **Rate limit**: Protect against abuse and DoS
6. **Secure keys**: Use secrets management or HSMs
7. **Log everything**: Comprehensive logging for debugging and auditing
8. **Set timeouts**: Fail fast on RPC issues
9. **Health checks**: Monitor RPC connectivity and balances
10. **Graceful degradation**: Return clear errors when services unavailable

## See Also

- [Client Guide](CLIENT.md) - Creating payments
- [Server Guide](SERVER.md) - Protecting resources
- [API Documentation](https://rubydoc.info/gems/x402) - Full API reference
