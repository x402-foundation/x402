# frozen_string_literal: true

module X402
  ##
  # Base error class for all X402 errors.
  class Error < StandardError; end

  ##
  # Raised when no matching scheme is found for a network.
  class SchemeNotFoundError < Error
    ##
    # @param network [String] the network that has no matching scheme
    def initialize(network)
      super("No scheme found for network: #{network}")
      @network = network
    end

    attr_reader :network
  end

  ##
  # Raised when no payment requirements match the client's policies.
  class NoMatchingRequirementsError < Error
    ##
    # @param message [String] error message
    def initialize(message = 'No matching payment requirements after applying policies')
      super
    end
  end

  ##
  # Raised when a payment is invalid.
  class InvalidPaymentError < Error
    ##
    # @param reason [String] the reason the payment is invalid
    def initialize(reason)
      super("Invalid payment: #{reason}")
      @reason = reason
    end

    attr_reader :reason
  end

  ##
  # Raised when payment settlement fails.
  class SettlementError < Error
    ##
    # @param reason [String] the reason settlement failed
    def initialize(reason)
      super("Settlement failed: #{reason}")
      @reason = reason
    end

    attr_reader :reason
  end

  ##
  # Raised for HTTP-related errors.
  class HTTPError < Error
    ##
    # @param status_code [Integer] HTTP status code
    # @param body [String, Hash] response body
    def initialize(status_code, body)
      @status_code = status_code
      @body = body
      super("HTTP #{status_code}: #{body}")
    end

    attr_reader :status_code, :body
  end

  ##
  # Raised when a required method is not implemented.
  class NotImplementedError < Error
    ##
    # @param method_name [String, Symbol] name of the unimplemented method
    def initialize(method_name = nil)
      message = method_name ? "Method not implemented: #{method_name}" : 'Method not implemented'
      super(message)
    end
  end

  ##
  # Raised when payment protocol version is unsupported.
  class UnsupportedVersionError < Error
    ##
    # @param version [Integer] the unsupported version
    def initialize(version)
      super("Unsupported x402 protocol version: #{version}")
      @version = version
    end

    attr_reader :version
  end

  ##
  # Raised when a configuration error occurs.
  class ConfigurationError < Error; end
end
