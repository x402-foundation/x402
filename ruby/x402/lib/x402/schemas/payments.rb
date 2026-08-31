# frozen_string_literal: true

require_relative 'base'

module X402
  ##
  # Describes the resource being accessed.
  #
  # @!attribute url
  #   @return [String] the URL of the resource
  # @!attribute description
  #   @return [String, nil] optional human-readable description
  # @!attribute mime_type
  #   @return [String, nil] optional MIME type of the resource
  class ResourceInfo < BaseStruct
    attribute :url, Types::String
    attribute :description, Types::String.optional.default(nil)
    attribute :mime_type, Types::String.optional.default(nil)
  end

  ##
  # V2 payment requirements structure.
  #
  # Describes what payment the server requires to access a resource.
  #
  # @!attribute scheme
  #   @return [String] payment scheme identifier (e.g., "exact")
  # @!attribute network
  #   @return [String] CAIP-2 network identifier (e.g., "eip155:8453")
  # @!attribute asset
  #   @return [String] asset address/identifier
  # @!attribute amount
  #   @return [String] amount in smallest unit
  # @!attribute pay_to
  #   @return [String] recipient address
  # @!attribute max_timeout_seconds
  #   @return [Integer] maximum time for payment validity
  # @!attribute extra
  #   @return [Hash] additional scheme-specific data
  class PaymentRequirements < BaseStruct
    attribute :scheme, Types::String
    attribute :network, Types::String
    attribute :asset, Types::String
    attribute :amount, Types::String
    attribute :pay_to, Types::String
    attribute :max_timeout_seconds, Types::Integer
    attribute :extra, Types::Hash.default({}.freeze)

    ##
    # Get the payment amount (V2 uses 'amount' field).
    #
    # @return [String] the payment amount
    def get_amount
      amount
    end

    ##
    # Get extra metadata.
    #
    # @return [Hash, nil] extra metadata
    def get_extra
      extra.empty? ? nil : extra
    end
  end

  ##
  # V2 402 Payment Required response structure.
  #
  # Sent by server when payment is required to access a resource.
  #
  # @!attribute x402_version
  #   @return [Integer] protocol version (always 2 for V2)
  # @!attribute error
  #   @return [String, nil] optional error message
  # @!attribute resource
  #   @return [ResourceInfo, nil] optional resource information
  # @!attribute accepts
  #   @return [Array<PaymentRequirements>] list of accepted payment requirements
  # @!attribute extensions
  #   @return [Hash, nil] optional extension data
  class PaymentRequired < BaseStruct
    attribute :x402_version, Types::Integer.default(X402_VERSION)
    attribute :error, Types::String.optional.default(nil)
    attribute :resource, ResourceInfo.optional.default(nil)
    attribute :accepts, Types::Array.of(PaymentRequirements)
    attribute :extensions, Types::Hash.optional.default(nil)
  end

  ##
  # V2 payment payload structure.
  #
  # Created by client to prove payment to server.
  #
  # @!attribute x402_version
  #   @return [Integer] protocol version (always 2 for V2)
  # @!attribute payload
  #   @return [Hash] scheme-specific payload data (authorization, signature, etc.)
  # @!attribute accepted
  #   @return [PaymentRequirements] the payment requirements being fulfilled
  # @!attribute resource
  #   @return [ResourceInfo, nil] optional resource information
  # @!attribute extensions
  #   @return [Hash, nil] optional extension data
  class PaymentPayload < BaseStruct
    attribute :x402_version, Types::Integer.default(X402_VERSION)
    attribute :payload, Types::Hash
    attribute :accepted, PaymentRequirements
    attribute :resource, ResourceInfo.optional.default(nil)
    attribute :extensions, Types::Hash.optional.default(nil)

    ##
    # Get the payment scheme (V2 uses accepted.scheme).
    #
    # @return [String] the payment scheme
    def get_scheme
      accepted.scheme
    end

    ##
    # Get the network (V2 uses accepted.network).
    #
    # @return [String] the network identifier
    def get_network
      accepted.network
    end
  end
end
