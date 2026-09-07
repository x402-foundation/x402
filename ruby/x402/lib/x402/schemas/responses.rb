# frozen_string_literal: true

require_relative 'base'
require_relative 'payments'

module X402
  ##
  # Request to verify a payment.
  #
  # @!attribute payment_payload
  #   @return [PaymentPayload] the payment payload to verify
  # @!attribute payment_requirements
  #   @return [PaymentRequirements] the requirements to verify against
  class VerifyRequest < BaseStruct
    attribute :payment_payload, PaymentPayload
    attribute :payment_requirements, PaymentRequirements
  end

  ##
  # Response from payment verification.
  #
  # @!attribute is_valid
  #   @return [Boolean] whether the payment is valid
  # @!attribute invalid_reason
  #   @return [String, nil] reason for invalidity (if is_valid is false)
  # @!attribute invalid_message
  #   @return [String, nil] human-readable message for invalidity
  # @!attribute payer
  #   @return [String, nil] the payer's address
  class VerifyResponse < BaseStruct
    attribute :is_valid, Types::Bool
    attribute :invalid_reason, Types::String.optional.default(nil)
    attribute :invalid_message, Types::String.optional.default(nil)
    attribute :payer, Types::String.optional.default(nil)

    ##
    # Check if the payment is valid.
    #
    # @return [Boolean] true if valid
    def valid?
      is_valid
    end
  end

  ##
  # Request to settle a payment.
  #
  # @!attribute payment_payload
  #   @return [PaymentPayload] the payment payload to settle
  # @!attribute payment_requirements
  #   @return [PaymentRequirements] the requirements for settlement
  class SettleRequest < BaseStruct
    attribute :payment_payload, PaymentPayload
    attribute :payment_requirements, PaymentRequirements
  end

  ##
  # Response from payment settlement.
  #
  # @!attribute success
  #   @return [Boolean] whether settlement was successful
  # @!attribute error_reason
  #   @return [String, nil] reason for failure (if success is false)
  # @!attribute error_message
  #   @return [String, nil] human-readable message for failure
  # @!attribute payer
  #   @return [String, nil] the payer's address
  # @!attribute transaction
  #   @return [String] transaction hash/identifier
  # @!attribute network
  #   @return [String] network where settlement occurred
  class SettleResponse < BaseStruct
    attribute :success, Types::Bool
    attribute :error_reason, Types::String.optional.default(nil)
    attribute :error_message, Types::String.optional.default(nil)
    attribute :payer, Types::String.optional.default(nil)
    attribute :transaction, Types::String
    attribute :network, Types::String

    ##
    # Check if settlement was successful.
    #
    # @return [Boolean] true if successful
    def success?
      success
    end
  end

  ##
  # A supported payment configuration.
  #
  # @!attribute x402_version
  #   @return [Integer] protocol version for this kind
  # @!attribute scheme
  #   @return [String] payment scheme identifier
  # @!attribute network
  #   @return [String] CAIP-2 network identifier
  # @!attribute extra
  #   @return [Hash, nil] additional scheme-specific data
  class SupportedKind < BaseStruct
    attribute :x402_version, Types::Integer
    attribute :scheme, Types::String
    attribute :network, Types::String
    attribute :extra, Types::Hash.optional.default(nil)
  end

  ##
  # Describes what payment kinds a facilitator supports.
  #
  # @!attribute kinds
  #   @return [Array<SupportedKind>] list of supported payment kinds
  # @!attribute extensions
  #   @return [Array<String>] list of supported extension keys
  # @!attribute signers
  #   @return [Hash] map of CAIP family to signer addresses
  class SupportedResponse < BaseStruct
    attribute :kinds, Types::Array.of(SupportedKind)
    attribute :extensions, Types::Array.of(Types::String).default([].freeze)
    attribute :signers, Types::Hash.default({}.freeze)
  end
end
