# frozen_string_literal: true

# Optional dependencies for Solana support
begin
  require 'base58'
rescue LoadError
  # base58 gem not available
  warn 'Warning: base58 gem not found. SVM address encoding/decoding will not work.'
  warn 'Install with: gem install base58'
end

begin
  require 'ed25519'
rescue LoadError
  # ed25519 gem not available
  warn 'Warning: ed25519 gem not found. Ed25519 signing will not work.'
  warn 'Install with: gem install ed25519'
end

# Core SVM components
require_relative 'svm/constants'
require_relative 'svm/types'
require_relative 'svm/utils'
require_relative 'svm/signer'

# Exact scheme
require_relative 'svm/exact/client'
require_relative 'svm/exact/server'
require_relative 'svm/exact/facilitator'

module X402
  module Mechanisms
    ##
    # SVM (Solana Virtual Machine) mechanism for x402 payments.
    #
    # Provides exact payment scheme using Solana transactions with SPL tokens.
    #
    # @example Register SVM client
    #   require 'x402/mechanisms/svm'
    #
    #   signer = X402::Mechanisms::SVM::Ed25519Signer.from_hex(ENV['SOLANA_PRIVATE_KEY'])
    #   client_scheme = X402::Mechanisms::SVM::Exact::ClientScheme.new(signer: signer)
    #
    #   client = X402::Client.new
    #   client.register('solana:*', client_scheme)
    #
    # @example Register SVM server
    #   require 'x402/mechanisms/svm'
    #
    #   server_scheme = X402::Mechanisms::SVM::Exact::ServerScheme.new
    #   server = X402::ResourceServer.new(facilitator_client)
    #   server.register('solana:*', server_scheme)
    #
    # @example Register SVM facilitator
    #   require 'x402/mechanisms/svm'
    #
    #   facilitator_scheme = X402::Mechanisms::SVM::Exact::FacilitatorScheme.new(
    #     managed_fee_payers: [ENV['FEE_PAYER_ADDRESS']]
    #   )
    #   facilitator = X402::Facilitator.new
    #   facilitator.register(
    #     ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], # mainnet
    #     facilitator_scheme
    #   )
    module SVM
    end
  end
end
