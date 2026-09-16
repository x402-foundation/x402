# frozen_string_literal: true

require 'spec_helper'

RSpec.describe 'Payment Schemas' do
  describe X402::PaymentRequirements do
    it 'creates from hash' do
      data = {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000000',
        pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        max_timeout_seconds: 3600
      }

      req = described_class.new(data)
      expect(req.scheme).to eq('exact')
      expect(req.network).to eq('eip155:8453')
      expect(req.amount).to eq('1000000')
    end

    it 'serializes to camelCase JSON' do
      req = described_class.new(
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000000',
        pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        max_timeout_seconds: 3600
      )

      json = JSON.parse(req.to_json)
      expect(json['payTo']).to eq('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb')
      expect(json['maxTimeoutSeconds']).to eq(3600)
      expect(json['pay_to']).to be_nil # snake_case should not be in JSON
    end

    it 'parses from camelCase JSON' do
      json_str = <<~JSON
        {
          "scheme": "exact",
          "network": "eip155:8453",
          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "amount": "1000000",
          "payTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
          "maxTimeoutSeconds": 3600
        }
      JSON

      req = described_class.from_json(json_str)
      expect(req.pay_to).to eq('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb')
      expect(req.max_timeout_seconds).to eq(3600)
    end

    it 'provides helper methods' do
      req = described_class.new(
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000000',
        pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        max_timeout_seconds: 3600
      )

      expect(req.get_scheme).to eq('exact')
      expect(req.get_network).to eq('eip155:8453')
      expect(req.get_amount).to eq('1000000')
    end
  end

  describe X402::PaymentPayload do
    it 'creates from hash' do
      data = {
        x402_version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        inner: {
          'authorization' => { 'from' => '0xabc' },
          'signature' => '0x123'
        }
      }

      payload = described_class.new(data)
      expect(payload.x402_version).to eq(2)
      expect(payload.scheme).to eq('exact')
      expect(payload.inner['authorization']).to be_a(Hash)
    end

    it 'serializes to camelCase JSON' do
      payload = described_class.new(
        x402_version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        inner: { 'test' => 'value' }
      )

      json = JSON.parse(payload.to_json)
      expect(json['x402Version']).to eq(2)
      expect(json['inner']).to eq({ 'test' => 'value' })
    end

    it 'provides helper methods' do
      payload = described_class.new(
        x402_version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        inner: { 'test' => 'value' }
      )

      expect(payload.get_scheme).to eq('exact')
      expect(payload.get_network).to eq('eip155:8453')
    end
  end

  describe X402::AssetAmount do
    it 'creates from hash' do
      data = { amount: '1.50', asset: 'USD' }
      asset_amount = described_class.new(data)
      expect(asset_amount.amount).to eq('1.50')
      expect(asset_amount.asset).to eq('USD')
    end

    it 'supports optional extra field' do
      data = { amount: '1.50', asset: 'USD', extra: { 'decimals' => 6 } }
      asset_amount = described_class.new(data)
      expect(asset_amount.extra['decimals']).to eq(6)
    end
  end

  describe X402::PaymentRequired do
    it 'creates from hash' do
      data = {
        x402_version: 2,
        requirements: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000',
            pay_to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
            max_timeout_seconds: 3600
          }
        ],
        resource: {
          url: 'https://example.com/api/data',
          description: 'Test data'
        }
      }

      pr = described_class.new(data)
      expect(pr.x402_version).to eq(2)
      expect(pr.requirements.first).to be_a(X402::PaymentRequirements)
      expect(pr.resource).to be_a(X402::ResourceInfo)
    end

    it 'serializes to camelCase JSON' do
      pr = described_class.new(
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

      json = JSON.parse(pr.to_json)
      expect(json['x402Version']).to eq(2)
      expect(json['requirements']).to be_an(Array)
      expect(json['requirements'][0]['payTo']).to be_a(String)
    end
  end
end
