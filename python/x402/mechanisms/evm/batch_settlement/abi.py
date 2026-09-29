"""Contract ABIs for the batch-settlement EVM scheme.

Shapes are the standard web3.py/eth_abi JSON ABI format.
"""

from typing import Any

CHANNEL_CONFIG_COMPONENTS: list[dict[str, Any]] = [
    {"name": "payer", "type": "address"},
    {"name": "payerAuthorizer", "type": "address"},
    {"name": "receiver", "type": "address"},
    {"name": "receiverAuthorizer", "type": "address"},
    {"name": "token", "type": "address"},
    {"name": "withdrawDelay", "type": "uint40"},
    {"name": "salt", "type": "bytes32"},
]

VOUCHER_CLAIM_COMPONENTS: list[dict[str, Any]] = [
    {
        "name": "voucher",
        "type": "tuple",
        "components": [
            {
                "name": "channel",
                "type": "tuple",
                "components": CHANNEL_CONFIG_COMPONENTS,
            },
            {"name": "maxClaimableAmount", "type": "uint128"},
        ],
    },
    {"name": "signature", "type": "bytes"},
    {"name": "totalClaimed", "type": "uint128"},
]

BATCH_SETTLEMENT_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "multicall",
        "inputs": [{"name": "data", "type": "bytes[]"}],
        "outputs": [{"name": "results", "type": "bytes[]"}],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "deposit",
        "inputs": [
            {"name": "config", "type": "tuple", "components": CHANNEL_CONFIG_COMPONENTS},
            {"name": "amount", "type": "uint128"},
            {"name": "collector", "type": "address"},
            {"name": "collectorData", "type": "bytes"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "claim",
        "inputs": [
            {"name": "voucherClaims", "type": "tuple[]", "components": VOUCHER_CLAIM_COMPONENTS}
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "claimWithSignature",
        "inputs": [
            {"name": "voucherClaims", "type": "tuple[]", "components": VOUCHER_CLAIM_COMPONENTS},
            {"name": "authorizerSignature", "type": "bytes"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "settle",
        "inputs": [
            {"name": "receiver", "type": "address"},
            {"name": "token", "type": "address"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "initiateWithdraw",
        "inputs": [
            {"name": "config", "type": "tuple", "components": CHANNEL_CONFIG_COMPONENTS},
            {"name": "amount", "type": "uint128"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "finalizeWithdraw",
        "inputs": [{"name": "config", "type": "tuple", "components": CHANNEL_CONFIG_COMPONENTS}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "refund",
        "inputs": [
            {"name": "config", "type": "tuple", "components": CHANNEL_CONFIG_COMPONENTS},
            {"name": "amount", "type": "uint128"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "refundWithSignature",
        "inputs": [
            {"name": "config", "type": "tuple", "components": CHANNEL_CONFIG_COMPONENTS},
            {"name": "amount", "type": "uint128"},
            {"name": "nonce", "type": "uint256"},
            {"name": "receiverAuthorizerSignature", "type": "bytes"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "type": "function",
        "name": "getChannelId",
        "inputs": [{"name": "config", "type": "tuple", "components": CHANNEL_CONFIG_COMPONENTS}],
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "channels",
        "inputs": [{"name": "channelId", "type": "bytes32"}],
        "outputs": [
            {"name": "balance", "type": "uint128"},
            {"name": "totalClaimed", "type": "uint128"},
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "pendingWithdrawals",
        "inputs": [{"name": "channelId", "type": "bytes32"}],
        "outputs": [
            {"name": "amount", "type": "uint128"},
            {"name": "initiatedAt", "type": "uint40"},
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "receivers",
        "inputs": [
            {"name": "receiver", "type": "address"},
            {"name": "token", "type": "address"},
        ],
        "outputs": [
            {"name": "totalClaimed", "type": "uint128"},
            {"name": "totalSettled", "type": "uint128"},
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "refundNonce",
        "inputs": [{"name": "channelId", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "getVoucherDigest",
        "inputs": [
            {"name": "channelId", "type": "bytes32"},
            {"name": "maxClaimableAmount", "type": "uint128"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "getRefundDigest",
        "inputs": [
            {"name": "channelId", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "amount", "type": "uint128"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "getClaimBatchDigest",
        "inputs": [
            {"name": "voucherClaims", "type": "tuple[]", "components": VOUCHER_CLAIM_COMPONENTS}
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
    },
    {
        "type": "event",
        "name": "Settled",
        "inputs": [
            {"name": "receiver", "type": "address", "indexed": True},
            {"name": "token", "type": "address", "indexed": True},
            {"name": "sender", "type": "address", "indexed": True},
            {"name": "amount", "type": "uint128", "indexed": False},
        ],
        "anonymous": False,
    },
]

ERC20_BALANCE_OF_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "balanceOf",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
]


__all__ = [
    "BATCH_SETTLEMENT_ABI",
    "ERC20_BALANCE_OF_ABI",
    "CHANNEL_CONFIG_COMPONENTS",
    "VOUCHER_CLAIM_COMPONENTS",
]
