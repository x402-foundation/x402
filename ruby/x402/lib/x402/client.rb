# frozen_string_literal: true

require_relative 'schemas/base'
require_relative 'schemas/errors'
require_relative 'schemas/payments'
require_relative 'schemas/hooks'
require_relative 'schemas/helpers'
require_relative 'interfaces'

module X402
  ##
  # Client for creating signed payment payloads.
  #
  # The client manages scheme registration, policy filtering, and payment
  # creation with lifecycle hooks.
  #
  # @example Basic usage
  #   signer = X402::Mechanisms::EVM::ClientEvmSigner.from_private_key(key)
  #   scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)
  #
  #   client = X402::Client.new
  #   client.register('eip155:*', scheme)
  #
  #   # Create payment from 402 response
  #   payload = client.create_payment_payload(payment_required)
  #
  # @example With policies
  #   client = X402::Client.new
  #   client.register('eip155:*', evm_scheme)
  #   client.register('solana:*', svm_scheme)
  #   client.register_policy(X402::Client.prefer_network('eip155:8453'))
  #   client.register_policy(X402::Client.max_amount(1_000_000))
  #
  # @example With hooks
  #   client.before_payment_creation do |context|
  #     puts "Creating payment for #{context.selected_requirements.network}"
  #   end
  #
  #   client.after_payment_creation do |context|
  #     puts "Created payload: #{context.payment_payload.to_json}"
  #   end
  #
  #   client.on_payment_creation_failure do |context|
  #     puts "Failed: #{context.error.message}"
  #     # Return RecoveredPayloadResult to recover, or nil to re-raise
  #     nil
  #   end
  class Client
    ##
    # Create a new client.
    #
    # @param payment_requirements_selector [Proc, nil] optional custom selector
    #   function. Defaults to selecting the first requirement.
    def initialize(payment_requirements_selector: nil)
      @selector = payment_requirements_selector || method(:default_payment_selector)
      @schemes = {}      # network pattern => scheme name => scheme client
      @schemes_v1 = {}   # V1 schemes (not yet supported)
      @policies = []
      @before_payment_creation_hooks = []
      @after_payment_creation_hooks = []
      @on_payment_creation_failure_hooks = []
    end

    # ========================================================================
    # Registration
    # ========================================================================

    ##
    # Register a V2 scheme client for a network pattern.
    #
    # @param network [String] network pattern (e.g., "eip155:*", "eip155:8453")
    # @param client [Object] scheme client implementing SchemeNetworkClient
    # @param x402_version [Integer] protocol version (default: 2)
    # @return [self] for chaining
    #
    # @example
    #   client.register('eip155:*', evm_scheme)
    #   client.register('solana:mainnet', svm_scheme)
    def register(network, client, x402_version: 2)
      raise ArgumentError, 'Only V2 protocol supported' unless x402_version == 2

      @schemes[network] ||= {}
      @schemes[network][client.scheme] = client
      self
    end

    ##
    # Register a requirement filter policy.
    #
    # Policies filter payment requirements before selection. They can:
    # - Reorder requirements (prefer specific networks/schemes)
    # - Filter out requirements (e.g., by maximum amount)
    #
    # @param policy [Proc] policy function taking (version, requirements) and
    #   returning filtered requirements array
    # @return [self] for chaining
    #
    # @example
    #   client.register_policy(X402::Client.prefer_network('eip155:8453'))
    def register_policy(policy)
      @policies << policy
      self
    end

    # ========================================================================
    # Payment Creation
    # ========================================================================

    ##
    # Create payment payload from PaymentRequired response.
    #
    # This is the main method for creating payments. It:
    # 1. Selects matching requirements using policies and selector
    # 2. Finds the appropriate scheme client
    # 3. Creates the scheme-specific payload
    # 4. Wraps it in a full PaymentPayload structure
    # 5. Executes lifecycle hooks
    #
    # @param payment_required [PaymentRequired] 402 response from server
    # @param resource [ResourceInfo, nil] optional resource override
    # @param extensions [Hash, nil] optional extensions override
    # @return [PaymentPayload] signed payment payload
    # @raise [NoMatchingRequirementsError] if no requirements match
    # @raise [SchemeNotFoundError] if no scheme found for selected network
    #
    # @example
    #   payload = client.create_payment_payload(payment_required)
    def create_payment_payload(payment_required, resource: nil, extensions: nil)
      if payment_required.x402_version == 2
        create_payment_payload_v2(payment_required, resource: resource, extensions: extensions)
      else
        raise UnsupportedVersionError, payment_required.x402_version
      end
    end

    # ========================================================================
    # Hooks
    # ========================================================================

    ##
    # Register a before-payment-creation hook.
    #
    # Hook receives PaymentCreationContext and can return:
    # - nil to continue
    # - AbortResult to abort payment creation
    #
    # @yield [context] the payment creation context
    # @yieldparam context [PaymentCreationContext] context with payment_required and selected_requirements
    # @yieldreturn [AbortResult, nil] result or nil
    # @return [self] for chaining
    #
    # @example
    #   client.before_payment_creation do |context|
    #     puts "Creating payment for #{context.selected_requirements.scheme}"
    #   end
    def before_payment_creation(&block)
      @before_payment_creation_hooks << block
      self
    end

    ##
    # Register an after-payment-creation hook.
    #
    # Hook receives PaymentCreatedContext with the created payload.
    #
    # @yield [context] the payment created context
    # @yieldparam context [PaymentCreatedContext] context with payment_payload
    # @return [self] for chaining
    #
    # @example
    #   client.after_payment_creation do |context|
    #     puts "Created payload with scheme: #{context.payment_payload.get_scheme}"
    #   end
    def after_payment_creation(&block)
      @after_payment_creation_hooks << block
      self
    end

    ##
    # Register a payment-creation-failure hook.
    #
    # Hook receives PaymentCreationFailureContext and can return:
    # - nil to re-raise the error
    # - RecoveredPayloadResult to recover with a payload
    #
    # @yield [context] the failure context
    # @yieldparam context [PaymentCreationFailureContext] context with error
    # @yieldreturn [RecoveredPayloadResult, nil] recovery result or nil
    # @return [self] for chaining
    #
    # @example
    #   client.on_payment_creation_failure do |context|
    #     Rails.logger.error("Payment creation failed: #{context.error}")
    #     nil  # Re-raise
    #   end
    def on_payment_creation_failure(&block)
      @on_payment_creation_failure_hooks << block
      self
    end

    # ========================================================================
    # Introspection
    # ========================================================================

    ##
    # Get list of registered schemes for debugging.
    #
    # @return [Hash] map of version => array of scheme info hashes
    #
    # @example
    #   client.get_registered_schemes
    #   # => { 2 => [{ network: "eip155:*", scheme: "exact" }] }
    def get_registered_schemes
      result = { 1 => [], 2 => [] }

      @schemes.each do |network, schemes|
        schemes.each_key do |scheme|
          result[2] << { network: network, scheme: scheme }
        end
      end

      @schemes_v1.each do |network, schemes|
        schemes.each_key do |scheme|
          result[1] << { network: network, scheme: scheme }
        end
      end

      result
    end

    # ========================================================================
    # Built-in Policies
    # ========================================================================

    ##
    # Create a policy that prefers a specific network.
    #
    # The preferred network's requirements will be placed first in the list.
    #
    # @param network [String] network to prefer (e.g., "eip155:8453")
    # @return [Proc] policy function
    #
    # @example
    #   client.register_policy(X402::Client.prefer_network('eip155:8453'))
    def self.prefer_network(network)
      ->(version, reqs) do
        preferred = reqs.select { |r| r.network == network }
        others = reqs.reject { |r| r.network == network }
        preferred + others
      end
    end

    ##
    # Create a policy that prefers a specific scheme.
    #
    # The preferred scheme's requirements will be placed first in the list.
    #
    # @param scheme [String] scheme to prefer (e.g., "exact")
    # @return [Proc] policy function
    #
    # @example
    #   client.register_policy(X402::Client.prefer_scheme('exact'))
    def self.prefer_scheme(scheme)
      ->(version, reqs) do
        preferred = reqs.select { |r| r.scheme == scheme }
        others = reqs.reject { |r| r.scheme == scheme }
        preferred + others
      end
    end

    ##
    # Create a policy that filters by maximum amount.
    #
    # Requirements with amount > max_value will be removed.
    #
    # @param max_value [Integer] maximum amount in smallest unit
    # @return [Proc] policy function
    #
    # @example
    #   client.register_policy(X402::Client.max_amount(1_000_000))
    def self.max_amount(max_value)
      ->(version, reqs) do
        reqs.select { |r| r.get_amount.to_i <= max_value }
      end
    end

    private

    # ========================================================================
    # Internal Implementation
    # ========================================================================

    def create_payment_payload_v2(payment_required, resource:, extensions:)
      # 1. Select requirements
      selected = select_requirements_v2(payment_required.accepts)

      # 2. Build context
      context = PaymentCreationContext.new(
        payment_required: payment_required,
        selected_requirements: selected
      )

      # 3. Execute before hooks
      @before_payment_creation_hooks.each do |hook|
        result = hook.call(context)
        raise InvalidPaymentError, result.reason if result.is_a?(AbortResult)
      end

      # 4. Create payment
      begin
        # Find scheme client
        schemes = Helpers.find_schemes_by_network(@schemes, selected.network)
        raise SchemeNotFoundError, selected.network if schemes.nil? || !schemes.key?(selected.scheme)

        scheme_client = schemes[selected.scheme]

        # Create inner payload
        inner_payload = scheme_client.create_payment_payload(selected)

        # Wrap into full PaymentPayload
        payload = PaymentPayload.new(
          x402_version: 2,
          payload: inner_payload,
          accepted: selected,
          resource: resource || payment_required.resource,
          extensions: extensions || payment_required.extensions
        )

        # 5. Execute after hooks
        result_context = PaymentCreatedContext.new(
          payment_required: payment_required,
          selected_requirements: selected,
          payment_payload: payload
        )
        @after_payment_creation_hooks.each { |hook| hook.call(result_context) }

        payload
      rescue StandardError => e
        # Execute failure hooks
        failure_context = PaymentCreationFailureContext.new(
          payment_required: payment_required,
          selected_requirements: selected,
          error: e
        )

        @on_payment_creation_failure_hooks.each do |hook|
          result = hook.call(failure_context)
          return result.payload if result.is_a?(RecoveredPayloadResult)
        end

        raise
      end
    end

    def select_requirements_v2(requirements)
      # Filter to supported schemes
      supported = requirements.select do |req|
        schemes = Helpers.find_schemes_by_network(@schemes, req.network)
        schemes && schemes.key?(req.scheme)
      end

      raise NoMatchingRequirementsError if supported.empty?

      # Apply policies
      filtered = supported
      @policies.each do |policy|
        filtered = policy.call(2, filtered)
        raise NoMatchingRequirementsError, 'All requirements filtered out by policies' if filtered.empty?
      end

      # Select final requirement
      @selector.call(2, filtered)
    end

    def default_payment_selector(_version, requirements)
      requirements.first
    end
  end
end
