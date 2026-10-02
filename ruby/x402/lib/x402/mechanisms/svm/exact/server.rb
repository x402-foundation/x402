# frozen_string_literal: true

require 'bigdecimal'
require_relative '../constants'
require_relative '../utils'

module X402
  module Mechanisms
    module SVM
      module Exact
        ##
        # Server scheme for exact SVM payments.
        #
        # Handles price parsing and requirement enhancement for Solana networks.
        class ServerScheme
          include X402::SchemeNetworkServer

          ##
          # @param money_parsers [Array<Proc>] custom price parsers
          def initialize(money_parsers: [])
            @money_parsers = money_parsers
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
          # Parse price string to AssetAmount.
          #
          # Accepts formats like "$1.50", "1.50", "1.50 USDC".
          # Defaults to USDC on the given network.
          #
          # @param price [String, AssetAmount] price to parse
          # @param network [String] network identifier
          # @return [AssetAmount] parsed asset amount
          def parse_price(price, network)
            # Already an AssetAmount
            return price if price.is_a?(AssetAmount)

            # Parse decimal amount
            decimal_amount = Utils.parse_money_to_decimal(price)

            # Try custom parsers
            @money_parsers.each do |parser|
              result = parser.call(decimal_amount, network)
              return result if result
            end

            # Default conversion: use network's default asset (USDC)
            default_money_conversion(decimal_amount, network.to_s)
          end

          ##
          # Enhance payment requirements with network-specific details.
          #
          # @param requirements [PaymentRequirements] base requirements
          # @param supported_kind [SupportedKind] supported kind from facilitator
          # @param extension_keys [Array<String>] extension keys
          # @return [PaymentRequirements] enhanced requirements
          def enhance_payment_requirements(requirements, supported_kind, extension_keys)
            # Get network config
            config = Utils.get_network_config(requirements.network)

            # Set default asset if not provided
            requirements.asset = config.default_asset.address if requirements.asset.nil? || requirements.asset.empty?

            # Get asset info
            asset_info = Utils.get_asset_info(requirements.network, requirements.asset)

            # Convert amount to smallest unit if it's a decimal string
            if requirements.amount.include?('.')
              amount_int = Utils.parse_amount(requirements.amount, asset_info.decimals)
              requirements.amount = amount_int.to_s
            end

            # Add extra metadata
            requirements.extra ||= {}
            requirements.extra['name'] ||= asset_info.name
            requirements.extra['decimals'] ||= asset_info.decimals

            requirements
          end

          private

          ##
          # Default money conversion to USDC.
          #
          # @param amount [Float] decimal amount
          # @param network [String] network identifier
          # @return [AssetAmount] asset amount
          def default_money_conversion(amount, network)
            # Get network config
            config = Utils.get_network_config(network)
            asset_info = config.default_asset

            # Convert to smallest unit
            amount_str = BigDecimal(amount.to_s).to_s('F')

            AssetAmount.new(
              amount: amount_str,
              asset: asset_info.address
            )
          end
        end

        ##
        # Register exact SVM scheme for server.
        #
        # @param server [X402::ResourceServer] server instance
        # @param money_parsers [Array<Proc>] custom price parsers
        # @param x402_version [Integer] protocol version (default: 2)
        # @return [X402::ResourceServer] server for chaining
        def self.register_server(server, money_parsers: [], x402_version: 2)
          scheme = ServerScheme.new(money_parsers: money_parsers)
          server.register('solana:*', scheme, x402_version: x402_version)
          server
        end
      end
    end
  end
end
