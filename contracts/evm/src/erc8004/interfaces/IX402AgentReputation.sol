// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "../../interfaces/ISignatureTransfer.sol";

/// @notice x402 payment-backed agent reputation wrapper: settle + consume-once ticket.
/// @dev Feedback is gated by `consumeTicket` and stored on the canonical ERC-8004
///      `ReputationRegistry` (via the EIP-7702 `FeedbackGateway`), not here.
interface IX402AgentReputation {
    struct Ticket {
        address payer;
        uint256 agentId;
        address agentAddress;
        address token;
        uint256 amount;
        bool consumed;
    }

    struct EIP3009Settlement {
        address token;
        address payTo;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
    }

    struct Permit2Settlement {
        ISignatureTransfer.PermitTransferFrom permit;
        address payTo;
        uint256 validAfter;
        bytes signature;
    }

    event TicketMinted(
        uint256 indexed ticketId,
        address indexed payer,
        uint256 indexed agentId,
        address agentAddress,
        address token,
        uint256 amount
    );

    event TicketConsumed(uint256 indexed ticketId, address indexed payer, uint256 indexed agentId);

    function settleAndMintTicketEIP3009(
        address payer,
        uint256 agentId,
        address agentAddress,
        EIP3009Settlement calldata settlement
    ) external returns (uint256 ticketId);

    function settleAndMintTicketPermit2(
        address payer,
        uint256 agentId,
        address agentAddress,
        Permit2Settlement calldata settlement
    ) external returns (uint256 ticketId);

    function consumeTicket(uint256 ticketId) external returns (uint256 agentId);

    function tickets(uint256 ticketId) external view returns (Ticket memory);

    function nextTicketId() external view returns (uint256);
}
