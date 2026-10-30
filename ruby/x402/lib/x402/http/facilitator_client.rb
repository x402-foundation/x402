# frozen_string_literal: true

require 'faraday'
require 'json'
require_relative '../schemas/base'
require_relative '../schemas/payments'
require_relative '../schemas/responses'

module X402
  module HTTP
    ##
    # HTTP-based facilitator client using Faraday.
    #
    # Communicates with remote x402 facilitator services over HTTP.
    #
    # @example Basic usage
    #   client = X402::HTTP::FacilitatorClient.new(url: 'https://x402.org/facilitator')
    #   supported = client.get_supported
    #   result = client.verify(payload, requirements)
    #
    # @example With custom timeout
    #   client = X402::HTTP::FacilitatorClient.new(
    #     url: 'https://x402.org/facilitator',
    #     timeout: 60
    #   )
    #
    # @example With authentication
    #   client = X402::HTTP::FacilitatorClient.new(
    #     url: 'https://x402.org/facilitator',
    #     auth_headers: {
    #       'Authorization' => 'Bearer token123'
    #     }
    #   )
    class FacilitatorClient
      # Default facilitator URL
      DEFAULT_URL = 'https://x402.org/facilitator'

      ##
      # @return [String] facilitator base URL
      attr_reader :url

      ##
      # @return [String] facilitator identifier
      attr_reader :identifier

      ##
      # Create a new HTTP facilitator client.
      #
      # @param url [String] facilitator base URL
      # @param timeout [Numeric] request timeout in seconds (default: 30)
      # @param auth_headers [Hash, nil] optional authentication headers
      # @param identifier [String, nil] optional identifier (defaults to URL)
      # @param connection [Faraday::Connection, nil] optional custom Faraday connection
      def initialize(url: DEFAULT_URL, timeout: 30, auth_headers: nil, identifier: nil, connection: nil)
        @url = url.chomp('/')
        @timeout = timeout
        @auth_headers = auth_headers || {}
        @identifier = identifier || @url
        @connection = connection
      end

      ##
      # Get supported payment kinds and extensions.
      #
      # @return [SupportedResponse] supported kinds, extensions, and signers
      # @raise [HTTPError] if request fails
      #
      # @example
      #   supported = client.get_supported
      #   supported.kinds.each { |kind| puts "#{kind.scheme} on #{kind.network}" }
      def get_supported
        response = connection.get('supported') do |req|
          merge_auth_headers(req, @auth_headers)
        end

        handle_response(response) do |body|
          SupportedResponse.from_json(JSON.generate(body))
        end
      end

      ##
      # Verify a payment with the facilitator.
      #
      # @param payload [PaymentPayload] payment payload to verify
      # @param requirements [PaymentRequirements] requirements to verify against
      # @return [VerifyResponse] verification result
      # @raise [HTTPError] if request fails
      #
      # @example
      #   result = client.verify(payload, requirements)
      #   puts result.valid? ? "Valid" : "Invalid: #{result.invalid_reason}"
      def verify(payload, requirements)
        request_body = build_request_body(
          payload.x402_version,
          JSON.parse(payload.to_json),
          JSON.parse(requirements.to_json)
        )

        response = connection.post('verify') do |req|
          req.headers['Content-Type'] = 'application/json'
          merge_auth_headers(req, @auth_headers)
          req.body = JSON.generate(request_body)
        end

        handle_response(response) do |body|
          VerifyResponse.from_json(JSON.generate(body))
        end
      end

      ##
      # Settle a payment with the facilitator.
      #
      # @param payload [PaymentPayload] payment payload to settle
      # @param requirements [PaymentRequirements] requirements for settlement
      # @return [SettleResponse] settlement result
      # @raise [HTTPError] if request fails
      #
      # @example
      #   result = client.settle(payload, requirements)
      #   puts "Transaction: #{result.transaction}" if result.success?
      def settle(payload, requirements)
        request_body = build_request_body(
          payload.x402_version,
          JSON.parse(payload.to_json),
          JSON.parse(requirements.to_json)
        )

        response = connection.post('settle') do |req|
          req.headers['Content-Type'] = 'application/json'
          merge_auth_headers(req, @auth_headers)
          req.body = JSON.generate(request_body)
        end

        handle_response(response) do |body|
          SettleResponse.from_json(JSON.generate(body))
        end
      end

      ##
      # Verify payment from raw JSON bytes.
      #
      # @param payload_bytes [String] JSON string of payment payload
      # @param requirements_bytes [String] JSON string of requirements
      # @return [VerifyResponse] verification result
      # @raise [HTTPError] if request fails
      def verify_from_bytes(payload_bytes, requirements_bytes)
        version = Helpers.detect_version(payload_bytes)
        payload_dict = JSON.parse(payload_bytes)
        requirements_dict = JSON.parse(requirements_bytes)

        request_body = build_request_body(version, payload_dict, requirements_dict)

        response = connection.post('verify') do |req|
          req.headers['Content-Type'] = 'application/json'
          merge_auth_headers(req, @auth_headers)
          req.body = JSON.generate(request_body)
        end

        handle_response(response) do |body|
          VerifyResponse.from_json(JSON.generate(body))
        end
      end

      ##
      # Settle payment from raw JSON bytes.
      #
      # @param payload_bytes [String] JSON string of payment payload
      # @param requirements_bytes [String] JSON string of requirements
      # @return [SettleResponse] settlement result
      # @raise [HTTPError] if request fails
      def settle_from_bytes(payload_bytes, requirements_bytes)
        version = Helpers.detect_version(payload_bytes)
        payload_dict = JSON.parse(payload_bytes)
        requirements_dict = JSON.parse(requirements_bytes)

        request_body = build_request_body(version, payload_dict, requirements_dict)

        response = connection.post('settle') do |req|
          req.headers['Content-Type'] = 'application/json'
          merge_auth_headers(req, @auth_headers)
          req.body = JSON.generate(request_body)
        end

        handle_response(response) do |body|
          SettleResponse.from_json(JSON.generate(body))
        end
      end

      private

      ##
      # Get or create Faraday connection.
      #
      # @return [Faraday::Connection] connection instance
      def connection
        @connection ||= Faraday.new(url: @url) do |f|
          f.request :json
          f.response :json, content_type: /\bjson$/
          f.adapter Faraday.default_adapter
          f.options.timeout = @timeout
          f.options.open_timeout = @timeout
        end
      end

      ##
      # Build request body for verify/settle endpoints.
      #
      # @param version [Integer] protocol version
      # @param payload_dict [Hash] payment payload as hash
      # @param requirements_dict [Hash] requirements as hash
      # @return [Hash] request body
      def build_request_body(version, payload_dict, requirements_dict)
        {
          x402Version: version,
          paymentPayload: to_json_safe(payload_dict),
          paymentRequirements: to_json_safe(requirements_dict)
        }
      end

      ##
      # Convert object to JSON-safe format (handles large integers).
      #
      # @param obj [Object] object to convert
      # @return [Object] JSON-safe object
      def to_json_safe(obj)
        # Ruby handles large integers natively, but ensure consistency
        JSON.parse(JSON.generate(obj))
      end

      ##
      # Handle HTTP response and parse result.
      #
      # @param response [Faraday::Response] HTTP response
      # @yield [body] block to parse response body
      # @yieldparam body [Hash] parsed response body
      # @return [Object] parsed result
      # @raise [HTTPError] if response status is not 2xx
      def handle_response(response)
        unless response.success?
          raise HTTPError.new(
            response.status,
            response.body.is_a?(Hash) ? response.body : response.body.to_s
          )
        end

        yield response.body
      end

      ##
      # Merge authentication headers into request.
      #
      # @param req [Faraday::Request] request object
      # @param headers [Hash] headers to merge
      def merge_auth_headers(req, headers)
        headers.each do |key, value|
          req.headers[key] = value
        end
      end
    end
  end
end
