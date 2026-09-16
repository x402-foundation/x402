# frozen_string_literal: true

require_relative '../../../interfaces'
require_relative '../../../schemas/base'
require_relative '../../../schemas/payments'
require_relative '../constants'
require_relative '../utils'

module X402
  module Mechanisms
    module EVM
      module Exact
        ##
        # EVM server implementation for the Exact payment scheme (V2).
        #
        # Parses prices and enhances payment requirements with EIP-712 domain info.
        #
        # Note: Money/price parsing lives here, not as a standalone utility.
        # USD→atomic conversion is scheme-specific.
        #
        # @example
        #   scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
        #   server = X402::ResourceServer.new(facilitator)
        #   server.register('eip155:*', scheme)
        class ServerScheme
          include X402::SchemeNetworkServer

          ##
          # @return [String] scheme identifier
          def scheme
            Constants::SCHEME_EXACT
          end

          ##
          # Create Exact EVM server scheme.
          def initialize
            @money_parsers = []
          end

          ##
          # Register custom money parser in the parser chain.
          #
          # Multiple parsers can be registered - tried in registration order.
          # Each parser receives decimal amount (e.g., 1.50 for $1.50).
          # If parser returns nil, next parser is tried.
          # Default parser is always the final fallback.
          #
          # @param parser [Proc] custom function to convert amount to AssetAmount
          # @return [self] for chaining
          #
          # @example
          #   scheme.register_money_parser do |amount, network|
          #     if network == 'eip155:8453'
          #       AssetAmount.new(
          #         amount: (amount * 1_000_000).to_i.to_s,
          #         asset: '0x...',
          #         extra: {}
          #       )
          #     end
          #   end
          def register_money_parser(&parser)
            @money_parsers << parser
            self
          end

          ##
          # Parse price into asset amount.
          #
          # If price is already AssetAmount, returns it directly.
          # If price is Money (str|float), parses and tries custom parsers.
          # Falls back to default USDC conversion.
          #
          # @param price [String, Numeric, AssetAmount, Hash] price to parse
          # @param network [String] network identifier
          # @return [AssetAmount] asset amount with amount, asset, and extra fields
          # @raise [ArgumentError] if asset address is missing for AssetAmount input
          def parse_price(price, network)
            # Already an AssetAmount object
            if price.is_a?(AssetAmount)
              raise ArgumentError, "Asset address required for AssetAmount on #{network}" unless price.asset

              return price
            end

            # Already an AssetAmount (hash with 'amount' key)
            if price.is_a?(Hash) && (price['amount'] || price[:amount])
              asset = price['asset'] || price[:asset]
              raise ArgumentError, "Asset address required for AssetAmount on #{network}" unless asset

              return AssetAmount.new(
                amount: price['amount'] || price[:amount],
                asset: asset,
                extra: price['extra'] || price[:extra] || {}
              )
            end

            # Parse Money to decimal
            decimal_amount = Utils.parse_money_to_decimal(price)

            # Try custom parsers
            @money_parsers.each do |parser|
              result = parser.call(decimal_amount, network.to_s)
              return result if result
            end

            # Default: convert to USDC
            default_money_conversion(decimal_amount, network.to_s)
          end

          ##
          # Add scheme-specific enhancements to payment requirements.
          #
          # - Fills in default asset if not specified
          # - Adds EIP-712 domain parameters (name, version) to extra
          # - Converts decimal amounts to smallest unit
          #
          # @param requirements [PaymentRequirements] base payment requirements
          # @param supported_kind [SupportedKind] supported kind from facilitator
          # @param extension_keys [Array<String>] extension keys being used
          # @return [PaymentRequirements] enhanced payment requirements
          def enhance_payment_requirements(requirements, supported_kind, extension_keys)
            config = Utils.get_network_config(requirements.network)

            # Default asset
            requirements.asset = config.default_asset.address if requirements.asset.nil? || requirements.asset.empty?

            asset_info = Utils.get_asset_info(requirements.network, requirements.asset)

            # Ensure amount is in smallest unit
            if requirements.amount.include?('.')
              requirements.amount = Utils.parse_amount(requirements.amount, asset_info.decimals).to_s
            end

            # Add EIP-712 domain params
            requirements.extra ||= {}
            requirements.extra['name'] ||= asset_info.name
            requirements.extra['version'] ||= asset_info.version

            requirements
          end

          private

          ##
          # Convert decimal amount to USDC AssetAmount.
          #
          # @param amount [Float] decimal amount (e.g., 1.50)
          # @param network [String] network identifier
          # @return [AssetAmount] asset amount in USDC
          def default_money_conversion(amount, network)
            config = Utils.get_network_config(network)
            asset_info = config.default_asset

            # Convert to smallest unit
            amount_in_smallest = Utils.parse_amount(amount.to_s, asset_info.decimals)

            AssetAmount.new(
              amount: amount_in_smallest.to_s,
              asset: asset_info.address,
              extra: {}
            )
          end
        end
      end
    end
  end
end
