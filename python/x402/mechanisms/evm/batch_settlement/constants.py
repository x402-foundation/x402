"""Constants for the x402 batch-settlement mechanism.

Mirrors ``typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts``.
Wire field names (camelCase) inside EIP-712 type dictionaries are normative
for digest equivalence with the TypeScript SDK and must not be reordered or
renamed. Module-level dicts and lists are normative; do not mutate at runtime
(``Final`` only prevents name rebinding, not container mutation).
"""

from typing import Final

try:
    from eth_utils import keccak  # type: ignore[attr-defined]
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

BATCH_SETTLEMENT_SCHEME: Final[str] = "batch-settlement"

BATCH_SETTLEMENT_ADDRESS: Final[str] = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003"
ERC3009_DEPOSIT_COLLECTOR_ADDRESS: Final[str] = "0x4020806089470a89826cB9fB1f4059150b550004"
PERMIT2_DEPOSIT_COLLECTOR_ADDRESS: Final[str] = "0x4020425FAf3B746C082C2f942b4E5159887B0005"

# Onchain enforced bounds: 15 minutes ≤ withdrawDelay ≤ 30 days.
MIN_WITHDRAW_DELAY: Final[int] = 900
MAX_WITHDRAW_DELAY: Final[int] = 2_592_000

BATCH_SETTLEMENT_DOMAIN: Final[dict[str, str]] = {
    "name": "x402 Batch Settlement",
    "version": "1",
}

CHANNEL_CONFIG_TYPEHASH: Final[bytes] = keccak(
    text=(
        "ChannelConfig("
        "address payer,"
        "address payerAuthorizer,"
        "address receiver,"
        "address receiverAuthorizer,"
        "address token,"
        "uint40 withdrawDelay,"
        "bytes32 salt"
        ")"
    )
)

channel_config_types: Final[dict[str, list[dict[str, str]]]] = {
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

voucher_types: Final[dict[str, list[dict[str, str]]]] = {
    "Voucher": [
        {"name": "channelId", "type": "bytes32"},
        {"name": "maxClaimableAmount", "type": "uint128"},
    ],
}

refund_types: Final[dict[str, list[dict[str, str]]]] = {
    "Refund": [
        {"name": "channelId", "type": "bytes32"},
        {"name": "nonce", "type": "uint256"},
        {"name": "amount", "type": "uint128"},
    ],
}

claim_batch_types: Final[dict[str, list[dict[str, str]]]] = {
    "ClaimBatch": [{"name": "claims", "type": "ClaimEntry[]"}],
    "ClaimEntry": [
        {"name": "channelId", "type": "bytes32"},
        {"name": "maxClaimableAmount", "type": "uint128"},
        {"name": "totalClaimed", "type": "uint128"},
    ],
}

receive_authorization_types: Final[dict[str, list[dict[str, str]]]] = {
    "ReceiveWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}

batch_permit2_witness_types: Final[dict[str, list[dict[str, str]]]] = {
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
