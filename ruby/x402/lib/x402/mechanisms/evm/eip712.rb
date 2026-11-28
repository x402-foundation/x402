# frozen_string_literal: true

begin
  require 'eth'
rescue LoadError
  raise LoadError, 'EVM mechanism requires eth gem. Install with: gem install eth'
end

require_relative 'types'

module X402
  module Mechanisms
    module EVM
      ##
      # EIP-712 typed data hashing utilities.
      module EIP712
        ##
        # Encode type string for EIP-712.
        #
        # @param type_name [String] name of the type
        # @param types [Hash] all type definitions
        # @return [String] encoded type string
        def self.encode_type(type_name, types)
          return '' unless types.key?(type_name)

          fields = types[type_name]
          field_strs = fields.map { |f| "#{f['type']} #{f['name']}" }
          "#{type_name}(#{field_strs.join(',')})"
        end

        ##
        # Compute type hash for EIP-712.
        #
        # @param type_name [String] name of the type
        # @param types [Hash] all type definitions
        # @return [String] 32-byte type hash as hex string
        def self.type_hash(type_name, types)
          encoded = encode_type(type_name, types)
          Eth::Util.keccak256(encoded)
        end

        ##
        # Encode data for EIP-712 struct hash.
        #
        # @param type_name [String] name of the type
        # @param types [Hash] all type definitions
        # @param data [Hash] data to encode
        # @return [String] encoded data bytes
        def self.encode_data(type_name, types, data)
          raise ArgumentError, "Unknown type: #{type_name}" unless types.key?(type_name)

          fields = types[type_name]
          encoded_values = [type_hash(type_name, types)]

          fields.each do |field|
            name = field['name']
            field_type = field['type']
            value = data[name] || data[name.to_sym]

            raise ArgumentError, "Missing field: #{name}" if value.nil?

            encoded_value = encode_field_value(field_type, value)
            encoded_values << encoded_value
          end

          encoded_values.join
        end

        ##
        # Encode a single field value based on its type.
        #
        # @param field_type [String] field type
        # @param value [Object] field value
        # @return [String] encoded value bytes
        def self.encode_field_value(field_type, value)
          case field_type
          when 'string'
            Eth::Util.keccak256(value.to_s)
          when 'bytes'
            bytes = value.is_a?(String) ? Eth::Util.hex_to_bin(value) : value
            Eth::Util.keccak256(bytes)
          when 'bytes32'
            value.is_a?(String) ? Eth::Util.hex_to_bin(value) : value
          when 'address'
            Eth::Abi.encode(['address'], [value])
          when /^uint(\d+)$/, /^int(\d+)$/
            Eth::Abi.encode([field_type], [value.to_i])
          when 'bool'
            Eth::Abi.encode(['bool'], [value])
          else
            raise ArgumentError, "Unsupported field type: #{field_type}"
          end
        end

        ##
        # Compute struct hash for EIP-712.
        #
        # @param type_name [String] name of the type
        # @param types [Hash] all type definitions
        # @param data [Hash] struct data
        # @return [String] 32-byte struct hash
        def self.hash_struct(type_name, types, data)
          encoded = encode_data(type_name, types, data)
          Eth::Util.keccak256(encoded)
        end

        ##
        # Compute domain separator hash.
        #
        # @param domain [Types::TypedDataDomain] EIP-712 domain
        # @return [String] 32-byte domain separator hash
        def self.hash_domain(domain)
          domain_data = {
            'name' => domain.name,
            'version' => domain.version,
            'chainId' => domain.chain_id,
            'verifyingContract' => domain.verifying_contract
          }
          hash_struct('EIP712Domain', Types::DOMAIN_TYPES, domain_data)
        end

        ##
        # Hash EIP-712 typed data.
        #
        # Creates hash: keccak256("\x19\x01" + domainSeparator + structHash)
        #
        # @param domain [Types::TypedDataDomain] EIP-712 domain separator
        # @param types [Hash] type definitions
        # @param primary_type [String] primary type being hashed
        # @param message [Hash] message data
        # @return [String] 32-byte hash suitable for signing/verification
        def self.hash_typed_data(domain, types, primary_type, message)
          # Merge domain types with provided types
          all_types = Types::DOMAIN_TYPES.merge(types)

          domain_separator = hash_domain(domain)
          struct_hash = hash_struct(primary_type, all_types, message)

          # EIP-712 final hash
          Eth::Util.keccak256("\x19\x01".b + domain_separator + struct_hash)
        end

        ##
        # Hash EIP-3009 TransferWithAuthorization message.
        #
        # Convenience wrapper around hash_typed_data with EIP-3009 types.
        #
        # @param authorization [Types::ExactEIP3009Authorization] authorization data
        # @param chain_id [Integer] chain ID
        # @param verifying_contract [String] token contract address
        # @param token_name [String] token name for domain
        # @param token_version [String] token version for domain
        # @return [String] 32-byte hash for signing/verification
        def self.hash_eip3009_authorization(authorization, chain_id, verifying_contract, token_name, token_version)
          domain = Types::TypedDataDomain.new(
            name: token_name,
            version: token_version,
            chain_id: chain_id,
            verifying_contract: verifying_contract
          )

          message = {
            'from' => authorization.from_address,
            'to' => authorization.to,
            'value' => authorization.value,
            'validAfter' => authorization.valid_after,
            'validBefore' => authorization.valid_before,
            'nonce' => authorization.nonce
          }

          hash_typed_data(domain, Types::AUTHORIZATION_TYPES, 'TransferWithAuthorization', message)
        end
      end
    end
  end
end
