# frozen_string_literal: true

require 'securerandom'

# Optional Ed25519 dependency
begin
  require 'ed25519'
rescue LoadError
  # ed25519 gem not available - will provide fallback
end

module X402
  module Mechanisms
    module SVM
      ##
      # Protocol for client-side SVM signers.
      #
      # Implementations must provide Ed25519 signing for Solana transactions.
      module ClientSvmSigner
        ##
        # Get the base58 encoded public key (Solana address).
        #
        # @return [String] base58 encoded public key
        def address
          raise NotImplementedError, 'ClientSvmSigner must implement #address'
        end

        ##
        # Sign a transaction message.
        #
        # @param message [String] transaction message bytes to sign
        # @return [String] 64-byte Ed25519 signature
        def sign_transaction(message)
          raise NotImplementedError, 'ClientSvmSigner must implement #sign_transaction'
        end
      end

      ##
      # Ed25519 keypair-based signer for SVM transactions.
      #
      # Requires the ed25519 and base58 gems.
      class Ed25519Signer
        include ClientSvmSigner

        attr_reader :address

        ##
        # Create signer from Ed25519 keypair.
        #
        # @param signing_key [Ed25519::SigningKey] Ed25519 signing key
        def initialize(signing_key)
          raise LoadError, 'ed25519 gem required for Ed25519Signer' unless defined?(Ed25519)
          raise LoadError, 'base58 gem required for Ed25519Signer' unless defined?(Base58)

          @signing_key = signing_key
          @verify_key = signing_key.verify_key
          @address = Base58.encode(@verify_key.to_bytes)
        end

        ##
        # Create signer from seed bytes.
        #
        # @param seed [String] 32-byte seed for key derivation
        # @return [Ed25519Signer] new signer instance
        def self.from_seed(seed)
          raise ArgumentError, 'Seed must be 32 bytes' unless seed.bytesize == 32

          signing_key = Ed25519::SigningKey.new(seed)
          new(signing_key)
        end

        ##
        # Create signer from base58 encoded private key.
        #
        # @param private_key_base58 [String] base58 encoded private key (64 bytes decoded)
        # @return [Ed25519Signer] new signer instance
        def self.from_base58(private_key_base58)
          raise LoadError, 'base58 gem required' unless defined?(Base58)

          private_key_bytes = Base58.decode(private_key_base58)
          raise ArgumentError, 'Private key must decode to 64 bytes' unless private_key_bytes.bytesize == 64

          # First 32 bytes are the seed
          seed = private_key_bytes[0...32]
          from_seed(seed)
        end

        ##
        # Create signer from hex encoded seed.
        #
        # @param hex_seed [String] hex encoded seed (64 characters for 32 bytes)
        # @return [Ed25519Signer] new signer instance
        def self.from_hex(hex_seed)
          hex_seed = hex_seed.delete_prefix('0x')
          raise ArgumentError, 'Hex seed must be 64 characters (32 bytes)' unless hex_seed.length == 64

          seed = [hex_seed].pack('H*')
          from_seed(seed)
        end

        ##
        # Generate a new random keypair.
        #
        # @return [Ed25519Signer] new signer with random keypair
        def self.generate
          seed = SecureRandom.random_bytes(32)
          from_seed(seed)
        end

        ##
        # Sign a transaction message.
        #
        # @param message [String] transaction message bytes
        # @return [String] 64-byte Ed25519 signature
        def sign_transaction(message)
          @signing_key.sign(message)
        end

        ##
        # Get the base58 encoded public key.
        #
        # @return [String] base58 encoded public key
        def public_key
          address
        end

        ##
        # Get the raw verify key bytes.
        #
        # @return [String] 32-byte public key
        def public_key_bytes
          @verify_key.to_bytes
        end
      end
    end
  end
end
