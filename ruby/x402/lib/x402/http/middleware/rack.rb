# frozen_string_literal: true

require 'json'
require_relative '../../server'
require_relative '../../schemas/config'
require_relative '../utils'

module X402
  module HTTP
    module Middleware
      ##
      # Rack middleware for x402 payment handling.
      #
      # Provides payment-gated route protection for Rack-based applications
      # (Rails, Sinatra, Hanami, etc.).
      #
      # @example Basic usage with Rack
      #   use X402::HTTP::Middleware::Rack,
      #     server: server,
      #     routes: {
      #       'GET /api/weather' => {
      #         scheme: 'exact',
      #         network: 'eip155:8453',
      #         pay_to: '0x...',
      #         price: '$0.01'
      #       }
      #     }
      #
      # @example With Rails
      #   # config/application.rb
      #   config.middleware.use X402::HTTP::Middleware::Rack,
      #     server: X402_SERVER,
      #     routes: X402_ROUTES
      class Rack
        ##
        # Create Rack middleware.
        #
        # @param app [#call] Rack application
        # @param server [X402::ResourceServer] x402 resource server
        # @param routes [Hash] route configuration map
        # @param initialize_on_start [Boolean] initialize server on first request (default: true)
        def initialize(app, server:, routes:, initialize_on_start: true)
          @app = app
          @server = server
          @routes = normalize_routes(routes)
          @initialize_on_start = initialize_on_start
          @initialized = false
        end

        ##
        # Process Rack request.
        #
        # @param env [Hash] Rack environment
        # @return [Array] Rack response tuple [status, headers, body]
        def call(env)
          request = ::Rack::Request.new(env)

          # Find matching route configuration
          route_config = find_route_config(request)

          # If no route matches, pass through
          return @app.call(env) unless route_config

          # Initialize server on first protected request
          if @initialize_on_start && !@initialized
            @server.initialize!
            @initialized = true
          end

          # Check for payment header
          payment_header = request.get_header('HTTP_PAYMENT_SIGNATURE') ||
                           request.get_header('HTTP_X_PAYMENT')

          if payment_header.nil? || payment_header.empty?
            # No payment provided, return 402
            return payment_required_response(route_config, request)
          end

          # Decode and verify payment
          begin
            payload_hash = Utils.decode_payment_payload(payment_header)
            payload = Helpers.parse_payment_payload(payload_hash)

            # Build requirements from route config
            requirements = build_requirements(route_config)

            # Verify payment
            verify_result = @server.verify_payment(payload, requirements.first)

            unless verify_result.valid?
              # Payment invalid, return 402 with error
              return payment_required_response(
                route_config,
                request,
                error: verify_result.invalid_reason
              )
            end

            # Payment valid, settle it
            settle_result = @server.settle_payment(payload, requirements.first)

            # Continue to application
            status, headers, body = @app.call(env)

            # Add payment response header
            if settle_result.success?
              payment_response = Utils.build_payment_response_headers(settle_result)
              headers = headers.merge(payment_response)
            end

            [status, headers, body]
          rescue StandardError => e
            # Error during payment processing, return 402
            payment_required_response(
              route_config,
              request,
              error: "Payment processing error: #{e.message}"
            )
          end
        end

        private

        ##
        # Normalize routes configuration to internal format.
        #
        # @param routes [Hash, RouteConfig] routes configuration
        # @return [Array<Hash>] normalized route configurations
        def normalize_routes(routes)
          # Convert single RouteConfig to hash
          if routes.is_a?(RouteConfig)
            routes = { '/**' => routes }
          end

          # Build compiled routes with regex patterns
          routes.map do |pattern, config|
            verb, path = parse_route_pattern(pattern)

            {
              verb: verb,
              path: path,
              regex: compile_route_regex(path),
              config: config.is_a?(RouteConfig) ? config : RouteConfig.new(**config)
            }
          end
        end

        ##
        # Parse route pattern into verb and path.
        #
        # @param pattern [String] route pattern (e.g., "GET /api/weather/*")
        # @return [Array<String, String>] tuple of [verb, path]
        def parse_route_pattern(pattern)
          parts = pattern.split(' ', 2)
          if parts.size == 2
            [parts[0].upcase, parts[1]]
          else
            ['*', parts[0]]
          end
        end

        ##
        # Compile route path to regex pattern.
        #
        # @param path [String] route path with wildcards
        # @return [Regexp] compiled regex pattern
        def compile_route_regex(path)
          # Convert path wildcards to regex
          # * matches single segment, ** matches multiple segments
          regex_str = path.gsub('**', '__DOUBLESTAR__')
                          .gsub('*', '[^/]+')
                          .gsub('__DOUBLESTAR__', '.*')

          Regexp.new("^#{regex_str}$")
        end

        ##
        # Find matching route configuration for request.
        #
        # @param request [Rack::Request] Rack request
        # @return [RouteConfig, nil] matching route config or nil
        def find_route_config(request)
          path = request.path
          method = request.request_method

          @routes.each do |route|
            # Check verb match (wildcard * matches all)
            next unless route[:verb] == '*' || route[:verb] == method

            # Check path match
            next unless route[:regex].match?(path)

            return route[:config]
          end

          nil
        end

        ##
        # Build payment requirements from route configuration.
        #
        # @param route_config [RouteConfig] route configuration
        # @return [Array<PaymentRequirements>] payment requirements
        def build_requirements(route_config)
          accepts = route_config.accepts
          accepts = [accepts] unless accepts.is_a?(Array)

          accepts.map do |option|
            config = ResourceConfig.new(
              scheme: option[:scheme] || option['scheme'],
              network: option[:network] || option['network'],
              pay_to: option[:pay_to] || option['payTo'] || option['pay_to'],
              price: option[:price] || option['price'],
              max_timeout_seconds: option[:max_timeout_seconds] || option['maxTimeoutSeconds']
            )

            @server.build_payment_requirements(config)
          end.flatten
        end

        ##
        # Build 402 Payment Required response.
        #
        # @param route_config [RouteConfig] route configuration
        # @param request [Rack::Request] Rack request
        # @param error [String, nil] optional error message
        # @return [Array] Rack response tuple [402, headers, body]
        def payment_required_response(route_config, request, error: nil)
          # Build payment requirements
          requirements = build_requirements(route_config)

          # Build resource info
          resource = ResourceInfo.new(
            url: request.url,
            description: route_config.description,
            mime_type: route_config.mime_type
          )

          # Create PaymentRequired response
          payment_required = @server.create_payment_required_response(
            requirements,
            resource: resource,
            error: error,
            extensions: route_config.extensions
          )

          # Build response headers
          headers = Utils.build_402_headers(payment_required)

          # Build response body
          body = if route_config.custom_paywall_html
                   headers['Content-Type'] = 'text/html'
                   [route_config.custom_paywall_html]
                 else
                   [payment_required.to_json]
                 end

          [402, headers, body]
        end
      end
    end
  end
end
