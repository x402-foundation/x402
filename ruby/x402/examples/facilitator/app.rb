#!/usr/bin/env ruby
# frozen_string_literal: true

require 'bundler/setup'
require 'sinatra'
require 'x402'
require 'x402/mechanisms/evm'
require 'json'

# Example: Simple x402 facilitator using Sinatra

# Configuration
FEE_PAYER_ADDRESS = ENV['FEE_PAYER_ADDRESS'] || raise('FEE_PAYER_ADDRESS required')
FEE_PAYER_PRIVATE_KEY = ENV['FEE_PAYER_PRIVATE_KEY'] || raise('FEE_PAYER_PRIVATE_KEY required')
BASE_RPC_URL = ENV['BASE_RPC_URL'] || 'https://mainnet.base.org'
ETH_RPC_URL = ENV['ETH_RPC_URL'] || 'https://eth-mainnet.alchemyapi.io/v2/...'

puts "=== X402 Facilitator ==="
puts "Fee payer: #{FEE_PAYER_ADDRESS}"
puts "Base RPC: #{BASE_RPC_URL}"
puts "ETH RPC: #{ETH_RPC_URL}"
puts

# Create facilitator
$facilitator = X402::Facilitator.new

# Create EVM scheme
evm_scheme = X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(
  managed_fee_payers: [FEE_PAYER_ADDRESS],
  rpc_urls: {
    'eip155:8453' => BASE_RPC_URL,
    'eip155:1' => ETH_RPC_URL
  }
)

# Register for Base and Ethereum
$facilitator.register(
  ['eip155:8453', 'eip155:1'],
  evm_scheme
)

# Add logging hooks
$facilitator.before_verify do |context|
  puts "[#{Time.now}] Verifying payment on #{context.payload.get_network}"
end

$facilitator.after_verify do |context|
  if context.result.valid?
    puts "[#{Time.now}] ✓ Payment valid"
  else
    puts "[#{Time.now}] ✗ Payment invalid: #{context.result.invalid_reason}"
  end
end

$facilitator.after_settle do |context|
  puts "[#{Time.now}] ✓ Settled: #{context.result.transaction}"
end

puts "✓ Facilitator configured"
puts

# Sinatra settings
set :port, ENV['PORT'] || 3402
set :bind, '0.0.0.0'

# Health check
get '/health' do
  content_type :json
  {
    status: 'healthy',
    timestamp: Time.now.to_i
  }.to_json
end

# Get supported kinds
get '/supported' do
  content_type :json
  
  begin
    supported = $facilitator.get_supported
    supported.to_json
  rescue StandardError => e
    status 500
    { error: e.message }.to_json
  end
end

# Verify payment
post '/verify' do
  content_type :json
  
  begin
    # Parse request
    request_body = JSON.parse(request.body.read)
    
    payload = X402::PaymentPayload.from_json(
      JSON.generate(request_body['payload'])
    )
    requirements = X402::PaymentRequirements.from_json(
      JSON.generate(request_body['requirements'])
    )
    
    # Verify
    result = $facilitator.verify(payload, requirements)
    
    result.to_json
  rescue JSON::ParserError => e
    status 400
    { error: 'Invalid JSON', details: e.message }.to_json
  rescue StandardError => e
    status 500
    { error: 'Verification failed', details: e.message }.to_json
  end
end

# Settle payment
post '/settle' do
  content_type :json
  
  begin
    # Parse request
    request_body = JSON.parse(request.body.read)
    
    payload = X402::PaymentPayload.from_json(
      JSON.generate(request_body['payload'])
    )
    requirements = X402::PaymentRequirements.from_json(
      JSON.generate(request_body['requirements'])
    )
    
    # Settle
    result = $facilitator.settle(payload, requirements)
    
    result.to_json
  rescue JSON::ParserError => e
    status 400
    { error: 'Invalid JSON', details: e.message }.to_json
  rescue StandardError => e
    status 500
    { error: 'Settlement failed', details: e.message }.to_json
  end
end

# Error handlers
error 404 do
  content_type :json
  { error: 'Not found' }.to_json
end

error 500 do
  content_type :json
  { error: 'Internal server error' }.to_json
end

# Start message
puts "Starting facilitator on port #{settings.port}..."
puts "Endpoints:"
puts "  GET  /health"
puts "  GET  /supported"
puts "  POST /verify"
puts "  POST /settle"
puts
