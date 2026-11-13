# frozen_string_literal: true

require 'bundler/setup'
require 'x402'
require 'x402/mechanisms/evm'
require 'rack'
require 'rackup'
require 'json'
require 'dotenv/load'

# Get configuration from environment
EVM_ADDRESS = ENV['EVM_PAYEE_ADDRESS']
PORT = Integer(ENV['PORT'] || '4021')
FACILITATOR_URL = ENV['FACILITATOR_URL']
EVM_NETWORK = 'eip155:84532' # Base Sepolia

unless EVM_ADDRESS
  $stderr.puts 'Error: Missing required environment variable EVM_PAYEE_ADDRESS'
  exit 1
end

# Configure facilitator client
facilitator = if FACILITATOR_URL
                $stderr.puts "Using remote facilitator at: #{FACILITATOR_URL}"
                X402::HTTP::FacilitatorClient.new(url: FACILITATOR_URL)
              else
                $stderr.puts 'Using default facilitator'
                X402::HTTP::FacilitatorClient.new
              end

# Create resource server
server = X402::ResourceServer.new(facilitator)

# Register EVM exact scheme
server_scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
server.register('eip155:*', server_scheme)

# Define routes with payment requirements
routes = {
  'GET /protected' => {
    scheme: 'exact',
    network: EVM_NETWORK,
    pay_to: EVM_ADDRESS,
    price: '$0.001'
  }
}

# Track shutdown state
$shutdown_requested = false

# Application handler
app = lambda do |env|
  request = Rack::Request.new(env)
  path = request.path_info
  method = request.request_method

  case "#{method} #{path}"
  when 'GET /protected'
    if $shutdown_requested
      [503, { 'content-type' => 'application/json' }, ['{"error":"Server shutting down"}']]
    else
      body = {
        message: 'Access granted to protected resource',
        timestamp: Time.now.utc.iso8601,
        data: { resource: 'premium_content', access_level: 'paid' }
      }
      [200, { 'content-type' => 'application/json' }, [body.to_json]]
    end
  when 'GET /health'
    body = { status: 'healthy', timestamp: Time.now.utc.iso8601, server: 'rack' }
    [200, { 'content-type' => 'application/json' }, [body.to_json]]
  when 'POST /close'
    $shutdown_requested = true
    body = { message: 'Server shutting down gracefully', timestamp: Time.now.utc.iso8601 }
    # Schedule shutdown
    Thread.new do
      sleep 0.1
      Process.kill('TERM', Process.pid)
    end
    [200, { 'content-type' => 'application/json' }, [body.to_json]]
  else
    [404, { 'content-type' => 'application/json' }, ['{"error":"Not found"}']]
  end
end

# Wrap app with x402 payment middleware
wrapped_app = X402::HTTP::Middleware::Rack.new(app, server: server, routes: routes)

# Handle signals gracefully
Signal.trap('TERM') do
  $stderr.puts 'Received shutdown signal, exiting...'
  exit 0
end

Signal.trap('INT') do
  $stderr.puts 'Received shutdown signal, exiting...'
  exit 0
end

$stderr.puts "Starting Rack server on port #{PORT}"
$stderr.puts "EVM address: #{EVM_ADDRESS}"
$stderr.puts "EVM Network: #{EVM_NETWORK}"
$stderr.puts "Using facilitator: #{FACILITATOR_URL}"
$stderr.puts "Server listening on port #{PORT}"

Rackup::Handler::WEBrick.run(wrapped_app, Port: PORT, Host: '0.0.0.0', Logger: WEBrick::Log.new('/dev/null'), AccessLog: [])
