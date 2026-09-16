# frozen_string_literal: true

require 'spec_helper'
require_relative '../mocks/cash'

RSpec.describe X402::Facilitator do
  let(:mock_facilitator_scheme) { Mocks::Cash::FacilitatorScheme.new }
  let(:facilitator) { described_class.new }

  describe '#initialize' do
    it 'creates a new facilitator' do
      expect(facilitator).to be_a(described_class)
    end
  end

  describe '#register' do
    it 'registers a scheme for networks' do
      facilitator.register(['mock:test'], mock_facilitator_scheme)
      schemes = facilitator.instance_variable_get(:@schemes)
      expect(schemes.length).to eq(1)
      expect(schemes.first.facilitator).to eq(mock_facilitator_scheme)
      expect(schemes.first.networks).to eq(['mock:test'])
    end

    it 'returns self for chaining' do
      result = facilitator.register(['mock:test'], mock_facilitator_scheme)
      expect(result).to eq(facilitator)
    end

    it 'derives network pattern from networks' do
      facilitator.register(['mock:test', 'mock:dev'], mock_facilitator_scheme)
      schemes = facilitator.instance_variable_get(:@schemes)
      expect(schemes.first.pattern).to eq('mock:*')
    end
  end

  describe '#get_supported' do
    before do
      facilitator.register(['mock:test'], mock_facilitator_scheme)
    end

    it 'returns supported response' do
      response = facilitator.get_supported
      expect(response).to be_a(X402::SupportedResponse)
      expect(response.kinds.length).to eq(1)
      expect(response.kinds.first.scheme).to eq('cash')
      expect(response.kinds.first.networks).to eq(['mock:test'])
    end
  end

  describe '#verify' do
    let(:payload) do
      X402::PaymentPayload.new(
        x402_version: 2,
        scheme: 'cash',
        network: 'mock:test',
        inner: {
          'amount' => '100',
          'currency' => 'USD'
        }
      )
    end

    let(:requirements) do
      X402::PaymentRequirements.new(
        scheme: 'cash',
        network: 'mock:test',
        asset: 'USD',
        amount: '100',
        pay_to: 'test',
        max_timeout_seconds: 3600
      )
    end

    before do
      facilitator.register(['mock:test'], mock_facilitator_scheme)
    end

    it 'verifies payment' do
      result = facilitator.verify(payload, requirements)
      expect(result).to be_a(X402::VerifyResponse)
      expect(result.valid).to be true
    end

    it 'executes before hooks' do
      hook_called = false
      facilitator.before_verify { |_ctx| hook_called = true }
      facilitator.verify(payload, requirements)
      expect(hook_called).to be true
    end

    it 'executes after hooks' do
      hook_called = false
      facilitator.after_verify { |_ctx| hook_called = true }
      facilitator.verify(payload, requirements)
      expect(hook_called).to be true
    end

    it 'returns invalid for insufficient amount' do
      payload.inner['amount'] = '50'
      result = facilitator.verify(payload, requirements)
      expect(result.valid).to be false
      expect(result.invalid_reason).to eq('insufficient_amount')
    end
  end

  describe '#settle' do
    let(:payload) do
      X402::PaymentPayload.new(
        x402_version: 2,
        scheme: 'cash',
        network: 'mock:test',
        inner: {
          'amount' => '100',
          'currency' => 'USD'
        }
      )
    end

    let(:requirements) do
      X402::PaymentRequirements.new(
        scheme: 'cash',
        network: 'mock:test',
        asset: 'USD',
        amount: '100',
        pay_to: 'test',
        max_timeout_seconds: 3600
      )
    end

    before do
      facilitator.register(['mock:test'], mock_facilitator_scheme)
    end

    it 'settles payment' do
      result = facilitator.settle(payload, requirements)
      expect(result).to be_a(X402::SettleResponse)
      expect(result.success).to be true
      expect(result.transaction).to match(/^mock_tx_/)
    end

    it 'executes before hooks' do
      hook_called = false
      facilitator.before_settle { |_ctx| hook_called = true }
      facilitator.settle(payload, requirements)
      expect(hook_called).to be true
    end

    it 'executes after hooks' do
      hook_called = false
      facilitator.after_settle { |_ctx| hook_called = true }
      facilitator.settle(payload, requirements)
      expect(hook_called).to be true
    end
  end
end
