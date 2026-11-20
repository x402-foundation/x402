# frozen_string_literal: true

require 'dry-struct'
require 'dry-types'
require 'json'

module X402
  ##
  # Current x402 protocol version.
  X402_VERSION = 2

  ##
  # Dry-types module for type definitions.
  module Types
    include Dry.Types()

    # CAIP-2 format network identifier (e.g., "eip155:8453", "solana:mainnet")
    Network = Types::String

    # User-friendly price format (e.g., "$1.50", 1.50, "0.10")
    Money = Types::String | Types::Coercible::Float | Types::Coercible::Integer
  end

  ##
  # Base struct for all X402 models with JSON serialization support.
  #
  # All schema classes inherit from this to get camelCase JSON serialization.
  class BaseStruct < Dry::Struct
    transform_keys(&:to_sym)

    ##
    # Convert struct to hash with camelCase keys for JSON serialization.
    #
    # @return [Hash] hash with camelCase keys
    def to_h_camelcase
      to_h.transform_keys { |k| camelize_key(k) }
    end

    ##
    # Serialize to JSON with camelCase keys.
    #
    # @param args [Array] additional arguments passed to JSON.generate
    # @return [String] JSON string
    def to_json(*args)
      to_h_camelcase.to_json(*args)
    end

    ##
    # Parse from JSON with camelCase keys.
    #
    # @param json_str [String] JSON string
    # @return [BaseStruct] parsed instance
    def self.from_json(json_str)
      hash = JSON.parse(json_str, symbolize_names: true)
      from_camelcase_hash(hash)
    end

    ##
    # Convert camelCase hash keys to snake_case and create instance.
    #
    # @param hash [Hash] hash with camelCase keys
    # @return [BaseStruct] instance
    def self.from_camelcase_hash(hash)
      snake_hash = hash.transform_keys { |k| underscore_key(k) }
      new(snake_hash)
    end

    private

    def camelize_key(key)
      key.to_s.gsub(/_([a-z])/) { Regexp.last_match(1).upcase }.to_sym
    end

    def self.underscore_key(key)
      key.to_s.gsub(/([A-Z])/) { "_#{Regexp.last_match(1).downcase}" }
         .sub(/^_/, '')
         .to_sym
    end
  end

  ##
  # Amount in smallest unit with asset identifier.
  #
  # @!attribute amount
  #   @return [String] amount in smallest unit (e.g., "1500000" for 1.5 USDC with 6 decimals)
  # @!attribute asset
  #   @return [String] asset address/identifier
  # @!attribute extra
  #   @return [Hash, nil] optional additional metadata
  class AssetAmount < BaseStruct
    attribute :amount, Types::String
    attribute :asset, Types::String
    attribute :extra, Types::Hash.optional.default(nil)

    ##
    # Create AssetAmount from hash with camelCase or snake_case keys.
    #
    # @param hash [Hash] input hash
    # @return [AssetAmount] new instance
    def self.from_hash(hash)
      hash = hash.transform_keys(&:to_sym)
      # Support both camelCase and snake_case
      if hash.key?(:amount) && hash.key?(:asset)
        new(hash)
      else
        from_camelcase_hash(hash)
      end
    end
  end

  ##
  # Price can be user-friendly Money (string/number) or explicit AssetAmount.
  #
  # Examples:
  #   "$1.50"  (Money)
  #   1.50     (Money)
  #   AssetAmount.new(amount: "1500000", asset: "0x...")  (AssetAmount)
  #
  # @note This is a conceptual type union. In Ruby, we handle this with duck typing.
  module Price
    ##
    # Check if value is a valid Price (Money or AssetAmount).
    #
    # @param value [Object] value to check
    # @return [Boolean] true if valid Price
    def self.valid?(value)
      return true if value.is_a?(AssetAmount)
      return true if value.is_a?(String) || value.is_a?(Numeric)

      false
    end

    ##
    # Normalize price to AssetAmount or Money string.
    #
    # @param value [String, Numeric, AssetAmount] price value
    # @return [AssetAmount, String] normalized price
    def self.normalize(value)
      return value if value.is_a?(AssetAmount)
      return value.to_s if value.is_a?(Numeric)

      value
    end
  end
end
