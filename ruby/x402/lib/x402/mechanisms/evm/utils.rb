# frozen_string_literal: true

require 'securerandom'
require 'bigdecimal'
require 'time'

begin
  require 'eth'
rescue LoadError
  raise LoadError, 'EVM mechanism requires eth gem. Install with: gem install eth'
end

require_relative 'constants'

module X402
  module Mechanisms
    module EVM
      ##
      # EVM utility functions for address, amount, and nonce handling.
      module Utils
        ##
        # Extract chain ID from network string.
        #
        # Handles both CAIP-2 format (eip155:8453) and legacy names (base-sepolia).
        #
        # @param network [String] network identifier
        # @return [Integer] numeric chain ID
        # @raise [ArgumentError] if network format is unrecognized
        def self.get_evm_chain_id(network)
          # Handle CAIP-2 format
          if network.start_with?('eip155:')
            parts = network.split(':')
            return parts[1].to_i if parts.size == 2
            raise ArgumentError, "Invalid CAIP-2 network format: #{network}"
          end

          # Check aliases
          if Constants::NETWORK_ALIASES.key?(network)
            caip2 = Constants::NETWORK_ALIASES[network]
            return caip2.split(':')[1].to_i
          end

          # Check V1 legacy names
          if Constants::V1_NETWORK_CHAIN_IDS.key?(network)
            return Constants::V1_NETWORK_CHAIN_IDS[network]
          end

          raise ArgumentError, "Unknown network: #{network}"
        end

        ##
        # Get configuration for a network.
        #
        # @param network [String] network identifier (CAIP-2 or legacy name)
        # @return [Constants::NetworkConfig] network configuration
        # @raise [ArgumentError] if network is not configured
        def self.get_network_config(network)
          # Normalize to CAIP-2
          if Constants::NETWORK_ALIASES.key?(network)
            network = Constants::NETWORK_ALIASES[network]
          elsif !network.start_with?('eip155:')
            # Try to convert legacy name
            if Constants::V1_NETWORK_CHAIN_IDS.key?(network)
              network = "eip155:#{Constants::V1_NETWORK_CHAIN_IDS[network]}"
            end
          end

          if Constants::NETWORK_CONFIGS.key?(network)
            return Constants::NETWORK_CONFIGS[network]
          end

          raise ArgumentError, "No configuration for network: #{network}"
        end

        ##
        # Get asset info by symbol or address.
        #
        # @param network [String] network identifier
        # @param asset_symbol_or_address [String] asset symbol (e.g., "USDC") or address
        # @return [Constants::AssetInfo] asset information
        # @raise [ArgumentError] if asset is not found
        def self.get_asset_info(network, asset_symbol_or_address)
          config = get_network_config(network)

          # Check if it's an address
          if asset_symbol_or_address.start_with?('0x')
            # Search by address
            config.supported_assets.each_value do |asset|
              return asset if asset.address.downcase == asset_symbol_or_address.downcase
            end

            # Return default with provided address if not found
            return Constants::AssetInfo.new(
              address: asset_symbol_or_address,
              name: config.default_asset.name,
              version: config.default_asset.version,
              decimals: config.default_asset.decimals
            )
          end

          # Search by symbol
          symbol = asset_symbol_or_address.upcase
          if config.supported_assets.key?(symbol)
            return config.supported_assets[symbol]
          end

          raise ArgumentError, "Asset #{asset_symbol_or_address} not found on #{network}"
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
        # Generate random 32-byte nonce as hex string (0x...).
        #
        # @return [String] hex string with 0x prefix
        def self.create_nonce
          '0x' + SecureRandom.hex(32)
        end

        ##
        # Normalize Ethereum address to checksummed format.
        #
        # Uses EIP-55 checksum algorithm.
        #
        # @param address [String] Ethereum address (with or without 0x prefix)
        # @return [String] checksummed address
        # @raise [ArgumentError] if address is invalid
        def self.normalize_address(address)
          # Remove prefix and lowercase
          addr = address.downcase.delete_prefix('0x')

          raise ArgumentError, "Invalid address length: #{addr.length}" if addr.length != 40

          begin
            addr.to_i(16)
          rescue ArgumentError
            raise ArgumentError, "Invalid hex in address: #{address}"
          end

          Eth::Util.public_key_to_address("0x#{addr}")
        end

        ##
        # Check if string is valid Ethereum address.
        #
        # @param address [String] string to check
        # @return [Boolean] true if valid Ethereum address
        def self.valid_address?(address)
          addr = address.downcase.delete_prefix('0x')
          return false if addr.length != 40

          addr.to_i(16)
          true
        rescue ArgumentError
          false
        end

        ##
        # Convert decimal string to smallest unit (wei).
        #
        # @param amount [String] decimal string (e.g., "1.50")
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
        # Create valid_after/valid_before timestamps.
        #
        # @param duration [Integer, nil] how long authorization is valid in seconds (default: 1 hour)
        # @param buffer [Integer] seconds before now for valid_after (clock skew)
        # @return [Array<Integer, Integer>] [valid_after, valid_before] as Unix timestamps
        def self.create_validity_window(duration: nil, buffer: Constants::DEFAULT_VALIDITY_BUFFER)
          duration ||= Constants::DEFAULT_VALIDITY_PERIOD

          now = Time.now.to_i
          valid_after = now - buffer
          valid_before = now + duration
          [valid_after, valid_before]
        end

        ##
        # Convert hex string to bytes (handles 0x prefix).
        #
        # @param hex_str [String] hex string with optional 0x prefix
        # @return [String] bytes
        def self.hex_to_bytes(hex_str)
          Eth::Util.hex_to_bin(hex_str)
        end

        ##
        # Convert bytes to hex string with 0x prefix.
        #
        # @param data [String] bytes to convert
        # @return [String] hex string with 0x prefix
        def self.bytes_to_hex(data)
          Eth::Util.bin_to_hex(data)
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
      end
    end
  end
end
