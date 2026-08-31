# frozen_string_literal: true

require 'json'
require 'base64'

module X402
  module Mechanisms
    module SVM
      ##
      # SVM-specific payload and data types.
      module Types
        ##
        # Exact payment payload for SVM networks.
        #
        # Contains a base64 encoded Solana transaction that includes:
        # - Compute budget instructions
        # - SPL Token TransferChecked instruction
        class ExactSvmPayload
          attr_accessor :transaction

          ##
          # @param transaction [String] Base64 encoded Solana transaction
          def initialize(transaction:)
            @transaction = transaction
          end

          ##
          # Convert to hash for JSON serialization.
          #
          # @return [Hash] hash with transaction field
          def to_h
            { 'transaction' => transaction }
          end

          ##
          # Convert to JSON string.
          #
          # @return [String] JSON string
          def to_json(*_args)
            JSON.generate(to_h)
          end

          ##
          # Create from hash.
          #
          # @param data [Hash] hash with transaction field
          # @return [ExactSvmPayload] instance
          def self.from_h(data)
            new(transaction: data['transaction'] || data[:transaction] || '')
          end

          ##
          # Create from JSON string.
          #
          # @param json_str [String] JSON string
          # @return [ExactSvmPayload] instance
          def self.from_json(json_str)
            data = JSON.parse(json_str)
            from_h(data)
          end
        end

        # Type aliases for V1/V2 compatibility
        ExactSvmPayloadV1 = ExactSvmPayload
        ExactSvmPayloadV2 = ExactSvmPayload

        ##
        # Information extracted from a parsed Solana transaction.
        TransactionInfo = Struct.new(
          :fee_payer,        # Base58 encoded fee payer address
          :payer,            # Base58 encoded token payer (authority) address
          :source_ata,       # Source associated token account
          :destination_ata,  # Destination associated token account
          :mint,             # Token mint address
          :amount,           # Transfer amount in smallest unit
          :decimals,         # Token decimals
          :token_program,    # Token program address (Token or Token-2022)
          keyword_init: true
        )
      end
    end
  end
end
