# frozen_string_literal: true

# Mock "cash" payment scheme for testing without blockchain dependencies
module Mocks
  module Cash
    ##
    # Mock client scheme
    class ClientScheme
      include X402::SchemeNetworkClient

      def scheme
        'cash'
      end

      def networks
        ['mock:test']
      end

      def create_payment_payload(requirements)
        {
          'amount' => requirements.amount,
          'currency' => 'USD',
          'note' => 'cash payment'
        }
      end
    end

    ##
    # Mock server scheme
    class ServerScheme
      include X402::SchemeNetworkServer

      def scheme
        'cash'
      end

      def networks
        ['mock:test']
      end

      def parse_price(price, network)
        return price if price.is_a?(X402::AssetAmount)

        amount = price.to_s.gsub(/[^\d.]/, '')
        X402::AssetAmount.new(amount: amount, asset: 'USD')
      end

      def enhance_payment_requirements(requirements, supported_kind, extension_keys)
        requirements.asset ||= 'USD'
        requirements.amount = requirements.amount.gsub('.', '') if requirements.amount.include?('.')
        requirements
      end
    end

    ##
    # Mock facilitator scheme
    class FacilitatorScheme
      include X402::SchemeNetworkFacilitator

      def scheme
        'cash'
      end

      def networks
        ['mock:test']
      end

      def verify(payload, requirements)
        inner = payload.inner
        amount = inner['amount'].to_i
        required_amount = requirements.amount.to_i

        if amount >= required_amount
          X402::VerifyResponse.new(valid: true)
        else
          X402::VerifyResponse.new(
            valid: false,
            invalid_reason: 'insufficient_amount',
            extra: { 'expected' => required_amount, 'got' => amount }
          )
        end
      end

      def settle(payload, requirements)
        X402::SettleResponse.new(
          success: true,
          transaction: "mock_tx_#{SecureRandom.hex(8)}",
          extra: { 'settled_at' => Time.now.to_i }
        )
      end
    end
  end
end
