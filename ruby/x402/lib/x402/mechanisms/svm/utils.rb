# frozen_string_literal: true

require 'bigdecimal'
require 'base64'

# Optional dependencies for full Solana support
begin
  require 'base58'
rescue LoadError
  # base58 gem not available - will provide fallback
end

require_relative 'constants'

module X402
  module Mechanisms
    module SVM
      ##
      # SVM utility functions for address, amount, and transaction handling.
      module Utils
        ##
        # Get network configuration for a Solana network.
        #
        # @param network [String] network identifier (CAIP-2 or legacy name)
        # @return [Constants::NetworkConfig] network configuration
        # @raise [ArgumentError] if network is not configured
        def self.get_network_config(network)
          # Normalize V1 names to CAIP-2
          if Constants::V1_TO_V2_NETWORK_MAP.key?(network)
            network = Constants::V1_TO_V2_NETWORK_MAP[network]
          end

          if Constants::NETWORK_CONFIGS.key?(network)
            return Constants::NETWORK_CONFIGS[network]
          end

          raise ArgumentError, "No configuration for network: #{network}"
        end

        ##
        # Get asset info for a Solana network.
        #
        # @param network [String] network identifier
        # @param asset_address [String] token mint address (optional, defaults to USDC)
        # @return [Constants::AssetInfo] asset information
        def self.get_asset_info(network, asset_address = nil)
          config = get_network_config(network)

          # Return default if no specific asset requested
          return config.default_asset if asset_address.nil? || asset_address.empty?

          # For custom assets, return with default decimals
          # In a full implementation, this would query the on-chain mint account
          Constants::AssetInfo.new(
            address: asset_address,
            name: 'SPL Token',
            decimals: Constants::DEFAULT_DECIMALS
          )
        end

        ##
        # Check if network is supported.
        #
        # @param network [String] network identifier
        # @return [Boolean] true if network is supported
        def self.valid_network?(network)
          get_network_config(network)
          true
        rescue ArgumentError
          false
        end

        ##
        # Validate Solana address format.
        #
        # @param address [String] Solana address to validate
        # @return [Boolean] true if valid base58 address
        def self.valid_address?(address)
          return false unless address.is_a?(String)

          Constants::SVM_ADDRESS_REGEX.match?(address)
        end

        ##
        # Convert decimal string to smallest unit.
        #
        # @param amount [String, Numeric] decimal string (e.g., "1.50")
        # @param decimals [Integer] token decimals
        # @return [Integer] amount in smallest unit
        def self.parse_amount(amount, decimals)
          d = BigDecimal(amount.to_s)
          multiplier = BigDecimal(10**decimals)
          (d * multiplier).to_i
        end

        ##
        # Convert smallest unit to decimal string.
        #
        # @param amount [Integer] amount in smallest unit
        # @param decimals [Integer] token decimals
        # @return [String] decimal string
        def self.format_amount(amount, decimals)
          d = BigDecimal(amount.to_s)
          divisor = BigDecimal(10**decimals)
          (d / divisor).to_s('F')
        end

        ##
        # Parse Money to decimal.
        #
        # Handles formats like "$1.50", "1.50", 1.50.
        #
        # @param money [String, Numeric] money value in various formats
        # @return [Float] decimal amount as float
        def self.parse_money_to_decimal(money)
          return money.to_f if money.is_a?(Numeric)

          # Clean string
          clean = money.to_s.strip
          clean = clean.sub(/^\$/, '')
          clean = clean.sub(/\s*(USD|USDC|usd|usdc)\s*$/, '')
          clean = clean.strip

          clean.to_f
        end

        ##
        # Decode base64 transaction.
        #
        # @param transaction_base64 [String] base64 encoded transaction
        # @return [String] decoded transaction bytes
        def self.decode_transaction(transaction_base64)
          Base64.strict_decode64(transaction_base64)
        rescue ArgumentError => e
          raise ArgumentError, "Failed to decode transaction: #{e.message}"
        end

        ##
        # Encode transaction to base64.
        #
        # @param transaction_bytes [String] transaction bytes
        # @return [String] base64 encoded transaction
        def self.encode_transaction(transaction_bytes)
          Base64.strict_encode64(transaction_bytes)
        end

        ##
        # Get RPC URL for network.
        #
        # @param network [String] network identifier
        # @return [String] RPC URL
        def self.get_rpc_url(network)
          config = get_network_config(network)
          config.rpc_url
        end

        ##
        # Get WebSocket URL for network.
        #
        # @param network [String] network identifier
        # @return [String] WebSocket URL
        def self.get_ws_url(network)
          config = get_network_config(network)
          config.ws_url
        end

        ##
        # Normalize network identifier to CAIP-2 format.
        #
        # @param network [String] network identifier (V1 or V2)
        # @return [String] CAIP-2 network identifier
        def self.normalize_network(network)
          # Already CAIP-2
          return network if network.start_with?('solana:')

          # Try V1 to V2 mapping
          Constants::V1_TO_V2_NETWORK_MAP[network] || network
        end
      end
    end
  end
end
