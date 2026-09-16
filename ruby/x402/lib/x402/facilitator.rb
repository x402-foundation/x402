# frozen_string_literal: true

require_relative 'schemas/base'
require_relative 'schemas/errors'
require_relative 'schemas/payments'
require_relative 'schemas/responses'
require_relative 'schemas/hooks'
require_relative 'schemas/helpers'
require_relative 'interfaces'

module X402
  ##
  # Facilitator for verifying and settling payments.
  #
  # The facilitator manages payment scheme implementations for verification
  # and on-chain settlement across multiple networks.
  #
  # @example Basic usage
  #   facilitator = X402::Facilitator.new
  #   facilitator.register(
  #     ['eip155:8453', 'eip155:84532'],
  #     X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(rpc_url: '...')
  #   )
  #
  #   # Expose supported kinds to servers
  #   supported = facilitator.get_supported
  #
  #   # Verify payment
  #   verify_result = facilitator.verify(payload, requirements)
  #
  #   # Settle payment if valid
  #   settle_result = facilitator.settle(payload, requirements) if verify_result.valid?
  #
  # @example With hooks
  #   facilitator.before_verify do |context|
  #     puts "Verifying: #{context.payment_payload.get_network}"
  #   end
  #
  #   facilitator.after_settle do |context|
  #     puts "Settled: #{context.result.transaction}"
  #   end
  class Facilitator
    ##
    # Internal data structure for registered schemes.
    #
    # @!attribute [r] facilitator
    #   @return [Object] scheme facilitator implementation
    # @!attribute [r] networks
    #   @return [Array<String>] list of supported networks
    # @!attribute [r] pattern
    #   @return [String] derived network pattern for matching
    SchemeData = Struct.new(:facilitator, :networks, :pattern, keyword_init: true)

    ##
    # Create a new facilitator.
    def initialize
      @schemes = []       # Array of SchemeData (V2)
      @schemes_v1 = []    # Array of SchemeData (V1, not yet implemented)
      @extensions = []    # Extension identifiers

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
    # Register a V2 facilitator scheme for specific networks.
    #
    # @param networks [Array<String>] list of networks (e.g., ['eip155:8453', 'eip155:84532'])
    # @param facilitator [Object] scheme facilitator implementing SchemeNetworkFacilitator
    # @param x402_version [Integer] protocol version (default: 2)
    # @return [self] for chaining
    #
    # @example
    #   facilitator.register(
    #     ['eip155:8453', 'eip155:84532'],
    #     X402::Mechanisms::EVM::Exact::FacilitatorScheme.new(rpc_url: 'https://...')
    #   )
    def register(networks, facilitator, x402_version: 2)
      raise ArgumentError, 'Only V2 protocol supported' unless x402_version == 2

      # Derive pattern from networks
      pattern = Helpers.derive_network_pattern(networks)

      # Store scheme data
      scheme_data = SchemeData.new(
        facilitator: facilitator,
        networks: networks,
        pattern: pattern
      )

      @schemes << scheme_data
      self
    end

    ##
    # Register an extension by identifier.
    #
    # @param extension_id [String] extension identifier
    # @return [self] for chaining
    def register_extension(extension_id)
      @extensions << extension_id unless @extensions.include?(extension_id)
      self
    end

    # ========================================================================
    # Supported Response
    # ========================================================================

    ##
    # Get supported payment kinds and signers.
    #
    # Returns information about all registered schemes for server initialization.
    #
    # @return [SupportedResponse] supported kinds, extensions, and signers
    #
    # @example
    #   supported = facilitator.get_supported
    #   supported.kinds.each do |kind|
    #     puts "#{kind.scheme} on #{kind.network}"
    #   end
    def get_supported
      kinds = []
      signers_by_family = {}

      # Build kinds from V2 schemes
      @schemes.each do |scheme_data|
        facilitator = scheme_data.facilitator
        scheme = facilitator.scheme
        caip_family = facilitator.caip_family

        scheme_data.networks.each do |network|
          # Get extra data for this network
          extra = facilitator.get_extra(network)

          # Create SupportedKind
          kind = SupportedKind.new(
            scheme: scheme,
            network: network,
            extra: extra
          )
          kinds << kind

          # Collect signers by CAIP family
          signers_by_family[caip_family] ||= []
          network_signers = facilitator.get_signers(network)
          signers_by_family[caip_family].concat(network_signers)
        end
      end

      # Deduplicate signers within each family
      signers = signers_by_family.transform_values(&:uniq)

      SupportedResponse.new(
        kinds: kinds,
        extensions: @extensions,
        signers: signers
      )
    end

    # ========================================================================
    # Verification
    # ========================================================================

    ##
    # Verify a payment.
    #
    # @param payload [PaymentPayload] payment payload to verify
    # @param requirements [PaymentRequirements] requirements to verify against
    # @param payload_bytes [String, nil] optional raw payload bytes
    # @param requirements_bytes [String, nil] optional raw requirements bytes
    # @return [VerifyResponse] verification result
    #
    # @example
    #   result = facilitator.verify(payload, requirements)
    #   if result.valid?
    #     puts "Payment is valid"
    #   else
    #     puts "Invalid: #{result.invalid_reason}"
    #   end
    def verify(payload, requirements, payload_bytes: nil, requirements_bytes: nil)
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
        # Route by version
        verify_result = if payload.x402_version == 1
                          verify_v1(payload, requirements)
                        else
                          verify_v2(payload, requirements)
                        end

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

    # ========================================================================
    # Settlement
    # ========================================================================

    ##
    # Settle a payment.
    #
    # @param payload [PaymentPayload] payment payload to settle
    # @param requirements [PaymentRequirements] requirements for settlement
    # @param payload_bytes [String, nil] optional raw payload bytes
    # @param requirements_bytes [String, nil] optional raw requirements bytes
    # @return [SettleResponse] settlement result
    #
    # @example
    #   result = facilitator.settle(payload, requirements)
    #   if result.success?
    #     puts "Transaction: #{result.transaction}"
    #   else
    #     puts "Failed: #{result.error_reason}"
    #   end
    def settle(payload, requirements, payload_bytes: nil, requirements_bytes: nil)
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
        # Route by version
        settle_result = if payload.x402_version == 1
                          settle_v1(payload, requirements)
                        else
                          settle_v2(payload, requirements)
                        end

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

    private

    # ========================================================================
    # Internal Implementation
    # ========================================================================

    def verify_v1(_payload, _requirements)
      # TODO: Implement V1 support
      raise UnsupportedVersionError, 1
    end

    def verify_v2(payload, requirements)
      # Extract scheme and network
      scheme = payload.get_scheme
      network = payload.get_network

      # Find facilitator
      facilitator = find_facilitator(network, scheme)
      raise SchemeNotFoundError, network if facilitator.nil?

      # Call facilitator's verify method
      facilitator.verify(payload, requirements)
    end

    def settle_v1(_payload, _requirements)
      # TODO: Implement V1 support
      raise UnsupportedVersionError, 1
    end

    def settle_v2(payload, requirements)
      # Extract scheme and network
      scheme = payload.get_scheme
      network = payload.get_network

      # Find facilitator
      facilitator = find_facilitator(network, scheme)
      raise SchemeNotFoundError, network if facilitator.nil?

      # Call facilitator's settle method
      facilitator.settle(payload, requirements)
    end

    ##
    # Find facilitator for network and scheme.
    #
    # @param network [String] network identifier
    # @param scheme [String] scheme identifier
    # @return [Object, nil] facilitator instance or nil
    def find_facilitator(network, scheme)
      # Try exact network match first
      @schemes.each do |scheme_data|
        next unless scheme_data.facilitator.scheme == scheme

        if scheme_data.networks.include?(network)
          return scheme_data.facilitator
        end
      end

      # Try pattern match (e.g., eip155:* for eip155:8453)
      @schemes.each do |scheme_data|
        next unless scheme_data.facilitator.scheme == scheme

        if Helpers.matches_network_pattern(network, scheme_data.pattern)
          return scheme_data.facilitator
        end
      end

      nil
    end
  end
end
