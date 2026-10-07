# frozen_string_literal: true

# EVM mechanism entry point
require_relative 'evm/constants'
require_relative 'evm/types'
require_relative 'evm/utils'
require_relative 'evm/eip712'
require_relative 'evm/signer'
require_relative 'evm/exact/client'
require_relative 'evm/exact/server'

module X402
  module Mechanisms
    ##
    # EVM (Ethereum Virtual Machine) payment mechanism.
    #
    # Provides support for EIP-3009 (TransferWithAuthorization) payments
    # on EVM-compatible networks.
    #
    # @example Client usage
    #   signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(private_key)
    #   client_scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)
    #
    #   client = X402::Client.new
    #   client.register('eip155:*', client_scheme)
    #
    # @example Server usage
    #   server_scheme = X402::Mechanisms::EVM::Exact::ServerScheme.new
    #
    #   server = X402::ResourceServer.new(facilitator)
    #   server.register('eip155:*', server_scheme)
    module EVM
      # Constants, types, utils, EIP-712, signer, and exact scheme are loaded above
    end
  end
end
