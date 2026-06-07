// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal stand-in for the canonical ERC-8004 ReputationRegistry.
/// @dev Records the caller (`msg.sender`) as the feedback author — exactly like the real
///      registry — so tests can assert client attribution under EIP-7702 delegation.
contract MockReputationRegistry {
    struct Feedback {
        uint256 agentId;
        address client;
        int128 value;
        bytes32 feedbackHash;
    }

    Feedback[] public feedbacks;
    mapping(uint256 => mapping(address => uint64)) public lastIndex;

    event GaveFeedback(uint256 indexed agentId, address indexed client, int128 value, bytes32 feedbackHash);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        feedbacks.push(Feedback({agentId: agentId, client: msg.sender, value: value, feedbackHash: feedbackHash}));
        lastIndex[agentId][msg.sender] += 1;
        emit GaveFeedback(agentId, msg.sender, value, feedbackHash);
    }

    function feedbackCount() external view returns (uint256) {
        return feedbacks.length;
    }
}
