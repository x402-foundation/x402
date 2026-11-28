# frozen_string_literal: true

require 'eth'
require_relative 'types'

module X402
  module Mechanisms
    module EVM
      ##
      # Protocol for EVM client-side signing.
      #
      # Implementers provide EIP-712 signing capabilities for payment authorizations.
      module ClientEvmSigner
        ##
        # Get the signer's Ethereum address.
        #
        # @return [String] Ethereum address (checksummed)
        # @raise [NotImplementedError] if not implemented
        def address
          raise NotImplementedError, 'address must be implemented'
        end

        ##
        # Sign EIP-712 typed data.
        #
        # @param domain [Types::TypedDataDomain] EIP-712 domain
        # @param types [Hash] type definitions
        # @param primary_type [String] primary type being signed
        # @param message [Hash] message data
        # @return [String] signature bytes
        # @raise [NotImplementedError] if not implemented
        def sign_typed_data(domain, types, primary_type, message)
          raise NotImplementedError, 'sign_typed_data must be implemented'
        end
      end

      ##
      # EVM signer using eth gem with private key.
      class PrivateKeySigner
        include ClientEvmSigner

        ##
        # @return [String] signer's Ethereum address
        attr_reader :address

        ##
        # Create signer from private key.
        #
        # @param private_key [String] private key as hex string (with or without 0x)
        def initialize(private_key)
          @key = Eth::Key.new(priv: private_key)
          @address = @key.address.to_s
        end

        ##
        # Sign EIP-712 typed data.
        #
        # @param domain [Types::TypedDataDomain] EIP-712 domain
        # @param types [Hash] type definitions
        # @param primary_type [String] primary type being signed
        # @param message [Hash] message data
        # @return [String] signature bytes (65 bytes: r + s + v)
        def sign_typed_data(domain, _types, primary_type, message)
          require_relative 'eip712'

          # Hash the typed data
          message_hash = EIP712.hash_eip3009_authorization(
            Types::ExactEIP3009Authorization.new(
              from_address: message['from'],
              to: message['to'],
              value: message['value'],
              valid_after: message['validAfter'],
              valid_before: message['validBefore'],
              nonce: message['nonce']
            ),
            domain.chain_id,
            domain.verifying_contract,
            domain.name,
            domain.version
          )

          # Sign the hash
          signature = @key.sign(message_hash)

          # Format as rsv (65 bytes)
          r = signature[0..31]
          s = signature[32..63]
          v = signature[64]

          r + s + [v].pack('C')
        end

        ##
        # Create signer from hex-encoded private key.
        #
        # @param hex_key [String] private key as hex string
        # @return [PrivateKeySigner] new signer instance
        def self.from_hex(hex_key)
          new(hex_key)
        end
      end
    end
  end
end
