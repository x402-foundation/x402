// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "../../interfaces/ISignatureTransfer.sol";

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

    /// @notice EIP-3009 settlement parameters.
    /// @dev Mirrors USDC's `transferWithAuthorization(...,bytes)` overload.
    struct EIP3009Settlement {
        address token;
        address payTo;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
    }

    /// @notice Permit2 settlement parameters. The TicketMinter acts as the Permit2 spender.
    /// @dev The witness over (payer, agentId, requestHash, interactionHash, endpoint, payTo, validAfter)
    ///      binds the payment to ticket metadata and destination.
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

    function settleAndMintTicketEIP3009(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint,
        EIP3009Settlement calldata settlement
    ) external returns (uint256 ticketId);

    function settleAndMintTicketPermit2(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint,
        Permit2Settlement calldata settlement
    ) external returns (uint256 ticketId);

    function consumeTicket(uint256 ticketId, address payer) external;

    function tickets(uint256 ticketId) external view returns (Ticket memory);

    function nextTicketId() external view returns (uint256);
}
