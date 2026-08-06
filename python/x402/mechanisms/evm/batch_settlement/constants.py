"""Constants for the batch-settlement EVM scheme."""

from typing import Any

try:
    from eth_utils import keccak, to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

# Scheme identifier
SCHEME_BATCH_SETTLEMENT = "batch-settlement"

# Deployed contract addresses (CREATE2 deterministic across chains)
BATCH_SETTLEMENT_ADDRESS = to_checksum_address("0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003")
ERC3009_DEPOSIT_COLLECTOR_ADDRESS = to_checksum_address(
    "0x4020806089470a89826cB9fB1f4059150b550004"
)
PERMIT2_DEPOSIT_COLLECTOR_ADDRESS = to_checksum_address(
    "0x4020425FAf3B746C082C2f942b4E5159887B0005"
)

# Withdraw delay bounds (seconds): 15 min – 30 days
MIN_WITHDRAW_DELAY = 900
MAX_WITHDRAW_DELAY = 2_592_000

# Default settings for the channel-manager auto-settlement loop
DEFAULT_CLAIM_INTERVAL_SECS = 60
DEFAULT_SETTLE_INTERVAL_SECS = 120
DEFAULT_REFUND_INTERVAL_SECS = 180
DEFAULT_MAX_CLAIMS_PER_BATCH = 100

# EIP-712 domain shared by all batch-settlement typed-data signatures
BATCH_SETTLEMENT_DOMAIN_NAME = "x402 Batch Settlement"
BATCH_SETTLEMENT_DOMAIN_VERSION = "1"

# EIP-712 type hash for channel identity (keccak of the type string)
CHANNEL_CONFIG_TYPE_STRING = (
    "ChannelConfig(address payer,address payerAuthorizer,address receiver,"
    "address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)"
)
CHANNEL_CONFIG_TYPEHASH = keccak(text=CHANNEL_CONFIG_TYPE_STRING)

# --- EIP-712 type definitions (compatible with eth_account.messages.encode_typed_data) ---

CHANNEL_CONFIG_TYPES: dict[str, list[dict[str, str]]] = {
    "ChannelConfig": [
        {"name": "payer", "type": "address"},
        {"name": "payerAuthorizer", "type": "address"},
        {"name": "receiver", "type": "address"},
        {"name": "receiverAuthorizer", "type": "address"},
        {"name": "token", "type": "address"},
        {"name": "withdrawDelay", "type": "uint40"},
        {"name": "salt", "type": "bytes32"},
    ],
}

VOUCHER_TYPES: dict[str, list[dict[str, str]]] = {
    "Voucher": [
        {"name": "channelId", "type": "bytes32"},
        {"name": "maxClaimableAmount", "type": "uint128"},
    ],
}

REFUND_TYPES: dict[str, list[dict[str, str]]] = {
    "Refund": [
        {"name": "channelId", "type": "bytes32"},
        {"name": "nonce", "type": "uint256"},
        {"name": "amount", "type": "uint128"},
    ],
}

CLAIM_BATCH_TYPES: dict[str, list[dict[str, str]]] = {
    "ClaimBatch": [{"name": "claims", "type": "ClaimEntry[]"}],
    "ClaimEntry": [
        {"name": "channelId", "type": "bytes32"},
        {"name": "maxClaimableAmount", "type": "uint128"},
        {"name": "totalClaimed", "type": "uint128"},
    ],
}

RECEIVE_AUTHORIZATION_TYPES: dict[str, list[dict[str, str]]] = {
    "ReceiveWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}

BATCH_PERMIT2_WITNESS_TYPES: dict[str, list[dict[str, str]]] = {
    "PermitWitnessTransferFrom": [
        {"name": "permitted", "type": "TokenPermissions"},
        {"name": "spender", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
        {"name": "witness", "type": "DepositWitness"},
    ],
    "TokenPermissions": [
        {"name": "token", "type": "address"},
        {"name": "amount", "type": "uint256"},
    ],
    "DepositWitness": [{"name": "channelId", "type": "bytes32"}],
}


# Default freshness for cached onchain channel state (server-side local verify).
# Server can verify a plain-EOA voucher locally if its mirrored onchain state is
# this fresh, skipping the facilitator round trip.
DEFAULT_ONCHAIN_STATE_TTL_MS = 60_000


# Payload type discriminators
PAYLOAD_TYPE_DEPOSIT = "deposit"
PAYLOAD_TYPE_VOUCHER = "voucher"
PAYLOAD_TYPE_REFUND = "refund"
PAYLOAD_TYPE_CLAIM = "claim"
PAYLOAD_TYPE_SETTLE = "settle"


# Re-exported for callers building typed-data on their own
__all__: list[Any] = [
    "SCHEME_BATCH_SETTLEMENT",
    "BATCH_SETTLEMENT_ADDRESS",
    "ERC3009_DEPOSIT_COLLECTOR_ADDRESS",
    "PERMIT2_DEPOSIT_COLLECTOR_ADDRESS",
    "MIN_WITHDRAW_DELAY",
    "MAX_WITHDRAW_DELAY",
    "BATCH_SETTLEMENT_DOMAIN_NAME",
    "BATCH_SETTLEMENT_DOMAIN_VERSION",
    "CHANNEL_CONFIG_TYPE_STRING",
    "CHANNEL_CONFIG_TYPEHASH",
    "CHANNEL_CONFIG_TYPES",
    "VOUCHER_TYPES",
    "REFUND_TYPES",
    "CLAIM_BATCH_TYPES",
    "RECEIVE_AUTHORIZATION_TYPES",
    "BATCH_PERMIT2_WITNESS_TYPES",
    "DEFAULT_CLAIM_INTERVAL_SECS",
    "DEFAULT_SETTLE_INTERVAL_SECS",
    "DEFAULT_REFUND_INTERVAL_SECS",
    "DEFAULT_MAX_CLAIMS_PER_BATCH",
    "DEFAULT_ONCHAIN_STATE_TTL_MS",
    "PAYLOAD_TYPE_DEPOSIT",
    "PAYLOAD_TYPE_VOUCHER",
    "PAYLOAD_TYPE_REFUND",
    "PAYLOAD_TYPE_CLAIM",
    "PAYLOAD_TYPE_SETTLE",
]
