# frozen_string_literal: true

module X402
  ##
  # Result from before hook to abort the operation.
  #
  # @!attribute reason
  #   @return [String] human-readable reason for aborting
  class AbortResult
    attr_reader :reason

    def initialize(reason)
      @reason = reason
    end
  end

  ##
  # Result from client failure hook to recover with a payload.
  #
  # @!attribute payload
  #   @return [PaymentPayload] the recovered payment payload
  class RecoveredPayloadResult
    attr_reader :payload

    def initialize(payload)
      @payload = payload
    end
  end

  ##
  # Result from verify failure hook to recover with a result.
  #
  # @!attribute result
  #   @return [VerifyResponse] the recovered verify response
  class RecoveredVerifyResult
    attr_reader :result

    def initialize(result)
      @result = result
    end
  end

  ##
  # Result from settle failure hook to recover with a result.
  #
  # @!attribute result
  #   @return [SettleResponse] the recovered settle response
  class RecoveredSettleResult
    attr_reader :result

    def initialize(result)
      @result = result
    end
  end

  # ============================================================================
  # Verify Hook Contexts
  # ============================================================================

  ##
  # Context for verify hooks.
  VerifyContext = Struct.new(:payment_payload, :requirements, :payload_bytes, :requirements_bytes, keyword_init: true) do
    def initialize(payment_payload:, requirements:, payload_bytes: nil, requirements_bytes: nil)
      super
    end
  end

  ##
  # Context for after-verify hooks.
  VerifyResultContext = Struct.new(:payment_payload, :requirements, :result, :payload_bytes, :requirements_bytes,
                                    keyword_init: true) do
    def initialize(payment_payload:, requirements:, result:, payload_bytes: nil, requirements_bytes: nil)
      raise ArgumentError, 'result is required' if result.nil?

      super
    end
  end

  ##
  # Context for verify failure hooks.
  VerifyFailureContext = Struct.new(:payment_payload, :requirements, :error, :payload_bytes, :requirements_bytes,
                                     keyword_init: true) do
    def initialize(payment_payload:, requirements:, error:, payload_bytes: nil, requirements_bytes: nil)
      raise ArgumentError, 'error is required' if error.nil?

      super
    end
  end

  # ============================================================================
  # Settle Hook Contexts
  # ============================================================================

  ##
  # Context for settle hooks.
  SettleContext = Struct.new(:payment_payload, :requirements, :payload_bytes, :requirements_bytes, keyword_init: true) do
    def initialize(payment_payload:, requirements:, payload_bytes: nil, requirements_bytes: nil)
      super
    end
  end

  ##
  # Context for after-settle hooks.
  SettleResultContext = Struct.new(:payment_payload, :requirements, :result, :payload_bytes, :requirements_bytes,
                                    keyword_init: true) do
    def initialize(payment_payload:, requirements:, result:, payload_bytes: nil, requirements_bytes: nil)
      raise ArgumentError, 'result is required' if result.nil?

      super
    end
  end

  ##
  # Context for settle failure hooks.
  SettleFailureContext = Struct.new(:payment_payload, :requirements, :error, :payload_bytes, :requirements_bytes,
                                     keyword_init: true) do
    def initialize(payment_payload:, requirements:, error:, payload_bytes: nil, requirements_bytes: nil)
      raise ArgumentError, 'error is required' if error.nil?

      super
    end
  end

  # ============================================================================
  # Payment Creation Hook Contexts (for Client)
  # ============================================================================

  ##
  # Context for payment creation hooks.
  PaymentCreationContext = Struct.new(:payment_required, :selected_requirements, keyword_init: true) do
    def initialize(payment_required:, selected_requirements:)
      super
    end
  end

  ##
  # Context for after-payment-creation hooks.
  PaymentCreatedContext = Struct.new(:payment_required, :selected_requirements, :payment_payload,
                                      keyword_init: true) do
    def initialize(payment_required:, selected_requirements:, payment_payload:)
      raise ArgumentError, 'payment_payload is required' if payment_payload.nil?

      super
    end
  end

  ##
  # Context for payment creation failure hooks.
  PaymentCreationFailureContext = Struct.new(:payment_required, :selected_requirements, :error, keyword_init: true) do
    def initialize(payment_required:, selected_requirements:, error:)
      raise ArgumentError, 'error is required' if error.nil?

      super
    end
  end
end
