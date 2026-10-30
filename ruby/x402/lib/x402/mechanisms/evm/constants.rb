# frozen_string_literal: true

module X402
  module Mechanisms
    module EVM
      ##
      # EVM mechanism constants - network configs, ABIs, error codes.
      module Constants
        # Scheme identifier
        SCHEME_EXACT = 'exact'

        # Default token decimals for USDC
        DEFAULT_DECIMALS = 6

        # EIP-3009 function names
        FUNCTION_TRANSFER_WITH_AUTHORIZATION = 'transferWithAuthorization'
        FUNCTION_AUTHORIZATION_STATE = 'authorizationState'

        # Transaction status
        TX_STATUS_SUCCESS = 1
        TX_STATUS_FAILED = 0

        # Default validity period (1 hour in seconds)
        DEFAULT_VALIDITY_PERIOD = 3600

        # Default validity buffer (30 seconds before now for clock skew)
        DEFAULT_VALIDITY_BUFFER = 30

        # ERC-6492 magic value (32 bytes)
        # bytes32(uint256(keccak256("erc6492.invalid.signature")) - 1)
        ERC6492_MAGIC_VALUE = ['6492649264926492649264926492649264926492649264926492649264926492'].pack('H*')

        # EIP-1271 magic value (returned by isValidSignature on success)
        EIP1271_MAGIC_VALUE = ['1626ba7e'].pack('H*')

        # Error codes
        ERR_INVALID_SIGNATURE = 'invalid_exact_evm_payload_signature'
        ERR_UNDEPLOYED_SMART_WALLET = 'invalid_exact_evm_payload_undeployed_smart_wallet'
        ERR_SMART_WALLET_DEPLOYMENT_FAILED = 'smart_wallet_deployment_failed'
        ERR_RECIPIENT_MISMATCH = 'invalid_exact_evm_payload_recipient_mismatch'
        ERR_INSUFFICIENT_AMOUNT = 'invalid_exact_evm_payload_authorization_value'
        ERR_VALID_BEFORE_EXPIRED = 'invalid_exact_evm_payload_authorization_valid_before'
        ERR_VALID_AFTER_FUTURE = 'invalid_exact_evm_payload_authorization_valid_after'
        ERR_NONCE_ALREADY_USED = 'nonce_already_used'
        ERR_INSUFFICIENT_BALANCE = 'insufficient_balance'
        ERR_MISSING_EIP712_DOMAIN = 'missing_eip712_domain'
        ERR_NETWORK_MISMATCH = 'network_mismatch'
        ERR_UNSUPPORTED_SCHEME = 'unsupported_scheme'
        ERR_FAILED_TO_GET_NETWORK_CONFIG = 'invalid_exact_evm_failed_to_get_network_config'
        ERR_FAILED_TO_GET_ASSET_INFO = 'invalid_exact_evm_failed_to_get_asset_info'
        ERR_FAILED_TO_VERIFY_SIGNATURE = 'invalid_exact_evm_failed_to_verify_signature'
        ERR_TRANSACTION_FAILED = 'transaction_failed'

        # Asset information structure
        AssetInfo = Struct.new(:address, :name, :version, :decimals, keyword_init: true)

        # Network configuration structure
        NetworkConfig = Struct.new(:chain_id, :default_asset, :supported_assets, keyword_init: true)

        # Network configurations
        NETWORK_CONFIGS = {
          # Ethereum Mainnet
          'eip155:1' => NetworkConfig.new(
            chain_id: 1,
            default_asset: AssetInfo.new(
              address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              name: 'USD Coin',
              version: '2',
              decimals: 6
            ),
            supported_assets: {
              'USDC' => AssetInfo.new(
                address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                name: 'USD Coin',
                version: '2',
                decimals: 6
              )
            }
          ),
          # Base Mainnet
          'eip155:8453' => NetworkConfig.new(
            chain_id: 8453,
            default_asset: AssetInfo.new(
              address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              name: 'USD Coin',
              version: '2',
              decimals: 6
            ),
            supported_assets: {
              'USDC' => AssetInfo.new(
                address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                name: 'USD Coin',
                version: '2',
                decimals: 6
              )
            }
          ),
          # Base Sepolia (Testnet)
          'eip155:84532' => NetworkConfig.new(
            chain_id: 84532,
            default_asset: AssetInfo.new(
              address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              name: 'USDC',
              version: '2',
              decimals: 6
            ),
            supported_assets: {
              'USDC' => AssetInfo.new(
                address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                name: 'USDC',
                version: '2',
                decimals: 6
              )
            }
          ),
          # Polygon Mainnet
          'eip155:137' => NetworkConfig.new(
            chain_id: 137,
            default_asset: AssetInfo.new(
              address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
              name: 'USD Coin',
              version: '2',
              decimals: 6
            ),
            supported_assets: {
              'USDC' => AssetInfo.new(
                address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
                name: 'USD Coin',
                version: '2',
                decimals: 6
              )
            }
          ),
          # Avalanche C-Chain
          'eip155:43114' => NetworkConfig.new(
            chain_id: 43114,
            default_asset: AssetInfo.new(
              address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
              name: 'USD Coin',
              version: '2',
              decimals: 6
            ),
            supported_assets: {
              'USDC' => AssetInfo.new(
                address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
                name: 'USD Coin',
                version: '2',
                decimals: 6
              )
            }
          ),
          # MegaETH Mainnet
          'eip155:4326' => NetworkConfig.new(
            chain_id: 4326,
            default_asset: AssetInfo.new(
              address: '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7',
              name: 'MegaUSD',
              version: '1',
              decimals: 18
            ),
            supported_assets: {
              'USDM' => AssetInfo.new(
                address: '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7',
                name: 'MegaUSD',
                version: '1',
                decimals: 18
              )
            }
          )
        }.freeze

        # Network aliases (legacy names to CAIP-2)
        NETWORK_ALIASES = {
          'base' => 'eip155:8453',
          'base-mainnet' => 'eip155:8453',
          'base-sepolia' => 'eip155:84532',
          'ethereum' => 'eip155:1',
          'mainnet' => 'eip155:1',
          'polygon' => 'eip155:137',
          'avalanche' => 'eip155:43114',
          'megaeth' => 'eip155:4326'
        }.freeze

        # V1 supported networks (legacy name-based)
        V1_NETWORKS = %w[
          abstract
          abstract-testnet
          base-sepolia
          base
          avalanche-fuji
          avalanche
          iotex
          sei
          sei-testnet
          polygon
          polygon-amoy
          peaq
          story
          educhain
          skale-base-sepolia
          megaeth
        ].freeze

        # V1 network name to chain ID mapping
        V1_NETWORK_CHAIN_IDS = {
          'base' => 8453,
          'base-sepolia' => 84532,
          'ethereum' => 1,
          'polygon' => 137,
          'polygon-amoy' => 80002,
          'avalanche' => 43114,
          'avalanche-fuji' => 43113,
          'abstract' => 2741,
          'abstract-testnet' => 11124,
          'iotex' => 4689,
          'sei' => 1329,
          'sei-testnet' => 713_715,
          'peaq' => 3338,
          'story' => 1513,
          'educhain' => 656_476,
          'skale-base-sepolia' => 1_444_673_419,
          'megaeth' => 4326
        }.freeze

        # EIP-3009 ABIs
        TRANSFER_WITH_AUTHORIZATION_VRS_ABI = [
          {
            'inputs' => [
              { 'name' => 'from', 'type' => 'address' },
              { 'name' => 'to', 'type' => 'address' },
              { 'name' => 'value', 'type' => 'uint256' },
              { 'name' => 'validAfter', 'type' => 'uint256' },
              { 'name' => 'validBefore', 'type' => 'uint256' },
              { 'name' => 'nonce', 'type' => 'bytes32' },
              { 'name' => 'v', 'type' => 'uint8' },
              { 'name' => 'r', 'type' => 'bytes32' },
              { 'name' => 's', 'type' => 'bytes32' }
            ],
            'name' => 'transferWithAuthorization',
            'outputs' => [],
            'stateMutability' => 'nonpayable',
            'type' => 'function'
          }
        ].freeze

        TRANSFER_WITH_AUTHORIZATION_BYTES_ABI = [
          {
            'inputs' => [
              { 'name' => 'from', 'type' => 'address' },
              { 'name' => 'to', 'type' => 'address' },
              { 'name' => 'value', 'type' => 'uint256' },
              { 'name' => 'validAfter', 'type' => 'uint256' },
              { 'name' => 'validBefore', 'type' => 'uint256' },
              { 'name' => 'nonce', 'type' => 'bytes32' },
              { 'name' => 'signature', 'type' => 'bytes' }
            ],
            'name' => 'transferWithAuthorization',
            'outputs' => [],
            'stateMutability' => 'nonpayable',
            'type' => 'function'
          }
        ].freeze

        AUTHORIZATION_STATE_ABI = [
          {
            'inputs' => [
              { 'name' => 'authorizer', 'type' => 'address' },
              { 'name' => 'nonce', 'type' => 'bytes32' }
            ],
            'name' => 'authorizationState',
            'outputs' => [{ 'name' => '', 'type' => 'bool' }],
            'stateMutability' => 'view',
            'type' => 'function'
          }
        ].freeze

        BALANCE_OF_ABI = [
          {
            'inputs' => [{ 'name' => 'account', 'type' => 'address' }],
            'name' => 'balanceOf',
            'outputs' => [{ 'name' => '', 'type' => 'uint256' }],
            'stateMutability' => 'view',
            'type' => 'function'
          }
        ].freeze

        IS_VALID_SIGNATURE_ABI = [
          {
            'inputs' => [
              { 'name' => 'hash', 'type' => 'bytes32' },
              { 'name' => 'signature', 'type' => 'bytes' }
            ],
            'name' => 'isValidSignature',
            'outputs' => [{ 'name' => 'magicValue', 'type' => 'bytes4' }],
            'stateMutability' => 'view',
            'type' => 'function'
          }
        ].freeze
      end
    end
  end
end
