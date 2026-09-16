# frozen_string_literal: true

require 'spec_helper'
require_relative '../mocks/cash'

RSpec.describe 'Full Payment Flow', type: :integration do
  # Set up all three components: client, server, facilitator
  let(:client_scheme) { Mocks::Cash::ClientScheme.new }
  let(:server_scheme) { Mocks::Cash::ServerScheme.new }
  let(:facilitator_scheme) { Mocks::Cash::FacilitatorScheme.new }

  let(:client) { X402::Client.new }
  let(:facilitator) { X402::Facilitator.new }
  let(:facilitator_client) { X402::HTTP::FacilitatorClient.new(url: 'http://localhost:3402') }
  let(:server) { X402::ResourceServer.new(facilitator) } # Use local facilitator

  before do
    # Register schemes
    client.register('mock:*', client_scheme)
    server.register('mock:*', server_scheme)
    facilitator.register(['mock:test', 'mock:dev'], facilitator_scheme)

    # Initialize server (fetches supported kinds from facilitator)
    server.initialize!
  end

  describe 'successful payment flow' do
    it 'completes the full payment lifecycle' do
      # Step 1: Server builds payment requirements
      config = X402::ResourceConfig.new(
        scheme: 'cash',
        network: 'mock:test',
        pay_to: 'merchant_wallet_123',
        price: '$1.00'
      )

      requirements_list = server.build_payment_requirements(config)
      expect(requirements_list).to be_an(Array)
      expect(requirements_list.length).to be > 0

      requirements = requirements_list.first
      expect(requirements.scheme).to eq('cash')
      expect(requirements.network).to eq('mock:test')
      expect(requirements.amount).to eq('100') # $1.00 as cents

      # Step 2: Server creates 402 response
      payment_required = server.create_payment_required_response(
        requirements_list,
        resource: X402::ResourceInfo.new(
          url: 'https://example.com/api/premium/data',
          description: 'Premium API data'
        )
      )

      expect(payment_required).to be_a(X402::PaymentRequired)
      expect(payment_required.x402_version).to eq(2)
      expect(payment_required.requirements.length).to eq(1)
      expect(payment_required.resource.url).to eq('https://example.com/api/premium/data')

      # Step 3: Client creates payment payload
      payment_payload = client.create_payment_payload(payment_required)

      expect(payment_payload).to be_a(X402::PaymentPayload)
      expect(payment_payload.scheme).to eq('cash')
      expect(payment_payload.network).to eq('mock:test')
      expect(payment_payload.inner['amount']).to eq('100')

      # Step 4: Server verifies payment
      verify_result = server.verify_payment(payment_payload, requirements)

      expect(verify_result).to be_a(X402::VerifyResponse)
      expect(verify_result.valid).to be true

      # Step 5: Server settles payment
      settle_result = server.settle_payment(payment_payload, requirements)

      expect(settle_result).to be_a(X402::SettleResponse)
      expect(settle_result.success).to be true
      expect(settle_result.transaction).to match(/^mock_tx_/)
    end
  end

  describe 'payment rejection flow' do
    it 'rejects insufficient payment' do
      # Server requires $1.00
      config = X402::ResourceConfig.new(
        scheme: 'cash',
        network: 'mock:test',
        pay_to: 'merchant_wallet_123',
        price: '$1.00'
      )

      requirements = server.build_payment_requirements(config).first

      # Client creates payment for only $0.50
      payment_required = X402::PaymentRequired.new(
        x402_version: 2,
        requirements: [requirements]
      )

      # Manually create underpaid payload
      payment_payload = X402::PaymentPayload.new(
        x402_version: 2,
        scheme: 'cash',
        network: 'mock:test',
        inner: {
          'amount' => '50', # Only $0.50
          'currency' => 'USD'
        }
      )

      # Verification should fail
      verify_result = server.verify_payment(payment_payload, requirements)

      expect(verify_result.valid).to be false
      expect(verify_result.invalid_reason).to eq('insufficient_amount')
    end
  end

  describe 'policy filtering' do
    it 'filters requirements by policy' do
      # Register multiple networks
      client.register('mock:*', client_scheme)
      client.register('test:*', client_scheme)

      # Add policy to prefer mock network
      client.register_policy(X402::Client.prefer_network('mock:test'))

      # Create requirements with multiple networks
      payment_required = X402::PaymentRequired.new(
        x402_version: 2,
        requirements: [
          X402::PaymentRequirements.new(
            scheme: 'cash',
            network: 'test:other',
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
      )

      # Client should select the preferred network
      payment_payload = client.create_payment_payload(payment_required)
      expect(payment_payload.network).to eq('mock:test')
    end
  end

  describe 'lifecycle hooks' do
    it 'executes hooks throughout the payment flow' do
      hooks_called = []

      # Client hooks
      client.before_payment_creation { |_ctx| hooks_called << :client_before }
      client.after_payment_creation { |_ctx| hooks_called << :client_after }

      # Server hooks
      server.before_verify { |_ctx| hooks_called << :server_before_verify }
      server.after_verify { |_ctx| hooks_called << :server_after_verify }
      server.before_settle { |_ctx| hooks_called << :server_before_settle }
      server.after_settle { |_ctx| hooks_called << :server_after_settle }

      # Facilitator hooks
      facilitator.before_verify { |_ctx| hooks_called << :facilitator_before_verify }
      facilitator.after_verify { |_ctx| hooks_called << :facilitator_after_verify }
      facilitator.before_settle { |_ctx| hooks_called << :facilitator_before_settle }
      facilitator.after_settle { |_ctx| hooks_called << :facilitator_after_settle }

      # Run full flow
      config = X402::ResourceConfig.new(
        scheme: 'cash',
        network: 'mock:test',
        pay_to: 'test',
        price: '$1.00'
      )

      requirements = server.build_payment_requirements(config).first
      payment_required = X402::PaymentRequired.new(
        x402_version: 2,
        requirements: [requirements]
      )

      payment_payload = client.create_payment_payload(payment_required)
      server.verify_payment(payment_payload, requirements)
      server.settle_payment(payment_payload, requirements)

      # Verify all hooks were called in order
      expect(hooks_called).to eq([
        :client_before,
        :client_after,
        :server_before_verify,
        :facilitator_before_verify,
        :facilitator_after_verify,
        :server_after_verify,
        :server_before_settle,
        :facilitator_before_settle,
        :facilitator_after_settle,
        :server_after_settle
      ])
    end
  end
end
