# frozen_string_literal: true

require 'json'

module X402
  ##
  # Utility functions for the x402 Ruby SDK.
  module Helpers
    ##
    # Extract x402Version from JSON string or hash.
    #
    # @param data [String, Hash] JSON string or parsed hash
    # @return [Integer] protocol version (1 or 2)
    # @raise [ArgumentError] if version is missing or invalid
    def self.detect_version(data)
      parsed = data.is_a?(String) ? JSON.parse(data) : data

      version = parsed['x402Version'] || parsed[:x402Version]
      raise ArgumentError, 'Missing x402Version field' if version.nil?
      raise ArgumentError, "Invalid x402Version: #{version}" unless [1, 2].include?(version)

      version
    end

    ##
    # Extract scheme and network from payment payload.
    #
    # @param version [Integer] protocol version (1 or 2)
    # @param payload [String, Hash] payment payload as JSON string or hash
    # @return [Array<String>] tuple of [scheme, network]
    # @raise [ArgumentError] if required fields are missing
    def self.get_scheme_and_network(version, payload)
      parsed = payload.is_a?(String) ? JSON.parse(payload) : payload

      if version == 1
        # V1: scheme/network at top level
        scheme = parsed['scheme'] || parsed[:scheme]
        network = parsed['network'] || parsed[:network]
      else
        # V2: scheme/network in accepted field
        accepted = parsed['accepted'] || parsed[:accepted] || {}
        scheme = accepted['scheme'] || accepted[:scheme]
        network = accepted['network'] || accepted[:network]
      end

      raise ArgumentError, 'Missing scheme field' unless scheme
      raise ArgumentError, 'Missing network field' unless network

      [scheme, network]
    end

    ##
    # Check if payment payload matches requirements.
    #
    # @param version [Integer] protocol version
    # @param payload [String, Hash] payment payload
    # @param requirements [String, Hash] payment requirements
    # @return [Boolean] true if payload matches requirements
    def self.match_payload_to_requirements(version, payload, requirements)
      payload = JSON.parse(payload) if payload.is_a?(String)
      requirements = JSON.parse(requirements) if requirements.is_a?(String)

      if version == 1
        # V1: Compare scheme and network
        payload_scheme = payload['scheme'] || payload[:scheme]
        payload_network = payload['network'] || payload[:network]
        req_scheme = requirements['scheme'] || requirements[:scheme]
        req_network = requirements['network'] || requirements[:network]

        payload_scheme == req_scheme && payload_network == req_network
      else
        # V2: Compare scheme, network, amount, asset, payTo
        accepted = payload['accepted'] || payload[:accepted] || {}
        %w[scheme network amount asset payTo].all? do |key|
          accepted_val = accepted[key] || accepted[key.to_sym]
          req_val = requirements[key] || requirements[key.to_sym]
          accepted_val == req_val
        end
      end
    end

    ##
    # Parse 402 response into appropriate version type.
    #
    # @param data [String, Hash] JSON string or parsed hash
    # @return [PaymentRequired] PaymentRequired instance (V1 not implemented yet)
    def self.parse_payment_required(data)
      version = detect_version(data)
      json_str = data.is_a?(String) ? data : JSON.generate(data)

      if version == 1
        # TODO: Implement V1 support
        raise UnsupportedVersionError, 1
      else
        PaymentRequired.from_json(json_str)
      end
    end

    ##
    # Parse payment payload into appropriate version type.
    #
    # @param data [String, Hash] JSON string or parsed hash
    # @return [PaymentPayload] PaymentPayload instance (V1 not implemented yet)
    def self.parse_payment_payload(data)
      version = detect_version(data)
      json_str = data.is_a?(String) ? data : JSON.generate(data)

      if version == 1
        # TODO: Implement V1 support
        raise UnsupportedVersionError, 1
      else
        PaymentPayload.from_json(json_str)
      end
    end

    ##
    # Parse payment requirements based on protocol version.
    #
    # @param x402_version [Integer] protocol version (1 or 2) from payment payload
    # @param data [String, Hash] JSON string or parsed hash
    # @return [PaymentRequirements] PaymentRequirements instance (V1 not implemented yet)
    # @raise [ArgumentError] if version is invalid
    def self.parse_payment_requirements(x402_version, data)
      raise ArgumentError, "Invalid x402Version: #{x402_version}" unless [1, 2].include?(x402_version)

      json_str = data.is_a?(String) ? data : JSON.generate(data)

      if x402_version == 1
        # TODO: Implement V1 support
        raise UnsupportedVersionError, 1
      else
        PaymentRequirements.from_json(json_str)
      end
    end

    ##
    # Check if network matches a pattern (supports wildcards).
    #
    # @param network [String] specific network (e.g., "eip155:8453")
    # @param pattern [String] pattern to match (e.g., "eip155:*" or "eip155:8453")
    # @return [Boolean] true if network matches pattern
    #
    # @example
    #   X402::Helpers.matches_network_pattern("eip155:8453", "eip155:*")  # => true
    #   X402::Helpers.matches_network_pattern("eip155:8453", "eip155:8453")  # => true
    #   X402::Helpers.matches_network_pattern("eip155:8453", "solana:*")  # => false
    def self.matches_network_pattern(network, pattern)
      if pattern.end_with?(':*')
        network.start_with?(pattern[0...-2])
      else
        pattern == network
      end
    end

    ##
    # Derive common pattern from list of networks.
    #
    # If all networks share same namespace, returns wildcard pattern.
    # Otherwise returns first network.
    #
    # @param networks [Array<String>] list of networks
    # @return [String] derived pattern
    # @raise [ArgumentError] if networks list is empty
    #
    # @example
    #   X402::Helpers.derive_network_pattern(["eip155:8453", "eip155:84532"])  # => "eip155:*"
    #   X402::Helpers.derive_network_pattern(["eip155:8453", "solana:mainnet"])  # => "eip155:8453"
    def self.derive_network_pattern(networks)
      raise ArgumentError, 'At least one network required' if networks.empty?

      namespaces = networks.map { |n| n.split(':')[0] }.uniq
      if namespaces.size == 1
        "#{namespaces.first}:*"
      else
        networks.first
      end
    end

    ##
    # Find schemes registered for a network (with wildcard matching).
    #
    # @param schemes [Hash] map of network => (scheme => implementation)
    # @param network [String] network to find schemes for
    # @return [Hash, nil] hash of scheme => implementation, or nil if not found
    def self.find_schemes_by_network(schemes, network)
      # Try exact match first
      return schemes[network] if schemes.key?(network)

      # Try wildcard patterns
      schemes.each do |pattern, scheme_map|
        return scheme_map if matches_network_pattern(network, pattern)
      end

      nil
    end
  end
end
