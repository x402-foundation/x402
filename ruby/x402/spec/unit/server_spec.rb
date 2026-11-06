# frozen_string_literal: true

require 'spec_helper'
require_relative '../mocks/cash'

RSpec.describe X402::ResourceServer do
  let(:mock_server_scheme) { Mocks::Cash::ServerScheme.new }
  let(:mock_facilitator_client) { instance_double(X402::HTTP::FacilitatorClient) }
  let(:server) { described_class.new(mock_facilitator_client) }

  describe '#initialize' do
    it 'creates a new server' do
      expect(server).to be_a(described_class)
    end

    it 'accepts a facilitator client' do
      expect(server.instance_variable_get(:@facilitator_clients)).to include(mock_facilitator_client)
    end

    it 'accepts an array of facilitator clients' do
      client1 = instance_double(X402::HTTP::FacilitatorClient)
      client2 = instance_double(X402::HTTP::FacilitatorClient)
      server = described_class.new([client1, client2])
      clients = server.instance_variable_get(:@facilitator_clients)
      expect(clients).to contain_exactly(client1, client2)
    end

    it 'starts uninitialized' do
      expect(server.instance_variable_get(:@initialized)).to be false
    end
  end

  describe '#register' do
    it 'registers a scheme for a network' do
      server.register('mock:test', mock_server_scheme)
      schemes = server.instance_variable_get(:@schemes)
      expect(schemes['mock:test']['cash']).to eq(mock_server_scheme)
    end

    it 'returns self for chaining' do
      result = server.register('mock:test', mock_server_scheme)
      expect(result).to eq(server)
    end
  end

  describe '#initialize!' do
    before do
      server.register('mock:test', mock_server_scheme)
    end

    it 'fetches supported kinds from facilitator' do
      supported_response = X402::SupportedResponse.new(
        kinds: [
          X402::SupportedKind.new(
            scheme: 'cash',
            networks: ['mock:test'],
            x402_version: 2
          )
        ],
        extensions: [],
        signers: {}
      )

      allow(mock_facilitator_client).to receive(:get_supported).and_return(supported_response)

      server.initialize!
      expect(server.instance_variable_get(:@initialized)).to be true
    end

    it 'raises error if facilitator does not support registered schemes' do
      supported_response = X402::SupportedResponse.new(
        kinds: [],
        extensions: [],
        signers: {}
      )

      allow(mock_facilitator_client).to receive(:get_supported).and_return(supported_response)

      expect do
        server.initialize!
      end.to raise_error(/No facilitator found/)
    end
  end

  describe '#build_payment_requirements' do
    before do
      server.register('mock:test', mock_server_scheme)

      supported_response = X402::SupportedResponse.new(
        kinds: [
          X402::SupportedKind.new(
            scheme: 'cash',
            networks: ['mock:test'],
            x402_version: 2
          )
        ],
        extensions: [],
        signers: {}
      )

      allow(mock_facilitator_client).to receive(:get_supported).and_return(supported_response)
      server.initialize!
    end

    it 'builds payment requirements from config' do
      config = X402::ResourceConfig.new(
        scheme: 'cash',
        network: 'mock:test',
        pay_to: 'recipient_123',
        price: '$1.00'
      )

      requirements = server.build_payment_requirements(config)
      expect(requirements).to be_a(X402::PaymentRequirements)
      expect(requirements.scheme).to eq('cash')
      expect(requirements.network).to eq('mock:test')
      expect(requirements.pay_to).to eq('recipient_123')
      expect(requirements.amount).to eq('100')
    end

    it 'raises error if server not initialized' do
      uninit_server = described_class.new(mock_facilitator_client)
      uninit_server.register('mock:test', mock_server_scheme)

      config = X402::ResourceConfig.new(
        scheme: 'cash',
        network: 'mock:test',
        pay_to: 'test',
        price: '$1.00'
      )

      expect do
        uninit_server.build_payment_requirements(config)
      end.to raise_error(/must call initialize!/i)
    end
  end

  describe '#verify_payment' do
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
      supported_response = X402::SupportedResponse.new(
        kinds: [
          X402::SupportedKind.new(
            scheme: 'cash',
            networks: ['mock:test'],
            x402_version: 2
          )
        ],
        extensions: [],
        signers: {}
      )

      allow(mock_facilitator_client).to receive(:get_supported).and_return(supported_response)
      allow(mock_facilitator_client).to receive(:verify).and_return(
        X402::VerifyResponse.new(valid: true)
      )

      server.register('mock:test', mock_server_scheme)
      server.initialize!
    end

    it 'verifies payment via facilitator' do
      result = server.verify_payment(payload, requirements)
      expect(result).to be_a(X402::VerifyResponse)
      expect(result.valid).to be true
    end

    it 'executes before hooks' do
      hook_called = false
      server.before_verify { |_ctx| hook_called = true }
      server.verify_payment(payload, requirements)
      expect(hook_called).to be true
    end

    it 'executes after hooks' do
      hook_called = false
      server.after_verify { |_ctx| hook_called = true }
      server.verify_payment(payload, requirements)
      expect(hook_called).to be true
    end

    it 'handles verification failure' do
      allow(mock_facilitator_client).to receive(:verify).and_return(
        X402::VerifyResponse.new(
          valid: false,
          invalid_reason: 'insufficient_amount'
        )
      )

      result = server.verify_payment(payload, requirements)
      expect(result.valid).to be false
      expect(result.invalid_reason).to eq('insufficient_amount')
    end
  end

  describe '#settle_payment' do
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
      supported_response = X402::SupportedResponse.new(
        kinds: [
          X402::SupportedKind.new(
            scheme: 'cash',
            networks: ['mock:test'],
            x402_version: 2
          )
        ],
        extensions: [],
        signers: {}
      )

      allow(mock_facilitator_client).to receive(:get_supported).and_return(supported_response)
      allow(mock_facilitator_client).to receive(:settle).and_return(
        X402::SettleResponse.new(
          success: true,
          transaction: 'mock_tx_123'
        )
      )

      server.register('mock:test', mock_server_scheme)
      server.initialize!
    end

    it 'settles payment via facilitator' do
      result = server.settle_payment(payload, requirements)
      expect(result).to be_a(X402::SettleResponse)
      expect(result.success).to be true
      expect(result.transaction).to eq('mock_tx_123')
    end

    it 'executes before hooks' do
      hook_called = false
      server.before_settle { |_ctx| hook_called = true }
      server.settle_payment(payload, requirements)
      expect(hook_called).to be true
    end

    it 'executes after hooks' do
      hook_called = false
      server.after_settle { |_ctx| hook_called = true }
      server.settle_payment(payload, requirements)
      expect(hook_called).to be true
    end
  end
end
