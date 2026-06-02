"""Chain-specific constants for ERC-8004."""

from __future__ import annotations

# ReputationRegistry (canonical ERC-8004 deployment)
MAINNET_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
MAINNET_IDENTITY_REGISTRY: str | None = None

SEPOLIA_REPUTATION_REGISTRY: str | None = None
SEPOLIA_IDENTITY_REGISTRY: str | None = None

BASE_REPUTATION_REGISTRY: str | None = None
BASE_IDENTITY_REGISTRY: str | None = None

# TicketMinter deployments per network (populated as deployments happen).
# Anvil/local deployments are written by run_on_anvil scripts (Phase 5).
TICKET_MINTER_ADDRESSES: dict[str, str] = {}

# Minimum ABI the facilitator + clients need. Excludes admin setters that
# only the deployer/owner cares about — those live in the Foundry artifacts.
TICKET_MINTER_ABI: list[dict] = [
    {
        "type": "function",
        "name": "settleAndMintTicket",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "payer", "type": "address"},
            {"name": "agentId", "type": "uint256"},
            {"name": "requestHash", "type": "bytes32"},
            {"name": "interactionHash", "type": "bytes32"},
            {"name": "endpoint", "type": "string"},
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
            {"name": "requestHash", "type": "bytes32"},
            {"name": "interactionHash", "type": "bytes32"},
            {"name": "endpoint", "type": "string"},
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
            {"name": "requestHash", "type": "bytes32"},
            {"name": "interactionHash", "type": "bytes32"},
            {"name": "endpoint", "type": "string"},
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
                    {"name": "requestHash", "type": "bytes32"},
                    {"name": "interactionHash", "type": "bytes32"},
                    {"name": "endpoint", "type": "string"},
                    {"name": "status", "type": "uint8"},
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
            {"name": "requestHash", "type": "bytes32", "indexed": False},
            {"name": "interactionHash", "type": "bytes32", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "TicketConsumed",
        "anonymous": False,
        "inputs": [
            {"name": "ticketId", "type": "uint256", "indexed": True},
            {"name": "payer", "type": "address", "indexed": True},
        ],
    },
]

# keccak256("TicketMinted(uint256,address,uint256,bytes32,bytes32)")
TICKET_MINTED_EVENT_TOPIC = "0x" + (
    # Computed at runtime to avoid hand-maintained hashes; cached lazily.
    ""
)


def get_ticket_minted_topic() -> str:
    """Return the topic0 for the TicketMinted event."""
    from eth_utils import keccak

    sig = b"TicketMinted(uint256,address,uint256,bytes32,bytes32)"
    return "0x" + keccak(sig).hex()
