# frozen_string_literal: true

require 'bundler/setup'
require 'x402'
require 'x402/mechanisms/evm'
require 'json'

# Example: Rack server with x402 payment protection

# Configuration from environment
FACILITATOR_URL = ENV['FACILITATOR_URL'] || 'https://x402.org/facilitator'
PAYMENT_WALLET = ENV['PAYMENT_WALLET'] || raise('PAYMENT_WALLET environment variable required')
PAYMENT_PRICE = ENV['PAYMENT_PRICE'] || '$0.01'
PAYMENT_NETWORK = ENV['PAYMENT_NETWORK'] || 'eip155:8453' # Base mainnet

puts "=== X402 Rack Server ==="
puts "Facilitator: #{FACILITATOR_URL}"
puts "Payment wallet: #{PAYMENT_WALLET}"
puts "Price: #{PAYMENT_PRICE}"
puts "Network: #{PAYMENT_NETWORK}"
puts

# Configure facilitator client
facilitator = X402::HTTP::FacilitatorClient.new(url: FACILITATOR_URL)

# Create server
server = X402::ResourceServer.new(facilitator)

# Register EVM scheme
server_scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
server.register('eip155:*', server_scheme)

# Add hooks for logging
server.before_verify do |context|
  puts "[#{Time.now}] Verifying payment from #{context.payload.get_network}"
end

server.after_verify do |context|
  if context.result.valid?
    puts "[#{Time.now}] ✓ Payment verified"
  else
    puts "[#{Time.now}] ✗ Payment invalid: #{context.result.invalid_reason}"
  end
end

server.after_settle do |context|
  puts "[#{Time.now}] ✓ Payment settled: #{context.result.transaction}"
end

# Initialize (fetches supported kinds from facilitator)
puts "Initializing server..."
server.initialize!
puts "✓ Server initialized"
puts

# Define protected routes
routes = {
  'GET /api/free' => nil, # Free endpoint
  'GET /api/premium/weather' => {
    scheme: 'exact',
    network: PAYMENT_NETWORK,
    pay_to: PAYMENT_WALLET,
    price: PAYMENT_PRICE
  },
  'GET /api/premium/stocks' => {
    scheme: 'exact',
    network: PAYMENT_NETWORK,
    pay_to: PAYMENT_WALLET,
    price: '$0.05'
  },
  'GET /api/premium/*' => {
    scheme: 'exact',
    network: PAYMENT_NETWORK,
    pay_to: PAYMENT_WALLET,
    price: '$1.00'
  }
}

# Application
class App
  def call(env)
    request = Rack::Request.new(env)
    path = request.path
    
    case path
    when '/api/free'
      [200, { 'Content-Type' => 'application/json' }, [{ data: 'free content' }.to_json]]
    when '/api/premium/weather'
      [200, { 'Content-Type' => 'application/json' }, [{ data: 'weather data', temp: 72 }.to_json]]
    when '/api/premium/stocks'
      [200, { 'Content-Type' => 'application/json' }, [{ data: 'stock prices', spy: 450 }.to_json]]
    when %r{^/api/premium/}
      [200, { 'Content-Type' => 'application/json' }, [{ data: 'premium content' }.to_json]]
    else
      [404, { 'Content-Type' => 'application/json' }, [{ error: 'Not found' }.to_json]]
    end
  end
end

# Add x402 middleware
use X402::HTTP::Middleware::Rack, server: server, routes: routes

# Run application
run App.new
