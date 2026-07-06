// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "../../interfaces/ISignatureTransfer.sol";

/// @notice x402 payment-backed agent reputation: settle + consume-once ticket + ticket-gated
///         feedback submitted to the canonical ERC-8004 ReputationRegistry by this contract.
/// @dev The contract is the registry author (`msg.sender == gateway`); the real payer is
///      recovered off-chain by joining `TicketConsumed` to `NewFeedback` on `feedbackHash`.
interface IFeedbackGateway {
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

    /// @notice On-chain feedback fields forwarded to `giveFeedback`.
    struct FeedbackParams {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    /// @notice Client-signed authorization for sponsored feedback. String fields are passed as
    ///         calldata (`FeedbackParams`) and must hash to the `*Hash` fields here.
    struct FeedbackIntent {
        address registry;
        uint256 ticketId;
        uint256 agentId;
        address payer;
        int128 value;
        uint8 valueDecimals;
        bytes32 tag1Hash;
        bytes32 tag2Hash;
        bytes32 endpointHash;
        bytes32 feedbackURIHash;
        bytes32 feedbackHash;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Client-signed authorization to revoke previously submitted feedback.
    struct RevokeIntent {
        address payer;
        uint256 ticketId;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Captured at submit time so revocation can target the right registry slot even
    ///         though all gateway feedback shares `clientAddress == gateway`.
    struct FeedbackRef {
        uint256 agentId;
        uint64 feedbackIndex;
        bool exists;
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
        uint256 indexed ticketId,
        address indexed payer,
        uint256 indexed agentId,
        address agentAddress,
        bytes32 feedbackHash
    );

    event FeedbackRevokedFor(
        uint256 indexed ticketId,
        address indexed payer,
        uint256 indexed agentId,
        uint64 feedbackIndex
    );

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

    function tickets(uint256 ticketId) external view returns (Ticket memory);

    function nextTicketId() external view returns (uint256);

    // NB: the feedback entrypoints (submitFeedback / submitFeedbackFor / revokeFeedbackFor) and
    // the public mappings (feedbackRef / usedFeedbackHashes / usedNonces) are intentionally NOT
    // declared here — they live only on the concrete `FeedbackGateway`. Keeping them off the
    // interface lets the contract compile after Task 2 (settle/mint only) without being
    // `abstract`, and lets later tasks add genuinely-new functions test-first. Tests reference the
    // concrete `FeedbackGateway` type for these (the structs/events above stay shared via the
    // interface).
}
