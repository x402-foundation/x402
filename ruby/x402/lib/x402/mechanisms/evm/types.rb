# frozen_string_literal: true

require 'json'

module X402
  module Mechanisms
    module EVM
      ##
      # EVM-specific payload and data types.
      module Types
        ##
        # EIP-3009 TransferWithAuthorization data.
        class ExactEIP3009Authorization
          attr_accessor :from_address, :to, :value, :valid_after, :valid_before, :nonce

          ##
          # @param from_address [String] sender address
          # @param to [String] recipient address
          # @param value [String] amount in smallest unit as string
          # @param valid_after [String] Unix timestamp as string
          # @param valid_before [String] Unix timestamp as string
          # @param nonce [String] 32-byte nonce as hex string (0x...)
          def initialize(from_address:, to:, value:, valid_after:, valid_before:, nonce:)
            @from_address = from_address
            @to = to
            @value = value
            @valid_after = valid_after
            @valid_before = valid_before
            @nonce = nonce
          end

          ##
          # Convert to hash for JSON serialization.
          #
          # @return [Hash] hash with camelCase keys
          def to_h
            {
              'from' => from_address,
              'to' => to,
              'value' => value,
              'validAfter' => valid_after,
              'validBefore' => valid_before,
              'nonce' => nonce
            }
          end

          ##
          # Create from hash.
          #
          # @param data [Hash] hash with authorization data
          # @return [ExactEIP3009Authorization] instance
          def self.from_h(data)
            new(
              from_address: data['from'] || data[:from],
              to: data['to'] || data[:to],
              value: data['value'] || data[:value],
              valid_after: data['validAfter'] || data[:validAfter] || data[:valid_after],
              valid_before: data['validBefore'] || data[:validBefore] || data[:valid_before],
              nonce: data['nonce'] || data[:nonce]
            )
          end
        end

        ##
        # Exact payment payload for EVM networks.
        class ExactEIP3009Payload
          attr_accessor :authorization, :signature

          ##
          # @param authorization [ExactEIP3009Authorization] authorization data
          # @param signature [String, nil] signature (optional, added after signing)
          def initialize(authorization:, signature: nil)
            @authorization = authorization
            @signature = signature
          end

          ##
          # Convert to hash for JSON serialization.
          #
          # @return [Hash] hash with authorization and signature
          def to_h
            result = { 'authorization' => authorization.to_h }
            result['signature'] = signature if signature
            result
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
          # @param data [Hash] hash with authorization and optional signature
          # @return [ExactEIP3009Payload] instance
          def self.from_h(data)
            auth_data = data['authorization'] || data[:authorization] || {}
            new(
              authorization: ExactEIP3009Authorization.from_h(auth_data),
              signature: data['signature'] || data[:signature]
            )
          end

          ##
          # Create from JSON string.
          #
          # @param json_str [String] JSON string
          # @return [ExactEIP3009Payload] instance
          def self.from_json(json_str)
            data = JSON.parse(json_str)
            from_h(data)
          end
        end

        # Type aliases for V1/V2 compatibility
        ExactEvmPayloadV1 = ExactEIP3009Payload
        ExactEvmPayloadV2 = ExactEIP3009Payload

        ##
        # EIP-712 domain separator.
        class TypedDataDomain
          attr_accessor :name, :version, :chain_id, :verifying_contract

          ##
          # @param name [String] domain name
          # @param version [String] domain version
          # @param chain_id [Integer] chain ID
          # @param verifying_contract [String] contract address
          def initialize(name:, version:, chain_id:, verifying_contract:)
            @name = name
            @version = version
            @chain_id = chain_id
            @verifying_contract = verifying_contract
          end

          ##
          # Convert to hash for EIP-712 signing.
          #
          # @return [Hash] hash with domain data
          def to_h
            {
              'name' => name,
              'version' => version,
              'chainId' => chain_id,
              'verifyingContract' => verifying_contract
            }
          end
        end

        ##
        # Field definition for EIP-712 types.
        TypedDataField = Struct.new(:name, :type, keyword_init: true)

        ##
        # Transaction receipt from blockchain.
        TransactionReceipt = Struct.new(:status, :block_number, :tx_hash, keyword_init: true)

        ##
        # Parsed ERC-6492 signature components.
        class ERC6492SignatureData
          attr_accessor :factory, :factory_calldata, :inner_signature

          ##
          # @param factory [String] 20-byte factory address (zero if not ERC-6492)
          # @param factory_calldata [String] deployment calldata (empty if not ERC-6492)
          # @param inner_signature [String] actual signature (EIP-1271 or EOA)
          def initialize(factory:, factory_calldata:, inner_signature:)
            @factory = factory
            @factory_calldata = factory_calldata
            @inner_signature = inner_signature
          end
        end

        # EIP-712 authorization types for signing
        AUTHORIZATION_TYPES = {
          'TransferWithAuthorization' => [
            { 'name' => 'from', 'type' => 'address' },
            { 'name' => 'to', 'type' => 'address' },
            { 'name' => 'value', 'type' => 'uint256' },
            { 'name' => 'validAfter', 'type' => 'uint256' },
            { 'name' => 'validBefore', 'type' => 'uint256' },
            { 'name' => 'nonce', 'type' => 'bytes32' }
          ]
        }.freeze

        # EIP-712 domain types
        DOMAIN_TYPES = {
          'EIP712Domain' => [
            { 'name' => 'name', 'type' => 'string' },
            { 'name' => 'version', 'type' => 'string' },
            { 'name' => 'chainId', 'type' => 'uint256' },
            { 'name' => 'verifyingContract', 'type' => 'address' }
          ]
        }.freeze
      end
    end
  end
end
