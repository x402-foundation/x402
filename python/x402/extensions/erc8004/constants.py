"""Chain-specific constants for ERC-8004."""

from __future__ import annotations

# Upstream ReputationRegistry (canonical ERC-8004 deployment)
MAINNET_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
MAINNET_IDENTITY_REGISTRY: str | None = None

SEPOLIA_REPUTATION_REGISTRY: str | None = None
SEPOLIA_IDENTITY_REGISTRY: str | None = None

BASE_REPUTATION_REGISTRY: str | None = None
BASE_IDENTITY_REGISTRY: str | None = None

# X402AgentReputation wrapper deployments per network.
WRAPPER_ADDRESSES: dict[str, str] = {}

X402_AGENT_REPUTATION_ABI: list[dict] = [
    {
        "type": "function",
        "name": "settleAndMintTicket",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "payer", "type": "address"},
            {"name": "agentId", "type": "uint256"},
            {"name": "agentAddress", "type": "address"},
            {
                "name": "payment",
                "type": "tuple",
                "components": [
                    {"name": "token", "type": "address"},
                    {"name": "payTo", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                ],
            },
        ],
        "outputs": [{"name": "ticketId", "type": "uint256"}],
    },
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
        "name": "giveFeedbackWithTicket",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "ticketId", "type": "uint256"},
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
        "name": "giveFeedbackWithTicketFor",
        "stateMutability": "nonpayable",
        "inputs": [
            {
                "name": "submission",
                "type": "tuple",
                "components": [
                    {"name": "payer", "type": "address"},
                    {"name": "ticketId", "type": "uint256"},
                    {"name": "value", "type": "int128"},
                    {"name": "valueDecimals", "type": "uint8"},
                    {"name": "tag1", "type": "string"},
                    {"name": "tag2", "type": "string"},
                    {"name": "endpoint", "type": "string"},
                    {"name": "feedbackURI", "type": "string"},
                    {"name": "feedbackHash", "type": "bytes32"},
                ],
            },
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "signature", "type": "bytes"},
        ],
        "outputs": [],
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
            {"name": "feedbackIndex", "type": "uint64", "indexed": False},
        ],
    },
]


def get_ticket_minted_topic() -> str:
    """Return the topic0 for the v2 TicketMinted event."""
    from eth_utils import keccak

    sig = b"TicketMinted(uint256,address,uint256,address,address,uint256)"
    return "0x" + keccak(sig).hex()
