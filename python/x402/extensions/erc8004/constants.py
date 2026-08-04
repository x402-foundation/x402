"""Chain-specific constants for ERC-8004."""

from __future__ import annotations

# Upstream ReputationRegistry (canonical ERC-8004 deployment)
MAINNET_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"

X402_AGENT_REPUTATION_ABI: list[dict] = [
    {
        "type": "function",
        "name": "settleAndMintTicketEIP3009",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "payer", "type": "address"},
            {"name": "agentId", "type": "uint256"},
            {"name": "agentAddress", "type": "address"},
            {
                "name": "settlement",
                "type": "tuple",
                "components": [
                    {"name": "token", "type": "address"},
                    {"name": "payTo", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce", "type": "bytes32"},
                    {"name": "signature", "type": "bytes"},
                ],
            },
        ],
        "outputs": [{"name": "ticketId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "settleAndMintTicketPermit2",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "payer", "type": "address"},
            {"name": "agentId", "type": "uint256"},
            {"name": "agentAddress", "type": "address"},
            {
                "name": "settlement",
                "type": "tuple",
                "components": [
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
                    {"name": "payTo", "type": "address"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "signature", "type": "bytes"},
                ],
            },
        ],
        "outputs": [{"name": "ticketId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "consumeTicket",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "ticketId", "type": "uint256"}],
        "outputs": [{"name": "agentId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "tickets",
        "stateMutability": "view",
        "inputs": [{"name": "ticketId", "type": "uint256"}],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "payer", "type": "address"},
                    {"name": "agentId", "type": "uint256"},
                    {"name": "agentAddress", "type": "address"},
                    {"name": "token", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "consumed", "type": "bool"},
                ],
            }
        ],
    },
    {
        "type": "function",
        "name": "nextTicketId",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "event",
        "name": "TicketMinted",
        "anonymous": False,
        "inputs": [
            {"name": "ticketId", "type": "uint256", "indexed": True},
            {"name": "payer", "type": "address", "indexed": True},
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "agentAddress", "type": "address", "indexed": False},
            {"name": "token", "type": "address", "indexed": False},
            {"name": "amount", "type": "uint256", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "TicketConsumed",
        "anonymous": False,
        "inputs": [
            {"name": "ticketId", "type": "uint256", "indexed": True},
            {"name": "payer", "type": "address", "indexed": True},
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "agentAddress", "type": "address", "indexed": False},
        ],
    },
]

# FeedbackParams tuple shared by the gateway submit entrypoints.
_FEEDBACK_PARAMS_TUPLE = {
    "name": "params",
    "type": "tuple",
    "components": [
        {"name": "value", "type": "int128"},
        {"name": "valueDecimals", "type": "uint8"},
        {"name": "tag1", "type": "string"},
        {"name": "tag2", "type": "string"},
        {"name": "endpoint", "type": "string"},
        {"name": "feedbackURI", "type": "string"},
        {"name": "feedbackHash", "type": "bytes32"},
    ],
}

# FeedbackGateway — the EIP-7702 delegate clients delegate their EOA to.
FEEDBACK_GATEWAY_ABI: list[dict] = [
    {
        "type": "function",
        "name": "submitFeedback",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "wrapper", "type": "address"},
            {"name": "registry", "type": "address"},
            {"name": "ticketId", "type": "uint256"},
            _FEEDBACK_PARAMS_TUPLE,
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "submitFeedbackFor",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "wrapper", "type": "address"},
            {"name": "registry", "type": "address"},
            {"name": "ticketId", "type": "uint256"},
            _FEEDBACK_PARAMS_TUPLE,
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "signature", "type": "bytes"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "domainSeparator",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
]

# Canonical ERC-8004 ReputationRegistry — feedback is keyed by msg.sender (the client).
REPUTATION_REGISTRY_ABI: list[dict] = [
    {
        "type": "function",
        "name": "giveFeedback",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "value", "type": "int128"},
            {"name": "valueDecimals", "type": "uint8"},
            {"name": "tag1", "type": "string"},
            {"name": "tag2", "type": "string"},
            {"name": "endpoint", "type": "string"},
            {"name": "feedbackURI", "type": "string"},
            {"name": "feedbackHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "getLastIndex",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "clientAddress", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint64"}],
    },
]

# EIP-712 type string for the gateway's sponsored FeedbackIntent (must match FeedbackGateway).
FEEDBACK_GATEWAY_DOMAIN_NAME = "X402FeedbackGateway"
FEEDBACK_GATEWAY_DOMAIN_VERSION = "1"


def get_ticket_minted_topic() -> str:
    """Return the topic0 for the v2 TicketMinted event."""
    from eth_utils import keccak

    sig = b"TicketMinted(uint256,address,uint256,address,address,uint256)"
    return "0x" + keccak(sig).hex()
