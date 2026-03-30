"""SVM mechanism constants - network configs, USDC addresses, error codes."""

from typing import TypedDict

# Scheme identifier
SCHEME_EXACT = "exact"

# Default token decimals for USDC on Solana
DEFAULT_DECIMALS = 6

# Token program addresses (same across all Solana networks)
TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111"
MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
LIGHTHOUSE_PROGRAM_ADDRESS = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"

# Default RPC URLs for Solana networks
DEVNET_RPC_URL = "https://api.devnet.solana.com"
TESTNET_RPC_URL = "https://api.testnet.solana.com"
MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com"

# WebSocket URLs
DEVNET_WS_URL = "wss://api.devnet.solana.com"
TESTNET_WS_URL = "wss://api.testnet.solana.com"
MAINNET_WS_URL = "wss://api.mainnet-beta.solana.com"

# USDC token mint addresses (default stablecoin)
USDC_MAINNET_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DEVNET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
USDC_TESTNET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"  # Same as devnet

# Compute budget configuration
# All prices are in microlamports (1 lamport = 1,000,000 microlamports)
DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1
MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000_000  # 5 lamports
DEFAULT_COMPUTE_UNIT_LIMIT = 20000

# Solana address validation regex (base58, 32-44 characters)
SVM_ADDRESS_REGEX = r"^[1-9A-HJ-NP-Za-km-z]{32,44}$"

# CAIP-2 network identifiers for Solana (V2)
SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
SOLANA_TESTNET_CAIP2 = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"

# V1 to V2 network identifier mappings (for backwards compatibility)
V1_TO_V2_NETWORK_MAP: dict[str, str] = {
    "solana": SOLANA_MAINNET_CAIP2,
    "solana-devnet": SOLANA_DEVNET_CAIP2,
    "solana-testnet": SOLANA_TESTNET_CAIP2,
}

# V1 supported networks (legacy name-based)
V1_NETWORKS = [
    "solana",
    "solana-devnet",
    "solana-testnet",
]

# Error codes
ERR_UNSUPPORTED_SCHEME = "unsupported_scheme"
ERR_NETWORK_MISMATCH = "network_mismatch"
ERR_INVALID_PAYLOAD = "invalid_exact_svm_payload"
ERR_TRANSACTION_DECODE_FAILED = "invalid_exact_svm_payload_transaction_could_not_be_decoded"
ERR_INVALID_INSTRUCTION_COUNT = "invalid_exact_svm_payload_transaction_instructions_length"
ERR_UNKNOWN_FOURTH_INSTRUCTION = "invalid_exact_svm_payload_unknown_fourth_instruction"
ERR_UNKNOWN_FIFTH_INSTRUCTION = "invalid_exact_svm_payload_unknown_fifth_instruction"
ERR_UNKNOWN_SIXTH_INSTRUCTION = "invalid_exact_svm_payload_unknown_sixth_instruction"
ERR_INVALID_COMPUTE_LIMIT = (
    "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction"
)
ERR_INVALID_COMPUTE_PRICE = (
    "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction"
)
ERR_COMPUTE_PRICE_TOO_HIGH = (
    "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high"
)
ERR_NO_TRANSFER_INSTRUCTION = "invalid_exact_svm_payload_no_transfer_instruction"
ERR_MINT_MISMATCH = "invalid_exact_svm_payload_mint_mismatch"
ERR_RECIPIENT_MISMATCH = "invalid_exact_svm_payload_recipient_mismatch"
ERR_AMOUNT_INSUFFICIENT = "invalid_exact_svm_payload_amount_insufficient"
ERR_FEE_PAYER_MISSING = "invalid_exact_svm_payload_missing_fee_payer"
ERR_FEE_PAYER_NOT_MANAGED = "fee_payer_not_managed_by_facilitator"
ERR_FEE_PAYER_TRANSFERRING = "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds"
ERR_SIMULATION_FAILED = "transaction_simulation_failed"
ERR_TRANSACTION_FAILED = "transaction_failed"
ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement"

# How long a transaction is held in the duplicate settlement cache (seconds).
# Covers the Solana blockhash lifetime (~60-90s) with margin.
SETTLEMENT_TTL_SECONDS = 120.0


class AssetInfo(TypedDict):
    """Information about a token asset."""

    address: str
    name: str
    decimals: int


class NetworkConfig(TypedDict):
    """Configuration for a Solana network."""

    rpc_url: str
    ws_url: str
    default_asset: AssetInfo


# Network configurations
NETWORK_CONFIGS: dict[str, NetworkConfig] = {
    # Solana Mainnet
    SOLANA_MAINNET_CAIP2: {
        "rpc_url": MAINNET_RPC_URL,
        "ws_url": MAINNET_WS_URL,
        "default_asset": {
            "address": USDC_MAINNET_ADDRESS,
            "name": "USD Coin",
            "decimals": 6,
        },
    },
    # Solana Devnet
    SOLANA_DEVNET_CAIP2: {
        "rpc_url": DEVNET_RPC_URL,
        "ws_url": DEVNET_WS_URL,
        "default_asset": {
            "address": USDC_DEVNET_ADDRESS,
            "name": "USD Coin",
            "decimals": 6,
        },
    },
    # Solana Testnet
    SOLANA_TESTNET_CAIP2: {
        "rpc_url": TESTNET_RPC_URL,
        "ws_url": TESTNET_WS_URL,
        "default_asset": {
            "address": USDC_TESTNET_ADDRESS,
            "name": "USD Coin",
            "decimals": 6,
        },
    },
}
