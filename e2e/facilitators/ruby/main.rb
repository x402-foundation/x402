# frozen_string_literal: true

require 'bundler/setup'
require 'sinatra/base'
require 'x402'
require 'x402/mechanisms/evm'
require 'json'
require 'dotenv/load'

# Configuration
PORT = Integer(ENV['PORT'] || '4022')
EVM_PRIVATE_KEY = ENV['EVM_PRIVATE_KEY']
EVM_RPC_URL = ENV['EVM_RPC_URL'] || 'https://sepolia.base.org'
EVM_NETWORK = ENV['EVM_NETWORK'] || 'eip155:84532'

unless EVM_PRIVATE_KEY
  $stderr.puts '❌ EVM_PRIVATE_KEY environment variable is required'
  exit 1
end

# Create facilitator
$facilitator = X402::Facilitator.new

# Create EVM scheme
evm_scheme = X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(
  rpc_urls: { EVM_NETWORK => EVM_RPC_URL }
)

# Register for EVM networks
$facilitator.register([EVM_NETWORK], evm_scheme)

# Add logging hooks
$facilitator.before_verify do |context|
  $stderr.puts "[#{Time.now}] Verifying payment on #{context.payload.get_network}"
end

$facilitator.after_verify do |context|
  if context.result.valid?
    $stderr.puts "[#{Time.now}] ✓ Payment valid"
  else
    $stderr.puts "[#{Time.now}] ✗ Payment invalid: #{context.result.invalid_reason}"
  end
end

$facilitator.after_settle do |context|
  $stderr.puts "[#{Time.now}] ✓ Settled: #{context.result.transaction}"
end

$stderr.puts '✓ Facilitator configured'

# Sinatra application
class FacilitatorApp < Sinatra::Base
  set :port, PORT
  set :bind, '0.0.0.0'
  set :logging, false

  # Health check
  get '/health' do
    content_type :json
    { status: 'healthy', timestamp: Time.now.utc.iso8601 }.to_json
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
      request_body = JSON.parse(request.body.read)

      payload = X402::PaymentPayload.from_json(
        JSON.generate(request_body['payload'])
      )
      requirements = X402::PaymentRequirements.from_json(
        JSON.generate(request_body['requirements'])
      )

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
      request_body = JSON.parse(request.body.read)

      payload = X402::PaymentPayload.from_json(
        JSON.generate(request_body['payload'])
      )
      requirements = X402::PaymentRequirements.from_json(
        JSON.generate(request_body['requirements'])
      )

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

  # Graceful shutdown
  post '/close' do
    content_type :json

    Thread.new do
      sleep 0.1
      Process.kill('TERM', Process.pid)
    end

    { message: 'Facilitator shutting down', timestamp: Time.now.utc.iso8601 }.to_json
  end
end

# Handle signals
Signal.trap('TERM') do
  $stderr.puts 'Received shutdown signal, exiting...'
  exit 0
end

Signal.trap('INT') do
  $stderr.puts 'Received shutdown signal, exiting...'
  exit 0
end

$stderr.puts "Starting facilitator on port #{PORT}..."
$stderr.puts "EVM Network: #{EVM_NETWORK}"
$stderr.puts "EVM RPC: #{EVM_RPC_URL}"
$stderr.puts 'Endpoints:'
$stderr.puts '  GET  /health'
$stderr.puts '  GET  /supported'
$stderr.puts '  POST /verify'
$stderr.puts '  POST /settle'
$stderr.puts '  POST /close'

FacilitatorApp.run!
