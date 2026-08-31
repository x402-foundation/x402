# frozen_string_literal: true

require_relative 'base'

module X402
  ##
  # Configuration for a protected resource.
  #
  # @!attribute scheme
  #   @return [String] payment scheme identifier (e.g., "exact")
  # @!attribute pay_to
  #   @return [String] recipient address
  # @!attribute price
  #   @return [String, Numeric, AssetAmount] price for the resource
  # @!attribute network
  #   @return [String] CAIP-2 network identifier
  # @!attribute max_timeout_seconds
  #   @return [Integer, nil] maximum time for payment validity
  class ResourceConfig < BaseStruct
    attribute :scheme, Types::String
    attribute :pay_to, Types::String
    attribute :price, Types::Any  # Can be Money (String/Numeric) or AssetAmount
    attribute :network, Types::String
    attribute :max_timeout_seconds, Types::Integer.optional.default(nil)
  end

  ##
  # Configuration for facilitator client.
  #
  # @!attribute url
  #   @return [String] facilitator service URL
  # @!attribute create_headers
  #   @return [Proc, nil] optional function to create auth headers
  # @!attribute timeout
  #   @return [Integer, nil] optional request timeout in seconds
  class FacilitatorConfig < BaseStruct
    attribute :url, Types::String
    attribute :create_headers, Types.Constructor(Proc).optional.default(nil)
    attribute :timeout, Types::Integer.optional.default(30)

    ##
    # Get auth headers for facilitator requests.
    #
    # @return [Hash] headers hash
    def headers
      create_headers&.call || {}
    end
  end

  ##
  # Configuration for paywall UI customization.
  #
  # @!attribute app_name
  #   @return [String, nil] application name to display
  # @!attribute app_logo
  #   @return [String, nil] URL to application logo
  class PaywallConfig < BaseStruct
    attribute :app_name, Types::String.optional.default(nil)
    attribute :app_logo, Types::String.optional.default(nil)
  end

  ##
  # Route configuration for middleware.
  #
  # @!attribute accepts
  #   @return [Array<Hash>] list of payment options
  # @!attribute extensions
  #   @return [Hash, nil] optional extension data
  class RouteConfig < BaseStruct
    attribute :accepts, Types::Array.of(Types::Hash)
    attribute :extensions, Types::Hash.optional.default(nil)
  end

  ##
  # Routes configuration - can be single route or map of paths to route configs.
  #
  # Examples:
  #   # Single route for all paths
  #   RouteConfig.new(accepts: [...])
  #
  #   # Different config per path
  #   {
  #     '/api/data' => RouteConfig.new(accepts: [...]),
  #     '/api/premium' => RouteConfig.new(accepts: [...])
  #   }
  #
  # @note This is a conceptual type. In Ruby, we use duck typing.
  module RoutesConfig
    ##
    # Check if value is a valid RoutesConfig.
    #
    # @param value [Object] value to check
    # @return [Boolean] true if valid
    def self.valid?(value)
      return true if value.is_a?(RouteConfig)
      return true if value.is_a?(Hash) && value.values.all? { |v| v.is_a?(RouteConfig) }

      false
    end
  end
end
