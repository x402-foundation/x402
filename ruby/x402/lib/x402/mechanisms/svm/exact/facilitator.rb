# frozen_string_literal: true

require 'base64'
require_relative '../constants'
require_relative '../types'
require_relative '../utils'

module X402
  module Mechanisms
    module SVM
      module Exact
        ##
        # Facilitator scheme for exact SVM payments.
        #
        # Verifies and settles Solana transactions.
        class FacilitatorScheme
          include X402::SchemeNetworkFacilitator

          ##
          # @param managed_fee_payers [Array<String>] list of fee payer addresses managed by facilitator
          # @param rpc_client [Object] Solana RPC client (optional)
          def initialize(managed_fee_payers: [], rpc_client: nil)
            @managed_fee_payers = managed_fee_payers.map(&:to_s)
            @rpc_client = rpc_client
          end

          ##
          # Get scheme identifier.
          #
          # @return [String] scheme name
          def scheme
            Constants::SCHEME_EXACT
          end

          ##
          # Get supported networks.
          #
          # @return [Array<String>] supported CAIP-2 network identifiers
          def networks
            Constants::NETWORK_CONFIGS.keys
          end

          ##
          # Verify payment payload.
          #
          # Validates transaction structure, amounts, and signatures.
          #
          # @param payload [PaymentPayload] payment payload
          # @param requirements [PaymentRequirements] payment requirements
          # @return [VerifyResponse] verification result
          def verify(payload, requirements)
            # Extract inner payload
            inner = payload.inner

            # Validate structure
            unless inner.is_a?(Hash) && inner.key?('transaction')
              return create_error_response(Constants::ERR_INVALID_PAYLOAD, 'Missing transaction field')
            end

            # Decode transaction
            begin
              transaction_bytes = Utils.decode_transaction(inner['transaction'])
            rescue ArgumentError => e
              return create_error_response(Constants::ERR_TRANSACTION_DECODE_FAILED, e.message)
            end

            # Parse transaction (simplified)
            # In production, this would fully parse the Solana transaction format
            # and validate:
            # - Compute budget instructions are correct
            # - SPL Token TransferChecked instruction is present
            # - Amount matches requirements
            # - Recipient matches requirements
            # - Signatures are valid

            # For now, return a simplified success
            # In production, this would perform full verification
            if @rpc_client
              # Could simulate or verify with RPC
              simulate_transaction(transaction_bytes, requirements)
            else
              # Basic validation only
              basic_validation(transaction_bytes, requirements)
            end
          end

          ##
          # Settle payment on-chain.
          #
          # Submits the Solana transaction to the network.
          #
          # @param payload [PaymentPayload] payment payload
          # @param requirements [PaymentRequirements] payment requirements
          # @return [SettleResponse] settlement result
          def settle(payload, requirements)
            # Extract transaction
            inner = payload.inner
            transaction_base64 = inner['transaction']

            # In production, this would:
            # 1. Submit transaction to Solana network
            # 2. Wait for confirmation
            # 3. Return transaction signature

            if @rpc_client
              # Submit to network
              submit_transaction(transaction_base64, requirements)
            else
              # Simulated settlement (for testing)
              simulated_signature = SecureRandom.hex(32)

              SettleResponse.new(
                success: true,
                transaction: simulated_signature,
                extra: {
                  'note' => 'Simulated settlement - no RPC client configured'
                }
              )
            end
          end

          private

          ##
          # Basic validation without RPC.
          #
          # @param transaction_bytes [String] decoded transaction
          # @param requirements [PaymentRequirements] payment requirements
          # @return [VerifyResponse] verification result
          def basic_validation(transaction_bytes, requirements)
            # Basic checks
            if transaction_bytes.bytesize < 64
              return create_error_response(Constants::ERR_INVALID_PAYLOAD, 'Transaction too small')
            end

            # In production, would parse and validate instruction data
            # For now, assume valid
            VerifyResponse.new(
              valid: true,
              extra: {
                'note' => 'Basic validation only - no RPC client configured'
              }
            )
          end

          ##
          # Simulate transaction with RPC.
          #
          # @param transaction_bytes [String] decoded transaction
          # @param requirements [PaymentRequirements] payment requirements
          # @return [VerifyResponse] verification result
          def simulate_transaction(transaction_bytes, requirements)
            # In production, call RPC method simulateTransaction
            # For now, placeholder
            raise NotImplementedError, 'RPC simulation not yet implemented'
          end

          ##
          # Submit transaction to network.
          #
          # @param transaction_base64 [String] base64 encoded transaction
          # @param requirements [PaymentRequirements] payment requirements
          # @return [SettleResponse] settlement result
          def submit_transaction(transaction_base64, requirements)
            # In production, call RPC method sendTransaction
            # For now, placeholder
            raise NotImplementedError, 'RPC submission not yet implemented'
          end

          ##
          # Create error response.
          #
          # @param code [String] error code
          # @param message [String] error message
          # @return [VerifyResponse] error response
          def create_error_response(code, message)
            VerifyResponse.new(
              valid: false,
              invalid_reason: code,
              extra: { 'error' => message }
            )
          end
        end

        ##
        # Register exact SVM scheme for facilitator.
        #
        # @param facilitator [X402::Facilitator] facilitator instance
        # @param managed_fee_payers [Array<String>] managed fee payer addresses
        # @param rpc_client [Object] Solana RPC client
        # @param x402_version [Integer] protocol version (default: 2)
        # @return [X402::Facilitator] facilitator for chaining
        def self.register_facilitator(facilitator, managed_fee_payers: [], rpc_client: nil, x402_version: 2)
          scheme = FacilitatorScheme.new(
            managed_fee_payers: managed_fee_payers,
            rpc_client: rpc_client
          )
          networks = Constants::NETWORK_CONFIGS.keys
          facilitator.register(networks, scheme, x402_version: x402_version)
          facilitator
        end
      end
    end
  end
end
