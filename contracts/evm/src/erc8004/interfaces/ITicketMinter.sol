// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITicketMinter {
    enum TicketStatus {
        NONE,
        MINTED,
        CONSUMED
    }

    struct Ticket {
        address payer;
        uint256 agentId;
        bytes32 requestHash;
        bytes32 interactionHash;
        string endpoint;
        TicketStatus status;
    }

    struct SettlePayment {
        address token;
        address payTo;
        uint256 amount;
    }

    event TicketMinted(
        uint256 indexed ticketId,
        address indexed payer,
        uint256 indexed agentId,
        bytes32 requestHash,
        bytes32 interactionHash
    );

    event TicketConsumed(uint256 indexed ticketId, address indexed payer);

    function settleAndMintTicket(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint,
        SettlePayment calldata payment
    ) external returns (uint256 ticketId);

    function consumeTicket(uint256 ticketId, address payer) external;

    function tickets(uint256 ticketId) external view returns (Ticket memory);

    function nextTicketId() external view returns (uint256);
}
