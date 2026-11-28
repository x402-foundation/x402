# frozen_string_literal: true

module X402
  ##
  # Interface definitions for payment schemes.
  #
  # These modules define the protocol that payment schemes must implement
  # to integrate with X402::Client, X402::ResourceServer, and X402::Facilitator.
  #
  # @note All protocols are synchronous (Ruby default). Async support can be
  #   added in a future version if needed.

  # ============================================================================
  # Client-Side Protocols
  # ============================================================================

  ##
  # V2 client-side payment mechanism.
  #
  # Implementations create signed payment payloads for specific schemes.
  # Returns inner payload hash, which X402::Client wraps into full PaymentPayload.
  #
  # @example Implementation
  #   class ExactEvmScheme
  #     include SchemeNetworkClient
  #
  #     def scheme
  #       'exact'
  #     end
  #
  #     def initialize(signer:)
  #       @signer = signer
  #     end
  #
  #     def create_payment_payload(requirements)
  #       # Create EIP-3009 authorization and sign it
  #       { 'authorization' => {...}, 'signature' => '0x...' }
  #     end
  #   end
  module SchemeNetworkClient
    ##
    # Payment scheme identifier (e.g., 'exact').
    #
    # @return [String] the scheme identifier
    # @raise [NotImplementedError] if not implemented
    def scheme
      raise NotImplementedError, 'scheme must be implemented'
    end

    ##
    # Create the scheme-specific inner payload hash.
    #
    # @param requirements [PaymentRequirements] the payment requirements to fulfill
    # @return [Hash] scheme-specific payload hash (e.g., authorization + signature)
    #   X402::Client wraps this into a full PaymentPayload with x402_version, accepted, etc.
    # @raise [NotImplementedError] if not implemented
    def create_payment_payload(requirements)
      raise NotImplementedError, 'create_payment_payload must be implemented'
    end
  end

  # ============================================================================
  # Server-Side Protocols
  # ============================================================================

  ##
  # V2 server-side payment mechanism.
  #
  # Implementations handle price parsing and requirement enhancement for specific schemes.
  # Does NOT verify/settle - that's delegated to FacilitatorClient.
  #
  # @note parse_price handles USD→atomic conversion for the scheme.
  #   This logic lives in the scheme implementation (e.g., EVM), not standalone.
  #
  # @example Implementation
  #   class ExactEvmScheme
  #     include SchemeNetworkServer
  #
  #     def scheme
  #       'exact'
  #     end
  #
  #     def parse_price(price, network)
  #       # Convert "$1.50" to { amount: "1500000", asset: "0x..." }
  #       ...
  #     end
  #
  #     def enhance_payment_requirements(requirements, supported_kind, extensions)
  #       # Add EIP-712 domain params to extra
  #       ...
  #     end
  #   end
  module SchemeNetworkServer
    ##
    # Payment scheme identifier.
    #
    # @return [String] the scheme identifier
    # @raise [NotImplementedError] if not implemented
    def scheme
      raise NotImplementedError, 'scheme must be implemented'
    end

    ##
    # Convert Money or AssetAmount to normalized AssetAmount.
    #
    # USD→atomic conversion logic lives here, not as a standalone utility.
    #
    # @param price [String, Numeric, AssetAmount] price as Money ("$1.50", 1.50) or AssetAmount
    # @param network [String] target network
    # @return [AssetAmount] normalized AssetAmount with amount in smallest unit
    # @raise [NotImplementedError] if not implemented
    def parse_price(price, network)
      raise NotImplementedError, 'parse_price must be implemented'
    end

    ##
    # Add scheme-specific fields to payment requirements.
    #
    # For EVM, this adds EIP-712 domain parameters (name, version).
    #
    # @param requirements [PaymentRequirements] base payment requirements
    # @param supported_kind [SupportedKind] the supported kind from facilitator
    # @param extensions [Array<String>] list of enabled extension keys
    # @return [PaymentRequirements] enhanced payment requirements
    # @raise [NotImplementedError] if not implemented
    def enhance_payment_requirements(requirements, supported_kind, extensions)
      raise NotImplementedError, 'enhance_payment_requirements must be implemented'
    end
  end

  # ============================================================================
  # Facilitator-Side Protocols
  # ============================================================================

  ##
  # V2 facilitator-side payment mechanism.
  #
  # Implementations verify and settle payments for specific schemes.
  #
  # @note Returns VerifyResponse/SettleResponse objects with
  #   is_valid=false/success=false on failure, not exceptions.
  #
  # @example Implementation
  #   class ExactEvmScheme
  #     include SchemeNetworkFacilitator
  #
  #     def scheme
  #       'exact'
  #     end
  #
  #     def caip_family
  #       'eip155:*'
  #     end
  #
  #     def verify(payload, requirements)
  #       # Verify EIP-3009 signature
  #       ...
  #     end
  #
  #     def settle(payload, requirements)
  #       # Execute transferWithAuthorization
  #       ...
  #     end
  #   end
  module SchemeNetworkFacilitator
    ##
    # Payment scheme identifier.
    #
    # @return [String] the scheme identifier
    # @raise [NotImplementedError] if not implemented
    def scheme
      raise NotImplementedError, 'scheme must be implemented'
    end

    ##
    # CAIP family pattern (e.g., 'eip155:*' for EVM, 'solana:*' for SVM).
    #
    # @return [String] the CAIP family pattern
    # @raise [NotImplementedError] if not implemented
    def caip_family
      raise NotImplementedError, 'caip_family must be implemented'
    end

    ##
    # Get extra data for SupportedKind.
    #
    # @param network [String] target network
    # @return [Hash, nil] extra data (e.g., { feePayer: addr } for SVM), or nil
    # @raise [NotImplementedError] if not implemented
    def get_extra(network)
      raise NotImplementedError, 'get_extra must be implemented'
    end

    ##
    # Get signer addresses for this network.
    #
    # @param network [String] target network
    # @return [Array<String>] list of signer addresses
    # @raise [NotImplementedError] if not implemented
    def get_signers(network)
      raise NotImplementedError, 'get_signers must be implemented'
    end

    ##
    # Verify a payment.
    #
    # @param payload [PaymentPayload] payment payload to verify
    # @param requirements [PaymentRequirements] requirements to verify against
    # @return [VerifyResponse] with is_valid=true on success,
    #   or is_valid=false with invalid_reason on failure
    # @raise [NotImplementedError] if not implemented
    def verify(payload, requirements)
      raise NotImplementedError, 'verify must be implemented'
    end

    ##
    # Settle a payment.
    #
    # @param payload [PaymentPayload] payment payload to settle
    # @param requirements [PaymentRequirements] requirements for settlement
    # @return [SettleResponse] with success=true and transaction on success,
    #   or success=false with error_reason on failure
    # @raise [NotImplementedError] if not implemented
    def settle(payload, requirements)
      raise NotImplementedError, 'settle must be implemented'
    end
  end

  # ============================================================================
  # V1 (Legacy) Protocols
  # ============================================================================

  ##
  # V1 client-side payment mechanism.
  #
  # @note V1 support is not yet implemented in the Ruby SDK.
  module SchemeNetworkClientV1
    def scheme
      raise NotImplementedError, 'V1 protocol not yet supported'
    end

    def create_payment_payload(requirements)
      raise NotImplementedError, 'V1 protocol not yet supported'
    end
  end

  ##
  # V1 facilitator-side payment mechanism.
  #
  # @note V1 support is not yet implemented in the Ruby SDK.
  module SchemeNetworkFacilitatorV1
    def scheme
      raise NotImplementedError, 'V1 protocol not yet supported'
    end

    def caip_family
      raise NotImplementedError, 'V1 protocol not yet supported'
    end

    def get_extra(network)
      raise NotImplementedError, 'V1 protocol not yet supported'
    end

    def get_signers(network)
      raise NotImplementedError, 'V1 protocol not yet supported'
    end

    def verify(payload, requirements)
      raise NotImplementedError, 'V1 protocol not yet supported'
    end

    def settle(payload, requirements)
      raise NotImplementedError, 'V1 protocol not yet supported'
    end
  end
end
