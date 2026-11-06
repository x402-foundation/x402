# frozen_string_literal: true

require_relative 'schemas/base'
require_relative 'schemas/errors'
require_relative 'schemas/payments'
require_relative 'schemas/responses'
require_relative 'schemas/config'
require_relative 'schemas/hooks'
require_relative 'schemas/helpers'
require_relative 'interfaces'

module X402
  ##
  # Resource server for protecting resources with payment requirements.
  #
  # The server manages scheme registration, payment verification, and settlement
  # through a facilitator client.
  #
  # @example Basic usage
  #   facilitator = X402::HTTP::FacilitatorClient.new(url: 'https://x402.org/facilitator')
  #   server = X402::ResourceServer.new(facilitator)
  #   server.register('eip155:*', X402::Mechanisms::EVM::Exact::ServerScheme.new)
  #   server.initialize!
  #
  #   # Build payment requirements
  #   config = X402::ResourceConfig.new(
  #     scheme: 'exact',
  #     network: 'eip155:8453',
  #     pay_to: '0x...',
  #     price: '$0.01'
  #   )
  #   requirements = server.build_payment_requirements(config)
  #
  #   # Verify and settle payment
  #   verify_result = server.verify_payment(payload, requirements.first)
  #   settle_result = server.settle_payment(payload, requirements.first) if verify_result.valid?
  #
  # @example With hooks
  #   server.before_verify do |context|
  #     puts "Verifying payment from #{context.payment_payload.get_network}"
  #   end
  #
  #   server.after_settle do |context|
  #     puts "Settled: #{context.result.transaction}"
  #   end
  class ResourceServer
    ##
    # Create a new resource server.
    #
    # @param facilitator_clients [Object, Array<Object>] facilitator client(s) implementing
    #   verify/settle/get_supported methods
    def initialize(facilitator_clients = nil)
      # Normalize to array
      @facilitator_clients = case facilitator_clients
                             when nil
                               []
                             when Array
                               facilitator_clients
                             else
                               [facilitator_clients]
                             end

      @schemes = {}  # network pattern => scheme name => scheme server
      @facilitator_clients_map = {}  # network => scheme => client
      @supported_responses = {}  # network => scheme => SupportedResponse
      @extensions = {}
      @initialized = false

      # Hooks
      @before_verify_hooks = []
      @after_verify_hooks = []
      @on_verify_failure_hooks = []
      @before_settle_hooks = []
      @after_settle_hooks = []
      @on_settle_failure_hooks = []
    end

    # ========================================================================
    # Registration
    # ========================================================================

    ##
    # Register a V2 scheme server for a network pattern.
    #
    # @param network [String] network pattern (e.g., "eip155:*", "eip155:8453")
    # @param server [Object] scheme server implementing SchemeNetworkServer
    # @param x402_version [Integer] protocol version (default: 2)
    # @return [self] for chaining
    #
    # @example
    #   server.register('eip155:*', X402::Mechanisms::EVM::Exact::ServerScheme.new)
    def register(network, server, x402_version: 2)
      raise ArgumentError, 'Only V2 protocol supported' unless x402_version == 2

      @schemes[network] ||= {}
      @schemes[network][server.scheme] = server
      self
    end

    ##
    # Check if a scheme is registered for a network.
    #
    # @param network [String] network identifier
    # @param scheme [String] scheme identifier
    # @return [Boolean] true if registered
    def has_registered_scheme?(network, scheme)
      # Check exact match
      return true if @schemes[network]&.key?(scheme)

      # Check wildcard (e.g., eip155:* for eip155:84532)
      prefix = network.split(':')[0]
      wildcard = "#{prefix}:*"
      @schemes[wildcard]&.key?(scheme) || false
    end

    # ========================================================================
    # Initialization
    # ========================================================================

    ##
    # Initialize server by fetching supported kinds from facilitators.
    #
    # This must be called before building requirements or verifying payments.
    #
    # @return [void]
    # @raise [StandardError] if facilitator communication fails
    #
    # @example
    #   server.initialize!
    def initialize!
      @facilitator_clients.each do |client|
        supported = client.get_supported

        supported.kinds.each do |kind|
          network = kind.network
          scheme = kind.scheme

          # Only add if not already registered (earlier takes precedence)
          @facilitator_clients_map[network] ||= {}
          @facilitator_clients_map[network][scheme] ||= client

          # Store supported response
          @supported_responses[network] ||= {}
          @supported_responses[network][scheme] ||= supported
        end
      end

      @initialized = true
    end

    # ========================================================================
    # Build Requirements
    # ========================================================================

    ##
    # Build payment requirements for a protected resource.
    #
    # @param config [ResourceConfig] resource configuration
    # @param extensions [Array<String>, nil] optional extension keys
    # @return [Array<PaymentRequirements>] payment requirements list
    # @raise [RuntimeError] if server not initialized
    # @raise [SchemeNotFoundError] if scheme not found
    #
    # @example
    #   config = X402::ResourceConfig.new(
    #     scheme: 'exact',
    #     network: 'eip155:8453',
    #     pay_to: '0x...',
    #     price: '$0.01'
    #   )
    #   requirements = server.build_payment_requirements(config)
    def build_payment_requirements(config, extensions: nil)
      raise 'Server not initialized. Call initialize! first' unless @initialized

      # Find scheme server
      schemes = Helpers.find_schemes_by_network(@schemes, config.network)
      raise SchemeNotFoundError, config.network if schemes.nil? || !schemes.key?(config.scheme)

      scheme_server = schemes[config.scheme]

      # Get supported kind
      supported = @supported_responses.dig(config.network, config.scheme)
      raise SchemeNotFoundError, config.network if supported.nil?

      # Find matching kind
      supported_kind = supported.kinds.find do |kind|
        kind.scheme == config.scheme && kind.network == config.network
      end
      raise SchemeNotFoundError, config.network if supported_kind.nil?

      # Parse price
      asset_amount = scheme_server.parse_price(config.price, config.network)

      # Build base requirements
      requirements = PaymentRequirements.new(
        scheme: config.scheme,
        network: config.network,
        asset: asset_amount.asset,
        amount: asset_amount.amount,
        pay_to: config.pay_to,
        max_timeout_seconds: config.max_timeout_seconds || 300,
        extra: asset_amount.extra || {}
      )

      # Enhance with scheme-specific details
      enhanced = scheme_server.enhance_payment_requirements(
        requirements,
        supported_kind,
        extensions || []
      )

      [enhanced]
    end

    ##
    # Create a 402 Payment Required response.
    #
    # @param requirements [Array<PaymentRequirements>] payment requirements
    # @param resource [ResourceInfo, nil] optional resource information
    # @param error [String, nil] optional error message
    # @param extensions [Hash, nil] optional extensions
    # @return [PaymentRequired] payment required response
    #
    # @example
    #   payment_required = server.create_payment_required_response(
    #     requirements,
    #     resource: ResourceInfo.new(url: 'https://example.com/api/data')
    #   )
    def create_payment_required_response(requirements, resource: nil, error: nil, extensions: nil)
      PaymentRequired.new(
        x402_version: 2,
        error: error,
        resource: resource,
        accepts: requirements,
        extensions: extensions
      )
    end

    # ========================================================================
    # Verification and Settlement
    # ========================================================================

    ##
    # Verify a payment.
    #
    # @param payload [PaymentPayload] payment payload to verify
    # @param requirements [PaymentRequirements] requirements to verify against
    # @param payload_bytes [String, nil] optional raw payload bytes
    # @param requirements_bytes [String, nil] optional raw requirements bytes
    # @return [VerifyResponse] verification result
    # @raise [RuntimeError] if server not initialized
    # @raise [SchemeNotFoundError] if scheme not found
    #
    # @example
    #   result = server.verify_payment(payload, requirements)
    #   if result.valid?
    #     # Payment is valid
    #   end
    def verify_payment(payload, requirements, payload_bytes: nil, requirements_bytes: nil)
      raise 'Server not initialized. Call initialize! first' unless @initialized

      context = VerifyContext.new(
        payment_payload: payload,
        requirements: requirements,
        payload_bytes: payload_bytes,
        requirements_bytes: requirements_bytes
      )

      # Execute before hooks
      @before_verify_hooks.each do |hook|
        result = hook.call(context)
        raise InvalidPaymentError, result.reason if result.is_a?(AbortResult)
      end

      begin
        # Get scheme and network
        scheme = payload.get_scheme
        network = payload.get_network

        # Find facilitator client
        client = @facilitator_clients_map.dig(network, scheme)
        raise SchemeNotFoundError, network if client.nil?

        # Call facilitator to verify
        verify_result = client.verify(payload, requirements)

        # Check if verification failed
        unless verify_result.valid?
          failure_context = VerifyFailureContext.new(
            payment_payload: payload,
            requirements: requirements,
            error: StandardError.new(verify_result.invalid_reason || 'Verification failed'),
            payload_bytes: payload_bytes,
            requirements_bytes: requirements_bytes
          )

          @on_verify_failure_hooks.each do |hook|
            result = hook.call(failure_context)
            if result.is_a?(RecoveredVerifyResult)
              # Execute after hooks for recovered result
              result_context = VerifyResultContext.new(
                payment_payload: payload,
                requirements: requirements,
                result: result.result,
                payload_bytes: payload_bytes,
                requirements_bytes: requirements_bytes
              )
              @after_verify_hooks.each { |h| h.call(result_context) }
              return result.result
            end
          end

          return verify_result
        end

        # Execute after hooks for success
        result_context = VerifyResultContext.new(
          payment_payload: payload,
          requirements: requirements,
          result: verify_result,
          payload_bytes: payload_bytes,
          requirements_bytes: requirements_bytes
        )
        @after_verify_hooks.each { |hook| hook.call(result_context) }

        verify_result
      rescue StandardError => e
        failure_context = VerifyFailureContext.new(
          payment_payload: payload,
          requirements: requirements,
          error: e,
          payload_bytes: payload_bytes,
          requirements_bytes: requirements_bytes
        )

        @on_verify_failure_hooks.each do |hook|
          result = hook.call(failure_context)
          return result.result if result.is_a?(RecoveredVerifyResult)
        end

        raise
      end
    end

    ##
    # Settle a payment.
    #
    # @param payload [PaymentPayload] payment payload to settle
    # @param requirements [PaymentRequirements] requirements for settlement
    # @param payload_bytes [String, nil] optional raw payload bytes
    # @param requirements_bytes [String, nil] optional raw requirements bytes
    # @return [SettleResponse] settlement result
    # @raise [RuntimeError] if server not initialized
    # @raise [SchemeNotFoundError] if scheme not found
    #
    # @example
    #   result = server.settle_payment(payload, requirements)
    #   if result.success?
    #     puts "Transaction: #{result.transaction}"
    #   end
    def settle_payment(payload, requirements, payload_bytes: nil, requirements_bytes: nil)
      raise 'Server not initialized. Call initialize! first' unless @initialized

      context = SettleContext.new(
        payment_payload: payload,
        requirements: requirements,
        payload_bytes: payload_bytes,
        requirements_bytes: requirements_bytes
      )

      # Execute before hooks
      @before_settle_hooks.each do |hook|
        result = hook.call(context)
        raise InvalidPaymentError, result.reason if result.is_a?(AbortResult)
      end

      begin
        # Get scheme and network
        scheme = payload.get_scheme
        network = payload.get_network

        # Find facilitator client
        client = @facilitator_clients_map.dig(network, scheme)
        raise SchemeNotFoundError, network if client.nil?

        # Call facilitator to settle
        settle_result = client.settle(payload, requirements)

        # Check if settlement failed
        unless settle_result.success?
          failure_context = SettleFailureContext.new(
            payment_payload: payload,
            requirements: requirements,
            error: StandardError.new(settle_result.error_reason || 'Settlement failed'),
            payload_bytes: payload_bytes,
            requirements_bytes: requirements_bytes
          )

          @on_settle_failure_hooks.each do |hook|
            result = hook.call(failure_context)
            if result.is_a?(RecoveredSettleResult)
              # Execute after hooks for recovered result
              result_context = SettleResultContext.new(
                payment_payload: payload,
                requirements: requirements,
                result: result.result,
                payload_bytes: payload_bytes,
                requirements_bytes: requirements_bytes
              )
              @after_settle_hooks.each { |h| h.call(result_context) }
              return result.result
            end
          end

          return settle_result
        end

        # Execute after hooks for success
        result_context = SettleResultContext.new(
          payment_payload: payload,
          requirements: requirements,
          result: settle_result,
          payload_bytes: payload_bytes,
          requirements_bytes: requirements_bytes
        )
        @after_settle_hooks.each { |hook| hook.call(result_context) }

        settle_result
      rescue StandardError => e
        failure_context = SettleFailureContext.new(
          payment_payload: payload,
          requirements: requirements,
          error: e,
          payload_bytes: payload_bytes,
          requirements_bytes: requirements_bytes
        )

        @on_settle_failure_hooks.each do |hook|
          result = hook.call(failure_context)
          return result.result if result.is_a?(RecoveredSettleResult)
        end

        raise
      end
    end

    # ========================================================================
    # Hooks
    # ========================================================================

    ##
    # Register a before-verify hook.
    #
    # @yield [context] the verify context
    # @yieldparam context [VerifyContext] context with payment and requirements
    # @yieldreturn [AbortResult, nil] result or nil
    # @return [self] for chaining
    def before_verify(&block)
      @before_verify_hooks << block
      self
    end

    ##
    # Register an after-verify hook.
    #
    # @yield [context] the verify result context
    # @yieldparam context [VerifyResultContext] context with result
    # @return [self] for chaining
    def after_verify(&block)
      @after_verify_hooks << block
      self
    end

    ##
    # Register a verify-failure hook.
    #
    # @yield [context] the verify failure context
    # @yieldparam context [VerifyFailureContext] context with error
    # @yieldreturn [RecoveredVerifyResult, nil] recovery result or nil
    # @return [self] for chaining
    def on_verify_failure(&block)
      @on_verify_failure_hooks << block
      self
    end

    ##
    # Register a before-settle hook.
    #
    # @yield [context] the settle context
    # @yieldparam context [SettleContext] context with payment and requirements
    # @yieldreturn [AbortResult, nil] result or nil
    # @return [self] for chaining
    def before_settle(&block)
      @before_settle_hooks << block
      self
    end

    ##
    # Register an after-settle hook.
    #
    # @yield [context] the settle result context
    # @yieldparam context [SettleResultContext] context with result
    # @return [self] for chaining
    def after_settle(&block)
      @after_settle_hooks << block
      self
    end

    ##
    # Register a settle-failure hook.
    #
    # @yield [context] the settle failure context
    # @yieldparam context [SettleFailureContext] context with error
    # @yieldreturn [RecoveredSettleResult, nil] recovery result or nil
    # @return [self] for chaining
    def on_settle_failure(&block)
      @on_settle_failure_hooks << block
      self
    end
  end
end
