"""EVM mechanism constants - network configs, ABIs, error codes."""

from typing import TypedDict

# Scheme identifier
SCHEME_EXACT = "exact"

# Default token decimals for USDC
DEFAULT_DECIMALS = 6

# EIP-3009 function names
FUNCTION_TRANSFER_WITH_AUTHORIZATION = "transferWithAuthorization"
FUNCTION_AUTHORIZATION_STATE = "authorizationState"

# Transaction status
TX_STATUS_SUCCESS = 1
TX_STATUS_FAILED = 0

# Default validity period (1 hour in seconds)
DEFAULT_VALIDITY_PERIOD = 3600

# Default validity buffer (10 minutes before now for clock skew)
DEFAULT_VALIDITY_BUFFER = 600

# ERC-6492 magic value (32 bytes)
# bytes32(uint256(keccak256("erc6492.invalid.signature")) - 1)
ERC6492_MAGIC_VALUE = bytes.fromhex(
    "6492649264926492649264926492649264926492649264926492649264926492"
)

# EIP-1271 magic value (returned by isValidSignature on success)
EIP1271_MAGIC_VALUE = bytes.fromhex("1626ba7e")

# Permit2 contract address (same on all EVM chains via CREATE2)
PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

# x402ExactPermit2Proxy contract address
X402_EXACT_PERMIT2_PROXY_ADDRESS = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001"

# Permit2 EIP-712 witness types for PermitWitnessTransferFrom
# Note: Types must be in alphabetical order after primary type (TokenPermissions < Witness)
PERMIT2_WITNESS_TYPES: dict[str, list[dict[str, str]]] = {
    "PermitWitnessTransferFrom": [
        {"name": "permitted", "type": "TokenPermissions"},
        {"name": "spender", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
        {"name": "witness", "type": "Witness"},
    ],
    "TokenPermissions": [
        {"name": "token", "type": "address"},
        {"name": "amount", "type": "uint256"},
    ],
    "Witness": [
        {"name": "to", "type": "address"},
        {"name": "validAfter", "type": "uint256"},
    ],
}

# x402ExactPermit2Proxy settle ABI
X402_EXACT_PERMIT2_PROXY_ABI = [
    {
        "type": "function",
        "name": "settle",
        "inputs": [
            {
                "name": "permit",
                "type": "tuple",
                "components": [
                    {
                        "name": "permitted",
                        "type": "tuple",
                        "components": [
                            {"name": "token", "type": "address"},
                            {"name": "amount", "type": "uint256"},
                        ],
                    },
                    {"name": "nonce", "type": "uint256"},
                    {"name": "deadline", "type": "uint256"},
                ],
            },
            {"name": "owner", "type": "address"},
            {
                "name": "witness",
                "type": "tuple",
                "components": [
                    {"name": "to", "type": "address"},
                    {"name": "validAfter", "type": "uint256"},
                ],
            },
            {"name": "signature", "type": "bytes"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    }
]

# x402ExactPermit2Proxy settleWithPermit ABI (EIP-2612 extension path)
X402_EXACT_PERMIT2_PROXY_SETTLE_WITH_PERMIT_ABI = [
    {
        "type": "function",
        "name": "settleWithPermit",
        "inputs": [
            {
                "name": "permit2612",
                "type": "tuple",
                "components": [
                    {"name": "value", "type": "uint256"},
                    {"name": "deadline", "type": "uint256"},
                    {"name": "r", "type": "bytes32"},
                    {"name": "s", "type": "bytes32"},
                    {"name": "v", "type": "uint8"},
                ],
            },
            {
                "name": "permit",
                "type": "tuple",
                "components": [
                    {
                        "name": "permitted",
                        "type": "tuple",
                        "components": [
                            {"name": "token", "type": "address"},
                            {"name": "amount", "type": "uint256"},
                        ],
                    },
                    {"name": "nonce", "type": "uint256"},
                    {"name": "deadline", "type": "uint256"},
                ],
            },
            {"name": "owner", "type": "address"},
            {
                "name": "witness",
                "type": "tuple",
                "components": [
                    {"name": "to", "type": "address"},
                    {"name": "validAfter", "type": "uint256"},
                ],
            },
            {"name": "signature", "type": "bytes"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    }
]

# EIP-2612 nonces ABI
EIP2612_NONCES_ABI = [
    {
        "type": "function",
        "name": "nonces",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"type": "uint256"}],
        "stateMutability": "view",
    }
]

# EIP-2612 EIP-712 Permit types
EIP2612_PERMIT_TYPES: dict[str, list[dict[str, str]]] = {
    "Permit": [
        {"name": "owner", "type": "address"},
        {"name": "spender", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
    ]
}

# Gas limit for a standard ERC-20 approve() transaction
ERC20_APPROVE_GAS_LIMIT = 70_000

# Permit2 deadline buffer (seconds) for verification
PERMIT2_DEADLINE_BUFFER = 6

# ERC-20 allowance ABI
ERC20_ALLOWANCE_ABI = [
    {
        "type": "function",
        "name": "allowance",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [{"type": "uint256"}],
        "stateMutability": "view",
    }
]

# ERC-20 approve ABI
ERC20_APPROVE_ABI = [
    {
        "type": "function",
        "name": "approve",
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [{"type": "bool"}],
        "stateMutability": "nonpayable",
    }
]

# Error codes
ERR_INVALID_SIGNATURE = "invalid_exact_evm_payload_signature"
ERR_UNDEPLOYED_SMART_WALLET = "invalid_exact_evm_payload_undeployed_smart_wallet"
ERR_SMART_WALLET_DEPLOYMENT_FAILED = "smart_wallet_deployment_failed"
ERR_RECIPIENT_MISMATCH = "invalid_exact_evm_payload_recipient_mismatch"
ERR_AUTHORIZATION_VALUE_MISMATCH = "invalid_exact_evm_payload_authorization_value_mismatch"
ERR_VALID_BEFORE_EXPIRED = "invalid_exact_evm_payload_authorization_valid_before"
ERR_VALID_AFTER_FUTURE = "invalid_exact_evm_payload_authorization_valid_after"
ERR_NONCE_ALREADY_USED = "invalid_exact_evm_nonce_already_used"
ERR_INSUFFICIENT_BALANCE = "invalid_exact_evm_insufficient_balance"
ERR_MISSING_EIP712_DOMAIN = "missing_eip712_domain"
ERR_NETWORK_MISMATCH = "network_mismatch"
ERR_UNSUPPORTED_SCHEME = "unsupported_scheme"
ERR_FAILED_TO_GET_NETWORK_CONFIG = "invalid_exact_evm_failed_to_get_network_config"
ERR_FAILED_TO_GET_ASSET_INFO = "invalid_exact_evm_failed_to_get_asset_info"
ERR_FAILED_TO_VERIFY_SIGNATURE = "invalid_exact_evm_failed_to_verify_signature"
ERR_TRANSACTION_FAILED = "transaction_failed"
ERR_TOKEN_NAME_MISMATCH = "invalid_exact_evm_token_name_mismatch"
ERR_TOKEN_VERSION_MISMATCH = "invalid_exact_evm_token_version_mismatch"
ERR_EIP3009_NOT_SUPPORTED = "invalid_exact_evm_eip3009_not_supported"
ERR_TRANSACTION_SIMULATION_FAILED = "invalid_exact_evm_transaction_simulation_failed"

# Permit2-specific error codes
ERR_PERMIT2_INVALID_SPENDER = "invalid_permit2_spender"
ERR_PERMIT2_RECIPIENT_MISMATCH = "invalid_permit2_recipient_mismatch"
ERR_PERMIT2_DEADLINE_EXPIRED = "permit2_deadline_expired"
ERR_PERMIT2_NOT_YET_VALID = "permit2_not_yet_valid"
ERR_PERMIT2_AMOUNT_MISMATCH = "invalid_exact_evm_payload_amount_mismatch"
ERR_PERMIT2_TOKEN_MISMATCH = "permit2_token_mismatch"
ERR_PERMIT2_INVALID_SIGNATURE = "invalid_permit2_signature"
ERR_PERMIT2_ALLOWANCE_REQUIRED = "permit2_allowance_required"


class _AssetInfoRequired(TypedDict):
    """Required fields for a token asset."""

    address: str
    name: str
    version: str
    decimals: int


class AssetInfo(_AssetInfoRequired, total=False):
    """Information about a token asset."""

    asset_transfer_method: str
    supports_eip2612: bool


class _NetworkConfigRequired(TypedDict):
    """Required fields for an EVM network configuration."""

    chain_id: int


class NetworkConfig(_NetworkConfigRequired, total=False):
    """Configuration for an EVM network."""

    default_asset: AssetInfo


# Network configurations
NETWORK_CONFIGS: dict[str, NetworkConfig] = {
    # Base Mainnet
    "eip155:8453": {
        "chain_id": 8453,
        "default_asset": {
            "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
        },
    },
    # Base Sepolia (Testnet)
    "eip155:84532": {
        "chain_id": 84532,
        "default_asset": {
            "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "name": "USDC",
            "version": "2",
            "decimals": 6,
        },
    },
    # MegaETH Mainnet (uses Permit2 instead of EIP-3009, supports EIP-2612)
    "eip155:4326": {
        "chain_id": 4326,
        "default_asset": {
            "address": "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
            "name": "MegaUSD",
            "version": "1",
            "decimals": 18,
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    },
    # Monad Mainnet
    "eip155:143": {
        "chain_id": 143,
        "default_asset": {
            "address": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
        },
    },
    # Mezo Testnet (uses Permit2 instead of EIP-3009, supports EIP-2612)
    "eip155:31611": {
        "chain_id": 31611,
        "default_asset": {
            "address": "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
            "name": "Mezo USD",
            "version": "1",
            "decimals": 18,
            "asset_transfer_method": "permit2",
            "supports_eip2612": True,
        },
    },
    # Stable Mainnet
    "eip155:988": {
        "chain_id": 988,
        "default_asset": {
            "address": "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
            "name": "USDT0",
            "version": "1",
            "decimals": 6,
        },
        "supported_assets": {
            "USDT0": {
                "address": "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
                "name": "USDT0",
                "version": "1",
                "decimals": 6,
            },
        },
    },
    # Polygon Mainnet
    "eip155:137": {
        "chain_id": 137,
        "default_asset": {
            "address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
        },
        "supported_assets": {
            "USDC": {
                "address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
                "name": "USD Coin",
                "version": "2",
                "decimals": 6,
            },
        },
    },
    # Arbitrum One
    "eip155:42161": {
        "chain_id": 42161,
        "default_asset": {
            "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
        },
    },
    # Arbitrum Sepolia
    "eip155:421614": {
        "chain_id": 421614,
        "default_asset": {
            "address": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
            "name": "USD Coin",
            "version": "2",
            "decimals": 6,
        },
    },
}

# V1 legacy constants are in x402.mechanisms.evm.v1.constants
# (V1_NETWORKS, V1_NETWORK_CHAIN_IDS, V1_DEFAULT_ASSETS)

# EIP-3009 ABIs
TRANSFER_WITH_AUTHORIZATION_VRS_ABI = [
    {
        "inputs": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
            {"name": "v", "type": "uint8"},
            {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"},
        ],
        "name": "transferWithAuthorization",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    }
]

TRANSFER_WITH_AUTHORIZATION_BYTES_ABI = [
    {
        "inputs": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
            {"name": "signature", "type": "bytes"},
        ],
        "name": "transferWithAuthorization",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    }
]

AUTHORIZATION_STATE_ABI = [
    {
        "inputs": [
            {"name": "authorizer", "type": "address"},
            {"name": "nonce", "type": "bytes32"},
        ],
        "name": "authorizationState",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    }
]

BALANCE_OF_ABI = [
    {
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    }
]

NAME_ABI = [
    {
        "inputs": [],
        "name": "name",
        "outputs": [{"name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function",
    }
]

VERSION_ABI = [
    {
        "inputs": [],
        "name": "version",
        "outputs": [{"name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function",
    }
]

IS_VALID_SIGNATURE_ABI = [
    {
        "inputs": [
            {"name": "hash", "type": "bytes32"},
            {"name": "signature", "type": "bytes"},
        ],
        "name": "isValidSignature",
        "outputs": [{"name": "magicValue", "type": "bytes4"}],
        "stateMutability": "view",
        "type": "function",
    }
]

MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11"

MULTICALL3_TRY_AGGREGATE_ABI = [
    {
        "inputs": [
            {"name": "requireSuccess", "type": "bool"},
            {
                "name": "calls",
                "type": "tuple[]",
                "components": [
                    {"name": "target", "type": "address"},
                    {"name": "callData", "type": "bytes"},
                ],
            },
        ],
        "name": "tryAggregate",
        "outputs": [
            {
                "name": "returnData",
                "type": "tuple[]",
                "components": [
                    {"name": "success", "type": "bool"},
                    {"name": "returnData", "type": "bytes"},
                ],
            }
        ],
        "stateMutability": "payable",
        "type": "function",
    }
]
