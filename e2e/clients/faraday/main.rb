# frozen_string_literal: true

require 'bundler/setup'
require 'x402'
require 'x402/mechanisms/evm'
require 'faraday'
require 'json'
require 'dotenv/load'

# Get environment variables
evm_private_key = ENV['EVM_PRIVATE_KEY']
base_url = ENV['RESOURCE_SERVER_URL']
endpoint_path = ENV['ENDPOINT_PATH']

unless base_url && endpoint_path
  puts JSON.generate(success: false, error: 'Missing required environment variables')
  exit 1
end

unless evm_private_key
  puts JSON.generate(success: false, error: 'EVM_PRIVATE_KEY must be set')
  exit 1
end

begin
  # Create signer and client scheme
  signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(evm_private_key)
  client_scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)

  # Create and configure client
  client = X402::Client.new
  client.register('eip155:*', client_scheme)

  # Build full URL
  url = "#{base_url}#{endpoint_path}"

  # Make initial request
  conn = Faraday.new do |f|
    f.adapter Faraday.default_adapter
  end

  response = conn.get(url)

  if response.status == 402
    # Parse payment requirements from header
    payment_required_header = response.headers['payment-required']

    unless payment_required_header
      puts JSON.generate(success: false, error: 'No Payment-Required header found')
      exit 1
    end

    payment_required = X402::HTTP::Utils.decode_payment_required(payment_required_header)

    # Create payment payload
    payment_payload = client.create_payment_payload(payment_required)

    # Encode and retry with payment
    payment_header = X402::HTTP::Utils.encode_payment_payload(payment_payload)

    response = conn.get(url) do |req|
      req.headers['Payment'] = payment_header
    end
  end

  # Parse response
  response_data = JSON.parse(response.body)

  result = {
    success: true,
    data: response_data,
    status_code: response.status,
    payment_response: nil
  }

  # Check for payment response header
  payment_header = response.headers['payment-response'] || response.headers['x-payment-response']
  if payment_header
    payment_response = X402::HTTP::Utils.decode_payment_response(payment_header)
    result[:payment_response] = payment_response.to_h
  end

  puts JSON.generate(result)
  exit 0
rescue StandardError => e
  puts JSON.generate(success: false, error: e.message)
  exit 1
end
