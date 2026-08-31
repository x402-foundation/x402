# frozen_string_literal: true

require 'spec_helper'

RSpec.describe X402::HTTP::Utils do
  describe '.encode_payment_payload' do
    it 'encodes hash to base64' do
      payload = { 'test' => 'value' }
      encoded = described_class.encode_payment_payload(payload)
      expect(encoded).to be_a(String)
      decoded = Base64.strict_decode64(encoded)
      expect(JSON.parse(decoded)).to eq(payload)
    end

    it 'encodes PaymentPayload to base64' do
      payload = X402::PaymentPayload.new(
        x402_version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        inner: { 'test' => 'value' }
      )

      encoded = described_class.encode_payment_payload(payload)
      expect(encoded).to be_a(String)
      decoded = Base64.strict_decode64(encoded)
      json = JSON.parse(decoded)
      expect(json['x402Version']).to eq(2)
    end

    it 'encodes JSON string to base64' do
      json_str = '{"test":"value"}'
      encoded = described_class.encode_payment_payload(json_str)
      expect(encoded).to be_a(String)
      decoded = Base64.strict_decode64(encoded)
      expect(decoded).to eq(json_str)
    end
  end

  describe '.decode_payment_payload' do
    it 'decodes base64 to PaymentPayload' do
      payload_hash = {
        'x402Version' => 2,
        'scheme' => 'exact',
        'network' => 'eip155:8453',
        'inner' => { 'test' => 'value' }
      }
      encoded = Base64.strict_encode64(JSON.generate(payload_hash))

      payload = described_class.decode_payment_payload(encoded)
      expect(payload).to be_a(X402::PaymentPayload)
      expect(payload.x402_version).to eq(2)
      expect(payload.scheme).to eq('exact')
    end

    it 'raises error for invalid base64' do
      expect do
        described_class.decode_payment_payload('invalid!@#$')
      end.to raise_error(ArgumentError)
    end
  end

  describe '.build_402_headers' do
    it 'builds headers with encoded PaymentRequired' do
      payment_required = X402::PaymentRequired.new(
        x402_version: 2,
        requirements: [
          X402::PaymentRequirements.new(
            scheme: 'exact',
            network: 'eip155:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000',
            pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
            max_timeout_seconds: 3600
          )
        ]
      )

      headers = described_class.build_402_headers(payment_required)
      expect(headers['Payment-Required']).to be_a(String)
      expect(headers['Content-Type']).to eq('application/json')

      # Decode and verify
      decoded = Base64.strict_decode64(headers['Payment-Required'])
      json = JSON.parse(decoded)
      expect(json['x402Version']).to eq(2)
    end
  end

  describe '.parse_payment_required' do
    it 'parses PaymentRequired from JSON string' do
      json_str = JSON.generate({
        'x402Version' => 2,
        'requirements' => [
          {
            'scheme' => 'exact',
            'network' => 'eip155:8453',
            'asset' => '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            'amount' => '1000000',
            'payTo' => '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
            'maxTimeoutSeconds' => 3600
          }
        ]
      })

      pr = described_class.parse_payment_required(json_str)
      expect(pr).to be_a(X402::PaymentRequired)
      expect(pr.x402_version).to eq(2)
      expect(pr.requirements.first.pay_to).to eq('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb')
    end
  end

  describe '.parse_payment_response' do
    it 'parses PaymentResponse from JSON string' do
      json_str = JSON.generate({
        'success' => true,
        'transaction' => '0x123abc',
        'extra' => { 'note' => 'test' }
      })

      pr = described_class.parse_payment_response(json_str)
      expect(pr).to be_a(X402::SettleResponse)
      expect(pr.success).to be true
      expect(pr.transaction).to eq('0x123abc')
    end
  end
end
