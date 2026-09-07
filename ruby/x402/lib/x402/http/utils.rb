# frozen_string_literal: true

require 'base64'
require 'json'

module X402
  module HTTP
    ##
    # HTTP utilities for x402 protocol.
    module Utils
      ##
      # Encode payment payload to Base64 for HTTP header.
      #
      # @param payload [PaymentPayload, Hash, String] payment payload
      # @return [String] Base64-encoded JSON
      #
      # @example
      #   encoded = X402::HTTP::Utils.encode_payment_payload(payload)
      #   # => "eyJ4NDAyVmVyc2lvbiI6Miw..."
      def self.encode_payment_payload(payload)
        json_str = case payload
                   when String
                     payload
                   when Hash
                     JSON.generate(payload)
                   else
                     payload.to_json
                   end

        Base64.strict_encode64(json_str)
      end

      ##
      # Decode payment payload from Base64 HTTP header.
      #
      # @param encoded [String] Base64-encoded JSON
      # @return [Hash] decoded payload as hash
      # @raise [ArgumentError] if decoding fails
      #
      # @example
      #   decoded = X402::HTTP::Utils.decode_payment_payload(encoded)
      #   # => { "x402Version" => 2, ... }
      def self.decode_payment_payload(encoded)
        json_str = Base64.strict_decode64(encoded)
        JSON.parse(json_str)
      rescue StandardError => e
        raise ArgumentError, "Failed to decode payment payload: #{e.message}"
      end

      ##
      # Encode payment requirements to Base64 for HTTP header.
      #
      # @param requirements [PaymentRequirements, Hash, String] requirements
      # @return [String] Base64-encoded JSON
      def self.encode_payment_requirements(requirements)
        json_str = case requirements
                   when String
                     requirements
                   when Hash
                     JSON.generate(requirements)
                   else
                     requirements.to_json
                   end

        Base64.strict_encode64(json_str)
      end

      ##
      # Decode payment requirements from Base64 HTTP header.
      #
      # @param encoded [String] Base64-encoded JSON
      # @return [Hash] decoded requirements as hash
      # @raise [ArgumentError] if decoding fails
      def self.decode_payment_requirements(encoded)
        json_str = Base64.strict_decode64(encoded)
        JSON.parse(json_str)
      rescue StandardError => e
        raise ArgumentError, "Failed to decode payment requirements: #{e.message}"
      end

      ##
      # Build 402 Payment Required response headers.
      #
      # @param payment_required [PaymentRequired, Hash] payment required response
      # @return [Hash] headers with Payment-Required header
      #
      # @example
      #   headers = X402::HTTP::Utils.build_402_headers(payment_required)
      #   # => { "Payment-Required" => "eyJ4NDAyVmVyc2lvbiI6Miw..." }
      def self.build_402_headers(payment_required)
        json_str = payment_required.is_a?(String) ? payment_required : payment_required.to_json
        encoded = Base64.strict_encode64(json_str)

        {
          'Payment-Required' => encoded,
          'Content-Type' => 'application/json'
        }
      end

      ##
      # Build Payment-Response header for successful settlement.
      #
      # @param settle_response [SettleResponse, Hash] settlement response
      # @return [Hash] headers with Payment-Response header
      #
      # @example
      #   headers = X402::HTTP::Utils.build_payment_response_headers(settle_response)
      #   # => { "Payment-Response" => "eyJzdWNjZXNzIjp0cnVlLCAuLi4=" }
      def self.build_payment_response_headers(settle_response)
        json_str = settle_response.is_a?(String) ? settle_response : settle_response.to_json
        encoded = Base64.strict_encode64(json_str)

        {
          'Payment-Response' => encoded
        }
      end

      ##
      # Parse Payment-Signature header from request.
      #
      # @param header_value [String, nil] Payment-Signature header value
      # @return [Hash, nil] decoded payment payload as hash, or nil
      def self.parse_payment_signature_header(header_value)
        return nil if header_value.nil? || header_value.empty?

        decode_payment_payload(header_value)
      end

      ##
      # Parse Payment-Required header from 402 response.
      #
      # @param header_value [String, nil] Payment-Required header value
      # @return [Hash, nil] decoded payment required as hash, or nil
      def self.parse_payment_required_header(header_value)
        return nil if header_value.nil? || header_value.empty?

        json_str = Base64.strict_decode64(header_value)
        JSON.parse(json_str)
      rescue StandardError => e
        raise ArgumentError, "Failed to parse Payment-Required header: #{e.message}"
      end
    end
  end
end
