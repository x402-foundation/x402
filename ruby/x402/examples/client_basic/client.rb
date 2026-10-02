#!/usr/bin/env ruby
# frozen_string_literal: true

require 'bundler/setup'
require 'x402'
require 'x402/mechanisms/evm'
require 'faraday'
require 'json'

# Example: Basic client usage for making payments to protected resources

# Configuration
PRIVATE_KEY = ENV['PRIVATE_KEY'] || raise('PRIVATE_KEY environment variable required')
API_URL = ENV['API_URL'] || 'https://example.com/api/premium/data'

puts "=== X402 Client Example ==="
puts "API URL: #{API_URL}"
puts

# 1. Create signer
puts "1. Creating EVM signer..."
signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(PRIVATE_KEY)
puts "   Address: #{signer.address}"
puts

# 2. Create client scheme
puts "2. Creating client scheme..."
client_scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)
puts "   Scheme: #{client_scheme.scheme}"
puts

# 3. Create and configure client
puts "3. Configuring client..."
client = X402::Client.new

# Register scheme for all EVM networks
client.register('eip155:*', client_scheme)

# Add policies
client.register_policy(X402::Client.prefer_network('eip155:8453')) # Prefer Base
client.register_policy(X402::Client.max_amount(10_000_000)) # Max $10 USDC
puts "   Registered schemes: eip155:*"
puts "   Policies: prefer Base, max $10"
puts

# Add hooks for logging
client.before_payment_creation do |context|
  puts "   Creating payment:"
  puts "     Network: #{context.requirements.network}"
  puts "     Amount: #{context.requirements.amount}"
  puts "     Recipient: #{context.requirements.pay_to}"
end

client.after_payment_creation do |context|
  puts "   ✓ Payment created successfully"
end

# 4. Make initial request (expect 402)
puts "4. Making initial request..."
conn = Faraday.new do |f|
  f.adapter Faraday.default_adapter
end

response = conn.get(API_URL)
puts "   Status: #{response.status}"
puts

if response.status == 402
  puts "5. Resource requires payment (402 response)"
  
  # 5. Parse Payment-Required header
  payment_required_header = response.headers['Payment-Required']
  
  if payment_required_header.nil?
    puts "   Error: No Payment-Required header found"
    exit 1
  end
  
  puts "   Parsing payment requirements..."
  payment_required = X402::HTTP::Utils.decode_payment_required(payment_required_header)
  
  puts "   Requirements received:"
  puts "     Protocol version: #{payment_required.x402_version}"
  puts "     Options: #{payment_required.requirements.length}"
  payment_required.requirements.each_with_index do |req, i|
    puts "       #{i + 1}. #{req.scheme} on #{req.network} - #{req.amount} (#{req.asset})"
  end
  puts
  
  # 6. Create payment
  puts "6. Creating payment payload..."
  payment_payload = client.create_payment_payload(payment_required)
  puts "   ✓ Payment payload created"
  puts "     Scheme: #{payment_payload.scheme}"
  puts "     Network: #{payment_payload.network}"
  puts
  
  # 7. Encode payment for header
  puts "7. Encoding payment for HTTP header..."
  payment_header = X402::HTTP::Utils.encode_payment_payload(payment_payload)
  puts "   ✓ Payment encoded (#{payment_header.length} bytes)"
  puts
  
  # 8. Retry request with payment
  puts "8. Retrying request with payment..."
  response = conn.get(API_URL) do |req|
    req.headers['Payment-Signature'] = payment_header
  end
  
  puts "   Status: #{response.status}"
  
  if response.status == 200
    puts "   ✓ Success! Resource accessed"
    puts
    
    # 9. Parse Payment-Response header
    payment_response_header = response.headers['Payment-Response']
    
    if payment_response_header
      puts "9. Payment response received"
      payment_response = X402::HTTP::Utils.parse_payment_response(payment_response_header)
      
      puts "   Settlement details:"
      puts "     Success: #{payment_response.success}"
      puts "     Transaction: #{payment_response.transaction}"
      puts
    end
    
    # 10. Display resource data
    puts "10. Resource data:"
    puts response.body
    puts
    
    puts "=== Payment Complete ==="
  else
    puts "   ✗ Error: #{response.status}"
    puts "   Body: #{response.body}"
  end
elsif response.status == 200
  puts "   No payment required (open resource)"
  puts "   Body: #{response.body}"
else
  puts "   Unexpected status: #{response.status}"
  puts "   Body: #{response.body}"
end
