# frozen_string_literal: true

require 'base64'
require 'securerandom'
require_relative '../constants'
require_relative '../types'
require_relative '../utils'

module X402
  module Mechanisms
    module SVM
      module Exact
        ##
        # Client scheme for exact SVM payments.
        #
        # Creates Solana transactions with SPL token transfers.
        class ClientScheme
          include X402::SchemeNetworkClient

          attr_reader :signer

          ##
          # @param signer [ClientSvmSigner] signer for transactions
          def initialize(signer:)
            @signer = signer
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
          # Create payment payload.
          #
          # @param requirements [PaymentRequirements] payment requirements
          # @return [Hash] inner payload with transaction
          def create_payment_payload(requirements)
            # Build Solana transaction
            transaction = build_transaction(requirements)

            # Sign transaction
            signed_transaction = sign_transaction(transaction)

            # Encode to base64
            transaction_base64 = Base64.strict_encode64(signed_transaction)

            # Return payload
            Types::ExactSvmPayload.new(transaction: transaction_base64).to_h
          end

          private

          ##
          # Build Solana transaction.
          #
          # This is a simplified implementation that would need to be replaced
          # with a full Solana transaction builder in production.
          #
          # @param requirements [PaymentRequirements] payment requirements
          # @return [String] serialized transaction (unsigned)
          def build_transaction(requirements)
            # Extract parameters
            network = requirements.network
            asset = requirements.asset
            amount = requirements.amount.to_i
            recipient = requirements.pay_to

            # Get network config
            config = Utils.get_network_config(network)

            # Get asset info
            asset_info = Utils.get_asset_info(network, asset)

            # For now, return a placeholder
            # In production, this would use a Solana transaction builder
            # to create:
            # 1. Compute budget instructions (set compute unit limit, set compute unit price)
            # 2. SPL Token TransferChecked instruction
            # The transaction would include proper recent blockhash, fee payer, etc.

            raise NotImplementedError, 'Full Solana transaction building not yet implemented. ' \
                                       'This would require a Solana transaction builder library.'
          end

          ##
          # Sign transaction.
          #
          # @param transaction [String] serialized unsigned transaction
          # @return [String] serialized signed transaction
          def sign_transaction(transaction)
            # Extract message to sign (this would be the serialized message part)
            # Sign with Ed25519
            signature = @signer.sign_transaction(transaction)

            # Prepend signature count and signatures to transaction
            # Format: [signature_count (1 byte)][signatures][transaction]
            signature_count = [1].pack('C')
            signature_count + signature + transaction
          end
        end

        ##
        # Register exact SVM scheme for client.
        #
        # @param client [X402::Client] client instance
        # @param signer [ClientSvmSigner] signer for transactions
        # @param x402_version [Integer] protocol version (default: 2)
        # @return [X402::Client] client for chaining
        def self.register_client(client, signer:, x402_version: 2)
          scheme = ClientScheme.new(signer: signer)
          client.register('solana:*', scheme, x402_version: x402_version)
          client
        end
      end
    end
  end
end
