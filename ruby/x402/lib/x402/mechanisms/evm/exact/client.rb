# frozen_string_literal: true

require_relative '../../../interfaces'
require_relative '../../../schemas/payments'
require_relative '../constants'
require_relative '../types'
require_relative '../utils'
require_relative '../signer'

module X402
  module Mechanisms
    module EVM
      module Exact
        ##
        # EVM client implementation for the Exact payment scheme (V2).
        #
        # Implements SchemeNetworkClient protocol. Returns the inner payload dict,
        # which X402::Client wraps into a full PaymentPayload.
        #
        # @example
        #   signer = X402::Mechanisms::EVM::PrivateKeySigner.from_hex(private_key)
        #   scheme = X402::Mechanisms::EVM::Exact::ClientScheme.new(signer: signer)
        #   client = X402::Client.new
        #   client.register('eip155:*', scheme)
        class ClientScheme
          include X402::SchemeNetworkClient

          ##
          # @return [String] scheme identifier
          def scheme
            Constants::SCHEME_EXACT
          end

          ##
          # Create Exact EVM client scheme.
          #
          # @param signer [ClientEvmSigner] EVM signer for payment authorizations
          def initialize(signer:)
            @signer = signer
          end

          ##
          # Create signed EIP-3009 inner payload.
          #
          # @param requirements [PaymentRequirements] payment requirements from server
          # @return [Hash] inner payload dict (authorization + signature)
          def create_payment_payload(requirements)
            nonce = Utils.create_nonce
            valid_after, valid_before = Utils.create_validity_window(
              duration: requirements.max_timeout_seconds || 3600
            )

            authorization = Types::ExactEIP3009Authorization.new(
              from_address: @signer.address,
              to: requirements.pay_to,
              value: requirements.amount,
              valid_after: valid_after.to_s,
              valid_before: valid_before.to_s,
              nonce: nonce
            )

            signature = sign_authorization(authorization, requirements)

            payload = Types::ExactEIP3009Payload.new(
              authorization: authorization,
              signature: signature
            )

            # Return inner payload dict - X402::Client wraps this
            payload.to_h
          end

          private

          ##
          # Sign EIP-3009 authorization using EIP-712.
          #
          # Requires requirements.extra to contain 'name' and 'version'
          # for the EIP-712 domain separator.
          #
          # @param authorization [Types::ExactEIP3009Authorization] authorization to sign
          # @param requirements [PaymentRequirements] payment requirements with EIP-712 domain info
          # @return [String] hex-encoded signature with 0x prefix
          # @raise [ArgumentError] if EIP-712 domain parameters are missing
          def sign_authorization(authorization, requirements)
            chain_id = Utils.get_evm_chain_id(requirements.network)

            extra = requirements.extra || {}
            if extra['name'].nil? && extra[:name].nil?
              # Try to get from asset info
              begin
                asset_info = Utils.get_asset_info(requirements.network, requirements.asset)
                extra['name'] = asset_info.name
                extra['version'] = asset_info.version || '1'
              rescue ArgumentError
                raise ArgumentError, 'EIP-712 domain parameters (name, version) required in extra'
              end
            end

            name = extra['name'] || extra[:name]
            version = extra['version'] || extra[:version] || '1'

            # Build EIP-712 domain
            domain = Types::TypedDataDomain.new(
              name: name,
              version: version,
              chain_id: chain_id,
              verifying_contract: requirements.asset
            )

            # Build message
            message = {
              'from' => authorization.from_address,
              'to' => authorization.to,
              'value' => authorization.value,
              'validAfter' => authorization.valid_after,
              'validBefore' => authorization.valid_before,
              'nonce' => authorization.nonce
            }

            # Sign
            sig_bytes = @signer.sign_typed_data(
              domain,
              Types::AUTHORIZATION_TYPES,
              'TransferWithAuthorization',
              message
            )

            '0x' + sig_bytes.unpack1('H*')
          end
        end
      end
    end
  end
end
