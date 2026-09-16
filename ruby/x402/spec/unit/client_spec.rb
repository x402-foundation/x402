# frozen_string_literal: true

require 'spec_helper'
require_relative '../mocks/cash'

RSpec.describe X402::Client do
  let(:mock_scheme) { Mocks::Cash::ClientScheme.new }
  let(:client) { described_class.new }

  describe '#initialize' do
    it 'creates a new client' do
      expect(client).to be_a(described_class)
    end

    it 'accepts a custom payment selector' do
      selector = ->(version, reqs) { reqs.first }
      client = described_class.new(payment_requirements_selector: selector)
      expect(client.instance_variable_get(:@selector)).to eq(selector)
    end
  end

  describe '#register' do
    it 'registers a scheme for a network' do
      client.register('mock:test', mock_scheme)
      schemes = client.instance_variable_get(:@schemes)
      expect(schemes['mock:test']['cash']).to eq(mock_scheme)
    end

    it 'returns self for chaining' do
      result = client.register('mock:test', mock_scheme)
      expect(result).to eq(client)
    end

    it 'supports wildcard patterns' do
      client.register('mock:*', mock_scheme)
      schemes = client.instance_variable_get(:@schemes)
      expect(schemes['mock:*']['cash']).to eq(mock_scheme)
    end
  end

  describe '#register_policy' do
    it 'registers a policy' do
      policy = ->(_version, reqs) { reqs }
      client.register_policy(policy)
      policies = client.instance_variable_get(:@policies)
      expect(policies).to include(policy)
    end

    it 'returns self for chaining' do
      policy = ->(_version, reqs) { reqs }
      result = client.register_policy(policy)
      expect(result).to eq(client)
    end
  end

  describe '#create_payment_payload' do
    before do
      client.register('mock:test', mock_scheme)
    end

    let(:payment_required) do
      X402::PaymentRequired.new(
        x402_version: 2,
        requirements: [
          X402::PaymentRequirements.new(
            scheme: 'cash',
            network: 'mock:test',
            asset: 'USD',
            amount: '100',
            pay_to: 'recipient_123',
            max_timeout_seconds: 3600
          )
        ],
        resource: X402::ResourceInfo.new(
          url: 'https://example.com/api/data',
          description: 'Test resource'
        )
      )
    end

    it 'creates a payment payload' do
      payload = client.create_payment_payload(payment_required)
      expect(payload).to be_a(X402::PaymentPayload)
      expect(payload.x402_version).to eq(2)
      expect(payload.scheme).to eq('cash')
      expect(payload.network).to eq('mock:test')
    end

    it 'uses the inner payload from the scheme' do
      payload = client.create_payment_payload(payment_required)
      expect(payload.inner['amount']).to eq('100')
      expect(payload.inner['currency']).to eq('USD')
    end

    it 'raises error when no matching scheme' do
      payment_required.requirements[0].scheme = 'unknown'
      expect do
        client.create_payment_payload(payment_required)
      end.to raise_error(X402::NoMatchingRequirementsError)
    end

    it 'applies policies before selection' do
      # Add a policy that filters out this requirement
      policy = ->(_version, reqs) { [] }
      client.register_policy(policy)

      expect do
        client.create_payment_payload(payment_required)
      end.to raise_error(X402::NoMatchingRequirementsError)
    end

    it 'executes before hooks' do
      hook_called = false
      client.before_payment_creation { |_ctx| hook_called = true }
      client.create_payment_payload(payment_required)
      expect(hook_called).to be true
    end

    it 'executes after hooks' do
      hook_called = false
      client.after_payment_creation { |_ctx| hook_called = true }
      client.create_payment_payload(payment_required)
      expect(hook_called).to be true
    end

    it 'handles hook errors with on_failure hook' do
      client.before_payment_creation { |_ctx| raise 'Test error' }

      error_caught = nil
      client.on_payment_creation_failure do |ctx|
        error_caught = ctx.error.message
        nil # Re-raise
      end

      expect do
        client.create_payment_payload(payment_required)
      end.to raise_error('Test error')

      expect(error_caught).to eq('Test error')
    end
  end

  describe '.prefer_network' do
    it 'returns a policy that prefers a network' do
      policy = described_class.prefer_network('mock:preferred')
      expect(policy).to be_a(Proc)
    end

    it 'prioritizes preferred network' do
      policy = described_class.prefer_network('mock:preferred')

      reqs = [
        X402::PaymentRequirements.new(
          scheme: 'cash',
          network: 'mock:other',
          asset: 'USD',
          amount: '100',
          pay_to: 'test',
          max_timeout_seconds: 3600
        ),
        X402::PaymentRequirements.new(
          scheme: 'cash',
          network: 'mock:preferred',
          asset: 'USD',
          amount: '100',
          pay_to: 'test',
          max_timeout_seconds: 3600
        )
      ]

      result = policy.call(2, reqs)
      expect(result.first.network).to eq('mock:preferred')
    end
  end

  describe '.prefer_scheme' do
    it 'returns a policy that prefers a scheme' do
      policy = described_class.prefer_scheme('cash')
      expect(policy).to be_a(Proc)
    end

    it 'prioritizes preferred scheme' do
      policy = described_class.prefer_scheme('cash')

      reqs = [
        X402::PaymentRequirements.new(
          scheme: 'other',
          network: 'mock:test',
          asset: 'USD',
          amount: '100',
          pay_to: 'test',
          max_timeout_seconds: 3600
        ),
        X402::PaymentRequirements.new(
          scheme: 'cash',
          network: 'mock:test',
          asset: 'USD',
          amount: '100',
          pay_to: 'test',
          max_timeout_seconds: 3600
        )
      ]

      result = policy.call(2, reqs)
      expect(result.first.scheme).to eq('cash')
    end
  end

  describe '.max_amount' do
    it 'returns a policy that filters by amount' do
      policy = described_class.max_amount(50)
      expect(policy).to be_a(Proc)
    end

    it 'filters out requirements above max' do
      policy = described_class.max_amount(50)

      reqs = [
        X402::PaymentRequirements.new(
          scheme: 'cash',
          network: 'mock:test',
          asset: 'USD',
          amount: '100',
          pay_to: 'test',
          max_timeout_seconds: 3600
        ),
        X402::PaymentRequirements.new(
          scheme: 'cash',
          network: 'mock:test',
          asset: 'USD',
          amount: '25',
          pay_to: 'test',
          max_timeout_seconds: 3600
        )
      ]

      result = policy.call(2, reqs)
      expect(result.length).to eq(1)
      expect(result.first.amount).to eq('25')
    end
  end
end
