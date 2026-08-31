# frozen_string_literal: true

require_relative 'x402/version'
require_relative 'x402/schemas/errors'
require_relative 'x402/schemas/base'
require_relative 'x402/schemas/config'
require_relative 'x402/schemas/payments'
require_relative 'x402/schemas/responses'
require_relative 'x402/schemas/hooks'
require_relative 'x402/schemas/helpers'
require_relative 'x402/interfaces'
require_relative 'x402/client'
require_relative 'x402/server'
require_relative 'x402/facilitator'
require_relative 'x402/http/utils'
require_relative 'x402/http/facilitator_client'

# Middleware (Rack)
begin
  require 'rack'
  require_relative 'x402/http/middleware/rack'
rescue LoadError
  # Rack not available, skip middleware
end

# Mechanisms (optional)
begin
  require_relative 'x402/mechanisms/evm'
rescue LoadError
  # EVM dependencies not available (eth gem), skip
end

begin
  require_relative 'x402/mechanisms/svm'
rescue LoadError
  # SVM dependencies not available (base58, ed25519 gems), skip
end

##
# X402 is a Ruby implementation of the x402 protocol - HTTP 402 Payment Required
# with cryptocurrency micropayments.
#
# The SDK provides three main components:
# - {X402::Client}: Creates signed payment payloads
# - {X402::ResourceServer}: Protects resources and verifies payments
# - {X402::Facilitator}: Verifies and settles payments on-chain
#
# @example Creating a client
#   signer = X402::Mechanisms::EVM::ClientEvmSigner.from_private_key(key)
#   scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)
#   client = X402::Client.new
#   client.register('eip155:*', scheme)
#
# @example Creating a server
#   facilitator = X402::HTTP::FacilitatorClient.new(url: 'https://x402.org/facilitator')
#   server = X402::ResourceServer.new(facilitator)
#   server.register('eip155:*', X402::Mechanisms::EVM::Exact::ServerScheme.new)
#
module X402
  class << self
    ##
    # Returns the version of the x402 gem.
    #
    # @return [String] the gem version
    def version
      VERSION
    end
  end
end
