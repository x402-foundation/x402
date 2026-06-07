// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "../../interfaces/ISignatureTransfer.sol";

/// @notice x402 payment-backed agent reputation wrapper (ERC-8004 ticket + gated feedback).
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

    struct FeedbackSubmission {
        address payer;
        uint256 ticketId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    event TicketMinted(
        uint256 indexed ticketId,
        address indexed payer,
        uint256 indexed agentId,
        address agentAddress,
        address token,
        uint256 amount
    );

    event TicketConsumed(
        uint256 indexed ticketId, address indexed payer, uint256 indexed agentId, uint64 feedbackIndex
    );

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackDisputed(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

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

    function giveFeedbackWithTicket(
        uint256 ticketId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function giveFeedbackWithTicketFor(
        FeedbackSubmission calldata submission,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external;

    function disputeFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external;

    function tickets(uint256 ticketId) external view returns (Ticket memory);

    function nextTicketId() external view returns (uint256);

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isDisputed);

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

    function domainSeparator() external view returns (bytes32);
}
